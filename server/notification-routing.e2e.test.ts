import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verificationServerEnvironment } from "../scripts/control-quati.ts";

import type { HandoffView } from "./coordinator.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { readHandoffs } from "./testing/handoff-rows.ts";
import { freePortBlock } from "./testing/ports.ts";
import { openSse } from "./testing/sse.ts";

// The ordinary turn is pinned first: a gate that suppressed everything would pass every quiet case.

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const FAKE_ACP = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const TEST_CAPABILITY_KEY = "notification-routing-fixture-capability";
const TAGGED_REPLY = "Draft is up.\n\n@you three open questions are blocking Section 2 & 3.";

let child: ChildProcess;
let home = "";
let base = "";
let stderr = "";

const api = async (
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: response.status === 204 ? null : await response.json() };
};

const capability = async (
  botId: string,
  threadId: string,
  kind: "agents" | "computer" = "agents",
): Promise<Record<string, string>> => {
  const minted = await api(
    "POST",
    "/api/testing/internal-capability",
    { botId, threadId, kind },
    { "x-quatibot-test-capability": TEST_CAPABILITY_KEY },
  );
  expect(minted.status).toBe(201);
  return { authorization: `Bearer ${minted.body.token}` };
};

const state = async (messages = 40) => (await api("GET", `/api/bots?messages=${messages}`)).body;
const botState = async (botId: string) =>
  (await state(40)).bots.find((candidate: { id: string }) => candidate.id === botId);
const groupState = async (groupId: string) =>
  (await state(40)).groups.find((candidate: { id: string }) => candidate.id === groupId);

const createBot = async (name: string, instanceId: string, model = "fixture/test") => {
  const created = (await api("POST", "/api/bots", {})).body.bot;
  // notifications on, explicitly: a silent bot would pass the "no banner" assertions for the wrong reason
  const patched = await api("PATCH", `/api/bots/${created.id}`, {
    name,
    notifications: true,
    modelSelection: { instanceId, model },
  });
  expect(patched.status).toBe(200);
  return patched.body.bot;
};

const cleanup = async (groupIds: Array<string | undefined>, botIds: string[]) => {
  for (const groupId of groupIds) {
    if (groupId) await api("POST", `/api/groups/${groupId}/interrupt`, {}).catch(() => undefined);
  }
  for (const botId of botIds) await api("POST", `/api/bots/${botId}/interrupt`, {}).catch(() => undefined);
  for (const groupId of groupIds) {
    if (groupId) await api("DELETE", `/api/groups/${groupId}`).catch(() => undefined);
  }
  for (const botId of botIds) await api("DELETE", `/api/bots/${botId}`).catch(() => undefined);
};

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "quati-notification-routing-"));
  const data = join(home, ".quatibot");
  mkdirSync(data, { recursive: true });
  const profiles: Record<string, { mode: string; reply?: string }> = {
    quick: { mode: "happy" }, tagger: { mode: "happy", reply: TAGGED_REPLY },
    stuck: { mode: "hang" }, curious: { mode: "question" }, asker: { mode: "ask-peer" },
  };
  const instances: Record<string, { driver: string; displayName: string; config: { cli: string } }> = {};
  for (const [id, profile] of Object.entries(profiles)) {
    const cli = join(home, `${id}-opencode.mjs`);
    writeFileSync(cli, [
      "#!/usr/bin/env node",
      'process.env.FAKE_ACP_VERSION = "2.0.31";',
      'process.env.FAKE_ACP_AGENT_VERSION = "2.0.31";',
      'process.env.FAKE_ACP_AGENT_NAME = "OpenCode";',
      'process.env.FAKE_ACP_MODELS = "fixture/test";',
      `process.env.FAKE_ACP_MODE = ${JSON.stringify(profile.mode)};`,
      ...(profile.reply ? [`process.env.FAKE_ACP_TEXT_REPLY = ${JSON.stringify(profile.reply)};`] : []),
      `process.env.FAKE_ACP_DUMP = ${JSON.stringify(join(home, `${id}-dump.json`))};`,
      `await import(${JSON.stringify(pathToFileURL(FAKE_ACP).href)});`,
    ].join("\n"), { mode: 0o700 });
    instances[id] = { driver: "opencodeGo", displayName: `${id} fixture`, config: { cli } };
  }
  const discovery = join(data, "providers", "opencode", "discovery");
  mkdirSync(discovery, { recursive: true });
  writeFileSync(join(discovery, ".quati-project"), "");
  writeFileSync(join(data, "config.json"), JSON.stringify({ instances }));
  const port = await freePortBlock([0, 1]);
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: ROOT,
    env: {
      ...verificationServerEnvironment({}, data, port),
      HOME: home,
      QUATI_TEST_INTERNAL_CAPABILITY_KEY: TEST_CAPABILITY_KEY,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr!.on("data", (chunk) => (stderr += chunk));

  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}: ${stderr}`);
    try {
      if ((await fetch(`${base}/api/health`)).status === 200) break;
    } catch {
    }
    if (Date.now() >= deadline) throw new Error(`server never became healthy: ${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const modelDeadline = Date.now() + 15_000;
  for (;;) {
    const available = (await api("GET", "/api/instances")).body.instances;
    if (Object.keys(instances).every((id) => available.find((instance: any) => instance.instanceId === id)?.models?.options?.some((model: any) => model.id === "fixture/test"))) break;
    if (Date.now() >= modelDeadline) throw new Error("OpenCode fixture models did not become available");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}, 45_000);

