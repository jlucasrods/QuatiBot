import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { verificationServerEnvironment } from "../scripts/control-quati.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const FAKE_ACP = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const HELD = (name: string) => `${name} is held (stopped by you) — @mention it or say resume`;

let child: ChildProcess;
let home = "";
let data = "";
let base = "";
let stderr = "";
let slowGate = "";

type StateMessage = {
  id: string;
  kind: string;
  role?: string;
  text?: string;
  turnTerminal?: boolean;
  from?: { botId?: string; name?: string };
  tool?: { name?: string; ok?: boolean };
};

const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() };
};

const fixture = (displayName: string, environment: Record<string, string>) => {
  const cli = join(home, `${displayName.replace(/\W+/g, "-")}.mjs`);
  const env = {
    FAKE_ACP_VERSION: "2.0.31", FAKE_ACP_AGENT_VERSION: "2.0.31",
    FAKE_ACP_AGENT_NAME: "OpenCode", FAKE_ACP_MODELS: "fixture/test", ...environment,
  };
  writeFileSync(cli, ["#!/usr/bin/env node",
    ...Object.entries(env).map(([key, value]) => `process.env[${JSON.stringify(key)}] = ${JSON.stringify(value)};`),
    `await import(${JSON.stringify(pathToFileURL(FAKE_ACP).href)});`,
  ].join("\n"), { mode: 0o700 });
  return { driver: "opencodeGo", displayName, config: { cli } };
};

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "quati-room-holds-"));
  data = join(home, ".quatibot");
  const staticDir = join(home, "static");
  mkdirSync(data, { recursive: true });
  mkdirSync(join(staticDir, "assets"), { recursive: true });
  writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>Room holds test</title>");
  writeFileSync(join(staticDir, "assets", "smoke.css"), "body{}");
  slowGate = join(home, "slow-finish");
  const thoughtFile = join(home, "narrator-updates.json");
  writeFileSync(thoughtFile, JSON.stringify([{ update: {
    sessionUpdate: "agent_thought_chunk", content: { text: "Let me check with @Ann later." },
  } }]));
  const discovery = join(data, "providers", "opencode", "discovery");
  mkdirSync(discovery, { recursive: true });
  writeFileSync(join(discovery, ".quati-project"), "fixture");
  writeFileSync(join(data, "config.json"), JSON.stringify({
    instances: {
      patient: fixture("Patient fixture", { FAKE_ACP_MODE: "echo-gated", FAKE_ACP_GATE_FILE: slowGate }),
      quick: fixture("Quick fixture", { FAKE_ACP_MODE: "happy" }),
      narrator: fixture("Narrating fixture", {
        FAKE_ACP_MODE: "reply-sequence", FAKE_ACP_REPLIES: JSON.stringify(["All done here."]),
        FAKE_ACP_REPLY_STATE: join(home, "narrator-replies.txt"), FAKE_ACP_UPDATES_FILE: thoughtFile,
      }),
      passer: fixture("Passing fixture", {
        FAKE_ACP_MODE: "reply-sequence",
        FAKE_ACP_REPLIES: JSON.stringify(["(pass)", "Result: the title is fixed."]),
        FAKE_ACP_REPLY_STATE: join(home, "passer-replies.txt"),
      }),
    },
  }));
  const port = await freePortBlock([0, 1]);
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: ROOT,
    env: {
      ...verificationServerEnvironment({}, data, port), HOME: home,
      QUATI_STATIC_DIR: staticDir,
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
  for (;;) {
    const instances = (await api("GET", "/api/instances")).body.instances;
    if (["patient", "quick", "narrator", "passer"].every((id) =>
      instances.find((instance: { instanceId: string }) => instance.instanceId === id)?.models.options.some((option: { id: string }) => option.id === "fixture/test"))) break;
    if (Date.now() >= deadline) throw new Error(`Fixture models unavailable: ${JSON.stringify(instances)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}, 30_000);

afterAll(async () => {
  if (child) await waitForExit(child, { signal: "SIGTERM" });
  if (home) await removeTempDir(home);
});

const createBot = async (name: string, instanceId: string) =>
  (await api("POST", "/api/bots", {
    name,
    modelSelection: { instanceId, model: "fixture/test" },
    requireAvailableModel: true,
  })).body.bot;

const createRoom = async (name: string, memberIds: string[], defaultResponder: unknown) =>
  (await api("POST", "/api/groups", { name, memberIds, setup: { bulletin: "", defaultResponder } })).body.group;

const snapshot = async (groupId: string) => {
  const state = (await api("GET", "/api/bots?messages=60")).body;
  const room = state.groups.find((group: { id: string }) => group.id === groupId);
  const messages: StateMessage[] = room?.messages ?? [];
  return { state, room, messages };
};

const send = async (roomId: string, text: string) =>
  expect((await api("POST", `/api/groups/${roomId}/messages`, { text })).status).toBe(202);

const botTexts = (messages: StateMessage[], botId: string) =>
  messages.filter((message) => message.kind === "text" && message.role === "bot" && message.from?.botId === botId);

const chips = (messages: StateMessage[], name: string) =>
  messages.filter((message) => message.kind === "activity" && message.tool?.name === name);

const cleanup = async (roomId: string | undefined, botIds: string[]) => {
  writeFileSync(slowGate, "cleanup");
  if (roomId) await api("POST", `/api/groups/${roomId}/interrupt`, {}).catch(() => undefined);
  if (roomId) await api("DELETE", `/api/groups/${roomId}`).catch(() => undefined);
  for (const botId of botIds) await api("DELETE", `/api/bots/${botId}`).catch(() => undefined);
};

describe("stop @Bot holds one room member", { timeout: 60_000 }, () => {
  it("ends that member's turn, skips it on every route, saves the hold, and brings it back with what it missed", async () => {
    const ann = await createBot("Ann", "quick");
    const bee = await createBot("Bee", "patient");
    const room = await createRoom("Hold room", [ann.id, bee.id], { kind: "everyone" });
    try {
      rmSync(slowGate, { force: true });
      await send(room.id, "@Bee start the long job");
      await expect.poll(async () => (await snapshot(room.id)).room?.busyBotId, { timeout: 15_000 }).toBe(bee.id);

      await send(room.id, "stop @Bee");
      await expect.poll(async () => {
        const { room: current, messages } = await snapshot(room.id);
        return {
          held: Object.keys(current?.holds ?? {}),
          working: current?.working,
          heldChips: chips(messages, HELD("Bee")).length,
          annSpoke: botTexts(messages, ann.id).length > 0,
        };
      }, { timeout: 15_000 }).toEqual({ held: [bee.id], working: false, heldChips: 1, annSpoke: false });

      await send(room.id, "Hello team");
      await expect.poll(async () => {
        const { room: current, messages } = await snapshot(room.id);
        return { working: current?.working, ann: botTexts(messages, ann.id).length, heldChips: chips(messages, HELD("Bee")).length };
      }, { timeout: 15_000 }).toEqual({ working: false, ann: 1, heldChips: 1 });
      const beforeResume = await snapshot(room.id);
      const beeTextsWhileHeld = botTexts(beforeResume.messages, bee.id).length;

      const saved = JSON.parse(readFileSync(join(data, "groups.json"), "utf8"));
      const savedRoom = saved.find((group: { id: string }) => group.id === room.id);
      expect(Object.keys(savedRoom.holds)).toEqual([bee.id]);
      expect(savedRoom.heldMessages[bee.id]).toHaveLength(1);

      writeFileSync(slowGate, "finish");
      await send(room.id, "@Bee resume");
      await expect.poll(async () => {
        const { room: current, messages } = await snapshot(room.id);
        const latest = botTexts(messages, bee.id).at(-1)?.text ?? "";
        return {
          working: current?.working,
          held: Object.keys(current?.holds ?? {}),
          beeSpoke: botTexts(messages, bee.id).length > beeTextsWhileHeld,
          replayed: latest.includes("While you were held") && latest.includes("Hello team"),
        };
      }, { timeout: 15_000 }).toEqual({ working: false, held: [], beeSpoke: true, replayed: true });
      expect((await snapshot(room.id)).room?.heldMessages?.[bee.id]).toBeUndefined();
    } finally {
      await cleanup(room?.id, [ann.id, bee.id]);
    }
  });

  it("holds and releases one member from its own control", async () => {
    const ann = await createBot("Ann", "quick");
    const bee = await createBot("Bee", "quick");
    const room = await createRoom("Control room", [ann.id, bee.id], { kind: "member", botId: bee.id });
    try {
      const held = await api("POST", `/api/groups/${room.id}/holds`, { botId: bee.id, held: true });
      expect(held.status).toBe(200);
      expect(Object.keys(held.body.group.holds)).toEqual([bee.id]);
      await send(room.id, "Anyone there?");
      await expect.poll(async () => chips((await snapshot(room.id)).messages, HELD("Bee")).length, { timeout: 15_000 }).toBe(1);
      const { messages } = await snapshot(room.id);
      expect(botTexts(messages, bee.id)).toHaveLength(0);
      expect(botTexts(messages, ann.id)).toHaveLength(0);

      expect((await api("POST", `/api/groups/${room.id}/holds`, { botId: "nobody", held: true })).status).toBe(404);
      expect((await api("POST", `/api/groups/${room.id}/holds`, { botId: bee.id })).status).toBe(400);
      const released = await api("POST", `/api/groups/${room.id}/holds`, { botId: bee.id, held: false });
      expect(released.body.group.holds).toEqual({});
      await send(room.id, "Now?");
      await expect.poll(async () => botTexts((await snapshot(room.id)).messages, bee.id).length, { timeout: 15_000 }).toBe(1);
    } finally {
      await cleanup(room?.id, [ann.id, bee.id]);
    }
  });
});

describe("a member's room reply is its final message", { timeout: 60_000 }, () => {
  it("keeps working notes out of the reply: a teammate named in one is not summoned", async () => {
    const nora = await createBot("Nora", "narrator");
    const ann = await createBot("Ann", "quick");
    const room = await createRoom("Notes room", [nora.id, ann.id], { kind: "member", botId: nora.id });
    try {
      await send(room.id, "How is it going?");
      await expect.poll(async () => {
        const { room: current, messages } = await snapshot(room.id);
        return { working: current?.working, final: botTexts(messages, nora.id).find((message) => message.turnTerminal)?.text };
      }, { timeout: 15_000 }).toEqual({ working: false, final: "All done here." });
      const { messages } = await snapshot(room.id);
      const nora_ = botTexts(messages, nora.id);
      expect(nora_.map((message) => [message.text, Boolean(message.turnTerminal)])).toEqual([["All done here.", true]]);
      expect(readFileSync(join(data, "native", `${room.threadId}.ndjson`), "utf8")).toContain("Let me check with @Ann later.");
      expect(botTexts(messages, ann.id)).toHaveLength(0);
    } finally {
      await cleanup(room?.id, [nora.id, ann.id]);
    }
  });

  it("re-asks once for a short result when a turn ends without one", async () => {
    const pat = await createBot("Pat", "passer");
    const ann = await createBot("Ann", "quick");
    const room = await createRoom("Pass room", [pat.id, ann.id], { kind: "member", botId: pat.id });
    try {
      await send(room.id, "Did the title get fixed?");
      await expect.poll(async () => {
        const { room: current, messages } = await snapshot(room.id);
        return {
          working: current?.working,
          chip: chips(messages, "Pat finished without a summary — asking for a short result").length,
          final: botTexts(messages, pat.id).at(-1)?.text,
        };
      }, { timeout: 15_000 }).toEqual({ working: false, chip: 1, final: "Result: the title is fixed." });
      expect(botTexts((await snapshot(room.id)).messages, ann.id)).toHaveLength(0);
    } finally {
      await cleanup(room?.id, [pat.id, ann.id]);
    }
  });
});
