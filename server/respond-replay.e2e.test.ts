import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verificationServerEnvironment } from "../scripts/control-quati.ts";

import type { DecisionRow } from "./decision-log.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
let port: number;
let BASE: string;
const UNDELIVERED = "Couldn't deliver that answer";

let child: ChildProcess;
let home: string;
let log = "";

const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

async function start() {
  child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: join(SERVER_DIR, ".."),
    env: {
      ...verificationServerEnvironment({}, join(home, ".quatibot"), port), HOME: home,
      FAKE_ACP_MODE: "permission", FAKE_ACP_MODELS: "fixture/test",
      FAKE_ACP_VERSION: "2.0.31", FAKE_ACP_AGENT_VERSION: "2.0.31", FAKE_ACP_AGENT_NAME: "OpenCode",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout!.on("data", (c) => (log += c));
  child.stderr!.on("data", (c) => (log += c));
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) break;
    } catch {
    }
    if (Date.now() > deadline) throw new Error(`server never came up:\n${log}`);
    await new Promise((r) => setTimeout(r, 150));
  }
  const ready = await waitFor(async () => {
    const snapshot = (await api("GET", "/api/instances")).body.instances.find((instance: { instanceId: string }) => instance.instanceId === "opencodeGo");
    return snapshot?.models.options.some((model: { id: string }) => model.id === "fixture/test") ? true : null;
  });
  expect(ready).toBe(true);
}

async function waitFor<T>(read: () => Promise<T | null | undefined>, ms = 30_000): Promise<T | null> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 250));
  }
}

const messages = async (threadId: string): Promise<any[]> =>
  (await api("GET", `/api/threads/${threadId}/messages`)).body.messages ?? [];
const undelivered = async (threadId: string) =>
  (await messages(threadId)).filter((m) => typeof m.tool?.name === "string" && m.tool.name.includes(UNDELIVERED));
const openCard = (threadId: string) => waitFor(async () =>
  (await messages(threadId)).find((m) => m.kind === "options" && m.card?.requestId && !m.card.answered) ?? null);
const userDecisionsFor = async (requestId: string) => {
  const { body } = await api("GET", "/api/decisions");
  return ((body.decisions ?? []) as DecisionRow[]).filter(
    (row) => row.requestId === requestId && (row.decision === "user-approved" || row.decision === "user-denied"),
  );
};

describe("a replayed respond for a settled card", () => {
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "quati-respond-replay-"));
    const data = join(home, ".quatibot");
    mkdirSync(data, { recursive: true });
    const discovery = join(data, "providers", "opencode", "discovery");
    mkdirSync(discovery, { recursive: true });
    writeFileSync(join(discovery, ".quati-project"), "Verification fixture\n");
    writeFileSync(join(data, "config.json"), JSON.stringify({
      instances: { opencodeGo: { driver: "opencodeGo", config: { cli: FAKE_CLI } } },
    }));
    port = await freePortBlock([0, 1]);
    BASE = `http://127.0.0.1:${port}`;
    await start();
  }, 40_000);

  afterAll(async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  });

  it("appends no couldn't-deliver message on replay, but still reports an unknown request", async () => {
    const created = await api("POST", "/api/bots", { name: "Replayed" });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const bot = created.body.bot as { id: string; threadId: string };
    const patched = await api("PATCH", `/api/bots/${bot.id}`, { modelSelection: { instanceId: "opencodeGo", model: "fixture/test" }, approvalMode: "ask" });
    expect(patched.status).toBe(200);

    const sent = await api("POST", `/api/bots/${bot.id}/messages`, { text: "run it", threadId: bot.threadId });
    expect(sent.status, JSON.stringify(sent.body)).toBe(202);
    const card = await openCard(bot.threadId);
    expect(card, `no approval card appeared:\n${log.slice(-2_000)}`).not.toBeNull();
    const requestId = card.card.requestId as string;

    const first = await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId, behavior: "allow" });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.outcome).not.toBe("unavailable");
    const settled = await waitFor(async () =>
      (await messages(bot.threadId)).find((m) => m.card?.requestId === requestId && m.card.answered) ?? null);
    expect(settled?.card.answered).toBe("allow");
    expect(await undelivered(bot.threadId)).toHaveLength(0);

    const replay = await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId, behavior: "allow" });
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(replay.body.outcome).toBe("unavailable");
    expect(await undelivered(bot.threadId)).toHaveLength(0);
    expect(await userDecisionsFor(requestId)).toHaveLength(1);

    // Control: a requestId that was never issued is a genuine miss, and the message still says so.
    const unknown = await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId: "req-never-issued", behavior: "allow" });
    expect(unknown.status, JSON.stringify(unknown.body)).toBe(200);
    expect(unknown.body.outcome).toBe("unavailable");
    expect(await undelivered(bot.threadId)).toHaveLength(1);
  }, 90_000);
});