afterAll(async () => {
  if (child) await waitForExit(child, { signal: "SIGTERM" });
  if (home) await removeTempDir(home);
});

describe("an ordinary turn still announces itself", () => {
  it("badges the bot and banners the person when a person asked", async () => {
    const bot = await createBot("Herald", "quick");
    const stream = await openSse(`${base}/api/events`);
    try {
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "how did it go?" })).status).toBe(202);

      const frame = await stream.until(
        (candidate) =>
          candidate.kind === "notify" &&
          candidate.notification?.kind === "done" &&
          candidate.notification?.botId === bot.id,
        20_000,
      );
      expect(frame.notification).toMatchObject({ threadId: bot.threadId, title: "Herald finished" });
      expect(frame.notification.body).toContain("hello from fake acp");
      expect(frame.notification.groupId).toBeUndefined();
      await expect.poll(async () => (await botState(bot.id))?.unread, { timeout: 20_000 }).toBe(true);
    } finally {
      stream.close();
      await cleanup([], [bot.id]);
    }
  }, 40_000);
});

describe("a room turn belongs to the room", () => {
  it("leaves the speaking bot's own thread unread-free while the room lights up", async () => {
    const bot = await createBot("Roomie", "quick");
    let roomId: string | undefined;
    try {
      const room = (await api("POST", "/api/groups", {
        name: "Standup",
        memberIds: [bot.id],
        setup: { bulletin: "", defaultResponder: { kind: "everyone" } },
      })).body.group;
      roomId = room.id;
      expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "status?" })).status).toBe(202);

      await expect.poll(async () => {
        const current = await groupState(room.id);
        const replied = (current?.messages ?? []).some(
          (message: { kind: string; role?: string }) => message.kind === "text" && message.role === "bot",
        );
        return { working: current?.working, replied };
      }, { timeout: 20_000 }).toEqual({ working: false, replied: true });

      expect((await groupState(room.id))?.unread).toBe(true);
      expect((await botState(bot.id))?.unread).toBeFalsy();
    } finally {
      await cleanup([roomId], [bot.id]);
    }
  }, 40_000);

  it("sends a sign-in request raised mid-room to the room, not to the bot's DM", async () => {
    const bot = await createBot("Handsy", "stuck");
    let roomId: string | undefined;
    try {
      // a sign-in needs a place to sign in on: this bot works in its built-in browser
      expect((await api("PATCH", "/api/config", { features: { browser: true } })).status).toBe(200);
      const placed = await api("PATCH", `/api/bots/${bot.id}`, { computer: "browser" });
      expect(placed.status, JSON.stringify(placed.body)).toBe(200);
      const room = (await api("POST", "/api/groups", {
        name: "War Room",
        memberIds: [bot.id],
        setup: { bulletin: "", defaultResponder: { kind: "everyone" } },
      })).body.group;
      roomId = room.id;
      expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "take the wheel" })).status).toBe(202);
      // the room must actually own the bot before it asks the person to sign in
      await expect.poll(async () => (await groupState(room.id))?.busyBotId, { timeout: 20_000 }).toBe(bot.id);

      const stream = await openSse(`${base}/api/events`);
      try {
        const asked = await api(
          "POST",
          "/api/internal/request-sign-in",
          { site: "example.com", reason: "the login page wants a code" },
          await capability(bot.id, room.threadId),
        );
        expect(asked.status).toBe(201);

        const frame = await stream.until(
          (candidate) => candidate.kind === "notify" && candidate.notification?.kind === "sign-in",
          15_000,
        );
        expect(frame.notification).toMatchObject({
          botId: bot.id,
          threadId: room.threadId,
          groupId: room.id,
          title: "Handsy in War Room needs you to sign in to example.com",
          body: "the login page wants a code",
        });
        expect(frame.notification.threadId).not.toBe(bot.threadId);
      } finally {
        stream.close();
      }
    } finally {
      await api("PATCH", "/api/config", { features: { browser: false } }).catch(() => undefined);
      await cleanup([roomId], [bot.id]);
    }
  }, 45_000);
});

