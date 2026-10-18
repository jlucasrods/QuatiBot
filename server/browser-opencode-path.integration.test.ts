import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";
import { openSse, type SseRecorder } from "./testing/sse.ts";
import { verificationServerEnvironment } from "../scripts/control-quati.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const MINIMAL_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

describe.skipIf(process.platform !== "linux")("OpenCode browser turns with a minimal PATH", () => {
  let home: string;
  let bin: string;
  let browser: string;
  let base: string;
  let child: ChildProcess;
  let events: SseRecorder;
  let stderr = "";

  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as any };
  };

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "quati-browser-opencode-path-"));
    bin = join(home, ".local", "bin");
    const data = join(home, ".quatibot");
    mkdirSync(bin, { recursive: true });
    mkdirSync(data);
    const opencode = join(bin, "opencode");
    const wrapper = [
      "#!/usr/bin/env node",
      'import { join } from "node:path";',
      'process.env.FAKE_ACP_VERSION = "2.0.31";',
      'process.env.FAKE_ACP_AGENT_VERSION = "2.0.31";',
      'process.env.FAKE_ACP_MODELS = "fixture/test";',
      'process.env.FAKE_ACP_DUMP = join(process.env.HOME, "opencode-dump.json");',
      `await import(${JSON.stringify(join(SERVER_DIR, "testing", "fake-acp-cli.ts"))});`,
    ].join("\n");
    writeFileSync(opencode, wrapper, { mode: 0o755 });
    symlinkSync(process.execPath, join(bin, "node"));
    browser = join(bin, "agent-browser");
    writeFileSync(browser, "#!/bin/sh\nif [ \"$1\" = session ]; then printf '%s\\n' '{\"success\":true,\"data\":{\"sessions\":[]}}'; fi\nexit 0\n", { mode: 0o755 });
    writeFileSync(join(data, "config.json"), JSON.stringify({
      features: { browser: true },
      instances: Object.fromEntries(["default", "absolute"].map((id) => [id, {
        driver: "opencodeGo",
        config: { cli: id === "default" ? "opencode" : opencode },
      }])),
    }));
    for (const id of ["default", "absolute"]) {
      const discovery = join(data, "providers", id, "discovery");
      mkdirSync(discovery, { recursive: true });
      writeFileSync(join(discovery, ".quati-project"), "");
    }
    const port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: {
        ...verificationServerEnvironment({}, data, port),
        HOME: home, PATH: MINIMAL_PATH, QUATI_AGENT_BROWSER_PATH: browser,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (chunk) => { stderr += chunk; });
    await new Promise<void>((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(new Error(`Fixture did not listen: ${stderr}`)), 25_000);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("exit", () => { clearTimeout(timer); reject(new Error(`Fixture exited: ${stderr}`)); });
      child.stdout!.on("data", (chunk) => {
        output += chunk;
        if (output.includes(`quatibot server on ${base}`)) { clearTimeout(timer); resolve(); }
      });
    });
    events = await openSse(`${base}/api/events`);
  }, 30_000);

  afterAll(async () => {
    events?.close();
    await waitForExit(child, { signal: "SIGTERM" });
    if (home) await removeTempDir(home);
  });

  it.each(["default", "absolute"])("keeps the browser mounted and completes a turn with the %s OpenCode CLI", async (instanceId) => {
    await expect.poll(async () => {
      const instances = (await api("GET", "/api/instances")).body.instances;
      return instances.find((instance: { instanceId: string }) => instance.instanceId === instanceId)?.models.options.some((model: { id: string }) => model.id === "fixture/test");
    }, { timeout: 10_000 }).toBe(true);

    const created = await api("POST", "/api/bots", {
      name: `Browser PATH ${instanceId}`, browser: true,
      modelSelection: { instanceId, model: "fixture/test" },
    });
    expect(created.status).toBe(201);
    const botId = created.body.bot.id;
    const since = events.frames.length;
    expect((await api("POST", `/api/bots/${botId}/messages`, { text: "Check the browser integration." })).status).toBe(202);
    const started = await events.until((frame) => events.frames.indexOf(frame) >= since && frame.kind === "bot" && frame.bot?.id === botId && frame.bot?.busy === true);
    // The creation's idle event can arrive after its HTTP response. Only
    // accept an idle event ordered after this turn became busy.
    await events.until((frame) => events.frames.indexOf(frame) > events.frames.indexOf(started) && frame.kind === "bot" && frame.bot?.id === botId && frame.bot?.busy === false);
    const bot = (await api("GET", "/api/bots")).body.bots.find((item: any) => item.id === botId);
    const replies = bot.messages.filter((message: any) => message.role === "bot").map((message: any) => message.text);
    expect(replies, JSON.stringify(replies)).toContain("hello from fake acp");
    const dump = JSON.parse(readFileSync(join(home, "opencode-dump.json"), "utf8"));
    // Linux may provide /usr/bin/node, so completion alone cannot prove the
    // absolute CLI retained access to the user's discovered runtime directory.
    expect(dump.env.PATH.split(":")).toContain(bin);
    expect(dump.env.PATH).toContain(MINIMAL_PATH);
    const browserMount = dump.mcpServers.find((server: { name: string }) => server.name === "browser");
    expect(browserMount.command).toBe(process.execPath);
    expect(browserMount.args).toContain("browser");
    expect(browserMount.args.some((arg: string) => arg.endsWith("harness-mcp-proxy.ts"))).toBe(true);
    expect(browserMount.env.some((entry: { name: string; value: string }) => entry.name.startsWith("QUATI_MCP_TOKEN") && entry.value)).toBe(true);
    expect(dump.env.AGENT_BROWSER_SESSION).toBeUndefined();
    expect(dump.env.AGENT_BROWSER_ENCRYPTION_KEY).toBeUndefined();
    expect(dump.argv).toContain("acp");
  });
});
