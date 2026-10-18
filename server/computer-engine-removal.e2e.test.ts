import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { runControlQuati, verificationServerEnvironment } from "../scripts/control-quati.ts";
import type { AppConfig } from "./config.ts";
import type { BotRecord } from "./store.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FAKE_CLI = join(ROOT, "server/testing/fake-acp-cli.ts");
const ENGINE_NAME = "Verification OpenCode";
const REMOVED = "The Computer choice in the model list was removed.";
const MODEL = "fixture/default";

function entry(cli = FAKE_CLI) {
  return { driver: "opencodeGo", displayName: ENGINE_NAME, config: { cli } };
}

function install(home: string) {
  const data = join(home, "data");
  const dumpFile = join(home, "provider.json");
  let child: ChildProcess | null = null;
  let base = "";
  let output = "";
  mkdirSync(join(data, "providers", "opencode", "discovery"), { recursive: true });
  writeFileSync(join(data, "providers", "opencode", "discovery", ".quati-project"), "fixture");
  mkdirSync(join(home, "static", "assets"), { recursive: true });
  writeFileSync(join(home, "static", "index.html"), "<title>Engine selection recovery</title>");

  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(base + path, {
      method, headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = JSON.parse(await response.text());
    expect(response.status, `${method} ${path}: ${JSON.stringify(result)}`).toBeLessThan(400);
    return result;
  };
  const bot = async (botId: string) => {
    const result = await api("GET", "/api/bots?messages=0");
    return result.bots.find((stored: { id: string }) => stored.id === botId);
  };
  const editConfig = (edit: (config: AppConfig) => void) => {
    const path = join(data, "config.json");
    const config = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
    edit(config);
    writeFileSync(path, JSON.stringify(config));
  };
  const editBot = (botId: string, edit: (saved: BotRecord) => void) => {
    const path = join(data, "bots.json");
    const bots = JSON.parse(readFileSync(path, "utf8"));
    edit(bots.find((saved: { id: string }) => saved.id === botId));
    writeFileSync(path, JSON.stringify(bots));
  };
  const moveLines = async (threadId: string) => {
    const result = await api("GET", `/api/threads/${threadId}/messages?limit=50`);
    return result.messages.filter((message: { tool?: { name?: string } }) => message.tool?.name?.includes(REMOVED))
      .map((message: { tool: { name: string } }) => message.tool.name);
  };
  const start = async () => {
    const port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    output = "";
    const proc = spawn(process.execPath, [join(ROOT, "server/index.ts")], {
      cwd: ROOT, env: {
        ...verificationServerEnvironment({}, data, port), HOME: home,
        QUATI_STATIC_DIR: join(home, "static"),
        FAKE_ACP_DUMP: dumpFile, FAKE_ACP_VERSION: "2.0.31", FAKE_ACP_AGENT_VERSION: "2.0.31",
        FAKE_ACP_AGENT_NAME: "OpenCode", FAKE_ACP_MODELS: MODEL,
      }, stdio: ["ignore", "pipe", "pipe"],
    });
    child = proc;
    proc.stdout!.on("data", chunk => { output += chunk; });
    proc.stderr!.on("data", chunk => { output += chunk; });
    await expect.poll(async () => {
      if (proc.exitCode !== null) throw new Error(output);
      try { return (await fetch(base + "/api/health")).ok; } catch { return false; }
    }, { timeout: 20_000 }).toBe(true);

    const configured = JSON.parse(readFileSync(join(data, "config.json"), "utf8"));
    for (const [id, instance] of Object.entries(configured.instances ?? {})) {
      const configuredInstance = instance as ReturnType<typeof entry>;
      if (configuredInstance.driver !== "opencodeGo" || !existsSync(configuredInstance.config.cli)) continue;
      await expect.poll(async () => (await api("GET", "/api/instances")).instances
        .find((candidate: { instanceId: string }) => candidate.instanceId === id)?.models.default,
      { timeout: 15_000 }).toBe(MODEL);
    }
  };
  const stop = async () => {
    if (!child) return;
    const proc = child;
    child = null;
    await waitForExit(proc, { signal: "SIGTERM" });
  };
  const turn = async (botId: string, threadId: string) => {
    rmSync(`${dumpFile}.prompts.jsonl`, { force: true });
    await runControlQuati(["send", "--bot", botId, "--task", threadId, "--text", "Reply once.", "--url", base]);
    const result = await runControlQuati(["wait", "--bot", botId, "--task", threadId, "--timeout", "30", "--url", base]);
    expect(result).toMatchObject({ status: "settled" });
    const turns = readFileSync(`${dumpFile}.prompts.jsonl`, "utf8").trim().split("\n").map(line => JSON.parse(line));
    return turns.findLast((turn) => turn.mcpServers.some((server: { env?: Array<{ name: string; value: string }> }) =>
      server.env?.some(item => item.name === "QUATI_THREAD_ID" && item.value === threadId)));
  };
  const send = async (botId: string, threadId: string) => {
    const response = await fetch(`${base}/api/bots/${botId}/messages`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ threadId, text: "hello" }),
    });
    await response.arrayBuffer();
    return response.status;
  };
  return { data, api, bot, editConfig, editBot, moveLines, start, stop, turn, send, log: () => output };
}

