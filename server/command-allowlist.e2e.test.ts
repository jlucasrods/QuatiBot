import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { verificationServerEnvironment } from "../scripts/control-quati.ts";
import { waitForExit } from "./testing/cleanup.ts";
import { launchPermissionFixture } from "./testing/permission-fixture.ts";

it("remembers real permission requests, scopes and revokes grants, and preserves them across restart", async () => {
  const { fixture, start, ask } = await launchPermissionFixture();
  const { url, dataDir, logPath } = fixture.info;
  let restarted: ChildProcess | undefined;
  const api = async (method: string, path: string, body?: unknown, status = 200, token?: string) => {
    const response = await fetch(url + path, { method, headers: {
      origin: url, "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}),
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
    const result = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(result)}`).toBe(status);
    return result;
  };
  const messages = async (thread: string): Promise<any[]> => (await api("GET", `/api/threads/${thread}/messages?limit=100`)).messages;
  const card = async (thread: string, id: string) => (await messages(thread)).find(message => message.card?.requestId === id)?.card;
  const stop = (bot: any, thread = bot.threadId) => api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: thread });
  try {
    const bot = (await api("POST", "/api/bots", { name: "Command rules fixture", modelSelection: { instanceId: "opencodeGo", model: "fixture/default" } }, 201)).bot;
    // The bot on Ask, so every thread it opens asks and only a saved rule answers.
    await api("PATCH", `/api/bots/${bot.id}`, { approvalMode: "ask" });
    const rulesPath = `/api/bots/${bot.id}/command-allowlist`;
    expect((await api("GET", rulesPath)).rules).toEqual([]);
    const turn = await start(bot);
    const command = "printf 'allowlist fixture'";
    const first = await ask(turn, command);
    await expect.poll(async () => Boolean((await card(bot.threadId, first.id))?.commandAllowlist)).toBe(true);
    const candidate = (await card(bot.threadId, first.id)).commandAllowlist;
    expect(candidate.command).toBe(command);
    expect(candidate.cwd).toBe((await api("GET", rulesPath)).context.cwd);

    const pairing = await api("POST", "/api/auth/pairing", { label: "Member fixture", scopes: ["client"] });
    const paired = await api("POST", "/api/auth/pair", { code: pairing.code });
    await api("GET", rulesPath, undefined, 403, paired.token);
    await api("POST", rulesPath, candidate, 403, paired.token);
    await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId: first.id, behavior: "allow", rememberCommand: true }, 403, paired.token);
    expect((await api("GET", rulesPath)).rules).toEqual([]);
    expect((await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId: first.id, behavior: "allow", rememberCommand: true })).outcome).toBe("allowed-once");
    expect(await first.reply()).toBe("allow-once");
    const saved = (await api("GET", rulesPath)).rules[0];
    expect(saved).toMatchObject(candidate);
    for (const profile of (await api("GET", "/api/bots")).bots) expect(profile).not.toHaveProperty("commandAllowlist");

    const repeated = await ask(turn, command);
    expect(await repeated.reply()).toBe("allow-once");
    expect(await card(bot.threadId, repeated.id)).toBeUndefined();
    await expect.poll(async () => (await api("GET", "/api/decisions")).decisions.some((row: any) => row.requestId === repeated.id && row.source === "command-allowlist")).toBe(true);

    for (const [text, input, tool] of [
      [command + " && pwd", {}, "Bash"],
      [command, { dangerouslyDisableSandbox: true }, "Bash"],
      [command, {}, "mcp__other__shell"],
    ] as const) {
      const different = await ask(turn, text, input, tool);
      await expect.poll(async () => Boolean(await card(bot.threadId, different.id))).toBe(true);
      expect(different.answer()).toBeUndefined();
      await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId: different.id, behavior: "deny" });
      expect(await different.reply()).toBe("reject");
    }
    await api("DELETE", rulesPath + "/" + saved.id);
    const revoked = await ask(turn, command);
    await expect.poll(async () => Boolean(await card(bot.threadId, revoked.id))).toBe(true);
    await api("POST", `/api/bots/${bot.id}/respond`, { threadId: bot.threadId, requestId: revoked.id, behavior: "allow", rememberCommand: true });
    expect(await revoked.reply()).toBe("allow-once");
    expect((await api("GET", rulesPath)).rules).toHaveLength(1);
    await stop(bot);
    await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId: revoked.id, behavior: "allow", rememberCommand: true }, 403);

    const sibling = (await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Different folder" }, 201)).task;
    const otherTurn = await start(bot, sibling.threadId);
    const other = await ask(otherTurn, command);
    await expect.poll(async () => Boolean(await card(sibling.threadId, other.id))).toBe(true);
    expect((await card(sibling.threadId, other.id)).commandAllowlist.cwd).not.toBe(candidate.cwd);
    await stop(bot, sibling.threadId);
    expect(await other.reply()).toBe("cancelled");

    await api("PATCH", `/api/bots/${bot.id}`, { cwd: candidate.cwd });
    const shared = (await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Same project folder" }, 201)).task;
    const sharedTurn = await start(bot, shared.threadId);
    const sharedRequest = await ask(sharedTurn, command);
    await delay(1_100);
    expect(await sharedRequest.reply()).toBe("allow-once");
    expect(await card(shared.threadId, sharedRequest.id)).toBeUndefined();
    await stop(bot, shared.threadId);

    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const log = openSync(logPath, "a", 0o600);
    restarted = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: verificationServerEnvironment({}, dataDir, Number(new URL(url).port)),
      stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(async () => {
      try { return (await fetch(url + "/api/health", { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
    }, { timeout: 20_000 }).toBe(true);
    expect((await api("GET", rulesPath)).rules).toHaveLength(1);
    const restartedTurn = await start(bot);
    const restored = await ask(restartedTurn, command);
    expect(await restored.reply()).toBe("allow-once");
    expect(await card(bot.threadId, restored.id)).toBeUndefined();
    await stop(bot);
    console.info(`Command allowlist real-server verification passed; isolated log: ${logPath}`);
  } finally {
    await waitForExit(restarted, { signal: "SIGTERM" });
    await fixture.close();
  }
}, 90_000);
