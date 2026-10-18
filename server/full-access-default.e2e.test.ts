import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlQuati, verificationServerEnvironment } from "../scripts/control-quati.ts";
import { waitForExit } from "./testing/cleanup.ts";

it("defaults bots and threads to Full access and preserves an explicit Ask across restart", async () => {
  const fixture = await launchVerificationServer({ FAKE_ACP_MODE: "permission" });
  const { dataDir, url, logPath } = fixture.info;
  let server: ChildProcess | undefined;
  const api = async (method: string, path: string, body?: unknown, status = 200) => {
    const response = await fetch(url + path, {
      method, headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
    });
    const value = JSON.parse(await response.text());
    expect(response.status, `${method} ${path}: ${JSON.stringify(value)}`).toBe(status);
    return value;
  };
  const control = (...args: string[]) => runControlQuati([...args, "--url", url]);
  const stored = () => JSON.parse(readFileSync(join(dataDir, "bots.json"), "utf8"));
  const openCard = async (threadId: string) => {
    const { messages } = await api("GET", `/api/threads/${threadId}/messages?limit=50`);
    return messages.find((message: { card?: { requestId?: string; answered?: string } }) => message.card?.requestId && !message.card.answered)?.card;
  };
  try {
    const bot = (await api("POST", "/api/bots", { name: "Default access" }, 201)).bot;
    expect(bot.approvalMode).toBe("full");
    expect(stored().find((saved: { id: string }) => saved.id === bot.id).approvalMode).toBeUndefined();
    const task = (await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Default thread" }, 201)).task;
    expect(task.approvalMode).toBe("full");
    await control("send", "--bot", bot.id, "--task", task.threadId, "--text", "Check the fixture report.");
    expect(await control("wait", "--bot", bot.id, "--task", task.threadId, "--timeout", "30")).toMatchObject({ status: "settled" });
    const decisions = (await api("GET", "/api/decisions")).decisions;
    expect(decisions.filter((row: { threadId: string }) => row.threadId === task.threadId))
      .toMatchObject([{ decision: "auto-approved", source: "full-access" }]);
    expect(await openCard(task.threadId)).toBeUndefined();

    const starter = (await api("GET", "/api/bots?messages=0")).bots.find((candidate: { id: string }) => candidate.id !== bot.id);
    expect(starter.approvalMode).toBe("full");
    expect(stored().find((saved: { id: string }) => saved.id === starter.id).approvalMode).toBeUndefined();
    await api("PATCH", `/api/bots/${bot.id}`, { approvalMode: "ask", applyToAllThreads: true });
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const log = openSync(logPath, "a", 0o600);
    server = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: verificationServerEnvironment({ FAKE_ACP_MODE: "permission" }, dataDir, Number(new URL(url).port)),
      stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(async () => {
      try { return (await fetch(url + "/api/health", { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
    }, { timeout: 20_000 }).toBe(true);

    expect(stored().find((saved: { id: string }) => saved.id === bot.id).approvalMode).toBe("ask");
    const ask = (await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Ask thread" }, 201)).task;
    expect(ask.approvalMode).toBe("ask");
    expect((await api("GET", "/api/bots?messages=0")).bots.find((candidate: { id: string }) => candidate.id === starter.id).approvalMode).toBe("full");
    await control("send", "--bot", bot.id, "--task", ask.threadId, "--text", "Ask before this fixture action.");
    await expect.poll(() => openCard(ask.threadId), { timeout: 20_000 }).toBeTruthy();
    const card = await openCard(ask.threadId);
    await api("POST", `/api/threads/${ask.threadId}/respond`, { requestId: card.requestId, behavior: "deny" });
    expect(await control("wait", "--bot", bot.id, "--task", ask.threadId, "--timeout", "30")).toMatchObject({ status: "settled" });
  } finally {
    await waitForExit(server, { signal: "SIGTERM" });
    await fixture.close();
  }
}, 60_000);
