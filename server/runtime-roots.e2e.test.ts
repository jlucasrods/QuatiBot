import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

import { launchVerificationServer, runControlQuati, verificationServerArgs, verificationServerEnvironment } from "../scripts/control-quati.ts";
import { waitForExit } from "./testing/cleanup.ts";
import { hostTimeout } from "./testing/host-timeout.ts";
import { ownTurnText } from "./testing/room-handoff-agent.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const RERUN_NOTE = "QuatiBot restarted while your previous turn here was running";
const RERUN_CHIP = "Resuming after a restart";
const SECRET_PROVIDED = "QuatiBot credential update: the user securely provided";
const DECISION = "QuatiBot team setup decision";
const SIGNED_IN = "QuatiBot sign-in update: the person finished signing in to";
const INTERRUPTED_OUTWARD = "Interrupted by an QuatiBot restart after it already";
const SETTLED = "Your downstream room requests have settled.";
const REPORT_FROM_MIRA = "[QuatiBot report from @Mira";

const jsonl = (path: string): any[] => existsSync(path)
  ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];

type Row = Record<string, any>;
interface RuntimeDb {
  assignments: Row[];
  events: Array<{ assignmentId: string; kind: string; detail?: string }>;
}

function readRuntimeDb(dataDir: string): RuntimeDb {
  const path = join(dataDir, "runtime.db");
  if (!existsSync(path)) return { assignments: [], events: [] };
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const assignments = (db.prepare("SELECT json FROM assignments ORDER BY created_at, id").all() as Array<{ json: string }>)
      .map((row) => JSON.parse(row.json) as Row);
    const events = (db.prepare("SELECT assignment_id, kind, detail FROM assignment_events ORDER BY id").all() as Array<{ assignment_id: string; kind: string; detail: string | null }>)
      .map((row) => ({ assignmentId: row.assignment_id, kind: row.kind, ...(row.detail == null ? {} : { detail: row.detail }) }));
    return { assignments, events };
  } finally {
    db.close();
  }
}

const chipText = (message: any): string => [message.tool?.name, message.tool?.output, message.text].filter(Boolean).join("\n");