describe("a reply that tags the person", () => {
  it("buzzes once from a room, as a mention that names the room", async () => {
    const bot = await createBot("Tagger", "tagger");
    let roomId: string | undefined;
    const stream = await openSse(`${base}/api/events`);
    try {
      const room = (await api("POST", "/api/groups", {
        name: "Spec Review",
        memberIds: [bot.id],
        setup: { bulletin: "", defaultResponder: { kind: "everyone" } },
      })).body.group;
      roomId = room.id;
      expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "where are we?" })).status).toBe(202);

      const frame = await stream.until(
        (candidate) => candidate.kind === "notify" && candidate.notification?.botId === bot.id,
        20_000,
      );
      expect(frame.notification).toEqual({
        kind: "mention",
        botId: bot.id,
        botName: "Tagger",
        threadId: room.threadId,
        groupId: room.id,
        title: "Tagger in Spec Review mentioned you",
        body: "@you three open questions are blocking Section 2 & 3.",
        id: expect.any(String),
        at: expect.any(Number),
        read: false,
      });
      await expect.poll(async () => (await groupState(room.id))?.working, { timeout: 20_000 }).toBe(false);
      const frames = stream.frames.filter(
        (candidate) => candidate.kind === "notify" && candidate.notification?.botId === bot.id,
      );
      expect(frames.map((candidate) => candidate.notification.kind)).toEqual(["mention"]);
    } finally {
      stream.close();
      await cleanup([roomId], [bot.id]);
    }
  }, 45_000);

  it("stays an ordinary finished notice in a 1:1 thread", async () => {
    const bot = await createBot("Solo Tagger", "tagger");
    const stream = await openSse(`${base}/api/events`);
    try {
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "where are we?" })).status).toBe(202);
      const frame = await stream.until(
        (candidate) =>
          candidate.kind === "notify" &&
          candidate.notification?.kind === "done" &&
          candidate.notification?.botId === bot.id,
        20_000,
      );
      expect(frame.notification.body).toContain("@you three open questions");
      await expect.poll(async () => (await botState(bot.id))?.busy, { timeout: 20_000 }).toBeFalsy();
      const kinds = stream.frames
        .filter((candidate) => candidate.kind === "notify" && candidate.notification?.botId === bot.id)
        .map((candidate) => candidate.notification.kind);
      expect(kinds).toEqual(["done"]);
    } finally {
      stream.close();
      await cleanup([], [bot.id]);
    }
  }, 45_000);
});

