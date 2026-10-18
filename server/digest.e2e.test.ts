import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { verificationServerEnvironment } from "../scripts/control-quati.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const fake = (name: string) => join(SERVER_DIR, "testing", name);
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;

interface Msg {
  id: string;
  role: string;
  kind: string;
  text?: string;
  turnId?: string;
  tool?: { name: string };
  digest?: { turnId: string; tools: Array<{ name: string; count: number }>; files?: { added: string[]; changed: string[] }; hookCoverage: string };
}

describe("OpenCode work digests", () => {
  let child: ChildProcess;
  let home: string;
  let stderr = "";
  const gate = () => join(home, "acp.gate");
  const started = () => join(home, "acp.started");

  const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  const getBot = async (id: string) => (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === id);
  const waitFor = async (predicate: () => Promise<boolean>, what: string, ms = 30_000) => {
    const deadline = Date.now() + ms;
    while (!(await predicate())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}. stderr: ${stderr.slice(-3000)}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  };
  const settled = async (id: string) => {
    const b = await getBot(id);
    return !!b && !b.busy && b.messages.some((m: Msg) => m.role === "bot" && m.kind === "text" && m.text);
  };

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "quati-digest-e2e-"));
    mkdirSync(join(home, ".quatibot"), { recursive: true });
    const tools = join(home, "bin");
    mkdirSync(tools);
    symlinkSync("/usr/bin/git", join(tools, "git"));
    const instances: Record<string, unknown> = {};
    for (const [id, mode] of [["opencodeGo", "happy"], ["gated", "echo-gated"], ["echo", "echo-gated"]]) {
      const cli = join(home, `${id}.mjs`);
      writeFileSync(cli, [
        `#!${process.execPath}`,
        `Object.assign(process.env, ${JSON.stringify({
          FAKE_ACP_MODE: mode, FAKE_ACP_VERSION: "2.0.31", FAKE_ACP_AGENT_VERSION: "2.0.31",
          FAKE_ACP_AGENT_NAME: "OpenCode", FAKE_ACP_MODELS: "fixture/test",
          ...(id === "gated" ? { FAKE_ACP_GATE_FILE: gate(), FAKE_ACP_STARTED_FILE: started() } : {}),
        })});`,
        `await import(${JSON.stringify(fake("fake-acp-cli.ts"))});`,
      ].join("\n"), { mode: 0o755 });
      instances[id] = { driver: "opencodeGo", config: { cli } };
    }
    const discovery = join(home, ".quatibot", "providers", "opencode", "discovery");
    mkdirSync(discovery, { recursive: true });
    writeFileSync(join(discovery, ".quati-project"), "");
    writeFileSync(join(home, ".quatibot", "config.json"), JSON.stringify({ instances }));

    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: { ...verificationServerEnvironment({}, join(home, ".quatibot"), PORT), HOME: home, PATH: `${dirname(process.execPath)}:${tools}` },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (c) => (stderr += c));
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        if ((await fetch(`${BASE}/api/health`)).ok) break;
      } catch {}
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
      await new Promise((r) => setTimeout(r, 150));
    }
    await waitFor(async () => {
      const rows = (await api("GET", "/api/instances")).body.instances;
      return ["opencodeGo", "gated", "echo"].every((id) => rows.find((row: { instanceId: string }) => row.instanceId === id)
        ?.models?.options?.some((model: { id: string }) => model.id === "fixture/test"));
    }, "OpenCode model discovery");
  }, 30_000);

  afterAll(async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  });

  it("one settled turn yields exactly one digest naming its tools", async () => {
    const created = (await api("POST", "/api/bots")).body.bot;
    expect((await api("PATCH", `/api/bots/${created.id}`, { modelSelection: { instanceId: "opencodeGo", model: "fixture/test" } })).status).toBe(200);
    expect((await api("POST", `/api/bots/${created.id}/messages`, { text: "do one thing" })).status).toBe(202);
    await waitFor(() => settled(created.id), "OpenCode to settle");
    await waitFor(async () => (await getBot(created.id)).messages.some((m: Msg) => m.kind === "digest"), "OpenCode digest");

    const bot = await getBot(created.id);
    const digests: Msg[] = bot.messages.filter((m: Msg) => m.kind === "digest");
    const reply: Msg = bot.messages.find((m: Msg) => m.role === "bot" && m.kind === "text" && m.text);
    expect(digests).toHaveLength(1);
    const [d] = digests;
    expect(d!.role).toBe("bot");
    expect(d!.text).toMatch(/^\[digest\]/);
    expect(d!.digest?.turnId).toBeTruthy();
    if (reply.turnId) expect(d!.digest?.turnId).toBe(reply.turnId);
    const names = d!.digest!.tools.map((t) => t.name);
    expect(names).toContain("run");
    const activities: Msg[] = bot.messages.filter((m: Msg) => m.kind === "activity" && m.tool);
    for (const a of activities) expect(a.turnId).toBe(d!.digest?.turnId);
    expect(d!.digest!.tools.reduce((n, t) => n + t.count, 0)).toBe(activities.length);
  }, 45_000);

  it("names the project files a turn changed, and a different engine taking over sees that in its replay", async () => {
    const project = mkdtempSync(join(tmpdir(), "quati-digest-project-"));
    writeFileSync(join(project, "README.md"), "hello");
    const created = (await api("POST", "/api/bots")).body.bot;
    expect((await api("PATCH", `/api/bots/${created.id}`, { cwd: project })).status).toBe(200);
    expect((await api("PATCH", `/api/bots/${created.id}`, { modelSelection: { instanceId: "gated", model: "fixture/test" } })).status).toBe(200);

    // the turn is held open by the gate; "the engine" changes a file meanwhile
    expect((await api("POST", `/api/bots/${created.id}/messages`, { text: "raise the retry limit" })).status).toBe(202);
    // busy flips at claim, BEFORE the pre-turn checkpoint; the fake's
    // started marker is written when the prompt reaches it, after that
    await waitFor(async () => existsSync(started()), "the gated turn to reach the engine");
    writeFileSync(join(project, "retry.ts"), "export const RETRY_LIMIT = 5;");
    writeFileSync(gate(), "go");
    await waitFor(() => settled(created.id), "the gated turn to settle");
    await waitFor(async () => (await getBot(created.id)).messages.some((m: Msg) => m.kind === "digest"), "digest with files");
    const digest: Msg = (await getBot(created.id)).messages.find((m: Msg) => m.kind === "digest");
    expect(digest.digest?.files?.added).toEqual(["retry.ts"]);

    expect((await api("PATCH", `/api/bots/${created.id}`, { modelSelection: { instanceId: "echo", model: "fixture/test" } })).status).toBe(200);
    expect((await api("POST", `/api/bots/${created.id}/messages`, { text: "what did you change?" })).status).toBe(202);
    await waitFor(async () => {
      const b = await getBot(created.id);
      return !b.busy && b.messages.filter((m: Msg) => m.role === "bot" && m.kind === "text" && m.text).length >= 2;
    }, "the echo engine to reply");
    const replies: Msg[] = (await getBot(created.id)).messages.filter((m: Msg) => m.role === "bot" && m.kind === "text" && m.text);
    const echoed = replies.at(-1)!.text!;
    expect(echoed).toContain("did in an earlier turn");
    expect(echoed).toContain("retry.ts");
    await removeTempDir(project);
  }, 60_000);
});
