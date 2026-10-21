import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { launchVerificationServer, type VerificationServer } from "../scripts/control-quati.ts";
import { CAPTURE_MARKER } from "./memory-capture.ts";
import { SKILL_REVIEW_MARKER } from "./skill-review.ts";
import { removeTempDir } from "./testing/cleanup.ts";

describe("OpenCode background jobs and helper boundaries", () => {
  let fixture: VerificationServer;
  let scratch: string;
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(fixture.info.url + path, {
      method, headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: JSON.parse(await response.text()) };
  };
  const botState = async (id: string) => {
    const response = await api("GET", "/api/bots");
    return response.body.bots.find((bot: { id: string }) => bot.id === id);
  };
  const ledger = (botId: string) => {
    const file = join(fixture.info.dataDir, "usage", `${new Date().toISOString().slice(0, 7)}.jsonl`);
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8").trim().split("\n").filter(Boolean)
      .map(line => JSON.parse(line)).filter(row => row.botId === botId);
  };
  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), "quati-background-jobs-"));
    const routes = join(scratch, "routes.json");
    writeFileSync(routes, JSON.stringify({
      [CAPTURE_MARKER]: JSON.stringify([{ text: "The person is vegetarian", kind: "preference", aboutUser: true, confidence: 0.9 }]),
      [SKILL_REVIEW_MARKER]: JSON.stringify({ changes: [{ action: "create", gist: "Five-bullet weekly report.",
        skill_md: "---\nname: weekly-report\ndescription: Writes the weekly status report.\n---\n\n# Weekly report\n\nWrites the weekly status report from project notes.\n\n## When to Use\n- Write the weekly report.\n\n## Procedure\n1. Read the notes.\n2. Keep it to five bullets.\n\n## Pitfalls\n- Long reports go unread.\n\n## Verification\n- Count the bullets.\n" }] }),
    }));
    fixture = await launchVerificationServer({
      FAKE_ACP_MODELS: "fixture/default,fixture/helper", FAKE_ACP_TEXT_ROUTES: routes,
      FAKE_ACP_SESSION_MODELS: "fixture/default,fixture/helper",
      FAKE_ACP_TOOL_CALLS: JSON.stringify([{ name: "Read", input: { file_path: "/fixture/notes.md" }, ok: true }]),
    });
    const configFile = join(fixture.info.dataDir, "config.json");
    const config = JSON.parse(readFileSync(configFile, "utf8"));
    config.helper = { instanceId: "opencodeGo", model: "fixture/helper" };
    writeFileSync(configFile, JSON.stringify(config));
    expect((await api("PATCH", "/api/config", {
      features: { skillReview: true, skillReviewSteps: 3 }, memory: { captureQuietMs: 1_000 },
    })).status).toBe(200);
  }, 30_000);
  afterAll(async () => {
    await fixture?.close();
    if (scratch) await removeTempDir(scratch);
  });

  it("books native memory capture and skill review to the bot without a separate compaction writer", async () => {
    const created = await api("POST", "/api/bots", { name: "Background jobs", modelSelection: { instanceId: "opencodeGo", model: "fixture/default" } });
    expect(created.status).toBe(201);
    const bot = created.body.bot;
    expect((await api("GET", `/api/bots/${bot.id}/memory/upkeep`)).body).toMatchObject({ enabled: true, modelSteps: true });
    for (const text of ["Just so you know, I'm vegetarian.", "Write the weekly report from the notes.", "Shorter please, five bullets at most."]) {
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { text })).status).toBe(202);
      await expect.poll(async () => (await botState(bot.id)).busy, { timeout: 15_000 }).toBe(false);
    }
    await expect.poll(async () => (await api("GET", `/api/bots/${bot.id}/memory/file?path=MEMORY.md`)).body.text,
      { timeout: 30_000 }).toContain("The person is vegetarian");
    await expect.poll(async () => (await botState(bot.id)).messages.some((message: { card?: { skillRequest?: { name: string } } }) =>
      message.card?.skillRequest?.name === "weekly-report"), { timeout: 30_000 }).toBe(true);
    const rows = ledger(bot.id);
    for (const job of ["memory", "skill-review"]) {
      expect(rows).toContainEqual(expect.objectContaining({
        instanceId: "opencodeGo", driverKind: "opencodeGo", model: "fixture/default",
        threadId: expect.stringMatching(new RegExp(`^${job}-`)),
        trigger: expect.objectContaining({ kind: "bot", botId: bot.id }),
      }));
    }
    expect(rows.some(row => row.trigger.kind === "helper")).toBe(false);
    expect((await api("POST", `/api/bots/${bot.id}/compact`, { threadId: bot.threadId })).status).toBe(202);
    await expect.poll(async () => (await botState(bot.id)).busy, { timeout: 15_000 }).toBe(false);
    expect(ledger(bot.id).some(row => row.trigger.kind === "helper")).toBe(false);
  }, 90_000);

  it("persists the helper opt-out without disabling the bot's own background engine", async () => {
    const created = await api("POST", "/api/bots", { settings: { helperModel: false } });
    expect(created.status).toBe(201);
    const id = created.body.bot.id;
    expect(await botState(id)).toMatchObject({ helperModel: false });
    const saved = JSON.parse(readFileSync(join(fixture.info.dataDir, "bots.json"), "utf8"));
    expect(saved.find((bot: { id: string }) => bot.id === id)).toMatchObject({ helperModel: false });
    expect((await api("GET", `/api/bots/${id}/memory/upkeep`)).body).toMatchObject({ modelSteps: true });
    for (const wrong of ["no", 0, null, { off: true }]) {
      expect((await api("PATCH", `/api/bots/${id}`, { helperModel: wrong })).status).toBe(400);
    }
    expect((await api("POST", "/api/bots", { settings: { helperModel: "false" } })).status).toBe(400);
    expect((await api("PATCH", `/api/bots/${id}`, { helperModel: true })).status).toBe(200);
    expect(await botState(id)).toMatchObject({ helperModel: true });
  });

  it("does not let HTTP settings replace a helper selected in the operator's config", async () => {
    expect(await api("PATCH", "/api/config", { helper: { instanceId: "" } }))
      .toMatchObject({ status: 400, body: { error: "nothing to save" } });
    expect((await api("PATCH", "/api/config", { helper: { instanceId: "" }, language: "en" })).status).toBe(200);
    expect(JSON.parse(readFileSync(join(fixture.info.dataDir, "config.json"), "utf8")))
      .toMatchObject({ helper: { instanceId: "opencodeGo", model: "fixture/helper" }, language: "en" });
  });
});
