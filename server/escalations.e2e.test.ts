import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlQuati } from "../scripts/control-quati.ts";
import { openSse } from "./testing/sse.ts";

async function launch() {
  const fixture = await launchVerificationServer({}, undefined, undefined, undefined, undefined, { scripted: true });
  const { url, dataDir } = fixture.info;
  const api = async (method: string, path: string, body?: unknown, expectedStatus = 200) => {
    const response = await fetch(url + path, {
      method,
      headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(value)}`).toBe(expectedStatus);
    return value;
  };
  const control = (args: string[]) => runControlQuati([...args, "--url", url]) as Promise<any>;
  const dump = async (threadId: string) => {
    let prompt = "";
    await expect.poll(() => {
      const file = `${fixture.fixtureDumpPath}.prompts.jsonl`;
      if (!existsSync(file)) return false;
      const turns: Array<{ prompt: Array<{ text?: string }>; mcpServers: Array<{ env?: Array<{ name: string; value: string }> }> }> =
        readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
      const turn = turns.findLast(turn => turn.mcpServers.some(server => server.env?.some(entry => entry.name === "QUATI_THREAD_ID" && entry.value === threadId)));
      prompt = turn?.prompt.map(block => block.text ?? "").join("\n") ?? "";
      return Boolean(turn);
    }, { timeout: 20_000 }).toBe(true);
    return prompt;
  };
  const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).messages as any[];
  const botsNow = async () => (await api("GET", "/api/bots")).bots as any[];
  const planFile = join(dataDir, "room-plan.json");
  const plan = async (threadId: string, entry: { tools?: Array<{ name: string; server: string; input: Record<string, unknown> }>; replies: string[] }) => {
    const current = existsSync(planFile) ? JSON.parse(readFileSync(planFile, "utf8")) : {};
    const bot = (await botsNow()).find(bot => bot.tasks.some((task: { threadId: string }) => task.threadId === threadId));
    current[bot.id] = { steps: entry.tools?.map(tool => ({ tool: tool.name, arguments: tool.input })), reply: entry.replies.join("\n") };
    writeFileSync(planFile, JSON.stringify(current));
  };
  await api("PATCH", "/api/config", { features: { chiefEscalations: true } });
  const turnEnded = (botId: string, threadId: string) => expect.poll(async () =>
    (await botsNow()).find((b) => b.id === botId)?.tasks?.find((t: any) => t.threadId === threadId)?.busy, { timeout: 30_000 }).toBe(false);
  const escalationsThread = async (botId: string) => {
    await expect.poll(async () => (await botsNow()).find((b) => b.id === botId)?.tasks?.some((t: any) => t.title === "Team escalations"), { timeout: 20_000 }).toBe(true);
    return (await botsNow()).find((b) => b.id === botId).tasks.find((t: any) => t.title === "Team escalations") as { threadId: string };
  };
  return { url, dataDir, api, control, dump, messages, botsNow, plan, turnEnded, escalationsThread, close: () => fixture.close() };
}

it("delivers a pending peer-comm approval card to the Chief's escalations thread", async () => {
  const { api, control, dump, messages, plan, turnEnded, escalationsThread, close } = await launch();
  try {
    const chief = (await control(["new-bot", "--name", "Clive", "--section", "Ops"])).bot;
    await api("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: true });
    const ada = (await control(["new-bot", "--name", "Ada", "--section", "Ops"])).bot;
    await api("PATCH", `/api/bots/${ada.id}`, { approvePeerComms: true, approvalMode: "ask" });
    const hedge = (await control(["new-bot", "--name", "Hedge", "--section", "Ops"])).bot;
    await plan(ada.activeTaskId, {
      tools: [{ name: "coordinate_bots", server: "agents", input: { bot_ids: [hedge.id], message: "Hedge, a quick one before I file the memo.", consult: true } }],
      replies: ["I asked Hedge and will wait for the person's say-so."],
    });
    await plan(chief.activeTaskId, { replies: ["Standing by."] });

    await control(["send", "--bot", ada.id, "--text", "File the memo after checking with Hedge."]);
    await expect.poll(async () => (await messages(ada.activeTaskId)).some((m) => m.kind === "options" && m.card?.requestId), { timeout: 20_000 }).toBe(true);
    const escalations = await escalationsThread(chief.id);
    await expect.poll(async () => (await messages(escalations.threadId)).some((m) =>
      m.kind === "activity" && m.tool?.ok === false && /Escalation: Ada's work .*approval card to contact @Hedge is waiting on the person/.test(m.tool?.name ?? "")
      && m.threadRef?.threadId === ada.activeTaskId && m.threadRef?.botId === ada.id,
    ), { timeout: 10_000 }).toBe(true);
    const run = await dump(escalations.threadId);
    const prompt = run;
    expect(prompt).toContain("[Escalation notice from QuatiBot — not from the person.");
    expect(prompt).toContain("approval card to contact @Hedge is waiting on the person");
    expect(prompt).toContain("Hedge, a quick one before I file the memo.");
    expect(prompt).toContain(`bot_id "${ada.id}"`);
    expect(prompt).toContain(`thread_id "${ada.activeTaskId}"`);
    expect(prompt).toContain("Team escalations");
    const noticeLine = (await messages(escalations.threadId)).find((m) => m.role === "user" && /Escalation notice/.test(m.text ?? ""));
    expect(noticeLine?.peerAsk).toEqual({ botId: ada.id, name: "Ada", unattended: true, incident: { threadId: ada.activeTaskId, notified: true } });

    await api("POST", `/api/bots/${ada.id}/respond`, { requestId: (await messages(ada.activeTaskId)).find((m) => m.kind === "options")?.card?.requestId, behavior: "deny" });
    await turnEnded(ada.id, ada.activeTaskId);
    await turnEnded(chief.id, escalations.threadId);
    expect((await messages(hedge.activeTaskId)).filter((m) => m.role === "user")).toEqual([]);
  } finally {
    await close();
  }
}, 150_000);

it("delivers a teammate turn that ends needing input to the Chief's escalations thread", async () => {
  const { api, control, dump, messages, plan, turnEnded, escalationsThread, close } = await launch();
  try {
    const chief = (await control(["new-bot", "--name", "Clive", "--section", "Ops"])).bot;
    await api("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: true });
    const mira = (await control(["new-bot", "--name", "Mira", "--section", "Ops"])).bot;
    await plan(mira.activeTaskId, { replies: ["Half done.\nNEEDS INPUT: which repository should I tag?"] });
    await plan(chief.activeTaskId, { replies: ["I told the person."] });

    await control(["send", "--bot", mira.id, "--text", "Tag the release."]);
    await turnEnded(mira.id, mira.activeTaskId);

    const escalations = await escalationsThread(chief.id);
    await expect.poll(async () => (await messages(escalations.threadId)).some((m) =>
      m.kind === "activity" && m.tool?.ok === false && /Escalation: Mira's work .*turn ended on a question the person has not answered/.test(m.tool?.name ?? "")
      && m.threadRef?.threadId === mira.activeTaskId,
    ), { timeout: 10_000 }).toBe(true);
    const run = await dump(escalations.threadId);
    const prompt = run;
    expect(prompt).toContain("[Escalation notice from QuatiBot — not from the person.");
    expect(prompt).toContain("which repository should I tag?");
    expect(prompt).toContain(`thread_id "${mira.activeTaskId}"`);
    const noticeLine = (await messages(escalations.threadId)).find((m) => m.role === "user" && /Escalation notice/.test(m.text ?? ""));
    expect(noticeLine?.peerAsk).toEqual({ botId: mira.id, name: "Mira", unattended: true, incident: { threadId: mira.activeTaskId } });
    await turnEnded(chief.id, escalations.threadId);
  } finally {
    await close();
  }
}, 150_000);

it("carries the provenance fence header on a bot-raised escalation", async () => {
  const { api, control, dump, messages, plan, turnEnded, escalationsThread, close } = await launch();
  try {
    const chief = (await control(["new-bot", "--name", "Clive", "--section", "Ops"])).bot;
    await api("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: true });
    const mira = (await control(["new-bot", "--name", "Mira", "--section", "Ops"])).bot;
    await plan(mira.activeTaskId, {
      tools: [{ name: "raise_escalation", server: "agents", input: { reason: "The deploy needs the production key only the person can unlock." } }],
      replies: ["I flagged the gate and stopped."],
    });
    await plan(chief.activeTaskId, { replies: ["I told the person."] });

    await control(["send", "--bot", mira.id, "--text", "Ship the deploy."]);
    await turnEnded(mira.id, mira.activeTaskId);

    const escalations = await escalationsThread(chief.id);
    const run = await dump(escalations.threadId);
    const prompt = run;
    expect(prompt).toContain("[Escalation notice from QuatiBot — not from the person.");
    expect(prompt).toContain("The deploy needs the production key only the person can unlock.");
    expect(prompt).toContain("it raised this flag itself");
    expect(prompt).toContain(`thread_id "${mira.activeTaskId}"`);
    const noticeLine = (await messages(escalations.threadId)).find((m) => m.role === "user" && /Escalation notice/.test(m.text ?? ""));
    expect(noticeLine?.text?.split("\n")[0]).toMatch(/^\[.+ from QuatiBot — not from the person\. .+\]$/);
    expect(noticeLine?.peerAsk).toEqual({ botId: mira.id, name: "Mira", unattended: true, incident: { threadId: mira.activeTaskId } });
    await turnEnded(chief.id, escalations.threadId);
  } finally {
    await close();
  }
}, 150_000);

it("routes a Chief's own gate to the person, never a dead end", async () => {
  const { url, api, control, botsNow, plan, turnEnded, close } = await launch();
  try {
    const clive = (await control(["new-bot", "--name", "Clive", "--section", "Ops"])).bot;
    await api("PATCH", `/api/bots/${clive.id}`, { chiefOfStaff: true });
    await plan(clive.activeTaskId, {
      tools: [{ name: "raise_escalation", server: "agents", input: { reason: "The production key needs the person's unlock." } }],
      replies: ["I flagged the gate and stopped."],
    });
    const stream = await openSse(`${url}/api/events`, { origin: url });
    try {
      await control(["send", "--bot", clive.id, "--text", "Ship the deploy."]);
      await turnEnded(clive.id, clive.activeTaskId);
      const name = `Barrier ${randomUUID().slice(0, 8)}`;
      await api("PATCH", `/api/bots/${clive.id}`, { name });
      await stream.until((frame) => frame.kind === "bot" && frame.bot?.name === name, 10_000);
      const notified = stream.frames.filter((frame) => frame.kind === "notify").map((frame) => frame.notification);
      expect(notified.some((n: any) => n?.kind === "incident" && n.botId === clive.id
        && /Escalation: Clive's work .*it raised this flag itself/.test(n.body ?? ""))).toBe(true);
    } finally {
      stream.close();
    }
    expect((await botsNow()).find((b) => b.id === clive.id)?.tasks?.some((t: any) => t.title === "Team escalations")).toBeFalsy();
  } finally {
    await close();
  }
}, 150_000);
