import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-quati.ts";
import { removeTempDir } from "./testing/cleanup.ts";

it("Chief creation uses the workspace default or a validated explicit model without inheriting permissions", async () => {
  const temp = mkdtempSync(join(tmpdir(), "quati-create-model-"));
  const gate = join(temp, "finish");
  const nextGate = join(temp, "next-finish");
  const fixture = await launchVerificationServer({
    FAKE_ACP_MODE: "echo-gated",
    FAKE_ACP_GATE_FILE: gate,
    FAKE_ACP_GATE_ROUTES: JSON.stringify({ "Prepare the next specialist.": nextGate }),
    FAKE_ACP_MODELS: "fixture/chief,fixture/default,fixture/chosen",
  });
  const readToken = () => {
    const path = `${fixture.fixtureDumpPath}.prompts.jsonl`;
    if (!existsSync(path)) return undefined;
    for (const line of readFileSync(path, "utf8").trim().split("\n").reverse()) {
      const prompt = JSON.parse(line) as { mcpServers?: Array<{ name: string; env: Array<{ name: string; value: string }> }> };
      const token = prompt.mcpServers?.find((server) => server.name === "agents")?.env.find((entry) => entry.name === "QUATI_COMMS_TOKEN")?.value;
      if (token) return token;
    }
    return undefined;
  };
  const api = async (method: string, path: string, body?: unknown, expected = 200, token?: string) => {
    const response = await fetch(fixture.info.url + path, { method,
      headers: { "content-type": "application/json", origin: fixture.info.url,
        ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json() as any;
    expect(response.status, JSON.stringify(result)).toBe(expected);
    return result;
  };
  try {
    const defaultModel = { instanceId: "opencodeGo", model: "fixture/default" };
    await api("PATCH", "/api/config", { defaultModelSelection: defaultModel });
    const chiefModel = { instanceId: "opencodeGo", model: "fixture/chief" };
    const chief = (await api("POST", "/api/bots", { name: "Chief", section: "Design", modelSelection: chiefModel }, 201)).bot;
    // On Ask, so each creation waits on its review card.
    await api("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: true, approvalMode: "ask" });
    await api("POST", `/api/bots/${chief.id}/messages`, { text: "Prepare a specialist." }, 202);
    await expect.poll(readToken, { timeout: 15_000 }).toBeTruthy();
    let token = readToken();
    const create = (name: string, modelSelection?: unknown, expected = 201) => api("POST", "/api/internal/create-bot", {
      fromBotId: chief.id, fromThreadId: chief.threadId, name,
      role: "Specialist", instructions: "Complete assigned work.",
      ...(modelSelection === undefined ? {} : { modelSelection }),
    }, expected, token);
    const idle = () => expect.poll(async () => (await api("GET", "/api/bots")).bots.every((bot: any) => !bot.busy), { timeout: 20_000 }).toBe(true);
    const apply = async (pending: any, behavior: "allow" | "deny" = "allow") => {
      expect(pending).toMatchObject({ state: "pending", applied: false });
      await idle();
      // the approval gate also counts turns the bots list does not show; a refused approval changes nothing, so retry it
      let answered: any;
      await expect.poll(async () => {
        const response = await fetch(fixture.info.url + `/api/threads/${chief.threadId}/respond`, { method: "POST",
          headers: { "content-type": "application/json", origin: fixture.info.url },
          body: JSON.stringify({ requestId: pending.requestId, behavior }) });
        answered = await response.json();
        return response.status;
      }, { timeout: 20_000 }).toBe(200);
      await idle();
      return answered.result.bots[0];
    };
    const before = (await api("GET", "/api/bots")).bots.length;
    const firstCard = await create("Default specialist");
    const explicit = { instanceId: "opencodeGo", model: "fixture/chosen" };
    const secondCard = await create("Chosen specialist", explicit);
    expect((await api("GET", "/api/bots")).bots.length).toBe(before);
    for (const invalid of [null, {}, { instanceId: "missing", model: "missing" },
      { ...explicit, model: "not-in-catalog" }, { ...explicit, effort: "invalid" },
      { ...explicit, variant: "" }]) {
      await create("Invalid specialist", invalid, 400);
    }
    const thirdCard = await create("Third specialist");
    const fourthCard = await create("Fourth specialist");
    await create("Fifth specialist", undefined, 429);
    writeFileSync(gate, "finish");
    await idle();
    await create("Expired authority", undefined, 401);
    const first = await apply(firstCard);
    const second = await apply(secondCard);
    await apply(thirdCard, "deny");
    await apply(fourthCard, "deny");
    await idle();
    expect(first.modelSelection).toEqual(defaultModel);
    expect(second.modelSelection).toEqual(explicit);
    const bots = (await api("GET", "/api/bots")).bots;
    expect(bots.length).toBe(before + 2);
    expect(bots.find((bot: any) => bot.id === chief.id).modelSelection).toEqual(chiefModel);
    for (const [id, modelSelection] of [[first.id, defaultModel], [second.id, explicit]]) {
      expect(bots.find((bot: any) => bot.id === id)).toMatchObject({
        section: "Design", modelSelection, approvalMode: "full", autoApprove: false, approvePeerComms: false,
        soul: "Complete assigned work.",
      });
    }
    await api("PATCH", "/api/config", { defaultModelSelection: explicit });
    await api("POST", `/api/bots/${chief.id}/messages`, { text: "Prepare the next specialist." }, 202);
    await expect.poll(async () => {
      const snapshot = await api("GET", "/api/bots");
      const source = snapshot.bots.find((bot: { id: string }) => bot.id === chief.id);
      return {
        received: readFileSync(`${fixture.fixtureDumpPath}.prompts.jsonl`, "utf8").includes("Prepare the next specialist."),
        busy: source.busy,
        errors: source.messages.filter((message: { tool?: { ok?: boolean } }) => message.tool?.ok === false),
        queued: snapshot.botQueuedMessages?.[chief.threadId],
      };
    }, { timeout: 15_000 }).toMatchObject({ received: true });
    await expect.poll(readToken, { timeout: 15_000 }).toBeTruthy();
    token = readToken();
    const updatedCard = await create("Updated default specialist");
    writeFileSync(nextGate, "finish");
    await idle();
    expect((await apply(updatedCard)).modelSelection).toEqual(explicit);
    expect((await api("GET", "/api/bots")).bots.find((bot: any) => bot.id === first.id).modelSelection).toEqual(defaultModel);
  } finally {
    writeFileSync(gate, "finish");
    writeFileSync(nextGate, "finish");
    await fixture.close();
    await removeTempDir(temp);
  }
}, 60_000);
