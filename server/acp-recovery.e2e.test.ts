import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlQuati, verificationServerEnvironment } from "../scripts/control-quati.ts";
import { waitForExit } from "./testing/cleanup.ts";

it.each([false, true])("rehydrates the same conversation after an ACP internal error only on explicit retry (output: %s)", async (afterOutput) => {
  const fixture = await launchVerificationServer();
  const { dataDir, url, logPath } = fixture.info;
  let server: ChildProcess | undefined;
  const failureFile = join(dataDir, "rpc-failure.json");
  const rpcFile = join(dataDir, "rpc.jsonl");
  const dumpFile = join(dataDir, "acp-dump.json");
  const evidence: unknown[] = [{ url, dataDir, afterOutput }];
  const api = async (method: string, path: string, body?: unknown, status = 200) => {
    const response = await fetch(url + path, {
      method, headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
    });
    const value = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(value)}`).toBe(status);
    return value;
  };
  const control = async (...args: string[]) => {
    const result = await runControlQuati([...args, "--url", url]) as any;
    evidence.push({ command: args, result });
    return result;
  };
  const calls = () => existsSync(rpcFile)
    ? readFileSync(rpcFile, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { pid: number; method: string }) : [];
  const prompts = () => calls().filter((call) => call.method === "session/prompt");
  try {
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const configPath = join(dataDir, "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    const cli = join(dataDir, "opencode-recovery.mjs");
    const fixtureEnv = {
      FAKE_ACP_MODELS: "fixture/recovery", FAKE_ACP_DUMP: dumpFile, FAKE_ACP_DUMP_PROMPT: "1",
      FAKE_ACP_RPC_APPEND_FILE: rpcFile, FAKE_ACP_RPC_FAILURE_FILE: failureFile,
      ...(afterOutput ? { FAKE_ACP_RPC_FAILURE_AFTER_OUTPUT: "1" } : {}),
    };
    writeFileSync(cli, [
      `#!${process.execPath}`,
      `Object.assign(process.env, ${JSON.stringify(fixtureEnv)});`,
      `await import(${JSON.stringify(fileURLToPath(new URL("./testing/fake-acp-cli.ts", import.meta.url)))});`,
    ].join("\n"), { mode: 0o755 });
    config.instances.opencodeGo = {
      driver: "opencodeGo", displayName: "Recovery fixture", config: { cli },
    };
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

    await expect.poll(async () => (await api("GET", "/api/instances")).instances
      .find((instance: { instanceId: string }) => instance.instanceId === "opencodeGo")
      ?.models.options.some((model: { id: string }) => model.id === "fixture/recovery"), { timeout: 10_000 }).toBe(true);

    const { bot } = await control("new-bot", "--name", "Recovery bot");
    const threadId = bot.activeTaskId;
    await api("PATCH", `/api/bots/${bot.id}/tasks/${threadId}`, { modelSelection: { instanceId: "opencodeGo", model: "fixture/recovery" } });
    const messages = async () => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).messages as any[];
    const task = async () => (await api("GET", "/api/bots")).bots.find((entry: any) => entry.id === bot.id)
      .tasks.find((entry: any) => entry.threadId === threadId);
    const send = (text: string) => control("send", "--bot", bot.id, "--task", threadId, "--text", text);
    const wait = () => control("wait", "--bot", bot.id, "--task", threadId, "--timeout", "30");
    const firstText = "REMEMBER_RECOVERY_7Q";
    const failedText = "FAILED_WORK_8R";
    const retryText = "EXPLICIT_RETRY_9S";

    await send(firstText);
    expect((await wait()).status).toBe("settled");
    expect(prompts()).toHaveLength(1);
    const firstProcess = prompts()[0].pid;

    writeFileSync(failureFile, JSON.stringify({ code: -32603, message: "Internal error", data: { details: "OpenCode service failure" } }));
    await send(failedText);
    await expect.poll(async () => (await messages()).some((message) => message.tool?.ok === false &&
      /OpenCode service failure/.test(message.tool.name)), { timeout: 20_000 }).toBe(true);
    await expect.poll(async () => (await task()).busy, { timeout: 20_000 }).toBe(false);
    expect(prompts()).toHaveLength(2);
    expect(prompts()[1].pid).toBe(firstProcess);
    expect(calls().filter((call) => call.method === "session/prompt.error")).toHaveLength(1);
    evidence.push({ failedTask: await task(), promptCallsBeforeRetry: prompts() });

    // The fake keeps the error cached in its process even after removal.
    // Only a replacement process can answer this explicit next user message.
    rmSync(failureFile);
    await send(retryText);
    expect((await wait()).status).toBe("settled");
    expect(prompts()).toHaveLength(3);
    expect(prompts()[2].pid).not.toBe(firstProcess);
    const prompt = JSON.stringify(JSON.parse(readFileSync(`${dumpFile}.prompt.json`, "utf8")));
    expect(prompt.split(retryText).length - 1).toBe(1);
    expect(prompt.split(firstText).length - 1).toBe(1);
    expect(prompt.split(failedText).length - 1).toBe(1);
    expect(prompt).toContain("complete current history follows");
    const finalMessages = await messages();
    for (const text of [firstText, failedText, retryText]) {
      expect(finalMessages.filter((message) => message.role === "user" && message.text === text)).toHaveLength(1);
    }
    expect(finalMessages.findLast((message) => message.role === "bot" && message.kind === "text")?.turnSucceeded).toBe(true);
    expect((await task()).busy).toBe(false);
    evidence.push({ task: await task(), calls: calls(), messages: finalMessages, prompt });
  } finally {
    const evidencePath = `${logPath}.acp-recovery.json`;
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    await waitForExit(server, { signal: "SIGTERM" });
    await fixture.close();
    console.info(JSON.stringify({ logPath, evidencePath, fixtureRemoved: !existsSync(dataDir) }));
  }
}, 90_000);
