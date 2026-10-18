import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { verificationServerEnvironment } from "../scripts/control-quati.ts";
import { waitForExit } from "./testing/cleanup.ts";
import { launchPermissionFixture } from "./testing/permission-fixture.ts";
import { openSse, type SseRecorder } from "./testing/sse.ts";

it("denies a never-list command a grant would have allowed, at a saved command and at Full access, and leaves a person's card alone", async () => {
  const { fixture, start, ask } = await launchPermissionFixture();
  const { url, dataDir, logPath } = fixture.info;
  let restarted: ChildProcess | undefined;
  let stream: SseRecorder | undefined;
  const api = async (method: string, path: string, body?: unknown, status = 200) => {
    const response = await fetch(url + path, { method, headers: { origin: url, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
    const result = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(result)}`).toBe(status);
    return result;
  };
  const messages = async (thread: string): Promise<any[]> => (await api("GET", `/api/threads/${thread}/messages?limit=100`)).messages;
  const card = async (thread: string, id: string) => (await messages(thread)).find(message => message.card?.requestId === id)?.card;
  const notices = async (thread: string): Promise<string[]> => (await messages(thread))
    .flatMap(message => message.kind === "activity" && typeof message.tool?.name === "string" && message.tool.name.startsWith("notice: Blocked") ? [message.tool.name] : []);
  const decision = async (id: string) => (await api("GET", "/api/decisions")).decisions.filter((row: any) => row.requestId === id);
  const stop = (bot: any) => api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId });
  const expectFloored = async (bot: any, request: Awaited<ReturnType<typeof ask>>, label: string, rule: string) => {
    expect(await request.reply()).toBe("reject");
    expect(await card(bot.threadId, request.id)).toBeUndefined();
    await expect.poll(async () => await notices(bot.threadId)).toContain(`notice: Blocked by the safety floor: ${label}`);
    await expect.poll(async () => await decision(request.id)).toEqual([
      expect.objectContaining({ decision: "auto-denied", source: "safety-floor", rule, tool: "shell", botId: bot.id }),
    ]);
  };
  try {
    const bot = (await api("POST", "/api/bots", { name: "Safety floor fixture", modelSelection: { instanceId: "opencodeGo", model: "fixture/default" } }, 201)).bot;
    await api("PATCH", `/api/bots/${bot.id}/tasks/${bot.threadId}`, { approvalMode: "ask" });
    stream = await openSse(`${url}/api/events`);
    const turn = await start(bot);
    const wipe = "rm -rf /";

    // Off by default. A person answers the card and saves the command; the
    // saved command then answers the next request, exactly as before.
    const first = await ask(turn, wipe);
    await expect.poll(async () => Boolean((await card(bot.threadId, first.id))?.commandAllowlist)).toBe(true);
    // The request reaches every connected client without its exact command:
    // neither the grant descriptor nor the line the safety floor reads.
    const broadcast = await stream.until((frame) => frame.kind === "runtime" && frame.event?.type === "request.opened" && frame.event.requestId === first.id);
    expect(broadcast.event).toMatchObject({ tool: "shell", requestType: "permission" });
    expect(broadcast.event).not.toHaveProperty("command");
    expect(broadcast.event).not.toHaveProperty("commandLine");
    expect((await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId: first.id, behavior: "allow", rememberCommand: true })).outcome).toBe("allowed-once");
    expect(await first.reply()).toBe("allow-once");
    const unguarded = await ask(turn, wipe);
    expect(await unguarded.reply()).toBe("allow-once");
    await expect.poll(async () => await decision(unguarded.id)).toEqual([expect.objectContaining({ decision: "auto-approved", source: "command-allowlist" })]);
    expect(await notices(bot.threadId)).toEqual([]);

    // Switched on in Settings: it applies to the very next request.
    expect((await api("GET", "/api/config")).safetyFloor).toEqual({ enabled: false });
    await api("PUT", "/api/config", { safetyFloor: { enabled: true } });
    expect((await api("GET", "/api/config")).safetyFloor).toEqual({ enabled: true });
    const guarded = await ask(turn, wipe);
    await expectFloored(bot, guarded, "recursive delete of the filesystem root", "delete-root");
    expect(await notices(bot.threadId)).toHaveLength(1);

    // A card a person answers is not overridden: at Ask an unsaved never-list
    // command still reaches them, and their Allow stands.
    const theirs = await ask(turn, "rm -rf ~");
    await expect.poll(async () => Boolean(await card(bot.threadId, theirs.id))).toBe(true);
    expect(theirs.answer()).toBeUndefined();
    await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId: theirs.id, behavior: "allow" });
    expect(await theirs.reply()).toBe("allow-once");
    expect(await notices(bot.threadId)).toHaveLength(1);
    await stop(bot);

    // Restart with the file's switch removed and only QUATI_SAFETY_FLOOR=1 set,
    // then give the bot Full access the way a person does.
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const configPath = join(dataDir, "config.json");
    const { safetyFloor: _removed, ...saved } = JSON.parse(readFileSync(configPath, "utf8"));
    expect(_removed).toEqual({ enabled: true });
    writeFileSync(configPath, JSON.stringify(saved, null, 2));
    const log = openSync(logPath, "a", 0o600);
    restarted = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: { ...verificationServerEnvironment({}, dataDir, Number(new URL(url).port)), QUATI_SAFETY_FLOOR: "1" },
      stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(async () => {
      try { return (await fetch(url + "/api/health", { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
    }, { timeout: 20_000 }).toBe(true);
    // the file no longer enables it; the environment alone does
    expect(JSON.parse(readFileSync(configPath, "utf8")).safetyFloor).toBeUndefined();
    expect((await api("GET", "/api/config")).safetyFloor).toEqual({ enabled: true });
    await api("PATCH", `/api/bots/${bot.id}/tasks/${bot.threadId}`, { approvalMode: "full" });
    const fullTurn = await start(bot);

    // Full access answers every request except one on the never-list.
    const atFull = await ask(fullTurn, "sudo rm -rf /etc");
    await expectFloored(bot, atFull, "recursive delete of /etc", "delete-system-directory");
    const ordinary = await ask(fullTurn, "printf 'safety floor fixture'");
    expect(await ordinary.reply()).toBe("allow-once");
    expect(await card(bot.threadId, ordinary.id)).toBeUndefined();
    await expect.poll(async () => await decision(ordinary.id)).toEqual([expect.objectContaining({ decision: "auto-approved", source: "full-access" })]);
    // the same words as data are not a command
    const quoted = await ask(fullTurn, "git commit -m 'never run rm -rf /'");
    expect(await quoted.reply()).toBe("allow-once");
    expect(await notices(bot.threadId)).toHaveLength(2);
    await stop(bot);
    console.info(`Safety floor real-server verification passed; isolated log: ${logPath}`);
  } finally {
    stream?.close();
    await waitForExit(restarted, { signal: "SIGTERM" });
    await fixture.close();
  }
}, 120_000);
