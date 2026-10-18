import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlQuati } from "../scripts/control-quati.ts";
import { removeTempDir } from "./testing/cleanup.ts";

it("Clive reviews multi-model teams once, continues after each decision, and preserves existing threads through setup and deletion", async () => {
  const gates = mkdtempSync(join(tmpdir(), "quati-team-setup-gates-"));
  const gate = join(gates, "finish");
  const fixture = await launchVerificationServer({ FAKE_ACP_MODE: "echo-gated", FAKE_ACP_GATE_FILE: gate, FAKE_ACP_MODELS: "fixture/standard,fixture/review" });
  const evidence: unknown[] = [{ fixture: fixture.info }];
  const api = async (method: string, path: string, body?: unknown, expected = 200, token?: string, fromApp = true) => {
    const response = await fetch(fixture.info.url + path, { method, headers: { "content-type": "application/json",
      ...(fromApp ? { origin: fixture.info.url } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json() as any;
    // Never record provider environment/capabilities. Keep actions and safe results.
    evidence.push({ method, path, body, authority: token ? "turn capability" : fromApp ? "app review" : "originless loopback", status: response.status, result });
    expect(response.status, JSON.stringify(result)).toBe(expected); return result;
  };
  const control = async (...args: string[]) => {
    const result = await runControlQuati([...args, "--url", fixture.info.url]) as any;
    evidence.push({ command: args, result }); return result;
  };
  try {
    const catalog = (await api("GET", "/api/instances")).instances;
    const instance = catalog.find((item: any) => item.instanceId === "opencodeGo");
    expect(instance.models.options.map((model: { id: string }) => model.id)).toEqual(expect.arrayContaining(["fixture/standard", "fixture/review"]));
    const standard = { instanceId: instance.instanceId, model: "fixture/standard" };
    const review = { instanceId: instance.instanceId, model: "fixture/review" };
    const chief = (await api("POST", "/api/bots", { name: "Clive", title: "Chief of Staff", section: "Operations", modelSelection: standard }, 201)).bot;
    // On Ask, so each team setup waits on Clive's review card.
    await api("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: true, approvalMode: "ask" });
    const state = async () => (await api("GET", "/api/bots")).bots;
    // The fixture pins its starter's name, but identity is the honest comparison: a name once collided with a random starter.
    const initialBotIds = new Set((await state()).map((bot: any) => bot.id));
    const setupBots = async () => (await state()).filter((bot: any) => !initialBotIds.has(bot.id));
    type NativeTurn = { prompt: Array<{ type: string; text?: string }>; mcpServers: Array<{ name: string; env: Array<{ name: string; value: string }> }> };
    const nativeTurns = (threadId = chief.threadId): NativeTurn[] => {
      const file = `${fixture.fixtureDumpPath}.prompts.jsonl`;
      if (!existsSync(file)) return [];
      return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((turn: NativeTurn) =>
        turn.mcpServers.some((server) => server.env.some((entry) => entry.name === "QUATI_THREAD_ID" && entry.value === threadId)));
    };
    let previousTurnCount = 0;
    let guardedMessageId: string | undefined;
    const start = async (text: string, sendId?: string) => {
      const beforeCount = nativeTurns().length;
      if (existsSync(gate)) unlinkSync(gate);
      if (sendId) {
        const before = await api("GET", `/api/threads/${chief.threadId}/messages`);
        const accepted = await api("POST", `/api/bots/${chief.id}/messages/guarded`, {
          threadId: chief.threadId, sendId, text, expectedActiveLeafId: before.activeLeafId,
        }, 202);
        guardedMessageId = accepted.message.id;
      } else await control("send", "--bot", chief.id, "--task", chief.threadId, "--text", text);
      await expect.poll(() => nativeTurns().length, { timeout: 15_000 }).toBe(beforeCount + 1);
      previousTurnCount = nativeTurns().length;
      const token = nativeTurns().at(-1)?.mcpServers.find((server) => server.name === "agents")?.env.find((entry) => entry.name === "QUATI_COMMS_TOKEN")?.value;
      expect(token).toBeTruthy();
      return token;
    };
    const finish = async () => {
      writeFileSync(gate, "finish");
      await expect.poll(async () => !(await state()).find((bot: any) => bot.id === chief.id).busy, { timeout: 20_000 }).toBe(true);
    };
    const continueOnce = async (requestId: string) => {
      await expect.poll(async () => {
        const bot = (await state()).find((bot: any) => bot.id === chief.id);
        return !bot.busy && bot.messages.filter((message: any) => message.role === "bot" && message.kind === "text" && message.text?.includes(`team setup decision ${requestId}:`)).length;
      }, { timeout: 20_000 }).toBe(1);
      previousTurnCount = nativeTurns().length;
      evidence.push({ continuation: { requestId, prompt: nativeTurns().at(-1)?.prompt, provider: "fixture OpenCode", exactlyOneReply: true } });
    };
    const stopWithoutResume = async (requestId: string, threadId: string, target: "--bot" | "--channel", id: string) => {
      const beforeCount = nativeTurns(threadId).length;
      await control("interrupt", target, id, "--task", threadId);
      writeFileSync(gate, "finish");
      await control("wait", target, id, "--task", threadId, "--timeout", "15");
      // Allow an erroneously queued provider handshake/reply to become visible.
      await new Promise((resolve) => setTimeout(resolve, 350));
      await api("POST", `/api/threads/${threadId}/respond`, { requestId, behavior: "deny" });
      const messages = (await api("GET", `/api/threads/${threadId}/messages`)).messages;
      expect(messages.some((message: any) => message.text?.includes(`team setup decision ${requestId}:`))).toBe(false);
      expect(nativeTurns(threadId)).toHaveLength(beforeCount);
      expect((await state()).find((bot: any) => bot.id === chief.id).busy).toBe(false);
      evidence.push({ cancellation: { requestId, threadId, noNewProviderPrompt: true, noContinuationReply: true } });
    };
    const build = (name: string, team: string, modelSelection: unknown) => ({ action: "create", key: name, fields: {
      name, title: `${team} specialist`, soul: `Own ${team.toLowerCase()} work. Return evidence and state uncertainty.`, section: team, modelSelection,
    } });
    const plan = { reason: "Set up Research, Engineering and Growth specialists as requested", newTeams: ["Research", "Engineering", "Growth"], operations: [
      build("Mira", "Research", standard), build("Patch", "Engineering", review), build("Quill", "Growth", standard),
      { action: "create", key: "Patch", fields: { title: "Implementation and verification engineer", chiefOfStaff: true } },
    ] };
    let token = await start("Clive, review this setup while you are working.");
    const stopped = await api("POST", "/api/internal/team-setup-requests", { plan }, 201, token);
    await api("POST", `/api/threads/${chief.threadId}/respond`, { requestId: stopped.requestId, behavior: "deny" });
    await stopWithoutResume(stopped.requestId, chief.threadId, "--bot", chief.id);
    token = await start("Clive, set up Research, Engineering and Growth specialists with suitable OpenCode models.");
    const tools = await api("GET", "/api/internal/team-setup-catalog", undefined, 200, token);
    expect(tools.instances.map((item: any) => item.instanceId)).toContain("opencodeGo");
    await api("POST", "/api/internal/team-setup-requests", { plan: { ...plan, operations: [build("Bad", "Research", { instanceId: "opencodeGo", model: "invented-model" })] } }, 400, token);
    await api("POST", "/api/internal/team-setup-requests", { fromBotId: "foreign", plan }, 403, token);
    const denied = await api("POST", "/api/internal/team-setup-requests", { plan }, 201, token);
    expect(await setupBots()).toHaveLength(0);
    await api("POST", `/api/threads/${chief.threadId}/respond`, { requestId: denied.requestId, behavior: "deny" });
    await finish(); await continueOnce(denied.requestId);
    expect((await state()).find((bot: any) => bot.id === chief.id).managedSections).toBeUndefined();

    const setupSendId = randomUUID();
    token = await start("Apply the reviewed Research, Engineering and Growth setup.", setupSendId);
    const requestSnapshot = () => api("GET", `/api/bots/${chief.id}/requests/${setupSendId}?threadId=${chief.threadId}`);
    const proposed = await api("POST", "/api/internal/team-setup-requests", { plan }, 201, token);
    const before = (await state()).find((bot: any) => bot.id === chief.id);
    const card = before.messages.find((message: any) => message.card?.requestId === proposed.requestId).card;
    expect(card.teamSetupRequest.operations).toHaveLength(3);
    expect(card.subtitle).toContain("Authorize @Clive");
    expect(card.subtitle).toContain("Chief of Staff: No → Yes");
    await api("POST", `/api/threads/${chief.threadId}/respond`, { requestId: proposed.requestId, behavior: "allow" }, 403);
    expect(await setupBots()).toHaveLength(0);
    await finish();
    const waiting = await requestSnapshot();
    expect(waiting).toMatchObject({ messageId: guardedMessageId, phase: "waiting", activeTurnId: null, executionId: expect.any(String) });
    expect(waiting.messages[0]).toMatchObject({ id: guardedMessageId, sendId: setupSendId, role: "user" });
    expect(waiting.messages.at(-1).id).toBe(waiting.activeLeafId);
    await api("POST", `/api/threads/${chief.threadId}/respond`, { requestId: proposed.requestId, behavior: "allow" }, 403, undefined, false);
    const approved = await api("POST", `/api/threads/${chief.threadId}/respond`, { requestId: proposed.requestId, behavior: "allow" });
    expect(approved.result.state).toBe("applied"); await continueOnce(proposed.requestId);
    const settled = await requestSnapshot();
    expect(settled).toMatchObject({ messageId: guardedMessageId, phase: "settled", activeTurnId: null, executionId: expect.any(String) });
    expect(settled.executionId).not.toBe(waiting.executionId);
    expect(settled.messages[0].id).toBe(guardedMessageId);
    expect(settled.messages.at(-1).id).toBe(settled.activeLeafId);
    const replies = settled.messages.filter((message: any) => message.role === "bot" && message.kind === "text" && message.turnTerminal);
    expect(replies).toHaveLength(2);
    expect(new Set(replies.map((message: any) => message.turnId)).size).toBe(2);
    expect(replies.every((message: any) => message.requestMessageId === guardedMessageId)).toBe(true);
    expect(replies.at(-1).text).toContain(`team setup decision ${proposed.requestId}:`);
    const saved = await state();
    const created = saved.filter((bot: any) => !initialBotIds.has(bot.id));
    expect(created.map((bot: any) => bot.name).sort()).toEqual(["Mira", "Patch", "Quill"]);
    const engineer = created.find((bot: any) => bot.name === "Patch");
    expect(engineer).toMatchObject({ title: "Implementation and verification engineer", section: "Engineering", chiefOfStaff: true, modelSelection: review, approvalMode: "full", autoApprove: false });
    expect(engineer.managedSections).toBeUndefined();
    expect(saved.find((bot: any) => bot.id === chief.id).managedSections).toEqual(expect.arrayContaining(plan.newTeams));
    await api("POST", `/api/threads/${chief.threadId}/respond`, { requestId: proposed.requestId, behavior: "allow" });
    expect((await setupBots()).filter((bot: any) => bot.name === "Patch")).toHaveLength(1);
    expect(nativeTurns()).toHaveLength(previousTurnCount);

    token = await start("Move Patch to Growth and switch its default model; retain its existing thread.");
    const updated = await api("POST", "/api/internal/team-setup-requests", { plan: { reason: "Requested default and team change", operations: [
      { action: "update", botId: engineer.id, fields: { section: "Growth", modelSelection: standard } },
      { action: "update", botId: engineer.id, fields: { description: "Shared delivery specialist" } },
    ] } }, 201, token);
    await finish(); await api("POST", `/api/threads/${chief.threadId}/respond`, { requestId: updated.requestId, behavior: "allow" }); await continueOnce(updated.requestId);
    const changed = (await state()).find((bot: any) => bot.id === engineer.id);
    expect(changed).toMatchObject({ section: "Growth", modelSelection: standard, description: "Shared delivery specialist" });
    expect(changed.tasks.find((task: any) => task.threadId === engineer.threadId))
      .toMatchObject({ modelSelection: standard, followsBotModel: true });

    token = await start("Review another profile change for Patch.");
    const stale = await api("POST", "/api/internal/team-setup-requests", { plan: { reason: "Review stale behavior", operations: [
      { action: "update", botId: engineer.id, fields: { title: "Stale title" } },
    ] } }, 201, token);
    await api("PATCH", `/api/bots/${engineer.id}`, { title: "Newer user title" });
    await finish();
    expect((await api("POST", `/api/threads/${chief.threadId}/respond`, { requestId: stale.requestId, behavior: "allow" })).result.state).toBe("cancelled");
    await continueOnce(stale.requestId);
    expect((await state()).find((bot: any) => bot.id === engineer.id).title).toBe("Newer user title");

    token = await start("Delete Patch as a separately confirmed cleanup.");
    const deletion = await api("POST", "/api/internal/bot-deletion-requests", { targetBotId: engineer.id, reason: "User explicitly requested deletion" }, 201, token);
    expect(deletion.detail).toContain("Permanently removes");
    await api("POST", `/api/threads/${chief.threadId}/respond`, { requestId: deletion.requestId, behavior: "allow" }, 403);
    expect((await state()).some((bot: any) => bot.id === engineer.id)).toBe(true);
    await finish();
    expect((await api("POST", `/api/threads/${chief.threadId}/respond`, { requestId: deletion.requestId, behavior: "allow" })).result.bots).toEqual([{ id: engineer.id, name: "Patch", action: "deleted" }]);
    await continueOnce(deletion.requestId);
    expect((await state()).some((bot: any) => bot.id === engineer.id)).toBe(false);
    expect((await state()).filter((bot: any) => initialBotIds.has(bot.id)).map((bot: any) => bot.id).sort())
      .toEqual([...initialBotIds].sort());
    await api("POST", `/api/threads/${chief.threadId}/respond`, { requestId: deletion.requestId, behavior: "allow" });
    const room = (await control("new-channel", "--name", "Chief review", "--members", chief.id)).channel;
    unlinkSync(gate);
    const beforeRoomCount = nativeTurns(room.activeTaskId).length;
    await control("send-channel", "--channel", room.id, "--task", room.activeTaskId, "--text", "@Clive Review another setup, then wait.");
    await expect.poll(() => nativeTurns(room.activeTaskId).length, { timeout: 15_000 }).toBe(beforeRoomCount + 1);
    const roomToken = nativeTurns(room.activeTaskId).at(-1)?.mcpServers.find((server) => server.name === "agents")?.env.find((entry) => entry.name === "QUATI_COMMS_TOKEN")?.value;
    expect(roomToken).toBeTruthy();
    const groupStopped = await api("POST", "/api/internal/team-setup-requests", { plan: { reason: "Check room Stop", operations: [
      build("NoRestart", "Operations", standard),
    ] } }, 201, roomToken);
    await api("POST", `/api/threads/${room.activeTaskId}/respond`, { requestId: groupStopped.requestId, behavior: "deny" });
    await stopWithoutResume(groupStopped.requestId, room.activeTaskId, "--channel", room.id);
    expect((await state()).some((bot: any) => bot.name === "NoRestart")).toBe(false);
    await control("messages", "--bot", chief.id, "--task", chief.threadId, "--limit", "30");
    await control("wait", "--bot", chief.id, "--task", chief.threadId, "--timeout", "15");
    expect(readFileSync(fixture.info.logPath, "utf8")).not.toMatch(/ReferenceError|change listener threw/);
  } finally {
    const evidencePath = `${fixture.info.logPath}.team-setup.json`;
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    console.info(JSON.stringify({ evidencePath, logPath: fixture.info.logPath }));
    await fixture.close(); await removeTempDir(gates);
  }
}, 150_000);
