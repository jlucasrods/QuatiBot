import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { launchVerificationServer, runControlQuati } from "../scripts/control-quati.ts";
import { failedTurnCause } from "../shared/failed-turn.ts";
import { lastNonReceipt } from "../src/lib/receipts.ts";
import { openSse } from "./testing/sse.ts";

const CALLS = 12;
const STOPPED = "the same call failed the same way 10 times in a row: “shell: git status” — the turn was stopped";
/** What the command prints, every time. Never in anything the harness writes. */
const OUTPUT = "fatal: not a git repository (or any of the parent directories): .git";

it("leaves repeated failures alone without a stop count and stops them at the configured threshold", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "quati-loop-guard-"));
  const gate = join(scratch, "finish");
  const fixture = await launchVerificationServer({
    FAKE_ACP_MODE: "echo-gated",
    FAKE_ACP_GATE_FILE: gate,
    FAKE_ACP_TOOL_CALLS: JSON.stringify(Array.from({ length: CALLS }, () => ({ name: "shell", kind: "execute", input: { command: "git status" }, ok: false, output: OUTPUT }))),
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
  const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=200`)).messages as any[];
  const stream = await openSse(`${fixture.info.url}/api/events`, { origin: fixture.info.url });
  /** The thread's rows as they were appended, each once. */
  const rows = (threadId: string) => [...new Map(stream.frames
    .filter((frame) => frame.kind === "message" && frame.threadId === threadId && frame.message?.id)
    .map((frame) => [frame.message.id as string, frame.message])).values()];
  const toolRows = (threadId: string) => rows(threadId).filter((row) => row.kind === "activity" && row.tool?.name === "shell");
  const row = (threadId: string, matches: (message: any) => boolean) =>
    stream.until((frame) => frame.kind === "message" && frame.threadId === threadId && matches(frame.message ?? {}), 90_000);
  /** The bot's one turn has ended and the bot is idle again: the idle frame
   * that follows its turn.completed, not one from before it began. */
  const settled = async (bot: { id: string; thread: string }) => {
    const done = await stream.until((frame) => frame.kind === "runtime" && frame.event?.threadId === bot.thread && frame.event.type === "turn.completed", 90_000);
    const at = stream.frames.indexOf(done);
    await stream.until((frame) => frame.kind === "bot" && frame.bot?.id === bot.id && frame.bot.busy === false && stream.frames.indexOf(frame) > at, 90_000);
    return done.event as { ok: boolean; stopReason?: string | null };
  };
  /** A new bot, sent "go", once `calls` of its turn's calls are on the wire. */
  const start = async (name: string, calls = CALLS) => {
    const { bot } = await control(["new-bot", "--name", name]);
    expect((await control(["send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", "go"])).success).toBe(true);
    await stream.until(() => toolRows(bot.activeTaskId).length >= calls, 90_000);
    return { id: bot.id as string, thread: bot.activeTaskId as string };
  };
  const names = (list: any[]) => list.filter((message) => message.kind === "activity").map((message) => message.tool?.name as string);
  const isReply = (message: any) => message.role === "bot" && message.kind === "text" && String(message.text).startsWith("echo:");

  try {
    const quiet = await start("Quiet");
    writeFileSync(gate, "ok");
    const untouched = await row(quiet.thread, isReply);
    expect(untouched.message.text).toMatch(/^echo: [\s\S]*go$/);
    expect(untouched.message.text).not.toContain("steered");
    expect(await settled(quiet)).toMatchObject({ ok: true });
    expect(names(await messages(quiet.thread)).filter((name) => name !== "shell")).toEqual([]);
    rmSync(gate);

    await api("PATCH", "/api/config", { loopGuard: { enabled: true } });
    const told = await start("Told");
    writeFileSync(gate, "ok");
    const reply = await row(told.thread, isReply);
    expect(reply.message.text).toMatch(/^echo: [\s\S]*go$/);
    expect(await settled(told)).toMatchObject({ ok: true });
    const toldRows = await messages(told.thread);
    expect(toldRows.filter((message) => message.role === "user").map((message) => message.text)).toEqual(["go"]);
    expect(JSON.stringify(toldRows)).not.toContain("[QuatiBot: this exact call has failed");
    expect(names(toldRows).filter((name) => name !== "shell")).toEqual([]);
    rmSync(gate);

    await api("PATCH", "/api/config", { loopGuard: { stopAt: 10 } });
    const stopped = await start("Stopped", 10);
    await row(stopped.thread, (message) => message.tool?.name === `error: ${STOPPED}`);
    expect(await settled(stopped)).toMatchObject({ ok: false });
    const stoppedRows = await messages(stopped.thread);
    const failed = stoppedRows.filter((message) => failedTurnCause(message.tool?.name ?? "") !== null);
    expect(failed.map((message) => failedTurnCause(message.tool.name))).toEqual([STOPPED]);
    // what the command printed is in its own rows and nowhere the harness spoke
    expect(names(stoppedRows).filter((name) => name !== "shell").join("\n")).not.toContain("not a git repository");
    // the turn never got to answer, and Retry belongs to the line that says why
    expect(stoppedRows.some(isReply)).toBe(false);
    expect(lastNonReceipt(stoppedRows)?.id).toBe(failed[0].id);
    expect((await api("GET", "/api/bots")).bots.find((bot: any) => bot.id === stopped.id).busy).toBe(false);

    // ── the server's log has one line for each thing the guard did, and
    // never the command ──
    const logged = (thread: string) => readFileSync(fixture.info.logPath, "utf8").split("\n")
      .filter((line) => line.startsWith("[loop-guard] ") && line.includes(`thread=${thread} `));
    expect(logged(quiet.thread)).toEqual([]);
    expect(logged(told.thread)).toEqual([]);
    expect(logged(stopped.thread)).toContain(`[loop-guard] stop sent: thread=${stopped.thread} failures-in-a-row=10`);
    expect(readFileSync(fixture.info.logPath, "utf8").split("\n").filter((line) => line.startsWith("[loop-guard] ")).join("\n")).not.toContain("git status");
  } finally {
    stream.close();
    await fixture.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}, 300_000);