describe("recovering selections of the removed Computer engine", () => {
  const fixtures: Array<{ home: string; server: ReturnType<typeof install> }> = [];
  const fresh = () => {
    const home = mkdtempSync(join(tmpdir(), "quati-computer-engine-"));
    const server = install(home);
    fixtures.push({ home, server });
    return { home, server };
  };
  afterAll(async () => {
    for (const { home, server } of fixtures) {
      await server.stop();
      await removeTempDir(home);
    }
  });

  it("moves obsolete model selections once without replacing explicit places or other conversation models", async () => {
    const { server } = fresh();
    server.editConfig(config => { config.instances = { opencodeGo: entry() }; });
    await server.start();
    const [starter] = (await server.api("GET", "/api/bots?messages=0")).bots;
    const { task: opened } = await server.api("POST", `/api/bots/${starter.id}/tasks`, {});
    const { bot: auto } = await server.api("POST", "/api/bots", { name: "Atlas" });
    const { bot: mixed } = await server.api("POST", "/api/bots", { name: "Iris" });
    const { task: mixedTask } = await server.api("POST", `/api/bots/${mixed.id}/tasks`, {});
    await server.stop();

    const retired = { instanceId: "computer", model: "obsolete-model" };
    server.editConfig(config => Object.assign(config, {
      instances: { opencodeGo: entry(), computer: { driver: "boxAgent" } },
      defaultModelSelection: retired, newBotDefaults: { profile: { modelSelection: retired } },
      automaticRecovery: { enabled: true, backup: retired },
    }));
    server.editBot(starter.id, saved => {
      saved.modelSelection = retired;
      saved.computer = "browser";
      saved.fallback = [retired];
      saved.resumeCursors = { computer: "obsolete-native-run" };
      for (const task of saved.tasks ?? []) task.modelSelection = retired;
    });
    server.editBot(auto.id, saved => {
      saved.modelSelection = retired;
      delete saved.computer;
      for (const task of saved.tasks ?? []) task.modelSelection = retired;
    });
    server.editBot(mixed.id, saved => {
      saved.tasks!.find(task => task.threadId === mixedTask.threadId)!.modelSelection = retired;
    });

    await server.start();
    const replacement = { instanceId: "opencodeGo", model: MODEL };
    await expect.poll(async () => (await server.bot(starter.id)).modelSelection).toEqual(replacement);
    const moved = await server.bot(starter.id);
    expect(moved.computer).toBe("browser");
    expect(moved.fallback ?? []).toEqual([]);
    expect(moved.threadId).toBe(opened.threadId);
    expect(moved.tasks.every((task: { modelSelection: unknown }) => JSON.stringify(task.modelSelection) === JSON.stringify(replacement))).toBe(true);
    const starterLine = `${starter.name} now uses ${ENGINE_NAME}. ${REMOVED}`;
    const conversationLine = `This conversation now uses ${ENGINE_NAME}. ${REMOVED}`;
    expect(await server.moveLines(opened.threadId)).toEqual([starterLine]);
    expect(await server.moveLines(starter.threadId)).toEqual([conversationLine]);
    expect((await server.bot(auto.id)).computer).toBeUndefined();
    expect(await server.moveLines(auto.threadId)).toEqual([`Atlas now uses ${ENGINE_NAME}. ${REMOVED}`]);
    expect((await server.bot(mixed.id)).modelSelection).toEqual(mixed.modelSelection);
    expect(await server.moveLines(mixed.threadId)).toEqual([]);
    expect(await server.moveLines(mixedTask.threadId)).toEqual([conversationLine]);
    expect((await server.bot(mixed.id)).tasks.find((task: { threadId: string }) => task.threadId === mixedTask.threadId).surface).toBeUndefined();
    const defaults = await server.api("GET", "/api/bot-defaults");
    expect(defaults.defaults.profile.modelSelection).toEqual(replacement);
    expect(defaults.modelSelection).toEqual(replacement);
    expect((await server.api("POST", "/api/bots", { name: "Nova" })).bot.modelSelection).toEqual(replacement);
    expect((await server.api("GET", "/api/config")).automaticRecovery).toEqual({ enabled: false });

    await server.stop();
    await server.start();
    expect(await server.moveLines(opened.threadId)).toEqual([starterLine]);
    expect(await server.moveLines(starter.threadId)).toEqual([conversationLine]);
    const nativeTurn = await server.turn(starter.id, opened.threadId);
    expect(nativeTurn.model).toBe(MODEL);
    expect(nativeTurn.mcpServers.some((mounted: { name: string }) => mounted.name === "computer")).toBe(false);
    await server.stop();
  }, 90_000);

  it("retries the move when OpenCode becomes available without restarting the server", async () => {
    const { home, server } = fresh();
    const cli = join(home, "later", "opencode.mjs");
    server.editConfig(config => { config.instances = { later: entry(cli) }; });
    await server.start();
    const [starter] = (await server.api("GET", "/api/bots?messages=0")).bots;
    await server.stop();
    server.editBot(starter.id, saved => {
      saved.modelSelection = { instanceId: "computer", model: "obsolete-model" };
      for (const task of saved.tasks ?? []) task.modelSelection = saved.modelSelection;
    });
    await server.start();
    expect((await server.bot(starter.id)).modelSelection.instanceId).toBe("computer");
    mkdirSync(dirname(cli), { recursive: true });
    writeFileSync(cli, `#!/usr/bin/env node\nawait import(${JSON.stringify(pathToFileURL(FAKE_CLI).href)});\n`, { mode: 0o700 });
    await server.api("POST", "/api/instances/later/refresh-models", {});
    await server.api("GET", "/api/instances");
    await expect.poll(async () => (await server.bot(starter.id)).modelSelection, { timeout: 15_000 }).toEqual({ instanceId: "later", model: MODEL });
    expect(await server.moveLines(starter.threadId)).toEqual([`${starter.name} now uses ${ENGINE_NAME}. ${REMOVED}`]);
    await server.stop();
  }, 90_000);

  it("keeps serving after a failed migration and persists it when storage becomes writable", async () => {
    const { server } = fresh();
    server.editConfig(config => { config.instances = { opencodeGo: entry() }; });
    await server.start();
    const [starter] = (await server.api("GET", "/api/bots?messages=0")).bots;
    await server.stop();
    server.editBot(starter.id, saved => {
      saved.modelSelection = { instanceId: "computer", model: "obsolete-model" };
      for (const task of saved.tasks ?? []) task.modelSelection = saved.modelSelection;
    });
    const teams = join(server.data, "section-contexts.json");
    writeFileSync(teams, "not json");
    await server.start();
    expect(server.log()).toContain("[engines] moving bots off the removed Computer engine failed");
    expect((await server.bot(starter.id)).modelSelection.instanceId).toBe("computer");
    expect(await server.moveLines(starter.threadId)).toEqual([]);
    rmSync(teams);
    expect(await server.send(starter.id, starter.threadId)).toBe(409);
    await expect.poll(async () => (await server.bot(starter.id)).modelSelection.instanceId, { timeout: 15_000 }).toBe("opencodeGo");
    expect((await server.bot(starter.id)).computer).toBeUndefined();
    expect(await server.moveLines(starter.threadId)).toEqual([`${starter.name} now uses ${ENGINE_NAME}. ${REMOVED}`]);
    await server.stop();
  }, 90_000);
});