async function scenario(test: (f: any) => Promise<void>, options: { env?: Record<string, string>; fake?: Record<string, string>; scripted?: boolean } = {}) {
  const parentEnv: NodeJS.ProcessEnv = { ...process.env, ...options.fake };
  const session = await launchVerificationServer(parentEnv, undefined, undefined, undefined, undefined, { scripted: options.scripted !== false });
  const url = session.info.url;
  const dataDir = session.info.dataDir;
  let server: ChildProcess = session.child;
  let restarted = false;
  const restart = async (signal: NodeJS.Signals, extraEnv: Record<string, string> = {}) => {
    await waitForExit(server, { signal });
    const env = { ...verificationServerEnvironment(parentEnv, dataDir, Number(new URL(url).port)), ...extraEnv };
    if (options.scripted !== false) env.FAKE_ACP_ROOM_PLAN = join(dataDir, "room-plan.json");
    const log = openSync(session.info.logPath, "a", 0o600);
    server = spawn(process.execPath, verificationServerArgs(env), { cwd: ROOT, env, stdio: ["ignore", log, log] });
    restarted = true;
    closeSync(log);
    await expect.poll(async () => {
      try { return (await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
    }, { timeout: 30_000 }).toBe(true);
  };
  try {
    // The launcher's environment is hermetic: a loopback backend the server must reach is given on a restart.
    if (options.env) await restart("SIGTERM", options.env);
    const api = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(`${url}${path}`, { method, headers: { "content-type": "application/json", origin: url },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000) });
      const raw = await response.text();
      let parsed: any = raw;
      try { parsed = JSON.parse(raw); } catch {}
      return { status: response.status, body: parsed };
    };
    const cli = (...args: string[]) => runControlQuati([...args, "--url", url]) as Promise<any>;
    const bot = async (name: string, section: string) => (await cli("new-bot", "--name", name, "--section", section)).bot;
    const clive = await bot("Clive", "Leadership");
    const planPath = join(dataDir, "room-plan.json");
    const plan: Record<string, { script: unknown[] }> = { [clive.id]: { script: [] } };
    const script = (botId: string, ...entries: unknown[]) => {
      (plan[botId] ??= { script: [] }).script.push(...entries);
      writeFileSync(planPath, JSON.stringify(plan));
    };
    writeFileSync(planPath, JSON.stringify(plan));

    const say = async (botId: string, threadId: string, text: string) => {
      const sent = await api("POST", `/api/bots/${botId}/messages`, { text, threadId });
      expect(sent.status, JSON.stringify(sent.body)).toBeLessThan(300);
      return sent.body;
    };
    const db = () => readRuntimeDb(dataDir);
    const roots = () => db().assignments.filter((row) => !row.parentId);
    const eventsOf = (id: string) => db().events.filter((event) => event.assignmentId === id).map((event) => event.kind);
    const turns = (botId?: string): any[] => jsonl(`${planPath}.evidence.jsonl`).filter((turn) => !botId || turn.botId === botId);
    const turn = (key: string) => turns().find((candidate) => candidate.planKey === key);
    const own = (record: any): string => ownTurnText(record?.prompt);
    const body = (record: any): string => own(record).replace(/^[\s\S]*?Current time when this message was sent:[^\n]*\n+/, "");
    const messages = async (threadId: string): Promise<any[]> => (await api("GET", `/api/threads/${threadId}/messages?limit=300`)).body.messages ?? [];
    const chips = async (threadId: string, text: string) => (await messages(threadId)).filter((message) => chipText(message).includes(text));
    const said = async (threadId: string, text: string) => (await messages(threadId))
      .filter((message) => message.role === "bot" && message.kind === "text" && String(message.text).includes(text)).length;
    const final = async (threadId: string, text: string, timeout = 30_000) => {
      const ended = () => roots().find((row) => row.status === "failed" || row.status === "cancelled");
      await expect.poll(async () => (await said(threadId, text)) === 1 || ended() !== undefined, { timeout }).toBe(true);
      const root = ended();
      expect(await said(threadId, text), root ? `root ${root.status} (${root.outcome}): ${root.result}` : "").toBe(1);
    };
    const task = async (botId: string, threadId: string) => ((await api("GET", "/api/bots?messages=0")).body.bots as any[])
      .find((candidate) => candidate.id === botId)?.tasks.find((candidate: any) => candidate.threadId === threadId);
    const gate = (name: string) => join(dataDir, `${name}.gate`);
    const open = (name: string) => writeFileSync(gate(name), "open");
    const ready = (name: string) => join(dataDir, `${name}.ready`);
    const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const token = () => {
      const prompt = jsonl(`${session.fixtureDumpPath}.prompts.jsonl`).findLast((row) => row.mcpServers?.some((server: { name: string }) => server.name === "agents"));
      const agents = prompt.mcpServers.find((server: { name: string }) => server.name === "agents");
      return agents.env.find((entry: { name: string }) => entry.name === "QUATI_COMMS_TOKEN").value as string;
    };
    const internal = async (path: string, body: unknown, bearer: string) => {
      const response = await fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
        body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
      return { status: response.status, body: await response.json() as any };
    };
    try {
      await test({ api, cli, clive, dataDir, script, say, db, roots, eventsOf, turns, turn, own, body, messages, chips, said, final, task,
        gate, open, ready, settle, restart, token, internal });
    } catch (error) {
      const summary = {
        turns: turns().map((record) => ({ planKey: record.planKey, unplanned: record.unplanned, threadId: record.threadId, own: own(record).slice(0, 700) })),
        assignments: db().assignments.map(({ id, parentId, status, outcome, outcomeDetail, executions, restarts, restart, result, question, answer, cards, continuation }) =>
          ({ id, parentId, status, outcome, outcomeDetail, executions, restarts, restart, result, question, answer, cards, continuation })),
        events: db().events,
        chat: (await messages(clive.activeTaskId).catch(() => [])).map((message) => ({ role: message.role, kind: message.kind, text: message.text, tool: message.tool?.name })),
      };
      console.error(`runtime roots fixture state:\n${JSON.stringify(summary, null, 1)}`);
      throw error;
    }
    expect(turns().filter((record) => record.unplanned).map((record) => own(record).slice(0, 300))).toEqual([]);
  } finally {
    if (restarted) await waitForExit(server, { signal: "SIGTERM" });
    await session.close();
  }
}

