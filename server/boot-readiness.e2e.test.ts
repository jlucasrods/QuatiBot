import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { runControlQuati, verificationServerEnvironment } from "../scripts/control-quati.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FAKE_CLI = pathToFileURL(join(ROOT, "server/testing/fake-acp-cli.ts")).href;

const homes: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) await waitForExit(child, { signal: "SIGTERM" });
  for (const home of homes.splice(0)) await removeTempDir(home);
});

function freshHome(): string {
  const home = mkdtempSync(join(tmpdir(), "quati-boot-readiness-"));
  homes.push(home);
  mkdirSync(join(home, "tmp"), { recursive: true });
  const discovery = join(home, "providers", "opencode", "discovery");
  mkdirSync(discovery, { recursive: true });
  writeFileSync(join(discovery, ".quati-project"), "Verification fixture\n");
  const cli = join(home, "opencode-fixture.mjs");
  writeFileSync(cli, [
    "#!/usr/bin/env node",
    "import { appendFileSync, existsSync } from 'node:fs';",
    `if (existsSync(${JSON.stringify(join(home, "hold-probe"))})) {`,
    `appendFileSync(${JSON.stringify(join(home, "probes.log"))}, 'probe ' + process.pid + '\\n');`,
    `while (!existsSync(${JSON.stringify(join(home, "release-probe"))})) await new Promise(resolve => setTimeout(resolve, 25));`,
    "}",
    "process.env.FAKE_ACP_AGENT_VERSION = '2.0.31';",
    "process.env.FAKE_ACP_VERSION = '2.0.31';",
    "process.env.FAKE_ACP_MODELS = 'fixture/test';",
    `process.env.FAKE_ACP_DUMP = ${JSON.stringify(join(home, "fake-acp-dump.json"))};`,
    `await import(${JSON.stringify(FAKE_CLI)});`,
  ].join("\n"), { mode: 0o700 });
  writeFileSync(join(home, "config.json"), JSON.stringify({
    instances: { opencodeGo: { driver: "opencodeGo", displayName: "Verification fixture", config: { cli } } },
  }));
  return home;
}

async function boot(home: string, knobs: Record<string, string> = {}) {
  const port = await freePortBlock([0, 1]);
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "server/index.ts")], {
    cwd: ROOT,
    env: verificationServerEnvironment({ ...process.env, ...knobs }, home, port),
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let output = "";
  child.stdout!.on("data", (chunk) => { output += chunk; });
  child.stderr!.on("data", (chunk) => { output += chunk; });
  await expect.poll(async () => {
    if (child.exitCode !== null) throw new Error(`server exited during boot:\n${output}`);
    try { return (await fetch(base + "/api/health")).ok; } catch { return false; }
  }, { timeout: 20_000, interval: 50 }).toBe(true);
  const get = async (path: string) => {
    const response = await fetch(base + path, { headers: { origin: base } });
    expect(response.status).toBe(200);
    return response.json() as Promise<any>;
  };
  const control = (...args: string[]) => runControlQuati([...args, "--url", base]) as Promise<any>;
  const stop = () => waitForExit(child, { signal: "SIGTERM" });
  return { get, control, stop };
}

it("makes a first run's starter bot on the engine a new bot gets", async () => {
  const server = await boot(freshHome());
  await expect.poll(async () => (await server.get("/api/bots?messages=0")).bots[0]?.modelSelection, { timeout: 10_000 })
    .toMatchObject({ instanceId: "opencodeGo", model: "fixture/test" });
  const { bots } = await server.get("/api/bots?messages=0");
  expect(bots).toHaveLength(1);
  expect(bots[0].modelSelection).toMatchObject({ instanceId: "opencodeGo", model: "fixture/test" });
});

