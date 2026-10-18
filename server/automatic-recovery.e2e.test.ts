import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlQuati, verificationServerEnvironment } from "../scripts/control-quati.ts";
import { waitForExit } from "./testing/cleanup.ts";
import { readHandoffs } from "./testing/handoff-rows.ts";

const primary = { instanceId: "opencodeGo", model: "fixture/recovery" };
const backup = { instanceId: "backup", model: "fixture/backup" };
const transient = { code: -32603, message: "Internal error", data: { details: "Upstream connection timed out" } };
const jsonLines = (path: string): any[] => existsSync(path)
  ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
// At boot OpenCode lists its models by opening one ACP session in this
// folder. Those calls are catalog discovery, not the turns under test.
const CATALOG_PROBE_FOLDER = ["", "providers", "opencode", "discovery"].join(sep);
const turnCalls = (path: string) => jsonLines(path).filter((call) => !String(call.cwd ?? "").endsWith(CATALOG_PROBE_FOLDER));

async function withRecoveryFixture(
  options: { enabled?: boolean; method?: string; error?: unknown; afterOutput?: boolean; backupFails?: boolean; gated?: boolean; scripted?: boolean },
  check: (fixture: {
    api: (method: string, path: string, body?: unknown, expectedStatus?: number) => Promise<any>;
    control: (...args: string[]) => Promise<any>;
    calls: () => Array<{ pid: number; method: string }>;
    backupPrompts: () => any[];
    backupReceipt: () => { prompt: unknown; env: Record<string, string> };
    dataDir: string; failureFile: string; gateFile: string; evidence: unknown[];
  }) => Promise<void>,
) {
  const fixture = await launchVerificationServer({}, undefined, undefined, undefined, undefined,
    options.scripted ? { scripted: true } : undefined);
  const { dataDir, url, logPath } = fixture.info;
  const failureFile = join(dataDir, "startup-failure.json");
  const gateFile = join(dataDir, "startup-release");
  const rpcFile = join(dataDir, "primary-rpc.jsonl");
  const backupDump = join(dataDir, "backup-dump.json");
  const backupFile = `${backupDump}.prompts.jsonl`;
  const backupFailure = join(dataDir, "backup-failure.json");
  const evidence: unknown[] = [{ url, options }];
  let server: ChildProcess | undefined;
  const api = async (method: string, path: string, body?: unknown, expectedStatus?: number) => {
    const response = await fetch(url + path, {
      method, headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
    });
    const result = JSON.parse(await response.text());
    const context = `${method} ${path}: ${JSON.stringify(result)}`;
    if (expectedStatus === undefined) expect(response.ok, context).toBe(true);
    else expect(response.status, context).toBe(expectedStatus);
    return result;
  };
  const control = async (...args: string[]) => {
    const result = await runControlQuati([...args, "--url", url]) as any;
    evidence.push({ command: args, result });
    return result;
  };
  try {
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const configPath = join(dataDir, "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    const cli = pathToFileURL(fileURLToPath(new URL("./testing/fake-acp-cli.ts", import.meta.url))).href;
    const startupFault = {
      FAKE_ACP_RPC_APPEND_FILE: rpcFile,
      FAKE_ACP_RPC_FAILURE_FILE: failureFile,
      FAKE_ACP_RPC_FAILURE_METHOD: options.method ?? "initialize",
      ...(options.afterOutput ? { FAKE_ACP_RPC_FAILURE_AFTER_OUTPUT: "1" } : {}),
      ...(options.gated ? { FAKE_ACP_RPC_FAILURE_GATE: gateFile } : {}),
    };
    const fixtures: Record<string, Record<string, string>> = {
      history: {}, opencodeGo: startupFault, secondary: startupFault,
      backup: {
        FAKE_ACP_DUMP: backupDump,
        FAKE_ACP_RPC_FAILURE_FILE: backupFailure,
        FAKE_ACP_RPC_FAILURE_METHOD: "session/prompt",
      },
    };
    config.instances = {};
    for (const [id, knobs] of Object.entries(fixtures)) {
      const executable = join(dataDir, `${id}-opencode.mjs`);
      const environment = {
        FAKE_ACP_VERSION: "2.0.31", FAKE_ACP_AGENT_VERSION: "2.0.31",
        FAKE_ACP_AGENT_NAME: "OpenCode", FAKE_ACP_MODELS: `${primary.model},${backup.model}`,
        ...knobs,
      };
      writeFileSync(executable, ["#!/usr/bin/env node",
        ...Object.entries(environment).map(([name, value]) => `process.env[${JSON.stringify(name)}] = ${JSON.stringify(value)};`),
        `await import(${JSON.stringify(cli)});`,
      ].join("\n"), { mode: 0o700 });
      config.instances[id] = { driver: "opencodeGo", displayName: `${id} fixture`, config: { cli: executable } };
    }
    config.defaultModelSelection = { instanceId: "history", model: primary.model };
    config.automaticRecovery = { enabled: options.enabled !== false, backup };
    writeFileSync(configPath, JSON.stringify(config));
    const log = openSync(logPath, "a", 0o600);
    server = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: {
        ...verificationServerEnvironment({}, dataDir, Number(new URL(url).port)),
        ...(options.scripted ? { FAKE_ACP_ROOM_PLAN: join(dataDir, "room-plan.json") } : {}),
      }, stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(async () => {
      try { return (await fetch(url + "/api/health", { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
    }, { timeout: 20_000 }).toBe(true);
    await expect.poll(async () => {
      const { instances } = await api("GET", "/api/instances");
      return Object.keys(fixtures).every((id) => instances.find((entry: { instanceId: string }) => entry.instanceId === id)
        ?.models?.options?.some((model: { id: string }) => model.id === primary.model));
    }, { timeout: 20_000 }).toBe(true);
    writeFileSync(failureFile, JSON.stringify(options.error ?? transient));
    if (options.backupFails) writeFileSync(backupFailure, JSON.stringify({ code: -32000, message: "Authentication required: run opencode auth login" }));
    await check({
      api, control, calls: () => turnCalls(rpcFile), backupPrompts: () => jsonLines(backupFile),
      backupReceipt: () => jsonLines(backupFile).at(-1),
      dataDir, failureFile, gateFile, evidence,
    });
  } finally {
    evidence.push({ calls: jsonLines(rpcFile), backupPrompts: jsonLines(backupFile) });
    const evidencePath = `${logPath}.automatic-recovery.json`;
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    await waitForExit(server, { signal: "SIGTERM" });
    await fixture.close();
    console.info(JSON.stringify({ logPath, evidencePath, fixtureRemoved: !existsSync(dataDir) }));
  }
}

it("recovers once on the same thread with its history and permissions, leaving the bot default and sibling unchanged", async () => {
  await withRecoveryFixture({}, async ({ api, control, calls, backupPrompts, backupReceipt, evidence }) => {
    const { bot } = await control("new-bot", "--name", "Recover in place");
    const threadId = bot.activeTaskId;
    const route = `/api/bots/${bot.id}/tasks/${threadId}`;
    const send = (text: string) => control("send", "--bot", bot.id, "--task", threadId, "--text", text);
    const wait = () => control("wait", "--bot", bot.id, "--task", threadId, "--timeout", "30");
    await api("PATCH", route, { modelSelection: { ...primary, instanceId: "history" }, approvalMode: "ask" });
    await send("REMEMBER_AUTOMATIC_RECOVERY_7Q");
    expect((await wait()).status).toBe("settled");
    await api("PATCH", route, { modelSelection: primary, updateBotDefault: true });
    const { task: sibling } = await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Sibling keeps primary" });
    const state = async () => (await api("GET", "/api/bots")).bots.find((entry: any) => entry.id === bot.id);
    const before = await state();
    const beforeTask = before.tasks.find((task: any) => task.threadId === threadId);
    const text = "RECOVER_THIS_WORK_ONCE_8R";
    await send(text);
    expect((await wait()).status).toBe("settled");
    expect(calls().filter((call) => call.method === "initialize.error")).toHaveLength(1);
    expect(calls().filter((call) => call.method === "session/prompt")).toHaveLength(0);
    expect(backupPrompts()).toHaveLength(1);
    const receipt = backupReceipt();
    const prompt = JSON.stringify(receipt.prompt);
    expect(prompt).toContain("REMEMBER_AUTOMATIC_RECOVERY_7Q");
    expect(prompt).toContain("hello from fake acp");
    expect(prompt.split(text)).toHaveLength(2);
    expect(JSON.parse(receipt.env.OPENCODE_CONFIG_CONTENT ?? "{}").permissions ?? [])
      .not.toContainEqual({ action: "*", resource: "*", effect: "allow" });
    const messages = (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).messages as any[];
    expect(messages.filter((message) => message.role === "user" && message.text === text)).toHaveLength(1);
    expect(messages.find((message) => message.role === "user" && message.text === text).requestPending).toBe(false);
    expect(messages.filter((message) => message.tool?.name?.startsWith("recovery:"))).toHaveLength(1);
    expect(messages.findLast((message) => message.role === "bot" && message.kind === "text")).toMatchObject({
      text: "hello from fake acp", turnSucceeded: true,
    });
    const after = await state();
    const task = after.tasks.find((entry: any) => entry.threadId === threadId);
    expect(task).toMatchObject({ modelSelection: backup, busy: false });
    expect(task.approvalMode).toBe(beforeTask.approvalMode);
    expect(task.alwaysAllow).toEqual(beforeTask.alwaysAllow);
    expect(after.modelSelection).toEqual(primary);
    expect(after.approvalMode).toBe(before.approvalMode);
    expect(after.tasks.find((entry: any) => entry.threadId === sibling.threadId).modelSelection).toEqual(primary);
    await control("messages", "--bot", bot.id, "--task", threadId, "--limit", "20");
    evidence.push({ beforeTask, task, messages, receipt });
  });
}, 90_000);

it("recovers a coordinated specialist and returns its result to the Chief exactly once", async () => {
  await withRecoveryFixture({ scripted: true }, async ({ api, control, calls, dataDir, evidence }) => {
    const { bot: chief } = await control("new-bot", "--name", "Recovery Chief", "--section", "Leadership");
    const { bot: specialist } = await control("new-bot", "--name", "Recovery specialist", "--section", "Engineering");
    await api("PATCH", `/api/bots/${chief.id}`, {
      chiefOfStaff: true, managedSections: ["Engineering"], acknowledgePeerScope: true,
    });
    await api("PATCH", `/api/bots/${specialist.id}/tasks/${specialist.activeTaskId}`, {
      modelSelection: primary, updateBotDefault: true, approvalMode: "ask",
    });
    const brief = "VERIFY_RECOVERED_SPECIALIST_2W";
    const specialistReply = "SPECIALIST_BACKUP_VERIFIED_3X";
    const finalReply = "Chief received the recovered specialist result";
    const planPath = join(dataDir, "room-plan.json");
    writeFileSync(planPath, JSON.stringify({
      [chief.id]: { turns: [
        { steps: [{ arguments: { bot_ids: [specialist.id], request_key: "recovery-check", message: brief } }], reply: "Assigned the recovery check" },
        { expectContextIncludes: [specialistReply], reply: finalReply },
      ] },
      [specialist.id]: { turns: [{ expectContextIncludes: [brief], reply: specialistReply }] },
    }));
    await control("send", "--bot", chief.id, "--task", chief.activeTaskId, "--text", "Ask Engineering to verify this task and report the result.");
    expect((await control("wait", "--bot", chief.id, "--task", chief.activeTaskId, "--timeout", "30")).status).toBe("settled");
    const nodes = readHandoffs(dataDir);
    evidence.push({ nodes });
    expect(nodes).toHaveLength(2);
    expect(nodes.every((node) => !node.groupId && node.status === "completed" && node.reported)).toBe(true);
    const child = nodes.find((node) => node.botId === specialist.id)!;
    expect(child.result).toBe(specialistReply);
    expect(nodes.find((node) => node.botId === chief.id)!.executions).toBe(2);
    const turns = jsonLines(`${planPath}.evidence.jsonl`);
    expect(turns.filter((turn) => turn.botId === chief.id)).toHaveLength(2);
    expect(turns.filter((turn) => turn.botId === specialist.id)).toHaveLength(1);
    expect(turns.find((turn) => turn.botId === specialist.id)).toMatchObject({
      threadId: child.threadId, model: backup.model,
      nativePermissions: expect.arrayContaining([{ action: "*", resource: "*", effect: "allow" }]),
    });
    expect(calls().filter((call) => call.method === "initialize.error")).toHaveLength(1);
    expect(calls().some((call) => call.method === "session/prompt")).toBe(false);
    const chiefMessages = (await api("GET", `/api/threads/${chief.activeTaskId}/messages?limit=100`)).messages as any[];
    expect(chiefMessages.filter((message) => message.text === finalReply)).toHaveLength(1);
    expect(chiefMessages.filter((message) => message.roomRequest?.id === child.id && message.roomRequest.phase === "result")).toHaveLength(1);
    const specialistMessages = (await api("GET", `/api/threads/${child.threadId}/messages?limit=100`)).messages as any[];
    evidence.push({ chiefMessages, specialistMessages, turns });
    expect(specialistMessages.filter((message) => message.text === specialistReply)).toHaveLength(1);
    expect(specialistMessages.filter((message) => message.roomRequest?.id === child.id && message.roomRequest.phase === "request" && message.text?.includes(brief))).toHaveLength(1);
    expect(specialistMessages.some((message) => message.role === "user")).toBe(false);
    expect(specialistMessages.filter((message) => message.tool?.name?.startsWith("recovery:"))).toHaveLength(1);
    const fleet = await api("GET", "/api/bots");
    expect(fleet.groups).toEqual([]);
    const after = fleet.bots.find((bot: any) => bot.id === specialist.id);
    expect(after.modelSelection).toEqual(primary);
    expect(after.tasks.find((task: any) => task.threadId === child.threadId)).toMatchObject({ modelSelection: backup, approvalMode: "full", busy: false });
    expect(after.tasks.find((task: any) => task.threadId === specialist.activeTaskId).modelSelection).toEqual(primary);
    expect(fleet.bots.find((bot: any) => bot.id === chief.id)).toMatchObject({ busy: false, waitingForTeammates: false });
    await control("messages", "--bot", chief.id, "--task", chief.activeTaskId, "--limit", "20");
    await control("messages", "--bot", specialist.id, "--task", child.threadId, "--limit", "20");
  });
}, 90_000);

it("uses the ordered bot list only for proven pre-prompt failures and leaves defaults and siblings unchanged", async () => {
  await withRecoveryFixture({}, async ({ api, control, calls, backupPrompts, evidence }) => {
    const { bot } = await control("new-bot", "--name", "Ordered startup fallback");
    const threadId = bot.activeTaskId;
    await api("PATCH", `/api/bots/${bot.id}/tasks/${threadId}`, { modelSelection: primary, updateBotDefault: true });
    const { task: sibling } = await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Unchanged sibling" });
    await api("PATCH", `/api/bots/${bot.id}`, { fallback: [{ instanceId: "secondary", model: primary.model }, backup] });
    const text = "ORDERED_STARTUP_ONLY_3F";
    await control("send", "--bot", bot.id, "--task", threadId, "--text", text);
    expect((await control("wait", "--bot", bot.id, "--task", threadId, "--timeout", "30")).status).toBe("settled");
    expect(calls().filter(call => call.method === "initialize.error")).toHaveLength(2);
    expect(calls().filter(call => call.method === "session/prompt")).toHaveLength(0);
    expect(backupPrompts()).toHaveLength(1);
    const after = (await api("GET", "/api/bots")).bots.find((entry: any) => entry.id === bot.id);
    expect(after.modelSelection).toEqual(primary);
    expect(after.tasks.find((task: any) => task.threadId === sibling.threadId).modelSelection).toEqual(primary);
    expect(after.tasks.find((task: any) => task.threadId === threadId)).toMatchObject({ modelSelection: backup, busy: false });
    const { messages } = await control("messages", "--bot", bot.id, "--task", threadId, "--limit", "30");
    expect(messages.filter((message: any) => message.role === "user" && message.text === text)).toHaveLength(1);
    expect(messages.filter((message: any) => message.tool?.name?.startsWith("recovery:"))).toHaveLength(2);
    evidence.push({ after, messages });
  });
}, 90_000);

it.each([
  { name: "disabled", enabled: false },
  { name: "prompt already accepted", method: "session/prompt" },
  { name: "partial output", method: "session/prompt", afterOutput: true },
  { name: "authentication failure", error: { code: -32603, message: "Authentication required: invalid API key" } },
])("does not automatically replay when $name", async ({ name: _name, ...options }) => {
  await withRecoveryFixture(options, async ({ api, control, calls, backupPrompts }) => {
    const { bot } = await control("new-bot", "--name", "No replay");
    const threadId = bot.activeTaskId;
    await api("PATCH", `/api/bots/${bot.id}/tasks/${threadId}`, { modelSelection: primary, updateBotDefault: true });
    await api("PATCH", `/api/bots/${bot.id}`, { fallback: [{ instanceId: "secondary", model: primary.model }, backup] });
    await control("send", "--bot", bot.id, "--task", threadId, "--text", "DO_NOT_REPLAY_THIS_9S");
    expect((await control("wait", "--bot", bot.id, "--task", threadId, "--timeout", "30")).status)
      .toBe(options.afterOutput ? "settled" : "failed");
    expect(backupPrompts()).toHaveLength(0);
    expect(calls().filter((call) => call.method.endsWith(".error"))).toHaveLength(1);
    const state = (await api("GET", "/api/bots")).bots.find((entry: any) => entry.id === bot.id);
    expect(state.tasks.find((task: any) => task.threadId === threadId)).toMatchObject({ modelSelection: primary, busy: false });
    const { messages } = await control("messages", "--bot", bot.id, "--task", threadId, "--limit", "20");
    expect(messages.filter((message: any) => message.role === "user" && message.text === "DO_NOT_REPLAY_THIS_9S")).toHaveLength(1);
    expect(messages.some((message: any) => message.tool?.ok === false)).toBe(true);
    expect(messages.some((message: any) => message.tool?.name?.startsWith("recovery:"))).toBe(false);
  });
}, 90_000);

it("rejects missing or unavailable backup settings through the API without changing the saved recovery choice", async () => {
  await withRecoveryFixture({ enabled: false }, async ({ api, evidence }) => {
    const before = (await api("GET", "/api/config")).automaticRecovery;
    const missing = await api("PUT", "/api/config", { automaticRecovery: { enabled: true } }, 400);
    expect(missing.error).toMatch(/backup|automaticRecovery/i);
    const unavailable = await api("PUT", "/api/config", {
      automaticRecovery: { enabled: true, backup: { instanceId: "missing-fixture-engine", model: "missing-model" } },
    }, 400);
    expect(unavailable.error).toMatch(/unavailable/i);
    expect((await api("GET", "/api/config")).automaticRecovery).toEqual(before);
    const allowed = { enabled: true, backup };
    await api("PUT", "/api/config", { automaticRecovery: allowed });
    expect((await api("GET", "/api/config")).automaticRecovery).toEqual(allowed);
    await api("PUT", "/api/config", { automaticRecovery: { enabled: false } });
    expect((await api("GET", "/api/config")).automaticRecovery).toEqual({ enabled: false });
    evidence.push({ rejectedSettings: [missing, unavailable], acceptedSettings: allowed });
  });
}, 90_000);

it("stops after one failed backup instead of looping between engines", async () => {
  await withRecoveryFixture({ backupFails: true }, async ({ api, control, calls, backupPrompts }) => {
    const { bot } = await control("new-bot", "--name", "One backup attempt");
    const threadId = bot.activeTaskId;
    await api("PATCH", `/api/bots/${bot.id}/tasks/${threadId}`, { modelSelection: primary, updateBotDefault: true });
    await control("send", "--bot", bot.id, "--task", threadId, "--text", "ONLY_ONE_BACKUP_4T");
    expect((await control("wait", "--bot", bot.id, "--task", threadId, "--timeout", "30")).status).toBe("failed");
    expect(backupPrompts()).toHaveLength(1);
    expect(calls().filter((call) => call.method === "initialize.error")).toHaveLength(1);
    const { messages } = await control("messages", "--bot", bot.id, "--task", threadId, "--limit", "20");
    expect(messages.filter((message: any) => message.role === "user" && message.text === "ONLY_ONE_BACKUP_4T")).toHaveLength(1);
    expect(messages.map((message: any) => message.tool).filter((tool: any) => tool?.ok === false))
      .toEqual([{ name: "error: Configure this model's provider in OpenCode with `opencode auth login`, then refresh models.", ok: false, setup: true }]);
  });
}, 90_000);

it.each(["Stop", "new message"])("does not recover a superseded turn after %s", async (action) => {
  await withRecoveryFixture({ gated: true }, async ({ api, control, calls, backupPrompts, failureFile, gateFile }) => {
    const { bot } = await control("new-bot", "--name", "Respect changed intent");
    const threadId = bot.activeTaskId;
    await api("PATCH", `/api/bots/${bot.id}/tasks/${threadId}`, { modelSelection: primary, updateBotDefault: true });
    const pendingSend = control("send", "--bot", bot.id, "--task", threadId, "--text", "SUPERSEDED_WORK_5U");
    await expect.poll(() => calls().some((call) => call.method === "initialize"), { timeout: 20_000 }).toBe(true);
    if (action === "Stop") await control("interrupt", "--bot", bot.id, "--task", threadId);
    else await control("send", "--bot", bot.id, "--task", threadId, "--text", "NEW_INTENT_6V");
    // The process already holds the first failure. A new process will work;
    // this distinguishes draining the new message from replaying the old one.
    rmSync(failureFile);
    writeFileSync(gateFile, "release");
    await pendingSend;
    if (action === "Stop") await control("send", "--bot", bot.id, "--task", threadId, "--text", "NEW_INTENT_6V");
    const state = async () => (await api("GET", "/api/bots")).bots.find((entry: any) => entry.id === bot.id);
    await expect.poll(() => calls().filter((call) => call.method === "session/prompt.result").length, { timeout: 20_000 }).toBe(1);
    expect((await control("wait", "--bot", bot.id, "--task", threadId, "--timeout", "30")).status).toBe("settled");
    expect(backupPrompts()).toHaveLength(0);
    expect((await state()).tasks.find((task: any) => task.threadId === threadId)).toMatchObject({ modelSelection: primary, busy: false });
    const { messages } = await control("messages", "--bot", bot.id, "--task", threadId, "--limit", "20");
    for (const text of ["SUPERSEDED_WORK_5U", "NEW_INTENT_6V"]) {
      expect(messages.filter((message: any) => message.role === "user" && message.text === text)).toHaveLength(1);
    }
  });
}, 90_000);