it("T1 records a person's turn as a root that runs and completes", () => scenario(async (f) => {
  const request = "T1-JOB: summarise the week's invoices and tell me the total.";
  f.script(f.clive.id, { key: "C0", match: ["T1-JOB"], readyFile: f.ready("c0"), gateFile: f.gate("c0"), reply: "T1-FINAL: the total is 42." });
  const job = f.clive.activeTaskId;
  await f.say(f.clive.id, job, request);
  await expect.poll(() => existsSync(f.ready("c0")), { timeout: 30_000 }).toBe(true);
  await expect.poll(() => f.roots()[0]?.status, { timeout: 15_000 }).toBe("running");
  const running = f.roots()[0];
  expect(running).toMatchObject({ depth: 0, executions: 1, requester: { kind: "person", threadId: job, botId: f.clive.id },
    origin: { kind: "person", quote: expect.stringContaining("T1-JOB") }, assignee: { botId: f.clive.id, destination: { threadId: job } } });
  expect(running.brief).toContain("T1-JOB");
  expect(f.eventsOf(running.id)).toEqual(expect.arrayContaining(["enqueued", "started"]));
  f.open("c0");
  await f.final(job, "T1-FINAL");
  await expect.poll(() => f.roots()[0]?.status, { timeout: 15_000 }).toBe("completed");
  const root = f.roots()[0];
  expect(root).toMatchObject({ id: running.id, status: "completed", outcome: "done", executions: 1, restarts: 0, result: "T1-FINAL: the total is 42." });
  expect(f.roots()).toHaveLength(1);
  expect(f.eventsOf(root.id)).toEqual(expect.arrayContaining(["enqueued", "started", "settled"]));
  expect(f.turns(f.clive.id).map((record: any) => record.planKey)).toEqual(["C0"]);
}), hostTimeout(60_000));

it("T2 parks the root on a credential card and runs it again with the provided line", () => scenario(async (f) => {
  f.script(f.clive.id,
    { key: "C1", match: [SECRET_PROVIDED], reply: "T2-DONE: the model is set up." },
    { key: "C0", match: ["T2-JOB"], steps: [{ tool: "request_credential", arguments: { credential_id: "openaiImageApiKey", reason: "T2 avatar generation" } }], reply: "T2-ASKED: waiting for the key." });
  const job = f.clive.activeTaskId;
  await f.say(f.clive.id, job, "T2-JOB: set up avatar generation; ask me for the key you need.");
  await f.final(job, "T2-ASKED");
  await expect.poll(() => f.roots()[0]?.status, { timeout: 15_000 }).toBe("needs_input");
  const card = (await f.messages(job)).find((message: any) => message.kind === "secret");
  expect(card).toBeDefined();
  expect(card.secret).toMatchObject({ target: "openaiImageApiKey" });
  expect(card.secret.resumed).toBeUndefined();
  const parked = f.roots()[0];
  expect(parked).toMatchObject({ status: "needs_input", cards: [card.id], executions: 1 });
  expect(parked.question).toMatch(/provide/i);
  expect(f.eventsOf(parked.id)).toContain("parked");
  await f.settle(500);
  expect(f.turns(f.clive.id).map((record: any) => record.planKey)).toEqual(["C0"]);
  expect(await f.task(f.clive.id, job)).toMatchObject({ busy: false, activity: "idle" });
  f.script(f.clive.id, { key: "C-TYPED", match: ["T2-TYPED"], reply: "T2-TYPED-DONE: hello back." });
  await f.say(f.clive.id, job, "T2-TYPED: hello while the card waits.");
  await f.final(job, "T2-TYPED-DONE");
  await expect.poll(() => f.roots().map((row: any) => row.status), { timeout: 15_000 }).toEqual(["needs_input", "completed"]);
  expect(f.roots()[0]).toMatchObject({ id: parked.id, cards: [card.id], executions: 1 });
  expect((await f.api("PUT", "/api/config", { imageGen: { key: "sk-avatar-fixture-key" } })).status).toBe(200);
  const provided = await f.api("POST", `/api/bots/${f.clive.id}/secret-cards/${card.id}/provided`, { threadId: job });
  expect(provided.status, JSON.stringify(provided.body)).toBe(200);
  expect(provided.body).toEqual({ provided: true, resumed: true });
  await f.final(job, "T2-DONE");
  await expect.poll(() => f.roots()[0]?.status, { timeout: 15_000 }).toBe("completed");
  expect(f.roots()).toHaveLength(2);
  expect(f.roots()[0]).toMatchObject({ id: parked.id, status: "completed", outcome: "done", executions: 2, result: "T2-DONE: the model is set up." });
  expect(f.roots()[0].cards).toBeUndefined();
  expect(f.eventsOf(parked.id)).toEqual(expect.arrayContaining(["parked", "answered", "started", "settled"]));
  expect(f.turns(f.clive.id).map((record: any) => record.planKey)).toEqual(["C0", "C-TYPED", "C1"]);
  const answered = f.body(f.turn("C1")).trimStart();
  expect(answered.startsWith(SECRET_PROVIDED), answered.slice(0, 200)).toBe(true);
  expect((await f.messages(job)).find((message: any) => message.id === card.id).secret).toMatchObject({ provided: true, resumed: true });
  const again = await f.api("POST", `/api/bots/${f.clive.id}/secret-cards/${card.id}/provided`, { threadId: job });
  expect(again.status).toBe(200);
  await f.settle(500);
  expect(f.turns(f.clive.id).map((record: any) => record.planKey)).toEqual(["C0", "C-TYPED", "C1"]);
  expect(f.roots()[0].executions).toBe(2);
}), hostTimeout(60_000));

