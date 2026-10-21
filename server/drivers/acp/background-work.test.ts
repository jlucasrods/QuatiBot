import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { chmodSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BackgroundWork, NativeWorkBridge } from "./background-work.ts";
import { backgroundPlugin } from "./background-plugin.ts";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const dispose of cleanup.splice(0)) dispose(); });

async function fixture(outcome?: string) {
  const bridge = new NativeWorkBridge({});
  cleanup.push(() => bridge.dispose());
  const messages = [
    { id: "message", type: "assistant", content: [{ type: "tool", id: "tool", name: "subagent", time: { ran: 10 },
      state: { input: { description: "Review", agent: "general" }, metadata: { sessionID: "child" } } }] },
    ...(outcome ? [{ type: "synthetic", metadata: { source: "subagent", childID: "child", state: outcome }, time: { created: 30 } }] : []),
  ];
  const prompt = vi.fn(async () => ({ id: "native-receipt" }));
  const interrupt = vi.fn(async () => {});
  const storage = new Map();
  const ctx = {
    options: { socket: bridge.socket }, location: { directory: "/fixture" },
    session: {
      get: async ({ sessionID }: { sessionID: string }): Promise<{
        location?: { directory: string }; parentID?: string; time?: { idle?: number }; model?: { providerID: string; id: string };
      }> => sessionID === "root"
        ? { location: { directory: "/fixture" } }
        : { parentID: "root", time: {}, model: { providerID: "fixture", id: "model" } },
      context: async ({ sessionID }: { sessionID: string }) => sessionID === "root" ? messages : [
        { type: "assistant", time: { created: 12, completed: 20 }, content: [{ type: "reasoning", text: "SECRET" }, { type: "text", text: "Final" }] },
        { type: "assistant", time: { created: 25 }, content: [{ type: "text", text: "Partial" }] },
      ], prompt, interrupt,
    },
    storage: { get: async (key: string) => storage.get(key), set: async (key: string, value: unknown) => { storage.set(key, value); } },
  };
  const factory = new Function("Plugin", "createServer", "chmodSync", "resolve",
    backgroundPlugin.replace(/^import .*;\n/gm, "").replace("export default", "return"));
  const plugin = factory({ define: (definition: unknown) => definition }, createServer, chmodSync, resolve);
  cleanup.push(await plugin.setup(ctx));
  return { bridge, ctx, prompt, interrupt, messages };
}

describe("native background projection", () => {
  it.each([['completed', 'completed'], ['cancelled', 'interrupted'], ['failed', 'failed'], [undefined, 'running']] as const)(
    "maps %s without exposing thoughts or unfinished output", async (outcome, status) => {
      const { bridge } = await fixture(outcome);
      const result = await bridge.call({ rootSessionId: "root" });
      expect(result).toMatchObject({ tasks: [{ id: "root:message:tool", status, model: "fixture/model" }] });
      expect(JSON.stringify(result)).not.toContain("SECRET");
      expect(JSON.stringify(result)).not.toContain("Partial");
      if (status === "completed") expect(result).toMatchObject({ tasks: [{ result: "Final" }] });
    },
  );

  it("rejects a foreign root and a forged child ancestry", async () => {
    const { bridge, ctx } = await fixture();
    ctx.location.directory = "/other";
    await expect(bridge.call({ rootSessionId: "root" })).rejects.toThrow();
    ctx.location.directory = "/fixture";
    ctx.session.get = async () => ({ location: { directory: "/fixture" }, parentID: "foreign", time: {} });
    await expect(bridge.call({ rootSessionId: "root" })).resolves.toMatchObject({ tasks: [] });
  });

  it("keeps separate work runs when a native child session is reused", async () => {
    const { bridge, messages } = await fixture("completed");
    messages.push({ id: "message-two", type: "assistant", content: [{ type: "tool", id: "tool-two", name: "subagent", time: { ran: 40 },
      state: { input: { description: "Continue review", agent: "general" }, metadata: { sessionID: "child" } } }] });
    const result = await bridge.call({ rootSessionId: "root" });
    expect(result).toMatchObject({ tasks: [
      { id: "root:message:tool", status: "completed", result: "Final" },
      { id: "root:message-two:tool-two", status: "running" },
    ] });
  });

  it("does not call an idle child successful without a native outcome", async () => {
    const { bridge, ctx } = await fixture();
    const get = ctx.session.get;
    ctx.session.get = async input => ({ ...await get(input), time: { idle: 30 } });
    expect(await bridge.call({ rootSessionId: "root" })).toMatchObject({ tasks: [{ status: "unknown" }] });
  });

  it("admits a concurrent control with the same receipt only once", async () => {
    const { bridge, prompt } = await fixture();
    const work = new BackgroundWork(randomUUID(), "chat");
    work.attach(bridge, "root", "/fixture");
    const input = { id: randomUUID(), taskId: "root:message:tool", action: "steer" as const, text: "Continue" };
    const receipts = await Promise.all([work.control(input), work.control(input)]);
    expect(receipts.map(receipt => receipt.status)).toEqual(["accepted", "accepted"]);
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it.each(["steer", "interrupt"] as const)("persists one %s admission across retries and host restart", async action => {
    const { bridge, prompt, interrupt } = await fixture();
    const instance = randomUUID();
    const work = new BackgroundWork(instance, "chat");
    work.attach(bridge, "root", "/fixture");
    const input = { id: randomUUID(), taskId: "root:message:tool", action, text: "Continue" };
    expect(await work.control(input)).toMatchObject({ status: "accepted", ...(action === "steer" ? { nativeId: "native-receipt" } : {}) });
    const restored = new BackgroundWork(instance, "chat");
    expect(await restored.control(input)).toMatchObject({ status: "accepted" });
    expect(prompt).toHaveBeenCalledTimes(action === "steer" ? 1 : 0);
    expect(interrupt).toHaveBeenCalledTimes(action === "interrupt" ? 1 : 0);
    expect(new BackgroundWork(instance, "other-chat").snapshot().tasks).toEqual([]);
  });

  it("retains uncertain controls after transport loss and never automatically sends again", async () => {
    const { bridge, prompt } = await fixture();
    prompt.mockRejectedValueOnce(new Error("lost response"));
    const work = new BackgroundWork(randomUUID(), "chat");
    work.attach(bridge, "root", "/fixture");
    const input = { id: randomUUID(), taskId: "root:message:tool", action: "steer" as const, text: "Continue" };
    expect(await work.control(input)).toMatchObject({ status: "uncertain" });
    expect(await work.control(input)).toMatchObject({ status: "uncertain" });
    expect(prompt).toHaveBeenCalledTimes(1);
    work.detach(bridge);
    expect((await work.refresh()).connected).toBe(false);
    expect(work.snapshot().tasks[0]?.status).toBe("running");
  });
});
