// A restartable fixture home lets tests seed bots.json between boots: the sourceless pin shapes only exist on disk.
import { spawn, type ChildProcess } from "node:child_process";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { verificationServerEnvironment } from "../scripts/control-quati.ts";
import { freePortBlock } from "./testing/ports.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

describe("surface pin provenance against the real server", () => {
  let home = "";
  let data = "";
  let ui = "";
  let stateFile = "";
  let dumpFile = "";
  let finishFile = "";
  let output = "";
  let child: ChildProcess | null = null;
  let base = "";

  const vmState = (state: Record<string, unknown> = {}) => writeFileSync(stateFile, JSON.stringify(state));
  const resetTurn = () => { vmState(); rmSync(dumpFile, { force: true }); rmSync(finishFile, { force: true }); };
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(base + path, {
      method, headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as any };
  };
  const apiOk = async (method: string, path: string, body?: unknown) => {
    const result = await api(method, path, body);
    expect(result.status, `${method} ${path}: ${JSON.stringify(result.body)}`).toBeLessThan(400);
    return result.body;
  };
  async function until<T>(read: () => T | Promise<T>, accept: (value: T) => boolean): Promise<T> {
    const end = Date.now() + 20_000;
    for (;;) {
      const value = await read();
      if (accept(value)) return value;
      if (Date.now() >= end) throw new Error(`Fixture wait expired: ${JSON.stringify(value)}`);
      await new Promise(resolve => setTimeout(resolve, 40));
    }
  }
  type NativeTurn = { prompt: Array<{ text?: string }>; mcpServers: Array<{ name: string; args: string[]; env?: Array<{ name: string; value: string }> }> };
  const dump = async () => {
    const turn = await until(() => {
      if (!existsSync(dumpFile)) return undefined;
      try {
        const turns: NativeTurn[] = readFileSync(dumpFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
        return turns.findLast((entry) => entry.mcpServers.some((server) => server.name === "agents"));
      } catch { return undefined; }
    }, Boolean);
    assert(turn);
    return turn;
  };
  const mountedComputer = (sent: NativeTurn) => {
    const mount = sent.mcpServers.find((server) => server.name === "computer");
    assert(mount);
    return { ...mount, env: Object.fromEntries(mount.env?.map(({ name, value }) => [name, value]) ?? []) };
  };
  // The first screen tools/call, exactly as the mounted proxy issues it: a claim and its pin land on use, not on mount.
  const gate = (c: any) => fetch(c.env.QUATI_CONTROL_URL, {
    headers: { authorization: `Bearer ${c.env.QUATI_CONTROL_TOKEN}` },
  }).then(response => response.json() as Promise<any>);
  const threadState = (botId: string, threadId: string) =>
    api("GET", "/api/bots?messages=0").then(({ body }) =>
      body.bots.find((bot: any) => bot.id === botId)?.tasks.find((task: any) => task.threadId === threadId));
  const busy = (botId: string, threadId: string) => until(() => threadState(botId, threadId), Boolean);
  const idle = (botId: string, threadId: string) => until(() => threadState(botId, threadId), task => !task?.busy);
  const savedTask = (botId: string, threadId: string) =>
    (JSON.parse(readFileSync(join(data, "bots.json"), "utf8")) as any[])
      .find((bot: any) => bot.id === botId)?.tasks.find((task: any) => task.threadId === threadId);
  const editSavedBot = (botId: string, edit: (bot: any) => void) => {
    const bots = JSON.parse(readFileSync(join(data, "bots.json"), "utf8")) as any[];
    edit(bots.find((bot: any) => bot.id === botId));
    writeFileSync(join(data, "bots.json"), JSON.stringify(bots, null, 2));
  };

  async function start() {
    const port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    output = "";
    const proc = spawn(process.execPath, ["--import", pathToFileURL(join(ROOT, "server/testing/group-local-vm-hooks.mjs")).href, join(ROOT, "server/index.ts")], {
      cwd: ROOT, env: {
        ...verificationServerEnvironment({}, data, port), HOME: home,
        QUATI_STATIC_DIR: ui, QUATI_TEST_VM_STATE: stateFile, QUATI_USER_DATA: join(home, "user-data"),
        FAKE_ACP_MODE: "echo-gated", FAKE_ACP_GATE_FILE: finishFile, FAKE_ACP_DUMP: join(home, "provider.json"),
        FAKE_ACP_VERSION: "2.0.31", FAKE_ACP_AGENT_VERSION: "2.0.31", FAKE_ACP_AGENT_NAME: "OpenCode", FAKE_ACP_MODELS: "fixture/test",
      }, stdio: ["ignore", "pipe", "pipe"],
    });
    child = proc;
    proc.stdout!.on("data", chunk => { output += chunk; });
    proc.stderr!.on("data", chunk => { output += chunk; });
    await until(async () => {
      if (proc.exitCode !== null) throw new Error(`server exited during boot:\n${output}`);
      try { return (await fetch(base + "/api/health")).ok; } catch { return false; }
    }, Boolean);
    await until(async () => (await apiOk("GET", "/api/instances")).instances.find((instance: { instanceId: string }) =>
      instance.instanceId === "opencodeGo")?.models.options.some((option: { id: string }) => option.id === "fixture/test"), Boolean);
  }
  async function stop() {
    if (!child) return;
    const proc = child;
    child = null;
    writeFileSync(finishFile, "finish");
    await waitForExit(proc, { signal: "SIGTERM" });
  }

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "quati-surface-pins-"));
    data = join(home, "data");
    ui = join(home, "static");
    stateFile = join(home, "vm.json");
    dumpFile = join(home, "provider.json.prompts.jsonl");
    finishFile = join(home, "finish");
    vmState();
    mkdirSync(data);
    mkdirSync(join(ui, "assets"), { recursive: true });
    writeFileSync(join(ui, "index.html"), "<title>Surface pins</title>");
    writeFileSync(join(ui, "assets", "test.css"), "body{}");
    const discovery = join(data, "providers", "opencode", "discovery");
    mkdirSync(discovery, { recursive: true });
    writeFileSync(join(discovery, ".quati-project"), "fixture");
    writeFileSync(join(data, "config.json"), JSON.stringify({ instances: { opencodeGo: {
      driver: "opencodeGo", config: { cli: join(ROOT, "server/testing/fake-acp-cli.ts") },
    } }, defaultModelSelection: { instanceId: "opencodeGo", model: "fixture/test" } }));
  });
  afterAll(async () => {
    await stop();
    if (home) await removeTempDir(home);
  });
  afterEach(async () => { await stop(); resetTurn(); });

  it("marks a person's thread pin as theirs and clears provenance with the pin", async () => {
    await start();
    const { bot } = await apiOk("POST", "/api/bots", { name: "Pin Bot" });
    const { task } = await apiOk("POST", `/api/bots/${bot.id}/tasks`, {});
    await apiOk("PATCH", `/api/bots/${bot.id}/tasks/${task.threadId}`, { surface: "browser" });
    expect(savedTask(bot.id, task.threadId)).toMatchObject({ surface: "browser", surfaceSource: "user" });
    const personPin = await threadState(bot.id, task.threadId);
    expect(personPin).toMatchObject({ surface: "browser" });
    expect(personPin).not.toHaveProperty("surfaceAuto");
    await apiOk("PATCH", `/api/bots/${bot.id}/tasks/${task.threadId}`, { surface: null });
    const cleared = savedTask(bot.id, task.threadId)!;
    expect(cleared.surface).toBeUndefined();
    expect(cleared.surfaceSource).toBeUndefined();
    await apiOk("DELETE", `/api/bots/${bot.id}`);
    await stop();
  });

  it("still refuses to change a busy thread's surface", async () => {
    await start();
    const { bot } = await apiOk("POST", "/api/bots", { name: "Busy Pin Bot" });
    const { task } = await apiOk("POST", `/api/bots/${bot.id}/tasks`, {});
    resetTurn();
    await apiOk("POST", `/api/bots/${bot.id}/messages`, { text: "Work slowly.", threadId: task.threadId });
    await busy(bot.id, task.threadId);
    expect(await gate(mountedComputer(await dump()))).toEqual({ held: false, helpOpen: false });
    await until(() => savedTask(bot.id, task.threadId)?.surface === "vm", Boolean);
    const refused = await api("PATCH", `/api/bots/${bot.id}/tasks/${task.threadId}`, { surface: "vm" });
    expect(refused.status).toBe(409);
    const pinned = savedTask(bot.id, task.threadId)!;
    expect(pinned.surface).toBe("vm");
    expect(pinned.surfaceSource).toBe("auto");
    writeFileSync(finishFile, "finish");
    await idle(bot.id, task.threadId);
    await apiOk("DELETE", `/api/bots/${bot.id}`);
    await stop();
  });

  it("sweeps only conflicting auto pins when Works on is set, and nothing when it returns to Auto", async () => {
    await start();
    const { bot } = await apiOk("POST", "/api/bots", { name: "Sweep Bot" });
    const [autoMismatch, personMismatch, autoMatch] = (await Promise.all([
      apiOk("POST", `/api/bots/${bot.id}/tasks`, {}),
      apiOk("POST", `/api/bots/${bot.id}/tasks`, {}),
      apiOk("POST", `/api/bots/${bot.id}/tasks`, {}),
    ])).map(({ task }) => task);
    await apiOk("PATCH", `/api/bots/${bot.id}/tasks/${personMismatch.threadId}`, { surface: "browser" });
    await stop();
    editSavedBot(bot.id, saved => {
      Object.assign(saved.tasks.find((task: any) => task.threadId === autoMismatch.threadId), { surface: "browser", surfaceSource: "auto" });
      Object.assign(saved.tasks.find((task: any) => task.threadId === autoMatch.threadId), { surface: "vm", surfaceSource: "auto" });
    });
    await start();
    expect(output).not.toContain("auto-pinned");
    expect(savedTask(bot.id, autoMismatch.threadId)?.surface).toBe("browser");
    await apiOk("PATCH", `/api/bots/${bot.id}`, { computer: "vm" });
    expect(savedTask(bot.id, autoMismatch.threadId)?.surface).toBeUndefined();
    expect(savedTask(bot.id, personMismatch.threadId)).toMatchObject({ surface: "browser", surfaceSource: "user" });
    expect(savedTask(bot.id, autoMatch.threadId)?.surface).toBe("vm");
    await apiOk("PATCH", `/api/bots/${bot.id}`, { computer: null });
    expect(savedTask(bot.id, personMismatch.threadId)).toMatchObject({ surface: "browser", surfaceSource: "user" });
    expect(savedTask(bot.id, autoMatch.threadId)?.surface).toBe("vm");
    expect(savedTask(bot.id, autoMismatch.threadId)?.surface).toBeUndefined();
    await apiOk("DELETE", `/api/bots/${bot.id}`);
    await stop();
  });

  it("preserves pre-provenance user pins at boot and after Works on changes", async () => {
    await start();
    const { bot } = await apiOk("POST", "/api/bots", { name: "Repair Bot" });
    const { task } = await apiOk("POST", `/api/bots/${bot.id}/tasks`, {});
    await apiOk("PATCH", `/api/bots/${bot.id}/tasks/${task.threadId}`, { surface: "browser" });
    await stop();
    editSavedBot(bot.id, saved => {
      saved.computer = "vm";
      const target = saved.tasks.find((entry: any) => entry.threadId === task.threadId);
      target.surface = "browser";
      delete target.surfaceSource;
    });
    await start();
    expect(output).not.toContain("auto-pinned thread");
    expect(savedTask(bot.id, task.threadId)?.surface).toBe("browser");
    expect(savedTask(bot.id, task.threadId)?.surfaceSource).toBeUndefined();
    const place = await apiOk("GET", `/api/bots/${bot.id}/computer?threadId=${task.threadId}`);
    expect(place.surface).toBe("browser");
    await apiOk("PATCH", `/api/bots/${bot.id}`, { computer: "browser" });
    expect(savedTask(bot.id, task.threadId)?.surface).toBe("browser");
    await stop();
    await start();
    expect(output).not.toContain("auto-pinned thread");
    expect(savedTask(bot.id, task.threadId)?.surface).toBe("browser");
    await apiOk("DELETE", `/api/bots/${bot.id}`);
    await stop();
  });

  it("mounts the VM for a thread previously auto-pinned to the browser", async () => {
    await start();
    const { bot } = await apiOk("POST", "/api/bots", { name: "Incident Bot" });
    const { task } = await apiOk("POST", `/api/bots/${bot.id}/tasks`, {});
    await apiOk("PATCH", `/api/bots/${bot.id}/tasks/${task.threadId}`, { surface: "browser" });
    await stop();
    editSavedBot(bot.id, saved => {
      saved.computer = "vm";
      saved.tasks.find((entry: any) => entry.threadId === task.threadId).surfaceSource = "auto";
    });
    await start();
    expect(output.match(/auto-pinned thread/g)).toHaveLength(1);
    await stop();
    await start();
    expect(output).not.toContain("auto-pinned thread");
    resetTurn();
    await apiOk("POST", `/api/bots/${bot.id}/messages`, { text: "Work where you should.", threadId: task.threadId });
    const sent = await dump();
    const prompt = sent.prompt.map((block) => block.text ?? "").join("\n");
    expect(prompt).toContain("Local VM");
    expect(mountedComputer(sent).args.some((arg: string) => arg.includes("container-mcp"))).toBe(true);
    expect(prompt).not.toContain("You can act on the user's computer");
    writeFileSync(finishFile, "finish");
    await idle(bot.id, task.threadId);
    expect(savedTask(bot.id, task.threadId)?.surface).toBeUndefined();
    await apiOk("DELETE", `/api/bots/${bot.id}`);
    await stop();
  });

  it("records future auto pins and moves them when Works on changes", async () => {
    await start();
    const { bot } = await apiOk("POST", "/api/bots", { name: "New Auto Pin Bot" });
    const { task } = await apiOk("POST", `/api/bots/${bot.id}/tasks`, {});
    resetTurn();
    await apiOk("POST", `/api/bots/${bot.id}/messages`, { text: "Use the available computer.", threadId: task.threadId });
    expect(mountedComputer(await dump()).args.some((arg: string) => arg.includes("container-mcp"))).toBe(true);
    expect(savedTask(bot.id, task.threadId)).not.toHaveProperty("surface");
    expect(await gate(mountedComputer(await dump()))).toEqual({ held: false, helpOpen: false });
    await until(() => savedTask(bot.id, task.threadId)?.surface === "vm", Boolean);
    expect(savedTask(bot.id, task.threadId)).toMatchObject({ surface: "vm", surfaceSource: "auto" });
    expect(await threadState(bot.id, task.threadId)).not.toHaveProperty("surfaceSource");
    expect(await threadState(bot.id, task.threadId)).toMatchObject({ surface: "vm", surfaceAuto: true });
    expect(savedTask(bot.id, task.threadId)).not.toHaveProperty("surfaceAuto");
    writeFileSync(finishFile, "finish");
    await idle(bot.id, task.threadId);
    await stop();
    await start();
    expect(savedTask(bot.id, task.threadId)).toMatchObject({ surface: "vm", surfaceSource: "auto" });
    await apiOk("PATCH", `/api/bots/${bot.id}`, { computer: "off" });
    expect(savedTask(bot.id, task.threadId)?.surface).toBeUndefined();
    expect(savedTask(bot.id, task.threadId)?.surfaceSource).toBeUndefined();
    resetTurn();
    await apiOk("POST", `/api/bots/${bot.id}/messages`, { text: "Continue without a computer.", threadId: task.threadId });
    expect((await dump()).mcpServers.some((server) => server.name === "computer")).toBe(false);
    writeFileSync(finishFile, "finish");
    await idle(bot.id, task.threadId);
    await apiOk("DELETE", `/api/bots/${bot.id}`);
    await stop();
  });

  it("clears a select_computer pin to a VM that fails, and keeps a person's pin", async () => {
    await start();
    const { bot } = await apiOk("POST", "/api/bots", { name: "Failed place bot" });
    const { task } = await apiOk("POST", `/api/bots/${bot.id}/tasks`, {});
    await apiOk("PATCH", `/api/bots/${bot.id}`, { computer: "browser", browser: false });
    const lastRow = async () => {
      const { messages } = await apiOk("GET", `/api/threads/${task.threadId}/messages?limit=30`);
      return String(messages.filter((message: any) => message.kind !== "digest").at(-1)?.tool?.name ?? "");
    };
    resetTurn();
    await apiOk("POST", `/api/bots/${bot.id}/messages`, { text: "Open Chrome on the VM.", threadId: task.threadId });
    const sent = await dump();
    const token = sent.mcpServers.find((server) => server.name === "agents")?.env?.find((entry) => entry.name === "QUATI_COMMS_TOKEN")?.value;
    const selected = await fetch(base + "/api/internal/computer/select", { method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ surface: "vm" }) });
    expect(await selected.json()).toMatchObject({ status: "pending", surface: "vm" });
    vmState({ failed: true });
    writeFileSync(finishFile, "finish");
    await until(() => lastRow(), row => row.startsWith("error:"));
    await idle(bot.id, task.threadId);
    expect(await lastRow()).toContain("fixture desktop unavailable");
    const cleared = savedTask(bot.id, task.threadId)!;
    expect(cleared.surface).toBeUndefined();
    expect(cleared.surfaceSource).toBeUndefined();
    resetTurn();
    await apiOk("POST", `/api/bots/${bot.id}/messages`, { text: "Carry on where you can.", threadId: task.threadId });
    const next = await dump();
    expect(next.mcpServers.some((server) => server.name === "computer")).toBe(false);
    writeFileSync(finishFile, "finish");
    await idle(bot.id, task.threadId);
    expect(await lastRow()).not.toMatch(/^error:/);

    await apiOk("PATCH", `/api/bots/${bot.id}/tasks/${task.threadId}`, { surface: "vm" });
    resetTurn();
    vmState({ failed: true });
    await apiOk("POST", `/api/bots/${bot.id}/messages`, { text: "Use the VM.", threadId: task.threadId });
    await until(() => lastRow(), row => row.startsWith("error:"));
    await idle(bot.id, task.threadId);
    expect(await lastRow()).toContain("fixture desktop unavailable");
    expect(savedTask(bot.id, task.threadId)).toMatchObject({ surface: "vm", surfaceSource: "user" });
    vmState();
    await apiOk("DELETE", `/api/bots/${bot.id}`);
    await stop();
  });

  it("never takes a relayed line's conversation for where the person writes, when select_computer continues its turn", async () => {
    await start();
    const { bot } = await apiOk("POST", "/api/bots", { name: "Relayed place bot" });
    await apiOk("PATCH", `/api/bots/${bot.id}`, { computer: "browser", browser: false });
    const { task } = await apiOk("POST", `/api/bots/${bot.id}/tasks`, { approvalMode: "ask" });
    const lastRow = async () => {
      const { messages } = await apiOk("GET", `/api/threads/${task.threadId}/messages?limit=30`);
      return String(messages.filter((message: any) => message.kind !== "digest").at(-1)?.tool?.name ?? "");
    };
    resetTurn();
    await apiOk("POST", `/api/bots/${bot.id}/messages/guarded`, {
      threadId: task.threadId, sendId: randomUUID(), text: "Check the dashboard on the VM.", expectedActiveLeafId: null,
    });
    const sent = await dump();
    const token = sent.mcpServers.find((server) => server.name === "agents")?.env?.find((entry) => entry.name === "QUATI_COMMS_TOKEN")?.value;
    const selected = await fetch(base + "/api/internal/computer/select", { method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ surface: "vm" }) });
    expect(await selected.json()).toMatchObject({ status: "pending", surface: "vm" });
    vmState({ failed: true });
    writeFileSync(finishFile, "finish");
    await until(() => lastRow(), row => row.startsWith("error:"));
    await idle(bot.id, task.threadId);
    expect(savedTask(bot.id, task.threadId)).not.toHaveProperty("askedAt");
    vmState();
    await apiOk("DELETE", `/api/bots/${bot.id}`);
    await stop();
  });
});