it("T4 parks the root on a team-setup card, runs it again with the decision, and a Stop cancels the park", () => scenario(async (f) => {
  // On Ask, so the setup waits on its review card.
  expect((await f.api("PATCH", `/api/bots/${f.clive.id}`, { chiefOfStaff: true, approvalMode: "ask" })).status).toBe(200);
  const catalog = (await f.api("GET", "/api/instances")).body.instances as any[];
  const opencode = catalog.find((item) => item.instanceId === "opencodeGo");
  const plan = (name: string) => ({ reason: `Set up ${name}`, newTeams: ["Research"], operations: [{ action: "create", key: name, fields: {
    name, title: "Research specialist", soul: "Own research work.", section: "Research", modelSelection: { instanceId: opencode.instanceId, model: opencode.models.options[0].id },
  } }] });
  f.script(f.clive.id,
    { key: "C1", match: [DECISION, '"denied"'], reply: "T4-DONE: understood, no new specialist." },
    { key: "C0", match: ["T4-JOB"], readyFile: f.ready("c0"), gateFile: f.gate("c0"), reply: "T4-ASKED: review the setup." },
    { key: "C2", match: ["T4-AGAIN"], readyFile: f.ready("c2"), gateFile: f.gate("c2"), reply: "T4-ASKED-AGAIN: review the second setup." });
  const job = f.clive.activeTaskId;
  await f.say(f.clive.id, job, "T4-JOB: set up a research specialist for me.");
  await expect.poll(() => existsSync(f.ready("c0")), { timeout: 30_000 }).toBe(true);
  const proposed = await f.internal("/api/internal/team-setup-requests", { plan: plan("Mira") }, f.token());
  expect(proposed.status, JSON.stringify(proposed.body)).toBe(201);
  f.open("c0");
  await f.final(job, "T4-ASKED");
  await expect.poll(() => f.roots()[0]?.status, { timeout: 15_000 }).toBe("needs_input");
  const card = (await f.messages(job)).find((message: any) => message.card?.requestId === proposed.body.requestId);
  expect(f.roots()[0].cards).toEqual([card.id]);
  expect(await f.task(f.clive.id, job)).toMatchObject({ busy: false, activity: "idle" });
  expect(f.roots()[0].question).toContain("team setup decision");
  const decided = await f.api("POST", `/api/threads/${job}/respond`, { requestId: proposed.body.requestId, behavior: "deny" });
  expect(decided.status, JSON.stringify(decided.body)).toBe(200);
  await f.final(job, "T4-DONE");
  await expect.poll(() => f.roots()[0]?.status, { timeout: 15_000 }).toBe("completed");
  expect(f.roots()[0]).toMatchObject({ executions: 2, outcome: "done" });
  expect(f.turns(f.clive.id).map((record: any) => record.planKey)).toEqual(["C0", "C1"]);
  const answered = f.body(f.turn("C1")).trimStart();
  expect(answered.startsWith(`${DECISION} ${proposed.body.requestId}: `), answered.slice(0, 200)).toBe(true);
  expect(answered).toContain('"state":"denied"');
  expect((await f.messages(job)).find((message: any) => message.id === card.id).card.teamSetupRequest).toMatchObject({ resumed: true, result: { state: "denied" } });

  await f.say(f.clive.id, job, "T4-AGAIN: propose another specialist.");
  await expect.poll(() => existsSync(f.ready("c2")), { timeout: 30_000 }).toBe(true);
  const second = await f.internal("/api/internal/team-setup-requests", { plan: plan("Quill") }, f.token());
  expect(second.status, JSON.stringify(second.body)).toBe(201);
  f.open("c2");
  await f.final(job, "T4-ASKED-AGAIN");
  await expect.poll(() => f.roots()[1]?.status, { timeout: 15_000 }).toBe("needs_input");
  expect((await f.api("POST", `/api/bots/${f.clive.id}/interrupt`, { threadId: job })).status).toBe(200);
  await expect.poll(() => f.roots()[1]?.status, { timeout: 15_000 }).toBe("cancelled");
  expect(f.roots()[1]).toMatchObject({ status: "cancelled", outcome: "stopped" });
  const late = await f.api("POST", `/api/threads/${job}/respond`, { requestId: second.body.requestId, behavior: "deny" });
  expect(late.status).toBe(200);
  await f.settle(1_500);
  expect(f.turns(f.clive.id).map((record: any) => record.planKey)).toEqual(["C0", "C1", "C2"]);
  expect(f.roots()[1]).toMatchObject({ status: "cancelled", executions: 1 });
  expect(await f.said(job, "T4-DONE")).toBe(1);
}), hostTimeout(90_000));

