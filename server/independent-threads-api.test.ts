// Gates are per model, so two tasks on one bot stay in flight until the test completes or stops each.
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { launchVerificationServer, runControlQuati, type VerificationServer } from "../scripts/control-quati.ts";
import { handleToolCall, request } from "../scripts/mcp-server.ts";
import { readHandoffs } from "./testing/handoff-rows.ts";
import { memoryDate } from "./workspace.ts";

describe("independent bot tasks through the isolated control surface", () => {
  let session: VerificationServer;
  let models: string[];
  let evidence: Array<Record<string, unknown>>;

  const api = async (method: string, path: string, body?: unknown, fromApp = false) => {
    const response = await fetch(`${session.info.url}${path}`, {
      method, headers: { "content-type": "application/json", ...(fromApp ? { origin: session.info.url } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (method !== "GET") evidence.push({ method, path, ...(path.startsWith("/api/auth/") ? {} : { body }), status: response.status });
    return { status: response.status, body: await response.json() as any };
  };
  const tool = async (name: string, args: Record<string, unknown>) => {
    const result: any = await handleToolCall(name, args, (path, options) => request(path, options, session.info.url));
    if (name !== "list_bots" && name !== "list_available_models") evidence.push({ tool: name, args, result });
    return result;
  };
  const control = async (args: string[]) => {
    const result = await runControlQuati([...args, "--url", session.info.url]);
    evidence.push({ command: args, result });
    return result as any;
  };
  const internal = async (token: string, method: string, path: string, body?: unknown) => {
    const response = await fetch(`${session.info.url}${path}`, {
      method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const result = { status: response.status, body: await response.json() as any };
    // Record the exercised authorization boundary, never the bearer itself.
    evidence.push({ authority: "captured provider capability", method, path, body, result });
    return result;
  };
  const botState = async (botId: string) => (await tool("list_bots", {})).bots.find((bot: any) => bot.id === botId);
  const modelFile = (model: string, extension: string) => join(session.info.dataDir, `${model.replace(/[^\w-]/g, "_")}.${extension}`);
  const dump = async (model: string) => {
    await expect.poll(() => existsSync(modelFile(model, "json")), { timeout: 15_000 }).toBe(true);
    return JSON.parse(readFileSync(modelFile(model, "json"), "utf8"));
  };
  const mcpEnvironment = (launched: { mcpServers: Array<{ name: string; env: Array<{ name: string; value: string }> }> }, name: string) => {
    const server = launched.mcpServers.find((entry) => entry.name === name);
    expect(server).toBeDefined();
    return Object.fromEntries(server!.env.map(({ name, value }) => [name, value]));
  };
  const permission = async (model: string, id: string, input: Record<string, unknown> = { command: "ls -la ./dist" }) => {
    const launched = await dump(model);
    const threadId = mcpEnvironment(launched, "agents").QUATI_THREAD_ID;
    writeFileSync(modelFile(model, "permission.json"), JSON.stringify({ key: id, input }));
    const answer = () => {
      const file = join(session.info.dataDir, `${id}.answer`);
      return existsSync(file) ? readFileSync(file, "utf8") : undefined;
    };
    let requestId: string | undefined;
    await expect.poll(async () => {
      const messages = (await api("GET", `/api/threads/${threadId}/messages`)).body.messages;
      const card = messages.find((message: any) => message.card?.requestId && !message.card.answered)?.card;
      requestId = card?.requestId;
      return requestId !== undefined || answer() !== undefined;
    }, { timeout: 15_000 }).toBe(true);
    return { requestId, answer };
  };

  beforeEach(async () => {
    // The approval deadline fires only on a marker file.
    session = await launchVerificationServer({ QUATI_TEST_APPROVAL_CLOCK: "1" });
    evidence = [{ fixture: session.info }];
    const wrapper = join(session.info.dataDir, "controlled-opencode.mjs");
    const fake = pathToFileURL(join(process.cwd(), "server/testing/fake-acp-cli.ts")).href;
    writeFileSync(wrapper, [
      "#!/usr/bin/env node",
      'process.env.FAKE_ACP_MODE = "controlled";',
      'process.env.FAKE_ACP_MODELS = "fixture/first,fixture/second,fixture/third";',
      `process.env.FAKE_ACP_CONTROL_DIR = ${JSON.stringify(session.info.dataDir)};`,
      `await import(${JSON.stringify(fake)});`,
    ].join("\n"), { mode: 0o700 });
    expect((await api("PATCH", "/api/instances/opencodeGo", { cli: wrapper })).status).toBe(200);
    const catalog = await tool("list_available_models", {});
    models = catalog.instances.find((instance: any) => instance.instanceId === "opencodeGo").models.options.map((model: any) => model.id);
    expect(models.length).toBeGreaterThanOrEqual(2);
  }, 30_000);

  afterEach(async () => {
    if (!session) return;
    const evidencePath = `${session.info.logPath}.json`;
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    console.info(JSON.stringify({ ...session.info, evidencePath }));
    await session.close();
  });

  it("holds coordinated work behind a peer's approval only while that card holds its last slot, says so, and delivers it once", async () => {
    const chief = (await tool("create_bot", { name: "Mailbox Chief", instance_id: "opencodeGo", model: models[0] })).bot;
    const peer = (await tool("create_bot", { name: "Mailbox Peer", instance_id: "opencodeGo", model: models[1] })).bot;
    await api("PATCH", `/api/bots/${peer.id}/tasks/${peer.activeTaskId}`, { approvalMode: "ask" });
    await control(["send", "--bot", peer.id, "--text", "Hold this review until I approve the check."]);
    const answers = await permission(models[1], "mailbox-approval");
    await expect.poll(async () => (await botState(peer.id)).activity).toBe("waiting-on-you");
    // One thread per bot: the card's thread holds the peer's only slot.
    expect((await api("PATCH", "/api/config", { threads: { maxConcurrentPerBot: 1 } })).status).toBe(200);
    await control(["send", "--bot", chief.id, "--text", "Ask the reviewer to check the release notes, then return the result here."]);
    const token = mcpEnvironment(await dump(models[0]), "agents").QUATI_COMMS_TOKEN;
    const roster = await internal(token, "GET", "/api/internal/agents");
    expect(roster.status).toBe(200);
    expect(roster.body.bots.find((bot: any) => bot.id === peer.id)).toMatchObject({
      status: "waiting-on-user", statusText: "waiting on the user", busy: true,
    });
    const queued = await internal(token, "POST", "/api/internal/coordinate-bots", {
      botIds: [peer.id], message: "MAILBOX_REVIEW: check the release notes.",
    });
    expect(queued.status).toBe(200);
    const requestId = queued.body.receipts[0].requestId;
    expect(queued.body.receipts).toEqual([{
      botId: peer.id,
      botName: "Mailbox Peer",
      outcome: "queued",
      detail: "sent to \"@Mailbox Chief · work\"; it runs after anything still running there",
      requestId: expect.any(String),
      threadId: expect.any(String),
    }]);
    const handoff = () => readHandoffs(session.info.dataDir).find((node) => node.id === requestId);
    const peerThread = handoff()!.threadId;
    expect(peerThread).not.toBe(peer.activeTaskId);
    expect(queued.body.receipts[0].threadId).toBe(peerThread);
    writeFileSync(modelFile(models[0], "gate"), "finish");
    const chiefMessages = async () => (await api("GET", "/api/bots")).body.bots.find((bot: any) => bot.id === chief.id).messages as any[];
    const queuedChips = async () => (await chiefMessages()).filter((message: any) => message.tool?.name?.startsWith("Queued for @Mailbox Peer"));
    await expect.poll(async () => (await queuedChips()).length).toBe(1);
    const [chip] = await queuedChips();
    expect(chip.threadRef).toMatchObject({ botId: peer.id, threadId: peer.activeTaskId });
    expect(chip.tool.name).toBe(`Queued for @Mailbox Peer behind your approval in “${chip.threadRef.title}”`);
    expect(chip.tool.ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(handoff()?.status).toBe("queued");
    expect(await queuedChips()).toHaveLength(1);
    expect((await chiefMessages()).filter((message: any) => message.tool?.name === "Sent to Mailbox Peer")).toHaveLength(1);
    await expect.poll(async () => (await botState(chief.id)).busy).toBe(false);
    await control(["send", "--bot", chief.id, "--text", "Is the review moving?"]);
    const told = async () => JSON.stringify((await dump(models[0])).prompt ?? "");
    await expect.poll(told).toContain("waiting for a free slot: that teammate is waiting on the person's approval in its thread");
    expect(await told()).toContain(chip.threadRef.title);
    await expect.poll(async () => (await botState(chief.id)).busy).toBe(false);
    expect((await api("PATCH", "/api/config", { threads: { maxConcurrentPerBot: 3 } })).status).toBe(200);
    await expect.poll(() => handoff()?.status, { timeout: 10_000 }).toBe("running");
    const peerNow = (await api("GET", "/api/bots")).body.bots.find((bot: any) => bot.id === peer.id);
    expect(peerNow.tasks.find((task: any) => task.threadId === peer.activeTaskId)?.activity).toBe("waiting-on-you");
    expect(answers.answer()).toBeUndefined();
    await control(["messages", "--bot", chief.id, "--limit", "10"]);
    const allowed = await api("POST", `/api/threads/${peer.activeTaskId}/respond`, { requestId: answers.requestId, behavior: "allow" });
    expect(allowed.body.outcome).toBe("allowed-once");
    await expect.poll(answers.answer).toBe("allow-once");
    writeFileSync(modelFile(models[1], "gate"), "finish");
    await expect.poll(async () => {
      const bots = (await api("GET", "/api/bots")).body.bots;
      const current = bots.find((bot: any) => bot.id === chief.id);
      return !current.busy && current.messages.some((message: any) =>
        message.from?.botId === peer.id && message.roomRequest?.id === requestId && message.roomRequest.phase === "result");
    }, { timeout: 20_000 }).toBe(true);
    const bots = (await api("GET", "/api/bots")).body.bots;
    const peerState = bots.find((bot: any) => bot.id === peer.id);
    expect(peerState.threadId).toBe(peer.activeTaskId);
    expect(peerState.messages.some((message: any) => message.text?.includes("MAILBOX_REVIEW"))).toBe(false);
    const targetMessages = (await api("GET", `/api/threads/${peerThread}/messages?limit=100`)).body.messages;
    expect(targetMessages.filter((message: any) => message.roomRequest?.id === requestId && message.roomRequest.phase === "request")).toHaveLength(1);
    expect(targetMessages.some((message: any) => message.text?.includes("MAILBOX_REVIEW"))).toBe(true);
    await expect.poll(() => handoff()?.status, { timeout: 10_000 }).toBe("completed");
    expect(await queuedChips()).toHaveLength(1);
    expect((await control(["wait", "--bot", peer.id, "--timeout", "15"])).status).toBe("settled");
    await control(["messages", "--bot", peer.id, "--limit", "10"]);
    await control(["messages", "--bot", chief.id, "--limit", "15"]);
  }, 60_000);

  it("tells the Chief what became of each teammate approval, and that an unanswered one did not run", async () => {
    const chief = (await tool("create_bot", { name: "Release Chief", instance_id: "opencodeGo", model: models[0] })).bot;
    const peer = (await tool("create_bot", { name: "Release Peer", instance_id: "opencodeGo", model: models[1] })).bot;
    expect((await api("PATCH", `/api/bots/${peer.id}`, { approvalMode: "ask" })).status).toBe(200);
    await control(["send", "--bot", chief.id, "--text", "Ask the reviewer to run the release checks, then report back."]);
    const token = mcpEnvironment(await dump(models[0]), "agents").QUATI_COMMS_TOKEN;
    const sent = await internal(token, "POST", "/api/internal/coordinate-bots", {
      botIds: [peer.id], message: "RELEASE_CHECKS: run the release checks.",
    });
    expect(sent.status).toBe(200);
    const requestId = sent.body.receipts[0].requestId;
    const handoff = () => readHandoffs(session.info.dataDir).find((node) => node.id === requestId);
    const workThread = handoff()!.threadId;
    writeFileSync(modelFile(models[0], "gate"), "finish");
    const chiefChips = async () => (await api("GET", `/api/threads/${chief.activeTaskId}/messages?limit=100`)).body.messages
      .filter((message: any) => message.kind === "activity" && message.from?.botId === peer.id && message.threadRef?.threadId === workThread
        && message.tool && !message.roomRequest) as any[];
    const card = async (id: string) => (await api("GET", `/api/threads/${workThread}/messages?limit=100`)).body.messages
      .find((message: any) => message.card?.requestId === id);

    const deniedAnswers = await permission(models[1], "denied-approval", { command: "git push --force" });
    await expect.poll(async () => (await chiefChips()).map((chip) => chip.tool.name)).toEqual(["Waiting on your approval in @Release Peer"]);
    expect((await api("POST", `/api/threads/${workThread}/respond`, { requestId: deniedAnswers.requestId, behavior: "deny" })).status).toBeLessThan(300);
    await expect.poll(deniedAnswers.answer).toBe("reject");
    await expect.poll(async () => (await chiefChips()).map((chip) => [chip.tool.name, chip.tool.ok]))
      .toEqual([["@Release Peer's request was denied", false]]);

    const unanswered = await permission(models[1], "unanswered-approval", { command: "npm run release-check" });
    await expect.poll(async () => Boolean(await card(unanswered.requestId!))).toBe(true);
    expect((await chiefChips()).at(-1).tool.name).toBe("Waiting on your approval in @Release Peer");
    const expiry = join(session.info.dataDir, "expire-approvals");
    writeFileSync(expiry, "expire");
    await expect.poll(unanswered.answer).toBe("reject");
    rmSync(expiry, { force: true });
    await expect.poll(async () => (await chiefChips()).map((chip) => [chip.tool.name, chip.tool.ok])).toEqual([
      ["@Release Peer's request was denied", false],
      ["Nobody answered @Release Peer's approval in time — that step did not run", false],
    ]);
    expect((await card(unanswered.requestId!)).card).toMatchObject({ answered: "deny", dismissed: true });

    const lint = await permission(models[1], "lint-approval", { command: "npm run lint" });
    await expect.poll(async () => Boolean(await card(lint.requestId!))).toBe(true);
    writeFileSync(expiry, "expire");
    await expect.poll(lint.answer).toBe("reject");
    rmSync(expiry, { force: true });
    const retried = await permission(models[1], "lint-retry", { command: "npm run lint" });
    await expect.poll(async () => Boolean(await card(retried.requestId!))).toBe(true);
    expect((await api("POST", `/api/threads/${workThread}/respond`, { requestId: retried.requestId, behavior: "allow" })).status).toBeLessThan(300);
    await expect.poll(retried.answer).toBe("allow-once");
    await expect.poll(async () => (await chiefChips()).map((chip) => [chip.tool.name, chip.tool.ok])).toEqual([
      ["@Release Peer's request was denied", false],
      ["Nobody answered @Release Peer's approval in time — that step did not run", false],
      ["Nobody answered @Release Peer's approval in time — that step did not run", false],
      ["@Release Peer got your approval", true],
    ]);

    writeFileSync(modelFile(models[1], "gate"), "finish");
    await expect.poll(() => handoff()?.status, { timeout: 20_000 }).toBe("completed");
    const result: string = handoff()!.result;
    expect(result.startsWith("[QuatiBot: nobody answered the approval for “shell: npm run release-check” in time, so it did not run. Do not report it as done;")).toBe(true);
    expect(result).toContain("echo:");
    expect(result).not.toContain("git push");
    expect(result).not.toContain("npm run lint");
    await expect.poll(async () => (await api("GET", `/api/threads/${chief.activeTaskId}/messages?limit=100`)).body.messages
      .find((message: any) => message.roomRequest?.id === requestId && message.roomRequest.phase === "result")?.tool?.output ?? "")
      .toContain("nobody answered the approval for “shell: npm run release-check”");
    evidence.push({ requestId, result: result.slice(0, 400) });
  }, 60_000);

  it.each(["finish", "fail"] as const)("tells a delegating bot that its teammate's approval went unanswered, so the step did not run (turn ends: %s)", async (ending) => {
    const chief = (await tool("create_bot", { name: "Delegating Chief", instance_id: "opencodeGo", model: models[0] })).bot;
    const peer = (await tool("create_bot", { name: "Delegated Peer", instance_id: "opencodeGo", model: models[1] })).bot;
    expect((await api("PATCH", `/api/bots/${peer.id}`, { approvalMode: "ask" })).status).toBe(200);
    const routine = await api("POST", "/api/routines", {
      name: "Release checks", prompt: "Delegate the release checks to the reviewer.", botId: chief.id, enabled: false,
      schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 },
    });
    expect(routine.status).toBe(201);
    const run = (await api("POST", `/api/routines/${routine.body.routine.id}/run`)).body.run;
    const runThread = async () => (await api("GET", "/api/routines")).body.runs.find((candidate: any) => candidate.id === run.id)?.threadId as string | undefined;
    await expect.poll(runThread).toBeTruthy();
    const token = mcpEnvironment(await dump(models[0]), "agents").QUATI_COMMS_TOKEN;
    const delegated = await internal(token, "POST", "/api/internal/coordinate-bots", { botIds: [peer.id], message: "RELEASE_CHECKS: run the release checks." });
    expect(delegated.status).toBe(200);
    expect(delegated.body.receipts).toEqual([expect.objectContaining({ botId: peer.id, outcome: "queued", requestId: expect.any(String) })]);
    const requestId = delegated.body.receipts[0].requestId as string;
    const handoff = () => readHandoffs(session.info.dataDir).find((node) => node.id === requestId);
    expect(handoff()).toMatchObject({ botId: peer.id, mode: "work", reply: "resume" });
    writeFileSync(modelFile(models[0], "gate"), "finish");
    const unanswered = await permission(models[1], "unanswered-delegated", { command: "npm run release-check" });
    const peerCard = async () => {
      for (const task of (await api("GET", "/api/bots")).body.bots.find((bot: any) => bot.id === peer.id).tasks as any[]) {
        const found = (await api("GET", `/api/threads/${task.threadId}/messages?limit=100`)).body.messages
          .find((message: any) => message.card?.requestId === unanswered.requestId);
        if (found) return found;
      }
      return undefined;
    };
    await expect.poll(async () => Boolean(await peerCard()), { timeout: 15_000 }).toBe(true);
    const expiry = join(session.info.dataDir, "expire-approvals");
    writeFileSync(expiry, "expire");
    await expect.poll(unanswered.answer).toBe("reject");
    rmSync(expiry, { force: true });
    // whole, so the engine never reads the gate half-written
    writeFileSync(`${modelFile(models[1], "gate")}.tmp`, ending);
    renameSync(`${modelFile(models[1], "gate")}.tmp`, modelFile(models[1], "gate"));
    const note = "[QuatiBot: nobody answered the approval for “shell: npm run release-check” in time, so it did not run.";
    const runMessages = async () => (await api("GET", `/api/threads/${await runThread()}/messages?limit=100`)).body.messages as any[];
    const reported = async () => (await runMessages()).find((message: any) => message.roomRequest?.id === requestId && message.roomRequest.phase === "result")?.tool;
    if (ending === "finish") {
      await expect.poll(reported, { timeout: 20_000 }).toBeTruthy();
      expect(await reported()).toMatchObject({ name: "Delegated Peer replied", ok: true });
      expect(String((await reported())!.output).startsWith(note)).toBe(true);
      await expect.poll(() => handoff()?.status, { timeout: 20_000 }).toBe("completed");
      expect(handoff()!.result.startsWith(note)).toBe(true);
    } else {
      await expect.poll(reported, { timeout: 20_000 }).toBeTruthy();
      expect(await reported()).toMatchObject({ ok: false });
      expect((await reported())!.name).toContain("Delegated Peer — failed: Fixture turn failed.");
      expect((await reported())!.name).not.toContain("made 1 tool call");
      await expect.poll(() => handoff()?.status, { timeout: 20_000 }).toBe("failed");
    }
    const woken = async () => JSON.stringify((await dump(models[0])).prompt);
    await expect.poll(woken, { timeout: 20_000 }).toContain("[QuatiBot report from @Delegated Peer on assignment");
    expect(await woken()).toContain("nobody answered the approval for “shell: npm run release-check” in time, so it did not run. Do not report it as done; it needs the person's approval.");
  }, 60_000);

  it("tells a room's coordinator that a member's approval went unanswered, so the step did not run", async () => {
    const chief = (await tool("create_bot", { name: "Room Chief", instance_id: "opencodeGo", model: models[0] })).bot;
    const peer = (await tool("create_bot", { name: "Room Peer", instance_id: "opencodeGo", model: models[1] })).bot;
    expect((await api("PATCH", `/api/bots/${peer.id}`, { approvalMode: "ask" })).status).toBe(200);
    const created = await api("POST", "/api/groups", {
      name: "Release room", memberIds: [chief.id, peer.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: chief.id } },
    });
    expect(created.status).toBe(201);
    const room = created.body.group;
    expect((await api("POST", `/api/groups/${room.id}/messages`, { threadId: room.threadId, text: "Have the reviewer run the release checks." })).status).toBe(202);
    const token = mcpEnvironment(await dump(models[0]), "agents").QUATI_COMMS_TOKEN;
    const sent = await internal(token, "POST", "/api/internal/coordinate-bots", { botIds: [peer.id], message: "RELEASE_CHECKS: run the release checks." });
    expect(sent.status).toBe(200);
    const requestId = sent.body.receipts[0].requestId;
    const handoff = () => readHandoffs(session.info.dataDir).find((node) => node.id === requestId);
    expect(handoff()).toMatchObject({ groupId: room.id });
    writeFileSync(modelFile(models[0], "gate"), "finish");
    const unanswered = await permission(models[1], "unanswered-room", { command: "npm run release-check" });
    await expect.poll(async () => (await api("GET", `/api/threads/${room.threadId}/messages?limit=100`)).body.messages
      .some((message: any) => message.card?.requestId === unanswered.requestId), { timeout: 15_000 }).toBe(true);
    const expiry = join(session.info.dataDir, "expire-approvals");
    writeFileSync(expiry, "expire");
    await expect.poll(unanswered.answer).toBe("reject");
    rmSync(expiry, { force: true });
    writeFileSync(modelFile(models[1], "gate"), "finish");
    await expect.poll(() => handoff()?.status, { timeout: 20_000 }).toBe("completed");
    expect(handoff()!.result.startsWith("[QuatiBot: nobody answered the approval for “shell: npm run release-check” in time, so it did not run.")).toBe(true);
  }, 60_000);

  it("ends a one-way notice whose recipient thread was deleted before it started, without restarting the sender", async () => {
    const sender = (await tool("create_bot", { name: "Independent sender", instance_id: "opencodeGo", model: models[0] })).bot;
    const recipient = (await tool("create_bot", { name: "Independent recipient", instance_id: "opencodeGo", model: models[1] })).bot;
    // One slot, held by the recipient's own turn, so the notice queues.
    const capacity = (await api("GET", "/api/config")).body.threads?.maxConcurrentPerBot ?? 2;
    expect((await api("PATCH", "/api/config", { threads: { maxConcurrentPerBot: 1 } })).status).toBe(200);
    try {
      await control(["send", "--bot", recipient.id, "--text", "Hold the recipient's slot."]);
      await expect.poll(async () => (await botState(recipient.id)).busy, { timeout: 15_000 }).toBe(true);
      await control(["send", "--bot", sender.id, "--text", "Prepare independent work."]);
      const launched = await dump(models[0]);
      const token = mcpEnvironment(launched, "agents").QUATI_COMMS_TOKEN;
      const sent = await internal(token, "POST", "/api/internal/coordinate-bots", {
        botIds: [recipient.id], message: "Own this work.", thread: "new", reply: "none",
      });
      expect(sent.status, JSON.stringify(sent.body)).toBe(200);
      const receipt = sent.body.receipts[0];
      expect(receipt).toMatchObject({ botId: recipient.id, outcome: "queued", threadId: expect.any(String), requestId: expect.any(String) });
      const threadId = receipt.threadId as string;
      const notice = () => readHandoffs(session.info.dataDir).find((node) => node.id === receipt.requestId);
      expect(notice()).toMatchObject({ mode: "notify", reply: "none", status: "queued", threadId });
      expect((await api("DELETE", `/api/bots/${recipient.id}/tasks/${threadId}`)).status).toBe(200);
      await expect.poll(() => notice()?.status, { timeout: 15_000 }).toMatch(/^(failed|cancelled)$/);
      expect(notice()!.executions).toBe(0);
      writeFileSync(modelFile(models[0], "gate"), "finish sender");
      expect((await control(["wait", "--bot", sender.id, "--timeout", "15"])).status).toBe("settled");
      const after = (await api("GET", `/api/threads/${sender.activeTaskId}/messages`)).body.messages as any[];
      expect(after.filter((message: any) => message.tool?.ok === false)).toEqual([]);
      expect(after.filter((message: any) => message.roomRequest?.phase === "result")).toEqual([]);
      expect((await api("GET", `/api/threads/${threadId}/messages`)).status).toBe(404);
      expect((await botState(recipient.id)).tasks.some((task: any) => task.threadId === threadId)).toBe(false);
      expect((await botState(sender.id)).busy).toBe(false);
      expect((await dump(models[0])).pid).toBe(launched.pid);
      writeFileSync(modelFile(models[1], "gate"), "finish recipient");
      await expect.poll(async () => (await botState(recipient.id)).busy, { timeout: 15_000 }).toBe(false);
    } finally {
      expect((await api("PATCH", "/api/config", { threads: { maxConcurrentPerBot: capacity } })).status).toBe(200);
    }
  }, 45_000);

  it("replaces the final worked thread with blank context but refuses to delete it while running", async () => {
    const created = await tool("create_bot", { name: "Last thread fixture", instance_id: "opencodeGo", model: models[0] });
    const botId = created.bot.id;
    const threadId = created.bot.activeTaskId;
    await control(["send", "--bot", botId, "--task", threadId, "--text", "LAST_THREAD_WORK"]);
    await dump(models[0]);
    expect((await api("DELETE", `/api/bots/${botId}/tasks/${threadId}`)).status).toBe(409);
    writeFileSync(modelFile(models[0], "gate"), "finish");
    expect((await control(["wait", "--bot", botId, "--task", threadId, "--timeout", "15"])).status).toBe("settled");
    const before = (await api("GET", "/api/bots")).body.bots.find((bot: any) => bot.id === botId);
    expect(before.tasks).toHaveLength(1);
    expect(before.messages.some((message: any) => message.role === "user" && message.text === "LAST_THREAD_WORK")).toBe(true);
    const artifact = join(session.info.dataDir, "task-workspaces", botId, threadId, "result.txt");
    writeFileSync(artifact, "Retain generated project files");

    const deleted = await api("DELETE", `/api/bots/${botId}/tasks/${threadId}`);
    expect(deleted.status).toBe(200);
    const fresh = deleted.body.bot;
    expect(fresh.tasks).toHaveLength(1);
    expect(fresh.threadId).not.toBe(threadId);
    expect(fresh.tasks[0]).toMatchObject({ threadId: fresh.threadId, title: "New thread", busy: false });
    expect(fresh.messages).toEqual([]);
    expect(fresh.modelSelection).toEqual(before.modelSelection);
    expect(readFileSync(artifact, "utf8")).toBe("Retain generated project files");
    expect((await api("DELETE", `/api/bots/${botId}/tasks/${threadId}`)).status).toBe(404);
    const loaded = (await api("GET", "/api/bots")).body.bots.find((bot: any) => bot.id === botId);
    expect(loaded.threadId).toBe(fresh.threadId);
    expect(loaded.messages).toEqual([]);
    await control(["send", "--bot", botId, "--task", fresh.threadId, "--text", "NEW_THREAD_WORK"]);
    expect((await control(["wait", "--bot", botId, "--task", fresh.threadId, "--timeout", "15"])).status).toBe("settled");
    const messages = (await api("GET", "/api/bots")).body.bots.find((bot: any) => bot.id === botId).messages;
    expect(messages.some((message: any) => message.text === "NEW_THREAD_WORK")).toBe(true);
    expect(messages.some((message: any) => message.text === "LAST_THREAD_WORK")).toBe(false);
    evidence.push({ deletedThreadId: threadId, replacementThreadId: fresh.threadId, blankReplacement: true, artifactRetained: true });
  }, 30_000);

  it("rejects blank memory replacements, caps new titles, and retains project files after deletion", async () => {
    const created = await tool("create_bot", { name: "Release review fixture", instance_id: "opencodeGo", model: models[0] });
    const botId = created.bot.id;
    const task = await api("POST", `/api/bots/${botId}/tasks`, { title: `  ${"t".repeat(120)}  ` });
    expect(task.status).toBe(201);
    expect(task.body.task.title).toBe("t".repeat(80));
    const threadId = task.body.task.threadId;
    await control(["send", "--bot", botId, "--task", threadId, "--text", "REVIEW_MEMORY_OWNER"]);
    const launched = await dump(models[0]);
    const token = mcpEnvironment(launched, "agents").QUATI_COMMS_TOKEN;
    expect((await internal(token, "POST", "/api/internal/memory", { action: "append", text: "A unique saved fact." })).status).toBe(200);
    for (const text of ["", " \n\t "]) {
      expect((await internal(token, "POST", "/api/internal/memory", { action: "replace", oldText: "unique saved fact", text })).status).toBe(400);
      expect((await api("GET", `/api/bots/${botId}/memory`)).body.text).toBe(`- ${memoryDate()} · from chat "${"t".repeat(60)}…" · A unique saved fact.\n`);
    }
    const project = join(session.info.dataDir, "task-workspaces", botId, threadId, "result.txt");
    writeFileSync(project, "Generated project files are retained.");
    await control(["interrupt", "--bot", botId, "--task", threadId]);
    await expect.poll(async () => (await botState(botId)).busy, { timeout: 10_000 }).toBe(false);
    expect((await api("DELETE", `/api/bots/${botId}/tasks/${threadId}`)).status).toBe(200);
    expect((await api("DELETE", `/api/bots/${botId}`)).status).toBe(200);
    expect(readFileSync(project, "utf8")).toBe("Generated project files are retained.");
    evidence.push({ cappedTitleLength: 80, blankMemoryReplacementRejected: true, generatedFilesRetained: true });
  }, 30_000);

  it("exposes background waiting threads and pins paired approval answers to the displayed request", async () => {
    const created = await tool("create_bot", { name: "Phone approval fixture", instance_id: "opencodeGo", model: models[0] });
    const botId = created.bot.id;
    const threadA = created.bot.activeTaskId;
    await api("PATCH", `/api/bots/${botId}/tasks/${threadA}`, { approvalMode: "ask" });
    await control(["send", "--bot", botId, "--task", threadA, "--text", "Hold thread A for approval"]);
    const answersA = await permission(models[0], "phone-approval-a");

    const second = await tool("create_task", { target_type: "bot", target_id: botId, title: "Phone background B" });
    const threadB = second.task.taskId;
    await control(["set-model", "--bot", botId, "--task", threadB, "--instance", "opencodeGo", "--model", models[1]]);
    await api("PATCH", `/api/bots/${botId}/tasks/${threadB}`, { approvalMode: "ask" });
    await control(["send", "--bot", botId, "--task", threadB, "--text", "Hold thread B for approval"]);
    const answersB = await permission(models[1], "phone-approval-b");
    await expect.poll(async () => (await botState(botId)).tasks.filter((task: any) => task.activity === "waiting-on-you").length).toBe(2);
    await tool("switch_task", { target_type: "bot", target_id: botId, task_id: threadA });

    const invitation = await api("POST", "/api/auth/pairing", { label: "Isolated iOS approval fixture", scopes: ["client", "admin"] });
    expect(invitation.status).toBe(200);
    const accepted = await api("POST", "/api/auth/pair", { code: invitation.body.code, label: "Isolated iOS client" });
    expect(accepted.status).toBe(200);
    const paired = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(`${session.info.url}${path}`, {
        method, headers: { "content-type": "application/json", authorization: `Bearer ${accepted.body.token}` },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json() as any };
    };
    const fleet = await paired("GET", "/api/bots?messages=50");
    const bot = fleet.body.bots.find((candidate: any) => candidate.id === botId);
    expect(bot.threadId).toBe(threadA);
    expect(bot.tasks.find((task: any) => task.threadId === threadB)?.activity).toBe("waiting-on-you");
    expect(bot.messages.some((message: any) => message.card?.requestId === answersB.requestId)).toBe(false);
    const background = await paired("GET", `/api/threads/${threadB}/messages?limit=50`);
    expect(background.body.messages.some((message: any) => message.card?.requestId === answersB.requestId && !message.card.answered)).toBe(true);

    const stale = await paired("POST", `/api/threads/${threadA}/respond`, { requestId: answersB.requestId, behavior: "allow" });
    expect(stale.body.outcome).toBe("unavailable");
    expect(answersA.answer()).toBeUndefined();
    expect(answersB.answer()).toBeUndefined();
    const answered = await paired("POST", `/api/threads/${threadB}/respond`, { requestId: answersB.requestId, behavior: "allow" });
    expect(answered.status).toBe(200);
    expect(answered.body.outcome).toBe("allowed-once");
    await expect.poll(answersB.answer).toBe("allow-once");
    expect(answersA.answer()).toBeUndefined();
    expect((await botState(botId)).tasks.find((task: any) => task.taskId === threadA)?.activity).toBe("waiting-on-you");
    evidence.push({ phoneApproval: { botId, threadA, threadB, backgroundActivity: "waiting-on-you", staleOutcome: stale.body.outcome, displayedOutcome: answered.body.outcome } });
    await control(["interrupt", "--bot", botId, "--task", threadA]);
    await control(["interrupt", "--bot", botId, "--task", threadB]);
  }, 45_000);

  it("keeps A and B independent across selection, models, approvals, and stopping A", async () => {
    const created = await tool("create_bot", { name: "Independent fixture", instance_id: "opencodeGo", model: models[0] });
    const botId = created.bot.id;
    const taskA = created.bot.activeTaskId;
    expect((await api("PATCH", `/api/bots/${botId}/tasks/${taskA}`, { approvalMode: "ask" })).status).toBe(200);
    await control(["send", "--bot", botId, "--task", taskA, "--text", "ONLY_A"]);
    const launchedA = await dump(models[0]);

    const second = await tool("create_task", { target_type: "bot", target_id: botId, title: "Independent B" });
    const taskB = second.task.taskId;
    await control(["set-model", "--bot", botId, "--task", taskB, "--instance", "opencodeGo", "--model", models[1]]);
    // This settings action models the trusted app's same-origin request.
    expect((await api("PATCH", `/api/bots/${botId}/tasks/${taskB}`, { approvalMode: "auto" })).status).toBe(409);
    expect((await api("PATCH", `/api/bots/${botId}/tasks/${taskB}`, { approvalMode: "auto" }, true)).status).toBe(200);
    await control(["send", "--bot", botId, "--task", taskB, "--text", "ONLY_B"]);
    const launchedB = await dump(models[1]);
    expect(launchedA.pid).not.toBe(launchedB.pid);
    expect(launchedA.model).toBe(models[0]);
    expect(launchedB.model).toBe(models[1]);
    expect(launchedA.nativePermissions ?? []).not.toContainEqual({ action: "*", resource: "*", effect: "allow" });
    expect(launchedB.nativePermissions ?? []).not.toContainEqual({ action: "*", resource: "*", effect: "allow" });
    evidence.push({ providerSelections: [models[0], models[1]], distinctProcesses: true });
    expect(launchedA.cwd).toBe(realpathSync(join(session.info.dataDir, "task-workspaces", botId, taskA)));
    expect(launchedB.cwd).toBe(realpathSync(join(session.info.dataDir, "task-workspaces", botId, taskB)));

    const tokenA = mcpEnvironment(launchedA, "agents").QUATI_COMMS_TOKEN;
    const tokenB = mcpEnvironment(launchedB, "agents").QUATI_COMMS_TOKEN;
    expect(tokenA).not.toBe(tokenB);
    const appended = await Promise.all([
      internal(tokenA, "POST", "/api/internal/memory", { botId, threadId: taskA, action: "append", text: "A remembers apples." }),
      internal(tokenB, "POST", "/api/internal/memory", { botId, threadId: taskB, action: "append", text: "B remembers berries." }),
    ]);
    expect(appended.map((result) => result.status)).toEqual([200, 200]);
    const memory = (await api("GET", `/api/bots/${botId}/memory`)).body.text;
    expect(memory).toContain("A remembers apples.");
    expect(memory).toContain("B remembers berries.");
    expect((await internal(tokenA, "POST", "/api/internal/memory", { action: "replace", oldText: "A remembers apples.", text: "A remembers apricots." })).status).toBe(200);
    expect((await internal(tokenB, "POST", "/api/internal/memory", { action: "replace", oldText: "A remembers apples.", text: "stale overwrite" })).status).toBe(409);
    const foreign = await tool("create_bot", { name: "Foreign memory owner" });
    expect((await internal(tokenA, "POST", "/api/internal/memory", { botId: foreign.bot.id, action: "append", text: "foreign write" })).status).toBe(403);
    expect((await internal(tokenA, "POST", "/api/internal/memory", { botId, threadId: taskB, action: "append", text: "wrong conversation" })).status).toBe(403);
    expect((await api("GET", `/api/bots/${foreign.bot.id}/memory`)).body.text).toBe("");

    await tool("switch_task", { target_type: "bot", target_id: botId, task_id: taskA });
    await tool("switch_task", { target_type: "bot", target_id: botId, task_id: taskB });
    expect((await botState(botId)).tasks.filter((task: any) => task.busy)).toHaveLength(2);
    expect((await control(["wait", "--bot", botId, "--task", taskA, "--timeout", "1"])).status).toBe("timed-out");
    const changeBusy = await api("PATCH", `/api/bots/${botId}/tasks/${taskA}`, { modelSelection: { instanceId: "opencodeGo", model: models[1] } });
    expect(changeBusy.status).toBe(409);

    const answerA = await permission(models[0], "approval-a");
    await expect.poll(async () => (await botState(botId)).tasks.find((task: any) => task.taskId === taskA)?.activity).toBe("waiting-on-you");
    expect((await botState(botId)).tasks.find((task: any) => task.taskId === taskB)?.activity).toBe("working");
    expect((await api("POST", `/api/bots/${botId}/respond`, { threadId: taskA, requestId: answerA.requestId, behavior: "allow" })).status).toBe(200);
    await expect.poll(answerA.answer).toBe("allow-once");

    await control(["interrupt", "--bot", botId, "--task", taskA]);
    await expect.poll(async () => (await botState(botId)).tasks.find((task: any) => task.taskId === taskA)?.busy).toBe(false);
    expect((await botState(botId)).tasks.find((task: any) => task.taskId === taskB)?.busy).toBe(true);
    expect((await internal(tokenA, "POST", "/api/internal/memory", { action: "append", text: "expired write" })).status).toBe(401);
    expect((await internal(tokenB, "POST", "/api/internal/memory", { action: "append", text: "B is still authorized." })).status).toBe(200);
    expect((await control(["wait", "--bot", botId, "--task", taskA, "--timeout", "1"])).status).toBe("settled");
    writeFileSync(modelFile(models[1], "gate"), "finish B");
    expect((await control(["wait", "--bot", botId, "--task", taskB, "--timeout", "10"])).status).toBe("settled");
    const messagesA = await control(["messages", "--bot", botId, "--task", taskA]);
    const messagesB = await control(["messages", "--bot", botId, "--task", taskB]);
    expect(JSON.stringify(messagesA.messages)).not.toContain("ONLY_B");
    expect(JSON.stringify(messagesB.messages)).not.toContain("ONLY_A");
    expect(messagesB.messages.some((message: any) => message.role === "bot" && message.text?.includes("ONLY_B"))).toBe(true);

    const userA = messagesA.messages.find((message: any) => message.role === "user");
    expect((await api("POST", `/api/bots/${botId}/messages/${userA.id}/edit`, { threadId: taskB, text: "wrong task" })).status).toBe(404);
    expect((await api("POST", `/api/bots/${botId}/active-branch`, { threadId: taskB, messageId: userA.id })).status).toBe(404);

    await tool("switch_task", { target_type: "bot", target_id: botId, task_id: taskA });
    const legacyModel = models.at(-1)!;
    expect((await api("PATCH", `/api/bots/${botId}`, { modelSelection: { instanceId: "opencodeGo", model: legacyModel } })).status).toBe(200);
    const final = await botState(botId);
    expect(final.tasks.find((task: any) => task.taskId === taskA).modelSelection.model).toBe(legacyModel);
    expect(final.tasks.find((task: any) => task.taskId === taskB).modelSelection.model).toBe(models[1]);
  }, 45_000);

  it("cancels a detached routine on its captured provider after an idle sibling changes the default", async () => {
    const created = await tool("create_bot", { name: "Routine provider fixture", instance_id: "opencodeGo", model: models[0] });
    const botId = created.bot.id;
    const selectedThread = created.bot.activeTaskId;
    const routine = await api("POST", "/api/routines", {
      name: "Captured routine provider", prompt: "ROUTINE_PROVIDER_OWNER", botId, runOn: "quati", enabled: false,
      schedule: { type: "daily", time: "10:00", weekdays: [1] },
    });
    expect(routine.status).toBe(201);
    const launched = await api("POST", `/api/routines/${routine.body.routine.id}/run`);
    expect(launched.status).toBe(201);
    await dump(models[0]);
    const run = (await api("GET", "/api/routines")).body.runs.find((item: any) => item.id === launched.body.run.id);
    expect(run.threadId).not.toBe(selectedThread);
    expect((await botState(botId)).tasks.find((task: any) => task.taskId === run.threadId)?.busy).toBe(true);
    expect((await api("PATCH", `/api/bots/${botId}`, {
      modelSelection: { instanceId: "offline-fixture", model: "offline-model" },
    })).status).toBe(200);
    expect((await api("POST", `/api/routine-runs/${run.id}/cancel`)).status).toBe(200);
    await expect.poll(async () => (await botState(botId)).tasks.find((task: any) => task.taskId === run.threadId)?.busy,
      { timeout: 10_000 }).toBe(false);
    const final = await botState(botId);
    expect(final.tasks.find((task: any) => task.taskId === run.threadId)?.modelSelection.instanceId).toBe("offline-fixture");
    expect(final.tasks.find((task: any) => task.taskId === selectedThread)?.modelSelection.instanceId).toBe("offline-fixture");
    evidence.push({ routineCancelledOnOriginalProvider: true, runId: run.id, taskId: run.threadId });
  }, 30_000);

  it("keeps a Group's profile model fixed while allowing independent idle task settings", async () => {
    const created = await tool("create_bot", { name: "Group model fixture", instance_id: "opencodeGo", model: models[0] });
    const botId = created.bot.id;
    const threadId = created.bot.activeTaskId;
    const group = (await api("POST", "/api/groups", { name: "Captured Group provider", memberIds: [botId] })).body.group;
    expect((await api("PATCH", `/api/groups/${group.id}/setup`, {
      action: "complete", cwd: null, bulletin: "", defaultResponder: { kind: "member", botId },
    })).status).toBe(200);
    expect((await api("POST", `/api/groups/${group.id}/messages`, { text: "GROUP_MODEL_OWNER" })).status).toBe(202);
    await dump(models[0]);
    const selection = { instanceId: "opencodeGo", model: models[1] };
    expect((await api("PATCH", `/api/bots/${botId}/tasks/${threadId}`, { modelSelection: selection })).status).toBe(200);
    expect((await api("PATCH", `/api/bots/${botId}/model`, selection)).status).toBe(409);
    expect((await api("PATCH", `/api/bots/${botId}`, { modelSelection: selection })).status).toBe(409);
    expect((await api("PATCH", `/api/bots/${botId}/tasks/${threadId}`, { modelSelection: selection, updateBotDefault: true })).status).toBe(409);
    expect((await botState(botId)).tasks.find((task: any) => task.taskId === threadId)?.modelSelection).toEqual(selection);
    const profile = (await api("GET", "/api/bots")).body.bots.find((bot: any) => bot.id === botId);
    expect(profile.modelSelection.model).toBe(models[0]);
    expect((await api("POST", `/api/groups/${group.id}/interrupt`, {})).status).toBe(200);
    await expect.poll(async () => (await botState(botId)).busy, { timeout: 10_000 }).toBe(false);
    expect((await api("PATCH", `/api/bots/${botId}/tasks/${threadId}`, { modelSelection: selection, updateBotDefault: true })).status).toBe(200);
    expect((await botState(botId)).modelSelection).toEqual(selection);
    evidence.push({ groupDefaultPreservedUntilStop: true, groupId: group.id, selectedTaskId: threadId });
  }, 30_000);

  it("runs a second engine of the same bot in the selected project folder at the same time", async () => {
    const created = await tool("create_bot", { name: "Shared project fixture", instance_id: "opencodeGo", model: models[0] });
    const botId = created.bot.id;
    const taskA = created.bot.activeTaskId;
    const cwd = join(session.info.dataDir, "selected-project");
    mkdirSync(cwd);
    expect((await api("PATCH", `/api/bots/${botId}`, { cwd })).status).toBe(200);
    await control(["send", "--bot", botId, "--task", taskA, "--text", "PROJECT_A"]);
    expect((await dump(models[0])).cwd).toBe(realpathSync(cwd));
    const second = await tool("create_task", { target_type: "bot", target_id: botId, title: "Project sibling" });
    const taskB = second.task.taskId;
    await control(["set-model", "--bot", botId, "--task", taskB, "--instance", "opencodeGo", "--model", models[1]]);
    await control(["send", "--bot", botId, "--task", taskB, "--text", "PROJECT_B_PARALLEL"]);
    expect((await dump(models[1])).cwd).toBe(realpathSync(cwd));
    const both = await botState(botId);
    expect(both.tasks.find((task: any) => task.taskId === taskA)?.busy).toBe(true);
    expect(both.tasks.find((task: any) => task.taskId === taskB)?.busy).toBe(true);
    expect(JSON.stringify((await control(["messages", "--bot", botId, "--task", taskB])).messages)).not.toContain("project folder");
    await control(["interrupt", "--bot", botId, "--task", taskA]);
    await control(["interrupt", "--bot", botId, "--task", taskB]);
    evidence.push({ parallelThreadsInOneProjectFolder: true, botId, taskA, taskB });
  }, 45_000);

  it("runs an unattended task in the bot's own level, still carding what the provider asks, while a sibling runs attended", async () => {
    const created = await tool("create_bot", { name: "Unattended fixture", instance_id: "opencodeGo", model: models[0] });
    const botId = created.bot.id;
    expect((await api("PATCH", `/api/bots/${botId}`, { approvalMode: "auto" })).status).toBe(200);
    const hook = await api("POST", "/api/webhooks", { name: "Fixture event", prompt: "UNATTENDED_ONLY", botId, runOn: "quati" });
    expect(hook.status).toBe(201);
    const delivered = await fetch(hook.body.credential.url, { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    expect(delivered.status).toBe(202);
    const { runId } = await delivered.json() as { runId: string };
    let unattendedTask = "";
    await expect.poll(async () => {
      unattendedTask = (await api("GET", "/api/routines")).body.runs.find((run: any) => run.id === runId)?.threadId ?? "";
      return Boolean(unattendedTask);
    }, { timeout: 15_000 }).toBe(true);
    const unattendedLaunch = await dump(models[0]);
    const second = await tool("create_task", { target_type: "bot", target_id: botId, title: "Attended sibling" });
    const attendedTask = second.task.taskId;
    await control(["set-model", "--bot", botId, "--task", attendedTask, "--instance", "opencodeGo", "--model", models[1]]);
    await control(["send", "--bot", botId, "--task", attendedTask, "--text", "ATTENDED_ONLY"]);
    const attendedLaunch = await dump(models[1]);
    expect(unattendedLaunch.nativePermissions ?? []).not.toContainEqual({ action: "*", resource: "*", effect: "allow" });
    expect(attendedLaunch.nativePermissions ?? []).not.toContainEqual({ action: "*", resource: "*", effect: "allow" });

    const unattendedAnswers = await permission(models[0], "unattended-permission");
    expect((await control(["wait", "--bot", botId, "--task", unattendedTask, "--timeout", "5"])).status).toBe("needs-user");
    const card = (await api("GET", `/api/threads/${unattendedTask}/messages`)).body.messages
      .find((message: any) => message.card?.requestId === unattendedAnswers.requestId);
    expect(card.card.heldCode).toBe("approval.held.native");
    expect(unattendedAnswers.answer()).toBeUndefined();
    expect((await botState(botId)).tasks.find((task: any) => task.taskId === attendedTask)?.activity).toBe("working");
    await control(["interrupt", "--bot", botId, "--task", attendedTask]);
    expect((await botState(botId)).tasks.find((task: any) => task.taskId === unattendedTask)?.activity).toBe("waiting-on-you");
    await control(["messages", "--bot", botId, "--task", unattendedTask]);
    await control(["interrupt", "--bot", botId, "--task", unattendedTask]);
  }, 45_000);
});