it("answers on a later start while an engine CLI is still being probed, and runs turns once it has answered", async () => {
  const home = freshHome();
  const first = await boot(home);
  await expect.poll(async () => (await first.get("/api/bots?messages=0")).bots[0]?.modelSelection.instanceId, { timeout: 10_000 }).toBe("opencodeGo");
  const [starter] = (await first.get("/api/bots?messages=0")).bots;
  const member = (await first.control("new-bot", "--name", "Room member")).bot;
  const room = (await first.control("new-channel", "--name", "Start room", "--members", member.id)).channel;
  await first.stop();

  const probes = join(home, "probes.log");
  const release = join(home, "release-probe");
  const prompts = join(home, "fake-acp-dump.json.prompts.jsonl");
  writeFileSync(join(home, "hold-probe"), "");
  const server = await boot(home);
  let held = 0;
  await expect.poll(() => {
    held = existsSync(probes) ? Number(/^probe (\d+)$/m.exec(readFileSync(probes, "utf8"))?.[1] ?? 0) : 0;
    return held;
  }, { timeout: 10_000 }).toBeGreaterThan(0);
  expect(() => process.kill(held, 0)).not.toThrow();

  await server.control("send", "--bot", starter.id, "--task", starter.threadId, "--text", "Right after the start");
  await server.control("send-channel", "--channel", room.id, "--text", "Right after the start, in a room");
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  expect(existsSync(prompts)).toBe(false);
  expect(() => process.kill(held, 0)).not.toThrow();
  writeFileSync(release, "");

  expect((await server.control("wait", "--bot", starter.id, "--task", starter.threadId, "--timeout", "30")).status).toBe("settled");
  expect((await server.control("wait", "--channel", room.id, "--timeout", "30")).status).toBe("settled");
  const seen = readFileSync(prompts, "utf8");
  expect(seen).toContain("Right after the start");
  expect(seen).toContain("Right after the start, in a room");
  const { instances } = await server.get("/api/instances");
  expect(instances.find((instance: { instanceId: string }) => instance.instanceId === "opencodeGo")?.snapshot)
    .toMatchObject({ state: "available", authenticated: true });
}, 60_000);

it("starts the words a later start restored before a message sent while the engines are read", async () => {
  const home = freshHome();
  const first = await boot(home);
  await expect.poll(async () => (await first.get("/api/bots?messages=0")).bots[0]?.modelSelection.instanceId, { timeout: 10_000 }).toBe("opencodeGo");
  const [starter] = (await first.get("/api/bots?messages=0")).bots;
  await first.stop();
  // Words still queued for the conversation when the last run stopped.
  const db = new DatabaseSync(join(home, "messages.db"));
  try {
    db.prepare("INSERT INTO chat_followups(id, kind, owner_id, thread_id, send_id, status, payload) VALUES (?, 'bot', ?, ?, NULL, 'pending', ?)")
      .run("queued_before_restart", starter.id, starter.threadId, JSON.stringify({ text: "Queued before the restart" }));
  } finally { db.close(); }

  const probes = join(home, "probes.log");
  const release = join(home, "release-probe");
  writeFileSync(join(home, "hold-probe"), "");
  const server = await boot(home);
  await expect.poll(() => existsSync(probes) && /^probe \d+$/m.test(readFileSync(probes, "utf8")), { timeout: 10_000 }).toBe(true);
  await server.control("send", "--bot", starter.id, "--task", starter.threadId, "--text", "Sent while the engines are read");
  writeFileSync(release, "");

  const said = async () => ((await server.get(`/api/threads/${starter.threadId}/messages?limit=100`)).messages as Array<{ role: string; text?: string }>)
    .filter((message) => message.role === "user").map((message) => message.text);
  await expect.poll(said, { timeout: 30_000 }).toHaveLength(2);
  expect(await said()).toEqual(["Queued before the restart", "Sent while the engines are read"]);
  expect((await server.control("wait", "--bot", starter.id, "--task", starter.threadId, "--timeout", "30")).status).toBe("settled");
}, 60_000);