it("T5 reruns a person's cut turn once after a restart, with the restart note first and the resuming chip", () => scenario(async (f) => {
  const request = "T5-JOB: migrate the invoices and report.";
  f.script(f.clive.id,
    { key: "C-RERUN", match: ["T5-JOB", RERUN_NOTE], reply: "T5-FINAL: migrated once." },
    { key: "C-CUT", match: ["T5-JOB"], readyFile: f.ready("cut"), gateFile: f.gate("cut"), reply: "never" });
  const job = f.clive.activeTaskId;
  await f.say(f.clive.id, job, request);
  await expect.poll(() => existsSync(f.ready("cut")), { timeout: 30_000 }).toBe(true);
  await expect.poll(() => f.roots()[0]?.status, { timeout: 15_000 }).toBe("running");
  const cut = f.roots()[0];

  await f.restart("SIGTERM");
  f.open("cut");

  await expect.poll(() => f.turns(f.clive.id).map((record: any) => record.planKey).at(-1), { timeout: 30_000 }).toBe("C-RERUN");
  const rerun = f.body(f.turn("C-RERUN")).trimStart();
  expect(rerun.startsWith(RERUN_NOTE), rerun.slice(0, 300)).toBe(true);
  expect(rerun).toContain("Continue the request you were working on");
  expect(rerun).toContain("T5-JOB");
  await f.final(job, "T5-FINAL");
  await expect.poll(() => f.roots()[0]?.status, { timeout: 15_000 }).toBe("completed");
  expect(f.roots()).toHaveLength(1);
  expect(f.roots()[0]).toMatchObject({ id: cut.id, status: "completed", outcome: "done", restarts: 1, executions: 2, result: "T5-FINAL: migrated once." });
  expect(f.eventsOf(cut.id)).toContain("restart_reconciled");
  expect(await f.chips(job, RERUN_CHIP)).toHaveLength(1);
  expect(await f.chips(job, "turn interrupted — QuatiBot restarted")).toHaveLength(0);
  await f.settle(500);
  expect(f.turns(f.clive.id).filter((record: any) => record.planKey === "C-RERUN")).toHaveLength(1);
}), hostTimeout(90_000));

const failedLines = async (f: any, threadId: string) => (await f.messages(threadId))
  .filter((message: any) => message.kind === "activity" && String(message.tool?.name ?? "").startsWith("error:"));

const browserPlace = async (f: any) => {
  expect((await f.api("PATCH", "/api/config", { features: { browser: true } })).status).toBe(200);
  expect((await f.api("PATCH", `/api/bots/${f.clive.id}`, { computer: "browser" })).status).toBe(200);
};