describe("bot-to-bot coordination is recorded, not announced", () => {
  const handoffs = () => readHandoffs(join(home, ".quatibot"));
  const consultation = async (requestId: string) => {
    await expect.poll(() => handoffs().some((node) => node.id === requestId), { timeout: 15_000 }).toBe(true);
    return handoffs().find((node) => node.id === requestId)!;
  };

  it("runs a consultation round trip with no badge or banner for the peer, and resumes the asker once", async () => {
    const peer = await createBot("Ink", "quick");
    const asker = await createBot("Pen", "asker");
    const stream = await openSse(`${base}/api/events`);
    try {
      expect((await api("PATCH", `/api/bots/${asker.id}`, { peers: [peer.id] })).status).toBe(200);
      // Seeded unread, or the "no badge" checks below would pass for a hop that had just cleared it.
      expect((await api("PATCH", `/api/bots/${peer.id}`, { unread: true })).status).toBe(200);
      expect((await botState(peer.id))?.unread).toBe(true);
      const peerConversation = (await botState(peer.id)).messages;

      expect((await api("POST", `/api/bots/${asker.id}/messages`, { text: "Pen, ask Ink whether it can take the deploy." })).status).toBe(202);
      await expect.poll(async () => ((await botState(asker.id))?.messages ?? []).some(
        (message: { text?: string }) => message.text === "woke after delegation: saw the result",
      ), { timeout: 40_000 }).toBe(true);
      const exchange = () => handoffs().filter((node) => node.botId === asker.id || node.botId === peer.id);
      await expect.poll(() => exchange().map((node) => node.status), { timeout: 20_000 }).toEqual(["completed", "completed"]);
      const [root, consult] = exchange() as [HandoffView, HandoffView];
      expect(root).toMatchObject({ botId: asker.id, threadId: asker.threadId });
      expect(root.parentId).toBeUndefined();
      expect(consult).toMatchObject({ botId: peer.id, parentId: root.id, mode: "consult", reply: "resume", result: expect.stringContaining("hello from fake acp") });

      const current = await state(40);
      const ink = current.bots.find((candidate: { id: string }) => candidate.id === peer.id);
      expect(consult.threadId).not.toBe(peer.threadId);
      expect(ink.tasks.find((task: { threadId: string }) => task.threadId === consult.threadId)?.openedBy)
        .toMatchObject({ botId: asker.id, kind: "work" });
      expect(ink.messages).toEqual(peerConversation);
      expect(current.groups.find((group: { dm?: boolean }) => group.dm === true)).toBeUndefined();
      const pen = current.bots.find((candidate: { id: string }) => candidate.id === asker.id);
      const replied = pen.messages.find(
        (message: { kind: string; tool?: { name?: string } }) => message.kind === "activity" && message.tool?.name === "Ink replied",
      );
      expect(replied?.tool?.output).toContain("hello from fake acp");
      expect(replied?.threadRef).toMatchObject({ botId: peer.id, threadId: consult.threadId });
      expect(ink.unread).toBe(true);

      // A unique bot patch is an SSE ordering barrier: once seen, every notification this exchange raised is in `frames`.
      expect((await api("PATCH", `/api/bots/${asker.id}`, { name: "Pen observed" })).status).toBe(200);
      await stream.until(
        (candidate) => candidate.kind === "bot" && candidate.bot?.id === asker.id && candidate.bot?.name === "Pen observed",
      );
      const notified = stream.frames.filter((candidate) => candidate.kind === "notify").map((candidate) => candidate.notification);
      expect(notified.filter((notification) => notification?.botId === peer.id), JSON.stringify(notified)).toEqual([]);
      expect(notified.every((notification) => notification?.botId === asker.id && notification?.threadId === asker.threadId), JSON.stringify(notified)).toBe(true);
      expect(notified.map((notification) => notification?.kind), JSON.stringify(notified)).toEqual(["done", "delegation-settled"]);
      expect(notified[1]).toMatchObject({ title: "Pen resumed with results", body: "Results in from Ink" });
    } finally {
      stream.close();
      await cleanup([], [asker.id, peer.id]);
    }
  }, 60_000);

  it("still announces the person's own next message after a hop that finished", async () => {
    const asker = await createBot("Nib", "quick");
    const peer = await createBot("Vellum", "quick");
    const stream = await openSse(`${base}/api/events`);
    try {
      const asked = await api(
        "POST",
        "/api/internal/coordinate-bots",
        { botIds: [peer.id], message: "Vellum, is the branch green?", consult: true },
        await capability(asker.id, asker.threadId),
      );
      expect(asked.status, JSON.stringify(asked.body)).toBe(200);
      expect(asked.body.receipts[0]).toMatchObject({ botId: peer.id, outcome: "queued" });
      const consult = await consultation(asked.body.receipts[0].requestId);
      expect(consult.threadId).not.toBe(peer.threadId);
      await expect.poll(() => handoffs().find((node) => node.id === consult.id)?.status, { timeout: 20_000 }).toBe("completed");
      expect((await botState(peer.id))?.unread).toBeFalsy();

      expect((await api("POST", `/api/bots/${peer.id}/messages`, { text: "and for me?" })).status).toBe(202);
      const frame = await stream.until(
        (candidate) =>
          candidate.kind === "notify" &&
          candidate.notification?.kind === "done" &&
          candidate.notification?.botId === peer.id,
        20_000,
      );
      expect(frame.notification.threadId).toBe(peer.threadId);
      await expect.poll(async () => (await botState(peer.id))?.unread, { timeout: 20_000 }).toBe(true);
    } finally {
      stream.close();
      await cleanup([], [asker.id, peer.id]);
    }
  }, 45_000);

  it("still announces the person's own next message after a hop that never started", async () => {
    const asker = await createBot("Quire", "quick");
    const peer = await createBot("Folio", "quick");
    const stream = await openSse(`${base}/api/events`);
    try {
      // An engine that is not there: the consultation is accepted, and its turn cannot start.
      expect((await api("PATCH", `/api/bots/${peer.id}`, {
        modelSelection: { instanceId: "ghost", model: "ghost-1" },
      })).status).toBe(200);
      const asked = await api(
        "POST",
        "/api/internal/coordinate-bots",
        { botIds: [peer.id], message: "Folio, still there?", consult: true },
        await capability(asker.id, asker.threadId),
      );
      expect(asked.status, JSON.stringify(asked.body)).toBe(200);
      expect(asked.body.receipts[0]).toMatchObject({ botId: peer.id, outcome: "queued" });
      const consult = await consultation(asked.body.receipts[0].requestId);
      expect(consult.threadId).not.toBe(peer.threadId);
      expect((await botState(peer.id))?.unread).toBeFalsy();

      expect((await api("PATCH", `/api/bots/${peer.id}`, {
        modelSelection: { instanceId: "quick", model: "fixture/test" },
      })).status).toBe(200);
      expect((await api("POST", `/api/bots/${peer.id}/messages`, { text: "back? tell me when" })).status).toBe(202);
      const frame = await stream.until(
        (candidate) =>
          candidate.kind === "notify" &&
          candidate.notification?.kind === "done" &&
          candidate.notification?.botId === peer.id,
        20_000,
      );
      expect(frame.notification.threadId).toBe(peer.threadId);
      await expect.poll(async () => (await botState(peer.id))?.unread, { timeout: 20_000 }).toBe(true);
    } finally {
      stream.close();
      await cleanup([], [asker.id, peer.id]);
    }
  }, 45_000);

  it("buzzes when a bot stops to ask whether it may contact a teammate", async () => {
    const asker = await createBot("Nib", "quick");
    const peer = await createBot("Dot", "quick");
    expect((await api("PATCH", `/api/bots/${asker.id}`, { approvePeerComms: true, approvalMode: "ask" })).status).toBe(200);
    const stream = await openSse(`${base}/api/events`);
    const asking = api(
      "POST",
      "/api/internal/coordinate-bots",
      { botIds: [peer.id], message: "Dot, can you take the deploy?", consult: true },
      await capability(asker.id, asker.threadId),
    );
    try {
      const frame = await stream.until(
        (candidate) => candidate.kind === "notify" && candidate.notification?.botId === asker.id,
        20_000,
      );
      expect(frame.notification).toMatchObject({
        kind: "approval",
        botId: asker.id,
        threadId: asker.threadId,
        title: "Nib needs approval",
      });
      expect(frame.notification.body).toContain("wants to contact @Dot");
      const card = (await botState(asker.id))?.messages.findLast(
        (message: { kind: string; card?: { requestId?: string; tool?: string } }) => message.kind === "options" && Boolean(message.card?.requestId),
      );
      expect(card?.card?.tool).toBe("ask_bot");
      const denied = await api("POST", `/api/bots/${asker.id}/respond`, { requestId: card.card.requestId, behavior: "deny" });
      expect(denied.status).toBe(200);
      const refused = await asking;
      expect(refused.status).toBe(403);
      expect(refused.body).toMatchObject({
        error: "Denied by user; no work sent.",
        approvals: [{ botId: peer.id, error: "denied by user", approvalOutcome: "deny", approvalSource: "user" }],
      });
      expect(handoffs().filter((node) => node.botId === peer.id)).toEqual([]);
    } finally {
      stream.close();
      await asking.catch(() => undefined);
      await cleanup([], [asker.id, peer.id]);
    }
  }, 45_000);

  it("still buzzes when a peer's turn stops to ask the person a question", async () => {
    const asker = await createBot("Quill", "quick");
    const peer = await createBot("Sage", "curious");
    const stream = await openSse(`${base}/api/events`);
    try {
      const asked = await api(
        "POST",
        "/api/internal/coordinate-bots",
        { botIds: [peer.id], message: "Sage, which colour?", consult: true },
        await capability(asker.id, asker.threadId),
      );
      expect(asked.status, JSON.stringify(asked.body)).toBe(200);
      const workThread = asked.body.receipts[0].threadId as string;
      expect(workThread).not.toBe(peer.threadId);
      const frame = await stream.until(
        (candidate) => candidate.kind === "notify" && candidate.notification?.botId === peer.id,
        20_000,
      );
      expect(frame.notification).toMatchObject({
        kind: "question",
        botId: peer.id,
        threadId: workThread,
        title: "Sage has a question",
      });
      // A new bot's onboarding card sits above it, so take the turn's own.
      const card = ((await api("GET", `/api/threads/${workThread}/messages`)).body.messages as any[]).findLast(
        (message: { kind: string; card?: { title?: string } }) => message.kind === "options" && Boolean(message.card),
      );
      expect(card?.card).toMatchObject({ title: "Your bot has a question", subtitle: "Which color?" });
      expect(((await botState(peer.id))?.messages ?? []).some(
        (message: { kind: string; card?: { subtitle?: string } }) => message.kind === "options" && message.card?.subtitle === "Which color?",
      )).toBe(false);
    } finally {
      stream.close();
      await api("POST", `/api/bots/${peer.id}/interrupt`, {}).catch(() => undefined);
      await cleanup([], [asker.id, peer.id]);
    }
  }, 45_000);
});
