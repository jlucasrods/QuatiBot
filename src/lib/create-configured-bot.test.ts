import { afterEach, describe, expect, it, vi } from "vitest";
import { api, persistBotUpdate, type Bot } from "@/state/store";
import { BotCreationDraft, EMPTY_BOT_DEFAULTS } from "./bot-creation-draft";
import { createConfiguredBot } from "./create-configured-bot";

afterEach(() => vi.unstubAllGlobals());

describe("configured bot creation", () => {
  function fixture(mode: "ask" | "auto" | "full" | "custom", fail = 0, selection?: Bot["modelSelection"]) {
    const draft = new BotCreationDraft(EMPTY_BOT_DEFAULTS, vi.fn());
    draft.patch({ name: "Fixture", approvalMode: mode, notifications: false });
    let bot = { ...draft.bot, id: "created", threadId: "initial", approvalMode: "ask" } as Bot;
    if (selection) bot.modelSelection = selection;
    const events: string[] = [];
    const bodies: unknown[] = [];
    let updates = 0;
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      events.push(`${init?.method} ${path}`);
      const body = JSON.parse(String(init?.body ?? "{}"));
      bodies.push(body);
      if (init?.method === "PATCH") {
        if (++updates === fail) throw new Error("Save rejected");
        bot = { ...bot, ...body };
      }
      return { bot };
    }) as unknown as typeof api;
    return { draft, events, bodies, request };
  }

  it("sets the chosen audience in the first creation request", async () => {
    const f = fixture("ask");
    await createConfiguredBot(f.draft, f.request, persistBotUpdate, "admins");
    expect(f.events[0]).toBe("POST /api/bots");
    expect(f.bodies[0]).toMatchObject({ visibility: "admins", useDefaults: false });
  });

  it("applies tool restrictions atomically before a new bot is published", async () => {
    const f = fixture("ask");
    f.draft.patch({ toolScope: { allow: [], deny: ["mcp:mail:send"] } });
    await createConfiguredBot(f.draft, f.request, persistBotUpdate);
    expect(f.bodies[0]).toMatchObject({ settings: { toolScope: { allow: [], deny: ["mcp:mail:send"] } } });
    expect(f.bodies[1]).not.toHaveProperty("toolScope");
  });

  it("keeps the server-completed workspace effort when applying draft settings", async () => {
    const selection = { instanceId: "claude", model: "sonnet", effort: "high" as const };
    const f = fixture("ask", 0, selection);
    f.draft.setModel({ instanceId: selection.instanceId, model: selection.model });
    const result = await createConfiguredBot(f.draft, f.request, persistBotUpdate);
    expect(f.bodies[0]).toMatchObject({ modelSelection: { instanceId: "claude", model: "sonnet" } });
    expect(f.bodies[1]).toMatchObject({ modelSelection: selection });
    expect(result.bot.modelSelection).toEqual(selection);
  });

  for (const mode of ["ask", "auto", "full"] as const) {
    it(`commits ${mode} settings without reapplying the template`, async () => {
      const f = fixture(mode);
      const result = await createConfiguredBot(f.draft, f.request, persistBotUpdate);
      expect(f.bodies[0]).toMatchObject({ useDefaults: false, name: "Fixture" });
      expect(result.bot).toMatchObject({ approvalMode: mode, notifications: false });
      expect(result.warnings).toEqual([]);
      expect(f.events).not.toContain("DELETE /api/bots/created");
    });
  }

  it("applies Full to the bot and its first thread over the API through the API", async () => {
    const f = fixture("full");
    const result = await createConfiguredBot(f.draft, f.request, persistBotUpdate, undefined);
    expect(result.bot).toMatchObject({ approvalMode: "full" });
    expect(f.events).toEqual(["POST /api/bots", "PATCH /api/bots/created", "PATCH /api/bots/created/tasks/initial"]);
    expect(f.bodies[1]).toMatchObject({ approvalMode: "full" });
    expect(f.bodies[2]).toEqual({ approvalMode: "full", acknowledgeLocalAuto: false });
    for (const body of f.bodies) expect(body).not.toHaveProperty("confirmFullAccess");
  });

  it("still refuses Custom as unsupported and removes the half-made bot", async () => {
    const f = fixture("custom");
    await expect(createConfiguredBot(f.draft, f.request, persistBotUpdate, undefined)).rejects.toThrow("Custom approval is not supported");
    expect(f.events).toEqual(["POST /api/bots", "DELETE /api/bots/created"]);
  });

  for (const fail of [1, 2]) {
    it(`rolls back when settings request ${fail} fails`, async () => {
      const f = fixture("full", fail);
      await expect(createConfiguredBot(f.draft, f.request, persistBotUpdate)).rejects.toThrow("Save rejected");
      expect(f.events.at(-1)).toBe("DELETE /api/bots/created");
    });
  }

});