it("T8 Stop while parked on a credential card cancels the root and stops the card; a key provided afterwards is saved but starts nothing", () => scenario(async (f) => {
  f.script(f.clive.id, { key: "C0", match: ["T8-JOB"], steps: [{ tool: "request_credential", arguments: { credential_id: "openaiImageApiKey", reason: "T8 avatar generation" } }], reply: "T8-ASKED: waiting for the key." });
  const job = f.clive.activeTaskId;
  await f.say(f.clive.id, job, "T8-JOB: set up avatar generation; ask me for the key you need.");
  await f.final(job, "T8-ASKED");
  await expect.poll(() => f.roots()[0]?.status, { timeout: 15_000 }).toBe("needs_input");
  const card = (await f.messages(job)).find((message: any) => message.kind === "secret");
  expect(f.roots()[0].cards).toEqual([card.id]);
  expect((await f.api("POST", `/api/bots/${f.clive.id}/interrupt`, { threadId: job })).status).toBe(200);
  await expect.poll(() => f.roots()[0]?.status, { timeout: 15_000 }).toBe("cancelled");
  expect(f.roots()[0]).toMatchObject({ status: "cancelled", outcome: "stopped", executions: 1 });
  const stopped = (await f.messages(job)).find((message: any) => message.id === card.id).secret;
  expect(stopped).toMatchObject({ stopped: true });
  expect(stopped.resumed).toBeUndefined();
  expect(stopped.provided).toBeUndefined();
  expect((await f.api("PUT", "/api/config", { imageGen: { key: "sk-avatar-fixture-key" } })).status).toBe(200);
  const provided = await f.api("POST", `/api/bots/${f.clive.id}/secret-cards/${card.id}/provided`, { threadId: job });
  expect(provided.status, JSON.stringify(provided.body)).toBe(200);
  expect(provided.body).toEqual({ provided: true, resumed: false });
  await f.settle(1_500);
  const after = (await f.messages(job)).find((message: any) => message.id === card.id).secret;
  expect(after).toMatchObject({ provided: true, stopped: true });
  expect(after.resumed).toBeUndefined();
  expect(f.roots()).toHaveLength(1);
  expect(f.roots()[0]).toMatchObject({ status: "cancelled", outcome: "stopped", executions: 1 });
  expect(f.turns(f.clive.id).map((record: any) => record.planKey)).toEqual(["C0"]);
  expect(await failedLines(f, job)).toEqual([]);
  expect(await f.task(f.clive.id, job)).toMatchObject({ busy: false, activity: "idle" });
}), hostTimeout(60_000));

it("T8 Stop while parked on a sign-in card cancels the root and stops the card; Cancel afterwards is saved but starts nothing", () => scenario(async (f) => {
  await browserPlace(f);
  f.script(f.clive.id, { key: "C0", match: ["T8S-JOB"], steps: [{ tool: "request_sign_in", arguments: { site: "https://example.com/dashboard", reason: "The dashboard is behind a login." } }], reply: "T8S-ASKED: sign in to example.com." });
  const job = f.clive.activeTaskId;
  await f.say(f.clive.id, job, "T8S-JOB: check my example.com dashboard.");
  await f.final(job, "T8S-ASKED");
  await expect.poll(() => f.roots()[0]?.status, { timeout: 15_000 }).toBe("needs_input");
  const card = (await f.messages(job)).find((message: any) => message.kind === "signin");
  expect(f.roots()[0]).toMatchObject({ cards: [card.id], question: expect.stringContaining("sign in to example.com") });
  expect((await f.api("POST", `/api/bots/${f.clive.id}/interrupt`, { threadId: job })).status).toBe(200);
  await expect.poll(() => f.roots()[0]?.status, { timeout: 15_000 }).toBe("cancelled");
  const stopped = (await f.messages(job)).find((message: any) => message.id === card.id).signIn;
  expect(stopped).toMatchObject({ stopped: true });
  expect(stopped.resumed).toBeUndefined();
  const cancelled = await f.api("POST", `/api/bots/${f.clive.id}/sign-in-cards/${card.id}/cancel`, { threadId: job });
  expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
  expect(cancelled.body).toEqual({ cancelled: true, resumed: false });
  await f.settle(1_500);
  const after = (await f.messages(job)).find((message: any) => message.id === card.id).signIn;
  expect(after).toMatchObject({ cancelled: true, stopped: true });
  expect(after.resumed).toBeUndefined();
  expect(f.roots()).toHaveLength(1);
  expect(f.roots()[0]).toMatchObject({ status: "cancelled", outcome: "stopped", executions: 1 });
  expect(f.turns(f.clive.id).map((record: any) => record.planKey)).toEqual(["C0"]);
  expect(await failedLines(f, job)).toEqual([]);
}), hostTimeout(60_000));

