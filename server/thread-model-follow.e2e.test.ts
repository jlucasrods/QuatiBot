import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlQuati, verificationServerEnvironment } from "../scripts/control-quati.ts";
import { waitForExit } from "./testing/cleanup.ts";

const SPARE = "spare";
const FAKE_CLI = fileURLToPath(new URL("./testing/fake-acp-cli.ts", import.meta.url));
const lines = (path: string): unknown[] => existsSync(path)
  ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
const notice = (message: any) => typeof message.tool?.name === "string" && message.tool.name.includes("isn't available, so it now uses");

type Engines = { spare?: "missing" | "disabled" | "signed-out"; claude?: "signed-out" };
type Fixture = {
  api: (method: string, path: string, body?: unknown) => Promise<any>;
  control: (...args: string[]) => Promise<any>;
  restart: (engines: Engines) => Promise<void>;
  prompts: (instance: "claude" | typeof SPARE) => unknown[];
};

async function withEngines(check: (fixture: Fixture) => Promise<void>) {
  const fixture = await launchVerificationServer();
  const { dataDir, url, logPath } = fixture.info;
  let server: ChildProcess | undefined;
  const promptFile = (instance: string) => join(dataDir, `${instance}-dump.json.prompts.jsonl`);
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(url + path, {
      method, headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
    });
    const result = JSON.parse(await response.text());
    expect(response.ok, `${method} ${path}: ${JSON.stringify(result)}`).toBe(true);
    return result;
  };
  const control = (...args: string[]) => runControlQuati([...args, "--url", url]) as Promise<any>;
  const restart = async (engines: Engines) => {
    await waitForExit(server ?? fixture.child, { signal: "SIGTERM" });
    const configPath = join(dataDir, "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    const cli = (instance: string, signedOut: boolean) => {
      const path = join(dataDir, `${instance}-opencode.mjs`);
      writeFileSync(path, `#!${process.execPath}
process.env.FAKE_ACP_AGENT_NAME = 'OpenCode';
process.env.FAKE_ACP_VERSION = '2.0.31';
process.env.FAKE_ACP_AGENT_VERSION = '2.0.31';
process.env.FAKE_ACP_MODELS = 'fixture/default,fixture/alternate';
process.env.FAKE_ACP_AUTH = ${JSON.stringify(signedOut ? "0" : "1")};
process.env.FAKE_ACP_MODE = ${JSON.stringify(signedOut ? "auth-required" : "happy")};
process.env.FAKE_ACP_DUMP = ${JSON.stringify(join(dataDir, `${instance}-dump.json`))};
await import(${JSON.stringify(FAKE_CLI)});
`, { mode: 0o755 });
      return path;
    };
    config.instances = {
      claude: { driver: "opencodeGo", displayName: "Verification fixture", config: { cli: cli("claude", engines.claude === "signed-out") } },
    };
    delete config.instances[SPARE];
    if (engines.spare !== "missing") {
      config.instances[SPARE] = {
        driver: "opencodeGo", displayName: "Spare OpenCode", config: { cli: cli(SPARE, engines.spare === "signed-out") },
        ...(engines.spare === "disabled" ? { enabled: false } : {}),
      };
    }
    config.defaultModelSelection = { instanceId: "claude", model: "fixture/default" };
    writeFileSync(configPath, JSON.stringify(config));
    const log = openSync(logPath, "a", 0o600);
    server = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: verificationServerEnvironment({}, dataDir, Number(new URL(url).port)), stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(async () => {
      try { return (await fetch(url + "/api/health", { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
    }, { timeout: 20_000 }).toBe(true);
    await expect.poll(async () => {
      const { instances } = await api("GET", "/api/instances");
      return instances.filter((entry: { enabled?: boolean }) => entry.enabled !== false).every((entry: { instanceId: string; snapshot: { state: string; authenticated: boolean }; models: { options: { id: string }[] } }) => {
        const signedOut = (entry.instanceId === SPARE ? engines.spare : engines.claude) === "signed-out";
        return entry.snapshot.state === "available" && entry.snapshot.authenticated === !signedOut &&
          (signedOut || entry.models.options.some((model) => model.id === "fixture/default"));
      });
    }, { timeout: 15_000 }).toBe(true);
  };
  try {
    await restart({});
    await check({ api, control, restart, prompts: (instance) => lines(promptFile(instance)) });
  } finally {
    await waitForExit(server, { signal: "SIGTERM" });
    await fixture.close();
    console.info(JSON.stringify({ logPath }));
  }
}

async function botWithOwnModel(fixture: Fixture, own: { instanceId: string; model: string }) {
  const { bot: created } = await fixture.control("new-bot", "--name", "Ada");
  const { task } = await fixture.api("POST", `/api/bots/${created.id}/tasks`, { title: "Own model" });
  await fixture.api("PATCH", `/api/bots/${created.id}/tasks/${task.threadId}`, { modelSelection: own });
  const profile = async () => (await fixture.api("GET", "/api/bots")).bots.find((entry: any) => entry.id === created.id);
  const thread = async () => (await profile()).tasks.find((entry: any) => entry.threadId === task.threadId);
  expect(await thread()).toMatchObject({ modelSelection: own, followsBotModel: false });
  return { bot: await profile(), threadId: task.threadId as string, thread };
}

async function sendAndSettle(fixture: Fixture, botId: string, threadId: string, text: string, status = "settled") {
  await fixture.control("send", "--bot", botId, "--task", threadId, "--text", text);
  expect((await fixture.control("wait", "--bot", botId, "--task", threadId, "--timeout", "30")).status).toBe(status);
  return (await fixture.api("GET", `/api/threads/${threadId}/messages?limit=100`)).messages as any[];
}

it.each([
  ["missing", "fixture/alternate"],
  ["disabled", "Spare OpenCode · fixture/alternate"],
] as const)("runs a thread whose engine is %s on its bot's model, once, and the thread follows the bot", async (state, ownName) => {
  await withEngines(async (fixture) => {
    const { bot, threadId, thread } = await botWithOwnModel(fixture, { instanceId: SPARE, model: "fixture/alternate" });
    await fixture.restart({ spare: state });
    const messages = await sendAndSettle(fixture, bot.id, threadId, "FOLLOW_THE_BOT_4K");
    expect(fixture.prompts("claude")).toHaveLength(1);
    expect(fixture.prompts(SPARE)).toHaveLength(0);
    expect(messages.filter(notice)).toHaveLength(1);
    expect(messages.find(notice).tool.name).toBe(
      `notice: This thread's model (${ownName}) isn't available, so it now uses Ada's model (Verification fixture · fixture/default).`,
    );
    expect(messages.findLast((message) => message.role === "bot" && message.kind === "text")).toMatchObject({ turnSucceeded: true });
    expect(bot.modelSelection).toEqual({ instanceId: "claude", model: "fixture/default" });
    expect(await thread()).toMatchObject({ modelSelection: bot.modelSelection, followsBotModel: true });
    const again = await sendAndSettle(fixture, bot.id, threadId, "STILL_FOLLOWING_5L");
    expect(again.filter(notice)).toHaveLength(1);
    expect(fixture.prompts("claude")).toHaveLength(2);
  });
}, 120_000);

it("gives way to a signed-out engine when the bot's model is on another engine that can run", async () => {
  await withEngines(async (fixture) => {
    const { bot, threadId, thread } = await botWithOwnModel(fixture, { instanceId: SPARE, model: "fixture/alternate" });
    await fixture.restart({ spare: "signed-out" });
    const messages = await sendAndSettle(fixture, bot.id, threadId, "SIGNED_OUT_ELSEWHERE_6M");
    expect(fixture.prompts(SPARE)).toHaveLength(0);
    expect(fixture.prompts("claude")).toHaveLength(1);
    expect(messages.filter(notice)).toHaveLength(1);
    expect(messages.find(notice).tool.name).toContain("This thread's model (Spare OpenCode · fixture/alternate) isn't available");
    expect((await thread()).followsBotModel).toBe(true);
  });
}, 120_000);

it("keeps the sign-in failure when the bot's model is on the same signed-out engine", async () => {
  await withEngines(async (fixture) => {
    const { bot, threadId, thread } = await botWithOwnModel(fixture, { instanceId: "claude", model: "fixture/alternate" });
    await fixture.restart({ claude: "signed-out" });
    const messages = await sendAndSettle(fixture, bot.id, threadId, "SAME_ENGINE_SIGN_IN_7N", "failed");
    expect(messages.filter(notice)).toHaveLength(0);
    expect(messages.findLast((message) => message.kind === "activity" && message.tool?.name?.startsWith("error:"))?.tool)
      .toMatchObject({ ok: false, setup: true });
    expect(fixture.prompts("claude")).toHaveLength(0);
    expect(await thread()).toMatchObject({ modelSelection: { instanceId: "claude", model: "fixture/alternate" }, followsBotModel: false });
  });
}, 120_000);
