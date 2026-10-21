import { z } from "zod";
import type { BackgroundSnapshot } from "../shared/background-work.ts";
import type { ProviderRegistry } from "./harness/registry.ts";
import type { Store } from "./store.ts";

export const backgroundControlSchema = z.object({
  id: z.string().uuid(), taskId: z.string().min(1).max(500), action: z.enum(["steer", "interrupt"]),
  text: z.string().trim().min(1).max(40_000).optional(),
}).strict().refine(input => input.action !== "steer" || Boolean(input.text), "Steer text required");

export function createBackgroundWorkService(store: Pick<Store, "taskByThread">, registry: Pick<ProviderRegistry, "entries">) {
  return async (botId: string, threadId: string, control?: z.infer<typeof backgroundControlSchema>) => {
    if (!store.taskByThread(botId, threadId)) throw Object.assign(new Error("No such conversation"), { status: 404 });
    const engines = registry.entries().flatMap(entry => entry.live?.adapter.backgroundWork ? [entry.live.adapter.backgroundWork] : []);
    const snapshots = await Promise.all(engines.map(async engine => ({ engine, snapshot: await engine.list(threadId) })));
    if (control) {
      const owner = snapshots.find(({ snapshot }) => snapshot.tasks.some(task => task.id === control.taskId));
      if (!owner) throw Object.assign(new Error("No such work in this conversation"), { status: 404 });
      return { receipt: await owner.engine.control(threadId, control) };
    }
    const snapshot: BackgroundSnapshot = {
      tasks: snapshots.flatMap(({ snapshot }) => snapshot.tasks),
      receipts: snapshots.flatMap(({ snapshot }) => snapshot.receipts),
      connected: snapshots.every(({ snapshot }) => snapshot.connected || snapshot.tasks.length === 0),
    };
    return snapshot;
  };
}
