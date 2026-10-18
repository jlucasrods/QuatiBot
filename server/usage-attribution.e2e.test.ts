import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verificationServerEnvironment } from "../scripts/control-quati.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_ACP = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
let BASE: string;

describe("usage attribution e2e", () => {
  let child: ChildProcess;
  let home: string;
  let stderr = "";

  type Reply = { status: number; body: any };
  const request = async (headers: Record<string, string>, method: string, path: string, body?: unknown): Promise<Reply> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const api = (method: string, path: string, body?: unknown) => request({}, method, path, body);
  const getBot = async (id: string) => (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === id);
  const PERSON = "Safari on Mac";
  const asPerson = async (scopes?: string[]) => {
    const opened = await api("POST", "/api/auth/pairing", scopes ? { scopes } : {});
    expect(opened.status).toBe(200);
    const paired = await fetch(`${BASE}/api/auth/pair`, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Safari/605.1" },
      body: JSON.stringify({ code: opened.body.code }),
    });
    const session = (await paired.json()) as any;
    expect(session.session.label).toBe(PERSON);
    return (method: string, path: string, body?: unknown) => request({ authorization: `Bearer ${session.token}` }, method, path, body);
  };
  const waitFor = async (predicate: () => Promise<boolean> | boolean, what: string, ms = 30_000) => {
    const deadline = Date.now() + ms;
    while (!(await predicate())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}. stderr: ${stderr.slice(-2000)}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  const ledger = (botId: string) => {
    const file = join(home, ".quatibot", "usage", `${new Date().toISOString().slice(0, 7)}.jsonl`);
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((row) => row.botId === botId);
  };
  const newBot = async (instanceId: string, model: string) => {
    const created = await api("POST", "/api/bots", { modelSelection: { instanceId, model } });
    expect(created.status).toBe(201);
    return created.body.bot as { id: string; threadId: string };
  };
  const owner = { kind: "owner" };
  const person = { kind: "user", label: PERSON };

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "quati-attribution-"));
    mkdirSync(join(home, ".quatibot"), { recursive: true });
    const discovery = join(home, ".quatibot", "providers", "opencode", "discovery");
    mkdirSync(discovery, { recursive: true });
    writeFileSync(join(discovery, ".quati-project"), "Verification fixture\n");
    const instances: Record<string, { driver: string; config: { cli: string } }> = {};
    for (const [instanceId, mode] of [["acp", "hang"], ["acpHappy", "happy"], ["questions", "question"]] as const) {
      const cli = join(home, `${instanceId}-opencode.mjs`);
      writeFileSync(cli, [
        "#!/usr/bin/env node",
        `process.env.FAKE_ACP_MODE = ${JSON.stringify(mode)};`,
        `await import(${JSON.stringify(pathToFileURL(FAKE_ACP).href)});`,
      ].join("\n"), { mode: 0o700 });
      instances[instanceId] = { driver: "opencodeGo", config: { cli } };
    }
    writeFileSync(
      join(home, ".quatibot", "config.json"),
      JSON.stringify({
        instances,
        defaultModelSelection: { instanceId: "acpHappy", model: "fixture/unpriced" },
      }),
    );
    const port = await freePortBlock([0, 1]);
    BASE = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: {
        ...verificationServerEnvironment({}, join(home, ".quatibot"), port), HOME: home,
        FAKE_ACP_VERSION: "2.0.31", FAKE_ACP_AGENT_VERSION: "2.0.31", FAKE_ACP_AGENT_NAME: "OpenCode",
        FAKE_ACP_MODELS: "x-ai/grok-4.7,fixture/unpriced",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (c) => (stderr += c));
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        if ((await fetch(`${BASE}/api/health`)).ok) break;
      } catch {
      }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
      await new Promise((r) => setTimeout(r, 150));
    }
    await waitFor(async () => {
      const snapshots = (await api("GET", "/api/instances")).body.instances;
      return snapshots.length === 3 && snapshots.every((instance: { models: { options: Array<{ id: string }> } }) => instance.models.options.some((model) => model.id === "fixture/unpriced"));
    }, "OpenCode fixture models", 15_000);
  }, 30_000);

  afterAll(async () => {
    child?.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (!child || child.exitCode !== null) return resolve();
      child.on("close", () => resolve());
      setTimeout(() => (child.kill("SIGKILL"), resolve()), 5_000).unref?.();
    });
    rmSync(home, { recursive: true, force: true });
  });

  it("books an engine that reports tokens but no price at an estimate, and an unlisted model as unpriced", async () => {
    const listed = await newBot("acpHappy", "x-ai/grok-4.7");
    expect((await api("POST", `/api/bots/${listed.id}/messages`, { text: "priced from the list" })).status).toBe(202);
    await waitFor(() => ledger(listed.id).length === 1, "the listed model's turn to be booked");
    const row = ledger(listed.id)[0];
    expect(row).toMatchObject({ driverKind: "opencodeGo", model: "x-ai/grok-4.7", input: 10, output: 5, costSource: "estimated" });
    expect(row.costUsd).toBeCloseTo((10 * 1.6 + 5 * 4.8) / 1_000_000, 12);

    const unlisted = await newBot("acpHappy", "fixture/unpriced");
    expect((await api("POST", `/api/bots/${unlisted.id}/messages`, { text: "no known price" })).status).toBe(202);
    await waitFor(() => ledger(unlisted.id).length === 1, "the unlisted model's turn to be booked");
    expect(ledger(unlisted.id)[0].costUsd).toBeNull();
    expect(ledger(unlisted.id)[0]).not.toHaveProperty("costSource");

    const usage = (await api("GET", "/api/usage?groupBy=bot")).body;
    const byBot = (id: string) => usage.groups.find((g: any) => g.key === `bot:${id}`);
    expect(byBot(listed.id)).toMatchObject({ unpriced: 0 });
    expect(byBot(listed.id).estimatedUsd).toBeCloseTo(row.costUsd, 12);
    expect(byBot(unlisted.id)).toMatchObject({ costUsd: null, estimatedUsd: null, unpriced: 1 });
    await waitFor(async () => (await getBot(unlisted.id)).busy === false, "the bots to go idle");
  }, 40_000);

  it("a queued message leaves the running turn with its starter, and its own turn is booked to its sender", async () => {
    const bot = await newBot("acp", "fixture/unpriced");
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "owner's work" })).status).toBe(202);
    await waitFor(async () => (await getBot(bot.id)).busy === true, "the owner's turn to start");
    const asPaired = await asPerson();
    const queued = await asPaired("POST", `/api/bots/${bot.id}/messages`, { text: "person's follow-up" });
    expect(queued.body.queued).toBe(true);

    await api("POST", `/api/bots/${bot.id}/interrupt`);
    await waitFor(() => ledger(bot.id).length === 1, "the owner's turn to be booked");
    expect(ledger(bot.id)[0].trigger).toEqual(owner);

    await waitFor(async () => (await getBot(bot.id)).messages.some((m: any) => m.text === "person's follow-up"), "the queued turn to start");
    await api("POST", `/api/bots/${bot.id}/interrupt`);
    await waitFor(() => ledger(bot.id).length === 2, "the queued turn to be booked");
    expect(ledger(bot.id)[1].trigger).toEqual(person);
    await waitFor(async () => (await getBot(bot.id)).busy === false, "the bot to go idle");
  }, 40_000);

  it("pressing Steer without native support keeps the queued sender and never re-books the running turn", async () => {
    const bot = await newBot("questions", "fixture/unpriced");
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "owner's turn" })).status).toBe(202);
    await waitFor(async () => (await getBot(bot.id)).messages.some((m: any) => m.card), "the question card");
    const asPaired = await asPerson();
    const queued = await asPaired("POST", `/api/bots/${bot.id}/messages`, { text: "steer these words" });
    expect(queued.body.queued).toBe(true);
    const steered = await asPaired("POST", `/api/bots/${bot.id}/queue/${queued.body.queueId}/steer`, { threadId: bot.threadId });
    expect(steered.body.queued).toBe(true);
    expect(steered.body.steered).toBeUndefined();

    await api("POST", `/api/bots/${bot.id}/interrupt`);
    await waitFor(() => ledger(bot.id).length === 1, "the original turn to be booked");
    expect(ledger(bot.id)[0].trigger).toEqual(owner);
    await waitFor(async () => (await getBot(bot.id)).messages.some((message: { text?: string }) => message.text === "steer these words"), "the paired follow-up to arrive");
    await api("POST", `/api/bots/${bot.id}/interrupt`);
    await waitFor(() => ledger(bot.id).length === 2, "the paired turn to be booked");
    expect(ledger(bot.id)[1].trigger).toEqual(person);
  }, 40_000);

  it("a room's queued message leaves the running room turn with its starter", async () => {
    const bot = await newBot("acp", "fixture/unpriced");
    const room = (await api("POST", "/api/groups", {
      name: "Attribution room",
      memberIds: [bot.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } },
    })).body.group;
    const working = async () => (await api("GET", "/api/bots?messages=30")).body.groups.find((g: any) => g.id === room.id);
    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "owner's room turn" })).status).toBe(202);
    await waitFor(async () => (await working())?.busyBotId === bot.id, "the room turn to start");
    const asPaired = await asPerson();
    expect((await asPaired("POST", `/api/groups/${room.id}/messages`, { text: "person's room follow-up" })).body.queued).toBe(true);

    await api("POST", `/api/groups/${room.id}/interrupt`, {});
    await waitFor(() => ledger(bot.id).length >= 1, "the owner's room turn to be booked");
    expect(ledger(bot.id)[0].trigger).toEqual(owner);
    await waitFor(async () => (await working())?.messages.some((m: any) => m.text === "person's room follow-up"), "the queued room turn to start");
    await waitFor(async () => (await working())?.busyBotId === bot.id, "the queued room turn to run");
    await api("POST", `/api/groups/${room.id}/interrupt`, {});
    await waitFor(() => ledger(bot.id).length >= 2, "the queued room turn to be booked");
    expect(ledger(bot.id)[1].trigger).toEqual(person);
  }, 40_000);

  it("a guarded relay books the turn to the person it names; without one it is this machine's", async () => {
    const health = await api("GET", "/api/health");
    expect(health.body.capabilities.guardedOnBehalfOf).toBe(1);
    const bot = await newBot("acpHappy", "fixture/unpriced");
    const send = async (sendId: string, extra: Record<string, unknown> = {}) => {
      const page = await api("GET", `/api/threads/${bot.threadId}/messages?limit=0`);
      return api("POST", `/api/bots/${bot.id}/messages/guarded`, {
        threadId: bot.threadId, sendId, text: `guarded ${sendId}`, expectedActiveLeafId: page.body.activeLeafId, expectedApprovalMode: "full", ...extra,
      });
    };
    const refused = await send("guarded-send-invalid-0001", { onBehalfOf: {} });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe("onBehalfOf must name the person with an email address, a name, or both");

    expect((await send("guarded-send-relayed-0001", { onBehalfOf: { email: " Ada@Example.test ", name: "Ada Lovelace" } })).status).toBe(202);
    await waitFor(() => ledger(bot.id).length === 1, "the relayed turn to be booked");
    expect(ledger(bot.id)[0].trigger).toEqual({ kind: "user", email: "ada@example.test", label: "Ada Lovelace" });
    await waitFor(async () => (await getBot(bot.id)).busy === false, "the relayed turn to settle");

    expect((await send("guarded-send-owner-00001")).status).toBe(202);
    await waitFor(() => ledger(bot.id).length === 2, "the plain guarded turn to be booked");
    expect(ledger(bot.id)[1].trigger).toEqual(owner);
    await waitFor(async () => (await getBot(bot.id)).busy === false, "the plain guarded turn to settle");

    const member = await asPerson(["client"]);
    const page = await api("GET", `/api/threads/${bot.threadId}/messages?limit=0`);
    const memberTry = await member("POST", `/api/bots/${bot.id}/messages/guarded`, {
      threadId: bot.threadId, sendId: "guarded-send-member-0001", text: "as someone else", expectedActiveLeafId: page.body.activeLeafId,
      onBehalfOf: { email: "boss@example.test" },
    });
    expect(memberTry.status).toBe(403);
    expect(ledger(bot.id)).toHaveLength(2);
  }, 40_000);
});
