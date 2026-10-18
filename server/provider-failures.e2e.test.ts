import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { launchVerificationServer, runControlQuati } from "../scripts/control-quati.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const LIMIT = "This provider account has reached its weekly limit, which resets on 22 October 2026 at 00:00 UTC.";

interface NativeTurn {
  prompt: Array<{ text?: string }>;
  mcpServers: Array<{ env?: Array<{ name: string; value: string }> }>;
}

async function launch() {
  const scratch = mkdtempSync(join(tmpdir(), "quati-provider-failure-"));
  const failure = join(scratch, "failure.json");
  const target = join(scratch, "target");
  writeFileSync(failure, JSON.stringify({ code: -32603, message: LIMIT }));
  const fixture = await launchVerificationServer({
    FAKE_ACP_RPC_FAILURE_FILE: failure, FAKE_ACP_FAULT_BOT_FILE: target,
  }, undefined, undefined, undefined, undefined, { scripted: true }).catch(async (error) => {
    await removeTempDir(scratch);
    throw error;
  });
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(fixture.info.url + path, {
      method,
      headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = JSON.parse(await response.text());
    expect(response.ok, `${method} ${path}: ${JSON.stringify(value)}`).toBe(true);
    return value;
  };
  const told = (threadId: string, botId: string) => {
    const turns: NativeTurn[] = readFileSync(`${fixture.fixtureDumpPath}.prompts.jsonl`, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const turn = turns.findLast((entry) => entry.mcpServers.some((server) =>
      server.env?.some((item) => item.name === "QUATI_THREAD_ID" && item.value === threadId)
      && server.env.some((item) => item.name === "QUATI_BOT_ID" && item.value === botId)));
    return turn?.prompt.map((block) => block.text ?? "").join("\n") ?? "";
  };
  const control = async (args: string[]) => {
    return runControlQuati([...args, "--url", fixture.info.url]);
  };
  const close = async () => {
    await fixture.close();
    await removeTempDir(scratch);
  };
  return { fixture, api, told, control, close, target };
}

it("preserves a provider's weekly limit and reset in the failed turn and Chief incident", async () => {
  const f = await launch();
  try {
    const chief = (await f.api("POST", "/api/bots", { name: "Tango", section: "Ops" })).bot;
    await f.api("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: true });
    const pesto = (await f.api("POST", "/api/bots", { name: "Pesto", section: "Ops" })).bot;
    writeFileSync(f.target, pesto.id);
    await f.control(["send", "--bot", pesto.id, "--text", "Draft the launch note."]);
    await f.control(["wait", "--bot", pesto.id, "--timeout", "30"]);
    const thread = (await f.api("GET", `/api/threads/${pesto.threadId}/messages`)).messages;
    const failed = thread.filter((message: { tool?: { ok?: boolean } }) => message.tool?.ok === false);
    expect(failed).toHaveLength(1);
    expect(failed[0].tool.name).toContain(LIMIT);
    expect(failed[0].tool).not.toHaveProperty("setup");
    await expect.poll(async () => {
      const bots = (await f.api("GET", "/api/bots")).bots;
      const incident = bots.find((bot: { id: string }) => bot.id === chief.id)?.tasks.find((task: { title: string }) => task.title === "Team incidents");
      return incident ? f.told(incident.threadId, chief.id) : "";
    }, { timeout: 20_000 }).toContain(LIMIT);
  } finally {
    await f.close();
  }
}, 60_000);

it.each(["direct", "room"])("preserves a teammate's weekly limit and reset in a %s coordinator's continuation", async (surface) => {
  const f = await launch();
  try {
    const chief = (await f.api("POST", "/api/bots", { name: "Tango", section: "Ops" })).bot;
    const pesto = (await f.api("POST", "/api/bots", { name: "Pesto", section: "Ops" })).bot;
    writeFileSync(f.target, pesto.id);
    writeFileSync(join(f.fixture.info.dataDir, "room-plan.json"), JSON.stringify({ [chief.id]: {
      steps: [{ arguments: { bot_ids: [pesto.id], message: "Draft the launch note.", request_key: "launch-note" } }],
      reply: "Assigned.", resumeReply: "The provider limit prevented completion.",
    } }));
    let threadId = chief.threadId;
    if (surface === "room") {
      const { group } = await f.api("POST", "/api/groups", {
        name: "Launch", memberIds: [chief.id, pesto.id],
        setup: { bulletin: "", defaultResponder: { kind: "member", botId: chief.id } },
      });
      threadId = group.threadId;
      await f.api("POST", `/api/groups/${group.id}/messages`, { text: "Have Pesto draft the launch note." });
    } else {
      await f.control(["send", "--bot", chief.id, "--text", "Have Pesto draft the launch note."]);
    }
    await expect.poll(() => f.told(threadId, chief.id), { timeout: 20_000 }).toContain(LIMIT);
    expect(f.told(threadId, chief.id)).toContain(surface === "room" ? "[Report from @Pesto" : "[QuatiBot report from @Pesto on assignment");
    expect(f.told(threadId, chief.id)).toContain("failed");
  } finally {
    await f.close();
  }
}, 60_000);
