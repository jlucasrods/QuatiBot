import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";

import { launchVerificationServer, runControlQuati, verificationServerEnvironment } from "../scripts/control-quati.ts";
import { waitForExit } from "./testing/cleanup.ts";

const jsonl = (path: string) => existsSync(path)
  ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
// The stand-in browser is a node script run through its shebang.
const withBrowser = process.platform !== "win32";

async function fixture(test: (f: any) => Promise<void>) {
  const session = await launchVerificationServer();
  const { dataDir, url, logPath } = session.info;
  let server: ChildProcess | undefined;
  try {
    const rpcPath = join(dataDir, "acp-rpc.jsonl");
    const acpDump = join(dataDir, "acp-dump.json");
    const release = join(dataDir, "release");
    const wrapper = join(dataDir, "warm-opencode.mjs");
    writeFileSync(wrapper, [
      "#!/usr/bin/env node",
      `Object.assign(process.env, ${JSON.stringify({ FAKE_ACP_MODE: "echo-gated", FAKE_ACP_GATE_FILE: release,
        FAKE_ACP_MODELS: "fixture/warm", FAKE_ACP_RPC_APPEND_FILE: rpcPath, FAKE_ACP_DUMP: acpDump,
        FAKE_ACP_UNIQUE_SESSIONS: "1", FAKE_ACP_VERSION: "2.0.31", FAKE_ACP_AGENT_VERSION: "2.0.31", FAKE_ACP_AGENT_NAME: "OpenCode" })});`,
      `await import(${JSON.stringify(pathToFileURL(fileURLToPath(new URL("./testing/fake-acp-cli.ts", import.meta.url))).href)});`,
    ].join("\n"), { mode: 0o700 });
    const browser = join(dataDir, "agent-browser.mjs");
    writeFileSync(browser, [
      "#!/usr/bin/env node",
      'if (process.argv[2] === "session" && process.argv[3] === "list") process.stdout.write(JSON.stringify({ success: true, data: { sessions: [] } }));',
    ].join("\n"), { mode: 0o700 });
    await waitForExit(session.child, { signal: "SIGTERM" });
    const configPath = join(dataDir, "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.instances.opencodeGo = {
      driver: "opencodeGo", displayName: "ACP fixture",
      config: { cli: wrapper },
    };
    config.defaultModelSelection = { instanceId: "opencodeGo", model: "fixture/warm" };
    writeFileSync(configPath, JSON.stringify(config));
    const log = openSync(logPath, "a", 0o600);
    server = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: {
        ...verificationServerEnvironment({}, dataDir, Number(new URL(url).port)),
        ...(withBrowser ? { QUATI_AGENT_BROWSER_PATH: browser } : {}),
      },
      stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(async () => {
      try { return (await fetch(url + "/api/health", { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
    }, { timeout: 20_000 }).toBe(true);

    const cli = (...args: string[]) => runControlQuati([...args, "--url", url]) as Promise<any>;
    const api = async (method: string, path: string, body?: unknown, token?: string) => {
      const response = await fetch(url + path, {
        method,
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : { origin: url }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
      });
      return { status: response.status, body: await response.json().catch(() => ({})) as any };
    };
    const busy = async (bot: any, threadId: string) => (await api("GET", "/api/bots")).body.bots
      .find((entry: any) => entry.id === bot.id)?.tasks.find((task: any) => task.threadId === threadId)?.busy === true;
    const turn = async (bot: any, threadId: string, text: string) => {
      writeFileSync(release, "go");
      await cli("send", "--bot", bot.id, "--task", threadId, "--text", text);
      expect((await cli("wait", "--bot", bot.id, "--task", threadId, "--timeout", "30")).status).toBe("settled");
    };
    const hold = async (bot: any, threadId: string, text: string) => {
      rmSync(release, { force: true });
      const before = nativeTurns().length;
      await cli("send", "--bot", bot.id, "--task", threadId, "--text", text);
      await expect.poll(() => busy(bot, threadId), { timeout: 15_000 }).toBe(true);
      await expect.poll(() => nativeTurns().length, { timeout: 15_000 }).toBe(before + 1);
    };
    const finish = async (bot: any, threadId: string) => {
      writeFileSync(release, "go");
      expect((await cli("wait", "--bot", bot.id, "--task", threadId, "--timeout", "30")).status).toBe("settled");
    };
    const agents = async (token: string) => (await api("GET", "/api/internal/agents", undefined, token)).status;
    const nativeTurns = () => jsonl(`${acpDump}.prompts.jsonl`).filter((turn) => turn.mcpServers.some((mounted: { name: string }) => mounted.name === "agents"));
    const mounts = () => nativeTurns().map((turn) => {
        const agents = turn.mcpServers.find((mounted: { name: string }) => mounted.name === "agents");
        return { sessionId: turn.sessionId, servers: turn.mcpServers.map((mounted: { name: string }) => mounted.name),
          token: agents.env.find((entry: { name: string }) => entry.name === "QUATI_COMMS_TOKEN").value };
      });
    const sessions = () => mounts().filter((turn, index, turns) => turns.findIndex((other) => other.sessionId === turn.sessionId) === index);
    await expect.poll(async () => {
      const snapshot = await api("GET", "/api/instances");
      return snapshot.body.instances.find((entry: { instanceId: string }) => entry.instanceId === "opencodeGo")?.models?.options.map((option: { id: string }) => option.id) ?? [];
    }, { timeout: 15_000 }).toContain("fixture/warm");
    await test({ dataDir, cli, api, turn, hold, finish, agents, sessions, mounts, nativeTurns, rpc: () => jsonl(rpcPath) });
  } finally {
    if (server) await waitForExit(server, { signal: "SIGTERM" });
    await session.close();
  }
}

it("keeps a thread's OpenCode process and ACP session across turns, with agents and the browser mounted", () => fixture(async (f) => {
  const { bot } = await f.cli("new-bot", "--name", "Warm OpenCode");
  await f.turn(bot, bot.activeTaskId, "First question.");
  await f.turn(bot, bot.activeTaskId, "Second question.");
  const warm = f.sessions();
  expect(warm.at(-1).servers).toEqual(expect.arrayContaining(withBrowser ? ["agents", "browser"] : ["agents"]));
  await f.turn(bot, bot.activeTaskId, "Third question.");
  await f.turn(bot, bot.activeTaskId, "Fourth question.");
  expect(f.sessions()).toHaveLength(warm.length);
  const pid = f.nativeTurns()[0].pid;
  const prompts = f.rpc().filter((call: any) => call.pid === pid && call.method === "session/prompt");
  expect(prompts).toHaveLength(4);
  expect(prompts.every((call: any) => call.pid === pid)).toBe(true);
  const established = f.rpc().filter((call: any) => call.pid === pid).map((call: any) => call.method)
    .filter((method: string) => method === "session/new" || method === "session/load");
  expect(established).toEqual(["session/new"]);
}), 120_000);

it("honours a thread's credential only while its turns run, and retires it on Stop, a lower approval level and bot deletion", () => fixture(async (f) => {
  const { bot } = await f.cli("new-bot", "--name", "Credential holder");
  const thread = bot.activeTaskId;
  await f.turn(bot, thread, "Warm up.");
  const token = f.mounts().at(-1).token;
  expect(token).toMatch(/^[a-f0-9]{48}$/);
  expect(await f.agents(token)).toBe(401);
  await f.hold(bot, thread, "Next question.");
  expect(f.mounts().at(-1).token).toBe(token);
  expect(await f.agents(token)).toBe(200);
  await f.finish(bot, thread);
  expect(await f.agents(token)).toBe(401);

  await f.hold(bot, thread, "Something long.");
  expect(await f.agents(token)).toBe(200);
  expect((await f.api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: thread })).status).toBe(200);
  expect(await f.agents(token)).toBe(401);
  const stopped = f.nativeTurns().length;
  await f.hold(bot, thread, "Start again.");
  expect(f.nativeTurns()).toHaveLength(stopped + 1);
  const restarted = f.mounts().at(-1).token;
  expect(restarted).not.toBe(token);
  expect(await f.agents(token)).toBe(401);
  expect(await f.agents(restarted)).toBe(200);
  await f.finish(bot, thread);

  expect((await f.api("PATCH", `/api/bots/${bot.id}/tasks/${thread}`, { approvalMode: "full" })).status).toBe(200);
  await f.turn(bot, thread, "Full access.");
  const raised = f.mounts().at(-1).token;
  expect((await f.api("PATCH", `/api/bots/${bot.id}/tasks/${thread}`, { approvalMode: "ask" })).status).toBe(200);
  const before = f.nativeTurns().length;
  await f.hold(bot, thread, "Ask first now.");
  expect(f.nativeTurns()).toHaveLength(before + 1);
  const lowered = f.mounts().at(-1).token;
  expect(lowered).not.toBe(raised);
  expect(await f.agents(raised)).toBe(401);
  expect(await f.agents(lowered)).toBe(200);

  expect((await f.api("DELETE", `/api/bots/${bot.id}`)).status).toBe(200);
  expect(await f.agents(lowered)).toBe(401);
}), 120_000);
