import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createBackgroundWorkService } from "./background-work.ts";
import { createOpenCodeDriver } from "./drivers/acp/opencode-go.ts";
import { Store } from "./store.ts";

describe("conversation background work authorization", () => {
  it.each(["foreign-bot", "foreign-thread"])("rejects %s before inspecting native sessions", async foreign => {
    const entries = vi.fn(() => []);
    const service = createBackgroundWorkService({ taskByThread: () => undefined }, { entries });
    await expect(service(foreign === "foreign-bot" ? foreign : "bot", foreign === "foreign-thread" ? foreign : "thread"))
      .rejects.toMatchObject({ status: 404 });
    expect(entries).not.toHaveBeenCalled();
  });

  it("never forwards a guessed native work ID to an executor", async () => {
    const driver = createOpenCodeDriver(async () => ({ default: "fixture/model", options: [] }));
    const instance = await driver.create({ instanceId: randomUUID(), displayName: "Fixture", enabled: true, config: driver.defaultConfig(), environment: {} });
    const list = vi.spyOn(instance.adapter.backgroundWork!, "list").mockResolvedValue({ tasks: [], receipts: [], connected: true });
    const control = vi.spyOn(instance.adapter.backgroundWork!, "control");
    const store = new Store(() => ({ instanceId: instance.instanceId, model: "fixture/model" }));
    const bot = store.createBot({ name: "Fixture" });
    const service = createBackgroundWorkService(store, { entries: () => [{ instanceId: instance.instanceId, live: instance }] });
    await expect(service(bot.id, bot.threadId, { id: randomUUID(), taskId: "foreign-native-task", action: "interrupt" }))
      .rejects.toMatchObject({ status: 404 });
    expect(control).not.toHaveBeenCalled();
    expect(list).toHaveBeenCalledWith(bot.threadId);
    await instance.dispose();
  });
});
