import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { launchVerificationServer, runControlQuati } from "../scripts/control-quati.ts";
import { openSse } from "./testing/sse.ts";
import { STOPPED_TURN_NAME } from "../shared/client-cancel.ts";
import { roomRetryRequest } from "../src/lib/room-retry.ts";

const CANCELLED = "The request was cancelled by the client.";
const PARTIAL = "hello from fake acp";

it("keeps a client abort a quiet stop and retries the room request it stopped", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "quati-cancelled-acp-"));
  const failure = join(scratch, "failure.json");
  const routes = join(scratch, "routes.json");
  writeFileSync(failure, JSON.stringify({ code: -32603, message: CANCELLED }));
  writeFileSync(routes, JSON.stringify({ "Read the brief.": CANCELLED, "Say hello first.": "Hello." }));
  const fixture = await launchVerificationServer({
    FAKE_ACP_RPC_FAILURE_FILE: failure,
    FAKE_ACP_RPC_FAILURE_AFTER_OUTPUT: "1",
    FAKE_ACP_TEXT_ROUTES: routes,
  }).catch((error) => {
    rmSync(scratch, { recursive: true, force: true });
    throw error;
  });
  const control = (args: string[]) => runControlQuati([...args, "--url", fixture.info.url]) as Promise<any>;
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method, headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json() as any;
    expect(response.ok, JSON.stringify(result)).toBe(true);
    return result;
  };
  const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).messages as any[];
  const stream = await openSse(`${fixture.info.url}/api/events`, { origin: fixture.info.url });
  try {
    const { bot } = await control(["new-bot", "--name", "Stopper"]);
    await api("PATCH", `/api/bots/${bot.id}`, { notifications: true });
    expect((await control(["send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", "Use the tool, then stop."])).success).toBe(true);
    await control(["wait", "--bot", bot.id, "--task", bot.activeTaskId, "--timeout", "30"]);
    const digest = await vi.waitFor(async () => {
      const found = (await messages(bot.activeTaskId)).find((message) => message.kind === "digest");
      if (!found) throw new Error("waiting for the turn digest");
      return found;
    }, { timeout: 10_000, interval: 100 });
    const direct = await messages(bot.activeTaskId);
    expect(direct.filter((message) => message.tool?.name === STOPPED_TURN_NAME), JSON.stringify(direct)).toHaveLength(1);
    expect(direct.some((message) => message.kind === "activity" && /cancelled by the client/i.test(message.tool?.name ?? ""))).toBe(false);
    expect(direct.some((message) => message.kind === "text" && message.text === PARTIAL)).toBe(true);
    expect(direct.some((message) => message.card)).toBe(false);
    expect(JSON.stringify(digest.digest)).not.toContain(PARTIAL);
    const notices = stream.frames.filter((candidate) => candidate.kind === "notify" && candidate.notification?.botId === bot.id);
    expect(notices.map((candidate) => candidate.notification.kind)).toEqual([]);
    const bots = (await api("GET", "/api/bots")).bots as any[];
    expect(bots.flatMap((candidate) => candidate.tasks ?? []).some((task: any) => /incident/i.test(task.title ?? ""))).toBe(false);

    writeFileSync(failure, "null");
    const { group } = await api("POST", "/api/groups", {
      name: "Stop room", memberIds: [bot.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } },
    });
    await control(["send-channel", "--channel", group.id, "--text", "Say hello first."]);
    expect((await control(["wait", "--channel", group.id, "--timeout", "30"])).status).toBe("settled");
    const brief = join(fixture.info.dataDir, "brief.txt");
    writeFileSync(brief, "fixture brief");
    const request = `Read the brief.\n\n<attached-file path="${brief}" name="brief.txt" />`;
    await api("POST", `/api/groups/${group.id}/messages`, { text: request, threadId: group.threadId });
    await control(["wait", "--channel", group.id, "--timeout", "30"]);
    const room = await messages(group.threadId);
    const stoppedIndex = room.findIndex((message) => message.tool?.name === STOPPED_TURN_NAME);
    expect(stoppedIndex).toBeGreaterThan(0);
    expect(room.some((message) => message.kind === "text" && message.text === CANCELLED)).toBe(false);
    const sent = room.find((message) => message.role === "user" && message.text?.includes("Read the brief."));
    const retry = roomRetryRequest(room, stoppedIndex);
    expect(retry).toMatchObject({ messageId: sent.id, mode: "chat" });
    expect(retry!.text).toContain("Read the brief.");
    expect(retry!.text).toContain(`path="${brief}"`);
    expect(retry!.text).not.toContain("Say hello first.");

    const promptFile = `${fixture.fixtureDumpPath}.prompts.jsonl`;
    const before = readFileSync(promptFile, "utf8").trim().split("\n").length;
    await api("POST", `/api/groups/${group.id}/messages`, { text: retry!.text, threadId: group.threadId, mode: retry!.mode });
    await control(["wait", "--channel", group.id, "--timeout", "30"]);
    const prompts = readFileSync(promptFile, "utf8").trim().split("\n").slice(before).map((line) => JSON.parse(line) as {
      prompt: Array<{ text?: string }>;
      mcpServers: Array<{ env?: Array<{ name: string; value: string }> }>;
    });
    const resent = prompts.findLast((row) => row.mcpServers.some((server) => server.env?.some((entry) => entry.name === "QUATI_THREAD_ID" && entry.value === group.threadId)))?.prompt.map((block) => block.text ?? "").join("\n") ?? "";
    expect(resent).toContain("Read the brief.");
    expect(resent).toContain("brief.txt");
  } finally {
    stream.close();
    await fixture.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}, 180_000);
