import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { launchVerificationServer, runControlQuati, type VerificationServer } from "../scripts/control-quati.ts";
import type { WireBot } from "../shared/wire.ts";

let fixture: VerificationServer;

async function api<T>(method: string, path: string, body?: unknown) {
  const response = await fetch(fixture.info.url + path, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() as T };
}

beforeAll(async () => {
  fixture = await launchVerificationServer();
}, 30_000);

afterAll(async () => {
  await fixture?.close();
});

describe("thread titles with OpenCode", () => {
  it.each([
    { enabled: true, error: "this bot's model can't generate a title — rename the thread instead" },
    { enabled: false, error: "generated thread titles are turned off on this server" },
  ])("preserves manual titles when generation is unavailable, enabled=$enabled", async ({ enabled, error }) => {
    expect((await api("PATCH", "/api/config", { features: { llmThreadTitles: enabled } })).status).toBe(200);
    const configured = await api<{ features: { llmThreadTitles: boolean } }>("GET", "/api/config");
    expect(configured.body.features.llmThreadTitles).toBe(enabled);

    const created = await api<{ bot: WireBot }>("POST", "/api/bots", { name: "Title fixture" });
    expect(created.status).toBe(201);
    const { bot } = created.body;
    const control = (...args: string[]) => runControlQuati([...args, "--url", fixture.info.url]);
    await control("send", "--bot", bot.id, "--task", bot.threadId, "--text", "Investigate the session expiry login hang");
    expect(await control("wait", "--bot", bot.id, "--task", bot.threadId, "--timeout", "15")).toMatchObject({ status: "settled" });

    const path = `/api/bots/${bot.id}/tasks/${bot.threadId}`;
    expect((await api("PATCH", path, { title: "My name for it" })).status).toBe(200);
    const regenerated = await api<{ error: string }>("POST", `${path}/title`);
    expect(regenerated.status).toBe(409);
    expect(regenerated.body.error).toBe(error);

    const listed = await api<{ bots: WireBot[] }>("GET", "/api/bots?messages=0");
    const current = listed.body.bots.find(candidate => candidate.id === bot.id);
    expect(current?.tasks?.find(task => task.threadId === bot.threadId)?.title).toBe("My name for it");
    expect((await api("POST", `/api/bots/${bot.id}/tasks/no-such-thread/title`)).status).toBe(404);
  }, 30_000);
});
