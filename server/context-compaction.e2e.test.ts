import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlQuati, verificationServerEnvironment } from "../scripts/control-quati.ts";
import { request } from "../scripts/mcp-server.ts";
import { waitForExit } from "./testing/cleanup.ts";

async function fixture(test: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const f = await setup();
  try { await test(f); } finally { await f.close(); }
}

async function setup() {
  const env = { FAKE_ACP_UNIQUE_SESSIONS: "1" };
  const session = await launchVerificationServer(env, undefined, undefined, undefined, undefined, { scripted: true });
  let ready = false;
  try {
    let restarted: ChildProcess | undefined;
    const evidence: unknown[] = [];
    const api = async (path: string, body?: unknown, method = "POST") => {
      const result = await request(path, body === undefined ? {} : { method, body: JSON.stringify(body) }, session.info.url) as any;
      evidence.push({ path, method: body === undefined ? "GET" : method, body, result });
      return result;
    };
    const cli = async (...args: string[]) => {
      const result = await runControlQuati(args, { env: { QUATIBOT_URL: session.info.url } }) as any;
      evidence.push({ command: args, result });
      return result;
    };
    const bot = (await cli("new-bot", "--name", "Context probe")).bot;
    const thread = bot.activeTaskId;
    const plan = join(session.info.dataDir, "room-plan.json");
    writeFileSync(plan, JSON.stringify({ [bot.id]: { reply: "Acknowledged" } }));
    const messages = async () => (await api(`/api/threads/${thread}/messages`)).messages as any[];
    const task = () => JSON.parse(readFileSync(join(session.info.dataDir, "bots.json"), "utf8"))
      .find((b: any) => b.id === bot.id).tasks.find((t: any) => t.threadId === thread);
    const idle = () => expect.poll(async () => (await api("/api/bots?messages=0")).bots
      .find((b: any) => b.id === bot.id).tasks.find((t: any) => t.threadId === thread).busy, { timeout: 15_000 }).toBe(false);
    const send = async (text: string) => {
      await cli("send", "--bot", bot.id, "--task", thread, "--text", text);
      expect((await cli("wait", "--bot", bot.id, "--task", thread, "--timeout", "30")).status).toBe("settled");
    };
    const turns = () => existsSync(`${plan}.evidence.jsonl`) ? readFileSync(`${plan}.evidence.jsonl`, "utf8")
      .trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
    ready = true;
    return { session, api, cli, bot, thread, messages, task, idle, send, turns,
      compact: () => api(`/api/bots/${bot.id}/compact`, { threadId: thread }),
      restart: async () => {
        await waitForExit(restarted ?? session.child, { signal: "SIGTERM" });
        const log = openSync(session.info.logPath, "a", 0o600);
        restarted = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
          cwd: process.cwd(), env: { ...verificationServerEnvironment(env, session.info.dataDir, Number(new URL(session.info.url).port)),
            FAKE_ACP_ROOM_PLAN: plan, FAKE_ACP_DUMP: session.fixtureDumpPath }, stdio: ["ignore", log, log],
        });
        closeSync(log);
        await expect.poll(async () => {
          try { return (await fetch(`${session.info.url}/api/health`, { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
        }, { timeout: 20_000 }).toBe(true);
      },
      close: async () => {
        try {
          if (restarted) await waitForExit(restarted, { signal: "SIGTERM" });
          writeFileSync(`${session.info.logPath}.context.json`, JSON.stringify(evidence, null, 2), { mode: 0o600 });
          console.info(`Context evidence: ${session.info.logPath}.context.json`);
        } finally { await session.close(); }
      },
    };
  } finally { if (!ready) await session.close(); }
}

it("requests native compaction and resumes the same session after restart, preserving history and explicit edits", () => fixture(async f => {
  await f.send("OLDER_REQUEST use port 9000");
  await f.send("CORRECTION use port 9001 instead; cancel the earlier request");
  const before = await f.messages();
  const oldSession = f.task().resumeCursors.opencodeGo;
  expect(oldSession).toBeTruthy();
  const turnsBefore = f.turns().length;
  const sibling = (await f.cli("new-bot", "--name", "Separate context")).bot;
  await expect(f.api(`/api/bots/${sibling.id}/compact`, { threadId: f.thread })).rejects.toThrow(/no such task/);
  await f.compact();
  await f.idle();
  const after = await f.messages();
  for (const message of before) expect(after.find(entry => entry.id === message.id)?.text).toBe(message.text);
  expect(after.filter(message => message.kind === "compaction")).toHaveLength(0);
  expect(f.turns()).toHaveLength(turnsBefore + 1);
  expect(f.turns().at(-1).prompt.message.content).toBe("/compact");
  expect(f.turns().at(-1).sessionId).toBe(oldSession);
  await f.restart();
  await f.send("What port did we settle on?");
  const next = f.turns().at(-1);
  expect(String(next.prompt.message.content)).not.toContain("CORRECTION");
  expect(f.task().resumeCursors.opencodeGo).toBe(oldSession);
  expect(next.sessionId).toBe(f.task().resumeCursors.opencodeGo);
  const compactedSession = f.task().resumeCursors.opencodeGo;
  await f.send("Continue with the corrected port");
  expect(f.task().resumeCursors.opencodeGo).toBe(compactedSession);
  expect(String(f.turns().at(-1).prompt.message.content)).not.toContain("Earlier conversation summary");
  const original = before.find(m => m.text === "OLDER_REQUEST use port 9000");
  await f.cli("edit", "--bot", f.bot.id, "--task", f.thread, "--message", original.id, "--text", "NEW_BRANCH only port 9100");
  await f.idle();
  expect(f.turns().at(-1).sessionId).not.toBe(compactedSession);
  expect(String(f.turns().at(-1).prompt.message.content)).not.toContain("CORRECTION");
  expect((await f.messages()).some(m => m.id === original.id)).toBe(true);
}), 90_000);

it("keeps native context despite a tiny local compaction budget", () => fixture(async f => {
  await f.api("/api/config", { context: { compactAt: 1 } }, "PATCH");
  await f.send("FIRST_EXCHANGE historical request");
  await f.send("SECOND_EXCHANGE keep verbatim");
  await f.send("THIRD_EXCHANGE correction -5 != 5");
  await f.send("INCOMING do not summarize this request");
  const records = (await f.messages()).filter(m => m.kind === "compaction");
  expect(records).toHaveLength(0);
  const prompt = String(f.turns().at(-1).prompt.message.content);
  expect(prompt).not.toContain("SECOND_EXCHANGE keep verbatim");
  expect(prompt).not.toContain("THIRD_EXCHANGE correction -5 != 5");
  expect(prompt).toContain("INCOMING do not summarize this request");
  expect(new Set(f.turns().map(turn => turn.sessionId)).size).toBe(1);
}), 70_000);
