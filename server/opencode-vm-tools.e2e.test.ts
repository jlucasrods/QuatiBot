import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { verificationServerEnvironment } from "../scripts/control-quati.ts";
import { writeFileAtomic } from "./atomic.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
let child: ChildProcess;
let home = "";
let base = "";
let stateFile = "";
let dumpFile = "";
let stderr = "";

interface McpServer {
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
}
interface NativeTurn {
  mcpServers: McpServer[];
}

const FAKE_PODMAN = `#!/usr/bin/env node
const readline = require('node:readline');
const names = ['screenshot', 'click', 'type_text', 'open_url'];
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const result = request.method === 'initialize'
    ? { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake-vm', version: '1' } }
    : request.method === 'tools/list'
      ? { tools: names.map(name => ({ name, inputSchema: { type: 'object', properties: {} } })) }
      : { content: [{ type: 'text', text: 'fake vm ran ' + String(request.params?.name) }] };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
});
rl.on('close', () => process.exit(0));
`;

const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(base + path, {
    method, headers: { "content-type": "application/json", origin: base },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = JSON.parse(await response.text());
  expect(response.ok, `${method} ${path}: ${JSON.stringify(result)}`).toBe(true);
  return result;
};

async function until<T>(read: () => T | Promise<T>, accept: (value: T) => boolean): Promise<T> {
  const end = Date.now() + 20_000;
  for (;;) {
    const value = await read();
    if (accept(value)) return value;
    if (Date.now() >= end) throw new Error(`Fixture wait expired: ${JSON.stringify(value)}\n${stderr}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

const nativeTurns = (threadId: string): NativeTurn[] => {
  if (!existsSync(dumpFile)) return [];
  return readFileSync(dumpFile, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as NativeTurn)
    .filter(turn => turn.mcpServers.some(server => server.env?.some(entry => entry.name === "QUATI_THREAD_ID" && entry.value === threadId)));
};

async function listedTools(server: McpServer) {
  const proxy = spawn(server.command, server.args, {
    env: { PATH: dirname(process.execPath), HOME: home, ...Object.fromEntries(server.env.map(({ name, value }) => [name, value])) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: proxy.stdout! });
  let next = 0;
  const request = (method: string) => new Promise<{ tools?: Array<{ name: string }> }>((resolve, reject) => {
    const id = ++next;
    const timer = setTimeout(() => reject(new Error(`VM MCP ${method} timed out`)), 5_000);
    const receive = (line: string) => {
      const response = JSON.parse(line);
      if (response.id !== id) return;
      clearTimeout(timer);
      lines.off("line", receive);
      if (response.error) reject(new Error(response.error.message));
      else resolve(response.result);
    };
    lines.on("line", receive);
    proxy.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params: method === "initialize"
      ? { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "vm-fixture", version: "1" } } : {} }) + "\n");
  });
  try {
    await request("initialize");
    proxy.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    return (await request("tools/list")).tools?.map(tool => tool.name) ?? [];
  } finally {
    lines.close();
    proxy.stdin!.end();
    await waitForExit(proxy, { signal: "SIGTERM" });
  }
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "quati-opencode-vm-"));
  const data = join(home, "data");
  const fakebin = join(home, "bin");
  const ui = join(home, "static");
  stateFile = join(home, "vm.json");
  dumpFile = join(home, "provider.json.prompts.jsonl");
  writeFileAtomic(stateFile, JSON.stringify({ containers: [] }));
  mkdirSync(fakebin);
  mkdirSync(ui);
  mkdirSync(join(data, "providers", "opencode", "discovery"), { recursive: true });
  writeFileSync(join(data, "providers", "opencode", "discovery", ".quati-project"), "fixture");
  writeFileSync(join(fakebin, "podman"), FAKE_PODMAN, { mode: 0o700 });
  writeFileSync(join(ui, "index.html"), "<title>OpenCode VM tools</title>");
  const cli = join(home, "opencode.mjs");
  writeFileSync(cli, [
    "#!/usr/bin/env node",
    'import { createInterface } from "node:readline";',
    'const input = createInterface({ input: process.stdin });',
    'input.on("line", line => {',
    '  const request = JSON.parse(line);',
    '  if (!["session/new", "session/load"].includes(request.method)) return;',
    '  const vm = request.params.mcpServers?.some(server => server.name === "computer");',
    `  process.env.FAKE_ACP_GATE_FILE = ${JSON.stringify(home)} + (vm ? "/vm-finish" : "/plain-finish");`,
    '});',
    `await import(${JSON.stringify(pathToFileURL(join(ROOT, "server/testing/fake-acp-cli.ts")).href)});`,
  ].join("\n"), { mode: 0o700 });
  writeFileSync(join(data, "config.json"), JSON.stringify({
    localVm: { mode: "per-bot" },
    instances: { opencodeGo: { driver: "opencodeGo", config: { cli } } },
    defaultModelSelection: { instanceId: "opencodeGo", model: "fixture/test" },
  }));
  const port = await freePortBlock([0, 1]);
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [
    "--import", pathToFileURL(join(ROOT, "server/testing/group-local-vm-hooks.mjs")).href,
    join(ROOT, "server/index.ts"),
  ], {
    cwd: ROOT,
    env: { ...verificationServerEnvironment({}, data, port), HOME: home,
      PATH: [fakebin, dirname(process.execPath)].join(delimiter),
      QUATI_EXTRA_PATH: fakebin, QUATI_STATIC_DIR: ui, QUATI_TEST_VM_STATE: stateFile,
      QUATI_USER_DATA: join(home, "user-data"), FAKE_ACP_MODE: "echo-gated",
      FAKE_ACP_DUMP: join(home, "provider.json"), FAKE_ACP_MODELS: "fixture/test",
      FAKE_ACP_VERSION: "2.0.31", FAKE_ACP_AGENT_VERSION: "2.0.31", FAKE_ACP_AGENT_NAME: "OpenCode" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout!.on("data", () => {});
  child.stderr!.on("data", chunk => { stderr += chunk; });
  await until(async () => {
    if (child.exitCode !== null) throw new Error(stderr);
    try { return (await fetch(base + "/api/health")).ok; } catch { return false; }
  }, Boolean);
  await until(() => api("GET", "/api/instances"), state => state.instances.some((instance: { models: { options: Array<{ id: string }> } }) => instance.models.options.some(model => model.id === "fixture/test")));
});

afterAll(async () => {
  await waitForExit(child, { signal: "SIGTERM" });
  if (home) await removeTempDir(home);
});

describe("OpenCode Local VM MCP tools", () => {
  it.each([false, true])("lists the actual VM tools after a native mount (selected in chat: %s)", async selectedInChat => {
    rmSync(join(home, "vm-finish"), { force: true });
    rmSync(join(home, "plain-finish"), { force: true });
    writeFileAtomic(stateFile, JSON.stringify({ containers: [] }));
    const { bot } = await api("POST", "/api/bots", { name: "OpenCode VM" });
    await api("PATCH", `/api/bots/${bot.id}`, { computer: selectedInChat ? "browser" : "vm", browser: false });
    try {
      await api("POST", `/api/bots/${bot.id}/messages`, { text: "Inspect the isolated VM." });
      await until(() => nativeTurns(bot.threadId).length, count => count === 1);
      if (selectedInChat) {
        const before = nativeTurns(bot.threadId)[0]!;
        expect(before.mcpServers.some(server => server.name === "computer")).toBe(false);
        const agents = before.mcpServers.find(server => server.name === "agents")!;
        const token = Object.fromEntries(agents.env.map(({ name, value }) => [name, value])).QUATI_COMMS_TOKEN;
        const response = await fetch(base + "/api/internal/computer/select", {
          method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({ surface: "vm" }),
        });
        expect(response.status).toBe(200);
        writeFileSync(join(home, "plain-finish"), "finish");
        await until(() => nativeTurns(bot.threadId).length, count => count === 2);
      }
      const mounted = nativeTurns(bot.threadId).at(-1)!.mcpServers.find(server => server.name === "computer");
      expect(mounted).toBeDefined();
      expect(await listedTools(mounted!)).toEqual(expect.arrayContaining(["screenshot", "click", "type_text", "open_url"]));
      expect((await api("GET", `/api/threads/${bot.threadId}/messages`)).messages.some((message: { card?: unknown }) => message.card)).toBe(false);
    } finally {
      writeFileSync(join(home, "vm-finish"), "finish");
      writeFileSync(join(home, "plain-finish"), "finish");
      await until(() => api("GET", "/api/bots?messages=0"), state => !state.bots.find((candidate: { id: string }) => candidate.id === bot.id)?.busy);
      await api("DELETE", `/api/bots/${bot.id}`);
    }
  }, 60_000);
});
