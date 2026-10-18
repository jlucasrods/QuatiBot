import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LIVE_COPY } from "../shared/live-approval.ts";
import { verificationServerEnvironment } from "../scripts/control-quati.ts";

import type { LiveCallState } from "../shared/wire.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { startFakeOpenAiLive, type FakeOpenAiLive } from "./testing/fake-openai-live.ts";
import { freePortBlock } from "./testing/ports.ts";
import { openSse } from "./testing/sse.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_ACP = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const LIVE_KEY = "sk-fake-e2e";
const SDP = "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n";
const posixOnly = describe.skipIf(process.platform !== "linux");

posixOnly("Live call e2e", () => {
  let child: ChildProcess;
  let home = "";
  let base = "";
  let output = "";
  let live: FakeOpenAiLive;

  const serverOutput = () => output;
  const post = async (path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: unknown }> => {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  const createBot = async (instanceId = "opencodeGo", model = "fixture/default"): Promise<{ id: string; threadId: string; name: string }> => {
    const { bot } = (await post("/api/bots", {})).body as { bot: { id: string; threadId: string; name: string } };
    const res = await fetch(`${base}/api/bots/${bot.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      // On Ask: the calls read cards aloud, and the Slack-style relay expects Ask.
      body: JSON.stringify({ modelSelection: { instanceId, model }, approvalMode: "ask" }),
    });
    expect(res.status).toBe(200);
    return bot;
  };
  const isBusy = async (botId: string): Promise<boolean> => {
    const { bots } = (await (await fetch(`${base}/api/bots`)).json()) as { bots: Array<{ id: string; busy?: boolean }> };
    return bots.find((bot) => bot.id === botId)?.busy === true;
  };
  const spokenTurnsLogged = () => serverOutput().split("text=(spoken)").length - 1;
  const startCall = async (botId: string, client: LiveCallState["client"] = "desktop") => {
    const before = live.sessions.length;
    const started = await post("/api/live/session", { botId, sdp: SDP, client });
    expect(started.status).toBe(201);
    const { call } = started.body as { call: LiveCallState };
    const session = live.sessions[before];
    expect(session).toBeDefined();
    return { started, call, session };
  };
  const setGeneratedTitles = async (on: boolean) => {
    const res = await fetch(`${base}/api/config`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ features: { llmThreadTitles: on } }),
    });
    expect(res.status).toBe(200);
  };

  beforeAll(async () => {
    live = await startFakeOpenAiLive();
    home = mkdtempSync(join(tmpdir(), "quati-live-call-"));
    mkdirSync(join(home, ".quatibot"), { recursive: true });
    const routes = join(home, "replies.json");
    writeFileSync(routes, JSON.stringify({ "what is six times seven": "Six times seven is 42." }));
    const instances = Object.fromEntries(Object.entries({ opencodeGo: "echo-gated", acp: "hang", asks: "permission", questions: "question" }).map(([id, mode]) => {
      const cli = join(home, `${id}-opencode.mjs`);
      writeFileSync(cli, [
        "#!/usr/bin/env node",
        `process.env.FAKE_ACP_MODE = ${JSON.stringify(mode)};`,
        ...(id === "opencodeGo" ? [`process.env.FAKE_ACP_TEXT_ROUTES = ${JSON.stringify(routes)};`] : []),
        `await import(${JSON.stringify(pathToFileURL(FAKE_ACP).href)});`,
      ].join("\n"), { mode: 0o700 });
      return [id, { driver: "opencodeGo", displayName: id, config: { cli } }];
    }));
    const discovery = join(home, ".quatibot", "providers", "opencode", "discovery");
    mkdirSync(discovery, { recursive: true });
    writeFileSync(join(discovery, ".quati-project"), "fixture");
    writeFileSync(
      join(home, ".quatibot", "config.json"),
      JSON.stringify({
        instances,
        defaultModelSelection: { instanceId: "opencodeGo", model: "fixture/default" },
      }),
    );
    const port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: {
        ...verificationServerEnvironment({}, join(home, ".quatibot"), port),
        HOME: home,
        FAKE_ACP_VERSION: "2.0.31",
        FAKE_ACP_AGENT_VERSION: "2.0.31",
        FAKE_ACP_AGENT_NAME: "OpenCode",
        FAKE_ACP_MODELS: "fixture/default",
        QUATI_OPENAI_LIVE_URL: live.url,
        QUATI_OPENAI_LIVE_KEY: LIVE_KEY,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.on("data", (chunk) => (output += chunk));
    child.stderr!.on("data", (chunk) => (output += chunk));
    // Generous: a loaded machine can take most of a minute to boot the harness.
    const deadline = Date.now() + 90_000;
    for (;;) {
      try {
        if ((await fetch(`${base}/api/health`)).ok) {
          const response = await fetch(`${base}/api/instances`);
          const snapshot = JSON.parse(await response.text());
          if (Object.keys(instances).every((id) => snapshot.instances.find((instance: { instanceId: string }) => instance.instanceId === id)?.models.options.some((option: { id: string }) => option.id === "fixture/default"))) break;
        }
      } catch {
      }
      if (Date.now() > deadline) throw new Error(`server never came up. output:\n${output}`);
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. output:\n${output}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  }, 120_000);

  afterAll(async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await live?.stop();
    if (home) await removeTempDir(home);
  });

  it("runs a spoken request through the bot and speaks the answer", async () => {
    const bot = await createBot();
    const sse = await openSse(`${base}/api/events`);
    try {
      const { started, call, session } = await startCall(bot.id);
      expect(JSON.stringify(started.body)).not.toContain(LIVE_KEY);
      expect(call).toMatchObject({ botId: bot.id, threadId: bot.threadId, client: "desktop" });
      expect(session.body).toMatchObject({ session: { client: { data_channel: { allowed_client_events: ["session.close"] } } } });
      expect((session.body.session as { instructions: string }).instructions).toContain("runs in QuatiBot on the user's own computer.");
      await live.waitForAttach(session.id);
      await sse.until((frame) => frame.kind === "live.call" && frame.call?.callId === call.callId && frame.call?.status === "live");

      live.emit(session.id, { type: "session.input_transcript.delta", delta: "what is six times seven", start_ms: 100, end_ms: 900 });
      live.emit(session.id, { type: "session.delegation.created", offset_ms: 950, delegation: { id: "del_1", target: "client", type: "delegation" } });

      const asked = await sse.until(
        (frame) => frame.kind === "message" && frame.threadId === bot.threadId && frame.message?.role === "user" && frame.message?.via === "call",
      );
      expect(asked.message.text).toBe("what is six times seven");
      expect(asked.message.callId).toBe(call.callId);
      const spoken = await live.waitForCommand(session.id, (c) => c.type === "session.commentary.append" && String(c.content).includes("42"), 20_000);
      expect(spoken.delegation_id).toBe("del_1");

      const ended = await post("/api/live/call/end", { callId: call.callId });
      expect(ended).toMatchObject({ status: 200, body: { call: { status: "ended", endReason: "hung-up" } } });
      expect(session.commands.some((c) => c.type === "session.close")).toBe(true);
      await sse.until((frame) => frame.kind === "live.call" && frame.call?.callId === call.callId && frame.call?.status === "ended");
      const row = await sse.until((frame) => frame.kind === "message" && frame.threadId === bot.threadId && frame.message?.kind === "call");
      expect(row.message).toMatchObject({
        role: "bot",
        text: `Call with ${bot.name} · 0:42`,
        call: { callId: call.callId, botId: bot.id, client: "desktop", startedAt: call.startedAt, seconds: 42, endReason: "hung-up" },
      });
      expect(row.message.call.endedAt).toBeGreaterThanOrEqual(call.startedAt);
      expect(JSON.stringify(row.message)).not.toMatch(/six times seven/i);
      const { messages } = (await (await fetch(`${base}/api/threads/${bot.threadId}/messages`)).json()) as { messages: Array<{ kind: string; call?: { callId: string } }> };
      expect(messages.filter((message) => message.kind === "call" && message.call?.callId === call.callId)).toHaveLength(1);
      // The pipe can deliver the summary line a moment after the HTTP answer.
      await expect.poll(serverOutput, { timeout: 5_000 }).toMatch(/\[live\] call ended bot=\S+ .*client=desktop .*end=hung-up/);
      expect(serverOutput()).toContain("text=(spoken)");
      expect(serverOutput()).not.toMatch(/six times seven/i);
      expect(serverOutput()).not.toContain(LIVE_KEY);
      expect(JSON.stringify(sse.frames)).not.toContain(LIVE_KEY);
    } finally {
      sse.close();
    }
  }, 40_000);

  it("answers 409 with the running call to a second client", async () => {
    const bot = await createBot();
    const { call, session } = await startCall(bot.id, "web");
    await live.waitForAttach(session.id);

    const second = await post("/api/live/session", { botId: bot.id, sdp: SDP, client: "ios" });
    expect(second.status).toBe(409);
    expect((second.body as { activeCall: LiveCallState }).activeCall).toMatchObject({ callId: call.callId, client: "web" });
    expect(live.sessions.at(-1)).toBe(session);

    const ended = await post("/api/live/call/end", { callId: call.callId });
    expect(ended).toMatchObject({ status: 200, body: { call: { callId: call.callId, status: "ended" } } });
  }, 40_000);

  it("queues a spoken request while the bot is busy, and the drained turn still keeps the words out of the log", async () => {
    const bot = await createBot("acp");
    const sse = await openSse(`${base}/api/events`);
    try {
      expect((await post(`/api/bots/${bot.id}/messages`, { text: "first" })).status).toBe(202);
      await expect.poll(() => isBusy(bot.id), { timeout: 20_000 }).toBe(true);
      const { call, session } = await startCall(bot.id);
      await live.waitForAttach(session.id);

      live.emit(session.id, { type: "session.input_transcript.delta", delta: "spell the word banana", start_ms: 100, end_ms: 900 });
      live.emit(session.id, { type: "session.delegation.created", offset_ms: 950, delegation: { id: "del_q", target: "client", type: "delegation" } });
      await sse.until(
        (frame) => frame.kind === "bot.queued" && (frame.queues?.[bot.threadId] ?? []).some((item: { text?: string }) => item.text === "spell the word banana"),
        20_000,
      );

      const logged = spokenTurnsLogged();
      await post(`/api/bots/${bot.id}/interrupt`, {});
      const drained = await sse.until(
        (frame) => frame.kind === "message" && frame.threadId === bot.threadId && frame.message?.text === "spell the word banana",
        20_000,
      );
      expect(drained.message).toMatchObject({ role: "user", via: "call", callId: call.callId });
      await expect.poll(spokenTurnsLogged, { timeout: 10_000 }).toBeGreaterThan(logged);
      expect(serverOutput()).not.toMatch(/banana/i);

      await post(`/api/bots/${bot.id}/interrupt`, {});
      await expect.poll(() => isBusy(bot.id), { timeout: 20_000 }).toBe(false);
      expect(await post("/api/live/call/end", { callId: call.callId })).toMatchObject({ status: 200 });
    } finally {
      sse.close();
    }
  }, 60_000);

  it("stops waiting for a queued spoken request once it is cancelled in the chat", async () => {
    const bot = await createBot("acp");
    const sse = await openSse(`${base}/api/events`);
    try {
      const { call, session } = await startCall(bot.id);
      await live.waitForAttach(session.id);
      live.emit(session.id, { type: "session.input_transcript.delta", delta: "check the build", start_ms: 100, end_ms: 900 });
      live.emit(session.id, { type: "session.delegation.created", offset_ms: 950, delegation: { id: "del_a", target: "client", type: "delegation" } });
      await expect.poll(() => isBusy(bot.id), { timeout: 20_000 }).toBe(true);
      live.emit(session.id, { type: "session.input_transcript.delta", delta: "and the tests", start_ms: 2_000, end_ms: 2_800 });
      live.emit(session.id, { type: "session.delegation.created", offset_ms: 2_850, delegation: { id: "del_b", target: "client", type: "delegation" } });
      const waiting = await sse.until(
        (frame) => frame.kind === "bot.queued" && (frame.queues?.[bot.threadId] ?? []).some((item: { text?: string }) => item.text === "and the tests"),
        20_000,
      );
      const { queueId } = (waiting.queues[bot.threadId] as Array<{ queueId: string; text: string }>).find((item) => item.text === "and the tests")!;

      const cancelled = await fetch(`${base}/api/bots/${bot.id}/queue/${queueId}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ threadId: bot.threadId }),
      });
      expect(cancelled.status).toBe(200);
      await post(`/api/bots/${bot.id}/interrupt`, {});
      await live.waitForCommand(session.id, (c) => c.type === "session.commentary.append" && c.content === LIVE_COPY.noAnswer, 20_000);
      expect(await post("/api/live/call/end", { callId: call.callId })).toMatchObject({ status: 200 });
    } finally {
      sse.close();
    }
  }, 60_000);

  it("never reads back a line a worker relayed into the call's chat as the caller's own", async () => {
    const bot = await createBot();
    const { call, session } = await startCall(bot.id);
    type Line = { id: string; role: string; text?: string; relayed?: boolean; requestMessageId?: string; turnTerminal?: boolean };
    const lines = async () => ((await (await fetch(`${base}/api/threads/${bot.threadId}/messages`)).json()) as { messages: Line[] }).messages;
    try {
      await live.waitForAttach(session.id);
      const page = (await (await fetch(`${base}/api/threads/${bot.threadId}/messages?limit=0`)).json()) as { activeLeafId?: string | null };
      const relayed = await post(`/api/bots/${bot.id}/messages/guarded`, {
        threadId: bot.threadId, sendId: "slackjob_live_call_relay_1", text: "relayed from Slack",
        expectedActiveLeafId: page.activeLeafId ?? null, onBehalfOf: { email: "ada@example.test", name: "Ada" },
      });
      expect(relayed.status, JSON.stringify(relayed.body)).toBe(202);
      const relayedId = (relayed.body as { message: { id: string } }).message.id;
      await expect.poll(async () => (await lines()).some((m) => m.requestMessageId === relayedId && m.turnTerminal), { timeout: 20_000 }).toBe(true);
      await expect.poll(() => isBusy(bot.id), { timeout: 20_000 }).toBe(false);

      expect((await post(`/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "typed on the desktop", sendId: "typed-live-call-e2e-0001" })).status).toBe(202);
      await live.waitForCommand(session.id, (c) => c.type === "session.commentary.append" && String(c.content).includes("typed on the desktop"), 20_000);
      const said = session.commands.filter((c) => c.type === "session.commentary.append").map((c) => String(c.content));
      expect(said).toHaveLength(1);
      expect(said[0]).not.toContain("relayed from Slack");

      const stored = await lines();
      expect(stored.find((m) => m.id === relayedId)).toMatchObject({ role: "user", relayed: true });
      expect(stored.find((m) => m.text === "typed on the desktop")?.relayed).toBeUndefined();
    } finally {
      await post("/api/live/call/end", { callId: call.callId });
    }
  }, 60_000);

  it("approves a card by voice and marks it as decided on the call", async () => {
    const bot = await createBot("asks");
    const { call, session } = await startCall(bot.id);
    try {
      await live.waitForAttach(session.id);
      live.emit(session.id, { type: "session.input_transcript.delta", delta: "run the check", start_ms: 100, end_ms: 900 });
      live.emit(session.id, { type: "session.delegation.created", offset_ms: 950, delegation: { id: "del_p", target: "client", type: "delegation" } });
      await live.waitForCommand(session.id, (c) => c.type === "session.instructions.append" && String(c.content).includes("May I?"), 20_000);
      live.emit(session.id, { type: "session.input_transcript.delta", delta: "yes", start_ms: 5_000, end_ms: 5_300 });
      live.emit(session.id, { type: "session.delegation.created", offset_ms: 5_400, delegation: { id: "del_y", target: "client", type: "delegation" } });
      type Card = { requestId?: string; answered?: string; answeredBy?: unknown };
      const approved = async () => {
        const { messages } = (await (await fetch(`${base}/api/threads/${bot.threadId}/messages`)).json()) as { messages: Array<{ card?: Card }> };
        return messages.find((m) => m.card?.requestId && m.card.answered === "allow")?.card;
      };
      await expect.poll(approved, { timeout: 20_000 }).toMatchObject({ answeredBy: { kind: "loopback", via: "call" } });
      const requestId = (await approved())!.requestId;
      const decision = async () => ((await (await fetch(`${base}/api/decisions`)).json()) as { decisions: Array<{ requestId?: string; decision: string; via?: string }> })
        .decisions.find((row) => row.requestId === requestId && row.decision === "user-approved");
      await expect.poll(decision, { timeout: 10_000 }).toMatchObject({ via: "call" });
    } finally {
      await post("/api/live/call/end", { callId: call.callId });
    }
  }, 60_000);

  it("reports a rejected question answer honestly and can retry it after the provider settles", async () => {
    const bot = await createBot("questions");
    const { call, session } = await startCall(bot.id);
    try {
      await live.waitForAttach(session.id);
      live.emit(session.id, { type: "session.input_transcript.delta", delta: "ask me which color", start_ms: 100, end_ms: 900 });
      live.emit(session.id, { type: "session.delegation.created", offset_ms: 950, delegation: { id: "del_question", target: "client" } });
      await live.waitForCommand(session.id, (c) => c.type === "session.instructions.append" && String(c.content).includes("Which color"), 20_000);
      type Line = { id: string; role: string; replyToId?: string; via?: string; callId?: string; card?: { requestId?: string; answered?: string; answeredText?: string; answeredBy?: unknown } };
      const lines = async (): Promise<Line[]> => ((await (await fetch(`${base}/api/threads/${bot.threadId}/messages`)).json()) as { messages: Line[] }).messages;
      const original = (await lines()).find((m) => m.card?.requestId)!;
      live.emit(session.id, { type: "session.input_transcript.delta", delta: "Purple", start_ms: 5_000, end_ms: 5_300 });
      live.emit(session.id, { type: "session.delegation.created", offset_ms: 5_400, delegation: { id: "del_rejected", target: "client" } });
      await live.waitForCommand(session.id, (c) => c.type === "session.commentary.append" && String(c.content).includes("could not be saved"), 5_000);
      expect((await lines()).find((m) => m.id === original.id)?.card).not.toHaveProperty("answeredText");
      expect(session.commands.some((c) => c.type === "session.thinking.append" && c.content === LIVE_COPY.answerPassed)).toBe(false);
      await expect.poll(() => isBusy(bot.id), { timeout: 5_000 }).toBe(false);

      live.emit(session.id, { type: "session.input_transcript.delta", delta: "Blue", start_ms: 8_000, end_ms: 8_300 });
      live.emit(session.id, { type: "session.delegation.created", offset_ms: 8_400, delegation: { id: "del_retry", target: "client" } });
      await expect.poll(async () => (await lines()).find((m) => m.id === original.id)?.card, { timeout: 10_000 }).toMatchObject({ answered: "answer", answeredText: "Blue", answeredBy: { kind: "loopback", via: "call" } });
      expect((await lines()).find((m) => m.role === "user" && m.replyToId === original.id)).toMatchObject({ via: "call", callId: call.callId });
      expect(serverOutput()).not.toContain("text=Blue");
    } finally {
      await post("/api/bots/" + bot.id + "/interrupt", { threadId: bot.threadId });
      await post("/api/live/call/end", { callId: call.callId });
    }
  }, 40_000);

  it("delivers a spoken answer to a persistent question after its turn is stopped", async () => {
    const bot = await createBot("questions");
    const { call, session } = await startCall(bot.id);
    try {
      await live.waitForAttach(session.id);
      live.emit(session.id, { type: "session.input_transcript.delta", delta: "ask me which color", start_ms: 100, end_ms: 900 });
      live.emit(session.id, { type: "session.delegation.created", offset_ms: 950, delegation: { id: "del_stopped_question", target: "client" } });
      await live.waitForCommand(session.id, (c) => c.type === "session.instructions.append" && String(c.content).includes("Which color"), 20_000);
      type Line = { id: string; role: string; replyToId?: string; via?: string; callId?: string; card?: { requestId?: string; answered?: string; answeredText?: string; answeredBy?: unknown } };
      const lines = async (): Promise<Line[]> => ((await (await fetch(`${base}/api/threads/${bot.threadId}/messages`)).json()) as { messages: Line[] }).messages;
      const original = (await lines()).find((m) => m.card?.requestId)!;
      expect((await post(`/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId })).status).toBe(200);
      await expect.poll(() => isBusy(bot.id), { timeout: 5_000 }).toBe(false);
      live.emit(session.id, { type: "session.input_transcript.delta", delta: "Green", start_ms: 5_000, end_ms: 5_300 });
      live.emit(session.id, { type: "session.delegation.created", offset_ms: 5_400, delegation: { id: "del_late", target: "client" } });
      await expect.poll(async () => (await lines()).find((m) => m.id === original.id)?.card, { timeout: 5_000 }).toMatchObject({ answered: "answer", answeredText: "Green", answeredBy: { kind: "loopback", via: "call" } });
      expect((await lines()).find((m) => m.role === "user" && m.replyToId === original.id)).toMatchObject({ via: "call", callId: call.callId });
      expect(serverOutput()).not.toContain("text=Green");
    } finally {
      await post(`/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId });
      await post("/api/live/call/end", { callId: call.callId });
    }
  }, 40_000);

  it("ends the call and tells clients when the sideband drops", async () => {
    const bot = await createBot();
    const sse = await openSse(`${base}/api/events`);
    try {
      const { call, session } = await startCall(bot.id);
      await live.waitForAttach(session.id);
      await sse.until((frame) => frame.kind === "live.call" && frame.call?.callId === call.callId && frame.call?.status === "live");

      live.dropSideband(session.id);

      const ended = await sse.until(
        (frame) => frame.kind === "live.call" && frame.call?.callId === call.callId && frame.call?.status === "ended",
      );
      expect(ended).toMatchObject({ botId: bot.id, threadId: bot.threadId, call: { endReason: "sideband-lost" } });
      const row = await sse.until((frame) => frame.kind === "message" && frame.threadId === bot.threadId && frame.message?.kind === "call");
      expect(row.message.call).toMatchObject({ callId: call.callId, endReason: "sideband-lost" });
      const current = await (await fetch(`${base}/api/live/call`)).json();
      expect(current).toEqual({ call: null });
      await expect.poll(serverOutput, { timeout: 5_000 }).toContain("end=sideband-lost");
    } finally {
      sse.close();
    }
  }, 40_000);

  it("leaves no row for a call that never went live", async () => {
    const bot = await createBot();
    const sse = await openSse(`${base}/api/events`);
    let callId = "";
    try {
      // 404, not 401: Node's WebSocket retries a refused 401 upgrade, and the retry is accepted.
      live.refuseNextAttach(404);
      const { call } = await startCall(bot.id);
      callId = call.callId;
      await sse.until((frame) => frame.kind === "live.call" && frame.call?.callId === call.callId && frame.call?.status === "ended", 20_000);
      expect(sse.frames.some((frame) => frame.kind === "live.call" && frame.call?.callId === call.callId && frame.call?.status === "live")).toBe(false);
      const { messages } = (await (await fetch(`${base}/api/threads/${bot.threadId}/messages`)).json()) as { messages: Array<{ kind: string }> };
      expect(messages.some((message) => message.kind === "call")).toBe(false);
    } finally {
      if (callId) await post("/api/live/call/end", { callId });
      await expect.poll(() => isBusy(bot.id), { timeout: 20_000 }).toBe(false);
      sse.close();
    }
  }, 40_000);

  // The first call's missing title is checked only after the second's title arrives: an event, not a clock.
  it("keeps truthful call labels when OpenCode has no background title generator", async () => {
    const quiet = await createBot();
    const named = await createBot();
    const sse = await openSse(`${base}/api/events`);
    let callId = "";
    const askAndHangUp = async (bot: { id: string; threadId: string }) => {
      const { call, session } = await startCall(bot.id);
      callId = call.callId;
      await live.waitForAttach(session.id);
      live.emit(session.id, { type: "session.input_transcript.delta", delta: "what is six times seven", start_ms: 100, end_ms: 900 });
      live.emit(session.id, { type: "session.delegation.created", offset_ms: 950, delegation: { id: `del_${bot.id}`, target: "client", type: "delegation" } });
      await live.waitForCommand(session.id, (c) => c.type === "session.commentary.append" && String(c.content).includes("42"), 20_000);
      expect(await post("/api/live/call/end", { callId })).toMatchObject({ status: 200 });
      return sse.until((frame) => frame.kind === "message" && frame.threadId === bot.threadId && frame.message?.kind === "call", 10_000);
    };
    try {
      const first = await askAndHangUp(quiet);
      expect(first.message.call.title).toBeUndefined();

      await setGeneratedTitles(true);
      const second = await askAndHangUp(named);
      expect(second.message.call.title).toBeUndefined();
      const saved = (await (await fetch(`${base}/api/threads/${named.threadId}/messages`)).json()) as { messages: Array<{ id: string; text: string; call?: { title?: string } }> };
      expect(saved.messages.find((message) => message.id === second.message.id)).toMatchObject({ text: second.message.text });
      expect(saved.messages.find((message) => message.id === second.message.id)?.call?.title).toBeUndefined();

      const { messages } = (await (await fetch(`${base}/api/threads/${quiet.threadId}/messages`)).json()) as { messages: Array<{ id: string; call?: { title?: string } }> };
      expect(messages.find((message) => message.id === first.message.id)?.call?.title).toBeUndefined();
      expect(sse.frames.some((frame) => frame.kind === "message.patch" && frame.message?.id === first.message.id)).toBe(false);
    } finally {
      await setGeneratedTitles(false);
      if (callId) await post("/api/live/call/end", { callId });
      for (const bot of [quiet, named]) await expect.poll(() => isBusy(bot.id), { timeout: 20_000 }).toBe(false);
      sse.close();
    }
  }, 90_000);

  it("keeps a finished call's row out of the next call's voice history", async () => {
    const bot = await createBot();
    const first = await startCall(bot.id);
    try {
      await live.waitForAttach(first.session.id);
      live.emit(first.session.id, { type: "session.input_transcript.delta", delta: "what is six times seven", start_ms: 100, end_ms: 900 });
      live.emit(first.session.id, { type: "session.delegation.created", offset_ms: 950, delegation: { id: "del_history", target: "client", type: "delegation" } });
      await live.waitForCommand(first.session.id, (c) => c.type === "session.commentary.append" && String(c.content).includes("42"), 20_000);
      await expect.poll(() => isBusy(bot.id), { timeout: 20_000 }).toBe(false);
    } finally {
      await post("/api/live/call/end", { callId: first.call.callId });
      await expect.poll(() => isBusy(bot.id), { timeout: 20_000 }).toBe(false);
    }
    const lines = async () => ((await (await fetch(`${base}/api/threads/${bot.threadId}/messages`)).json()) as { messages: Array<{ kind: string }> }).messages;
    await expect.poll(async () => (await lines()).some((message) => message.kind === "call"), { timeout: 10_000 }).toBe(true);

    const second = await startCall(bot.id);
    try {
      const history = JSON.stringify((second.session.body.session as { input?: unknown }).input ?? []);
      expect(history).toContain("what is six times seven");
      expect(history).not.toContain("Call with");
    } finally {
      await post("/api/live/call/end", { callId: second.call.callId });
      await expect.poll(() => isBusy(bot.id), { timeout: 20_000 }).toBe(false);
    }
  }, 60_000);

  it("leaves no row, and no error, for a call whose bot is deleted during it", async () => {
    const bot = await createBot();
    const sse = await openSse(`${base}/api/events`);
    let callId = "";
    try {
      const { call, session } = await startCall(bot.id);
      callId = call.callId;
      await live.waitForAttach(session.id);
      await sse.until((frame) => frame.kind === "live.call" && frame.call?.callId === call.callId && frame.call?.status === "live");
      expect((await fetch(`${base}/api/bots/${bot.id}`, { method: "DELETE" })).status).toBeLessThan(300);
      const ended = await sse.until((frame) => frame.kind === "live.call" && frame.call?.callId === call.callId && frame.call?.status === "ended", 20_000);
      expect(ended.call.endReason).toBe("deleted");
      await expect.poll(serverOutput, { timeout: 5_000 }).toMatch(/\[live\] call ended bot=\S+ .*end=deleted errors=none/);
      expect(sse.frames.some((frame) => frame.kind === "message" && frame.message?.kind === "call")).toBe(false);
      expect(await (await fetch(`${base}/api/live/call`)).json()).toEqual({ call: null });
    } finally {
      if (callId) await post("/api/live/call/end", { callId });
      await expect.poll(() => isBusy(bot.id), { timeout: 20_000 }).toBe(false);
      sse.close();
    }
  }, 40_000);
});