it("T9 parks the root on a sign-in card and runs it again with the signed-in line on Done", () => scenario(async (f) => {
  await browserPlace(f);
  f.script(f.clive.id,
    { key: "C1", match: [SIGNED_IN, "example.com"], reply: "T9-DONE: the dashboard is open." },
    { key: "C0", match: ["T9-JOB"], steps: [{ tool: "request_sign_in", arguments: { site: "https://example.com/dashboard", reason: "The dashboard is behind a login." } }], reply: "T9-ASKED: sign in to example.com." });
  const job = f.clive.activeTaskId;
  await f.say(f.clive.id, job, "T9-JOB: check my example.com dashboard.");
  await f.final(job, "T9-ASKED");
  await expect.poll(() => f.roots()[0]?.status, { timeout: 15_000 }).toBe("needs_input");
  const card = (await f.messages(job)).find((message: any) => message.kind === "signin");
  const parked = f.roots()[0];
  expect(parked).toMatchObject({ status: "needs_input", cards: [card.id], executions: 1, question: expect.stringContaining("sign in to example.com") });
  expect(card.signIn.resumed).toBeUndefined();
  expect(await f.task(f.clive.id, job)).toMatchObject({ busy: false, activity: "idle" });
  const done = await f.api("POST", `/api/bots/${f.clive.id}/sign-in-cards/${card.id}/done`, { threadId: job });
  expect(done.status, JSON.stringify(done.body)).toBe(200);
  expect(done.body).toEqual({ done: true, resumed: true });
  await f.final(job, "T9-DONE");
  await expect.poll(() => f.roots()[0]?.status, { timeout: 15_000 }).toBe("completed");
  expect(f.roots()).toHaveLength(1);
  expect(f.roots()[0]).toMatchObject({ id: parked.id, status: "completed", outcome: "done", executions: 2, result: "T9-DONE: the dashboard is open." });
  expect(f.eventsOf(parked.id)).toEqual(expect.arrayContaining(["parked", "answered", "started", "settled"]));
  expect(f.turns(f.clive.id).map((record: any) => record.planKey)).toEqual(["C0", "C1"]);
  const answered = f.body(f.turn("C1")).trimStart();
  expect(answered.startsWith(`${SIGNED_IN} example.com.`), answered.slice(0, 200)).toBe(true);
  expect((await f.messages(job)).find((message: any) => message.id === card.id).signIn).toMatchObject({ done: true, resumed: true });
  expect((await f.api("POST", `/api/bots/${f.clive.id}/sign-in-cards/${card.id}/done`, { threadId: job })).body).toEqual({ done: true, resumed: true });
  await f.settle(500);
  expect(f.turns(f.clive.id).map((record: any) => record.planKey)).toEqual(["C0", "C1"]);
}), hostTimeout(60_000));

it("T10 parks a teammate's turn on its credential card, tells the Chief at once, and the key answers the teammate", () => scenario(async (f) => {
  const mira = (await f.cli("new-bot", "--name", "Mira", "--section", "Engineering")).bot;
  expect((await f.api("PATCH", `/api/bots/${f.clive.id}`, { chiefOfStaff: true, managedSections: ["Engineering"], acknowledgePeerScope: true })).status).toBe(200);
  const brief = "T10-BRIEF: set up the Grok model for the export; ask for the key you need.";
  f.script(f.clive.id,
    { key: "C0", match: ["T10-JOB"], steps: [{ arguments: { bot_ids: [mira.id], message: brief } }], reply: "C0: Mira is on it." },
    { key: "C1", match: [SETTLED, REPORT_FROM_MIRA, "T10-RESULT"], reply: "T10-FINAL: the export model is set up." });
  f.script(mira.id,
    { key: "M2", match: ["T10-BRIEF", SECRET_PROVIDED], reply: "T10-RESULT: the key is in and the export runs." },
    { key: "M1", match: ["T10-BRIEF"], steps: [{ tool: "request_credential", arguments: { credential_id: "openaiImageApiKey", reason: "T10 avatar generation" } }], reply: "M1: I asked for the key." });
  const job = f.clive.activeTaskId;
  await f.say(f.clive.id, job, "T10-JOB: have Mira set up the export model and own the result.");
  const children = () => f.db().assignments.filter((row: any) => row.parentId);
  await expect.poll(() => children()[0]?.status, { timeout: 30_000 }).toBe("needs_input");
  const child = children()[0];
  const work = child.assignee.destination.threadId as string;
  const card = (await f.messages(work)).find((message: any) => message.kind === "secret");
  expect(card).toBeDefined();
  expect(child).toMatchObject({ status: "needs_input", cards: [card.id], executions: 1, question: expect.stringContaining("provide") });
  expect(f.eventsOf(child.id)).toContain("parked");
  await expect.poll(async () => (await f.chips(job, "needs your input")).length, { timeout: 15_000 }).toBe(1);
  expect(chipText((await f.chips(job, "needs your input"))[0])).toContain("provide");
  expect(f.turns(f.clive.id).map((record: any) => record.planKey)).toEqual(["C0"]);
  expect(f.roots()[0].status).toBe("waiting");
  expect((await f.task(mira.id, work)).busy).toBe(false);
  expect((await f.api("PUT", "/api/config", { imageGen: { key: "sk-avatar-fixture-key" } })).status).toBe(200);
  const provided = await f.api("POST", `/api/bots/${mira.id}/secret-cards/${card.id}/provided`, { threadId: work });
  expect(provided.status, JSON.stringify(provided.body)).toBe(200);
  expect(provided.body).toEqual({ provided: true, resumed: true });
  await f.final(job, "T10-FINAL", 45_000);
  expect(children()[0]).toMatchObject({ id: child.id, status: "completed", outcome: "done", executions: 2 });
  expect(f.eventsOf(child.id)).toEqual(expect.arrayContaining(["parked", "answered", "started", "settled"]));
  expect(f.turns(mira.id).map((record: any) => record.planKey)).toEqual(["M1", "M2"]);
  expect(f.own(f.turn("M2"))).toContain(SECRET_PROVIDED);
  expect(f.roots()[0]).toMatchObject({ status: "completed", executions: 2 });
  expect((await f.messages(work)).find((message: any) => message.id === card.id).secret).toMatchObject({ provided: true, resumed: true });
  expect(await f.chips(job, "needs your input")).toHaveLength(1);
}), hostTimeout(90_000));

it("T11 does not rerun a cut turn that already pushed: the root ends with what it did, said once", async () => {
  const home = mkdtempSync(join(tmpdir(), "quati-runtime-roots-outward-"));
  const failure = join(home, "failure.json");
  writeFileSync(failure, JSON.stringify({ code: -32603, message: "Fixture turn interrupted" }));
  try {
    await scenario(async (f) => {
      const job = f.clive.activeTaskId;
      await f.say(f.clive.id, job, "T11-JOB: push the release branch.");
      await expect.poll(async () => (await f.messages(job)).some((message: any) => message.kind === "activity" && message.tool?.name === "shell" && message.tool.summary === "git push origin release" && message.tool.ok === true), { timeout: 30_000 }).toBe(true);
      await expect.poll(() => f.roots()[0]?.status, { timeout: 15_000 }).toBe("running");
      const cut = f.roots()[0];
      await f.restart("SIGTERM");
      await expect.poll(() => f.roots()[0]?.status, { timeout: 30_000 }).toBe("failed");
      const root = f.roots()[0];
      expect(root).toMatchObject({ id: cut.id, status: "failed", outcome: "interrupted", executions: 1, restarts: 0 });
      expect(root.outcomeDetail.startsWith(INTERRUPTED_OUTWARD), root.outcomeDetail).toBe(true);
      expect(root.outcomeDetail).toContain("git push");
      expect(f.db().events.find((event: any) => event.assignmentId === root.id && event.kind === "restart_reconciled")?.detail).toBe("failed: outward action done");
      await expect.poll(async () => (await f.chips(job, INTERRUPTED_OUTWARD)).length, { timeout: 15_000 }).toBe(1);
      const line = (await f.chips(job, INTERRUPTED_OUTWARD))[0];
      expect(line.tool.name.startsWith("error: ")).toBe(true);
      expect(line.tool.name).toContain("git push");
      expect(await f.chips(job, RERUN_CHIP)).toHaveLength(0);
      expect(await f.chips(job, "turn interrupted — QuatiBot restarted")).toHaveLength(0);
      await f.settle(1_500);
      expect(f.roots()).toHaveLength(1);
      expect(f.roots()[0]).toMatchObject({ status: "failed", executions: 1 });
      expect(await f.task(f.clive.id, job)).toMatchObject({ busy: false });
      const rows = (await f.messages(job)).filter((message: any) => !["digest", "compaction", "call"].includes(message.kind));
      expect(rows.at(-1).id).toBe(line.id);
    }, { scripted: false, fake: {
      FAKE_ACP_RPC_FAILURE_FILE: failure,
      FAKE_ACP_RPC_FAILURE_GATE: join(home, "finish"),
      FAKE_ACP_RPC_FAILURE_AFTER_OUTPUT: "1",
      FAKE_ACP_TOOL_CALLS: JSON.stringify([{ name: "git push origin release", kind: "execute", input: { command: "git push origin release" }, ok: true }]),
    } });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}, hostTimeout(90_000));
