import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import type { BackgroundReceipt, BackgroundSnapshot } from "../../../shared/background-work.ts";
import { DATA_DIR } from "../../config.ts";
import { backgroundPlugin } from "./background-plugin.ts";

const receiptSchema = z.object({
  id: z.string(), taskId: z.string(), action: z.enum(["steer", "interrupt"]),
  status: z.enum(["pending", "accepted", "uncertain", "rejected"]), createdAt: z.number(), nativeId: z.string().optional(),
});
const taskSchema = z.object({
  id: z.string(), rootSessionId: z.string(), parentSessionId: z.string(), childSessionId: z.string(),
  description: z.string(), agent: z.string(), model: z.string().optional(),
  status: z.enum(["running", "completed", "failed", "interrupted", "unknown"]),
  createdAt: z.number(), completedAt: z.number().optional(), result: z.string().optional(), error: z.string().optional(),
});
const savedSchema = z.object({
  cwd: z.string(), roots: z.array(z.string()), tasks: z.array(taskSchema), receipts: z.array(receiptSchema),
});

export class NativeWorkBridge {
  readonly directory = mkdtempSync(join(tmpdir(), "quati-work-"));
  readonly socket = join(this.directory, "work.sock");

  constructor(env: Record<string, string | undefined>) {
    chmodSync(this.directory, 0o700);
    writeFileSync(join(this.directory, "index.mjs"), backgroundPlugin, { mode: 0o600 });
    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT || "{}");
    config.plugins = [...(config.plugins ?? []), { package: this.directory, options: { socket: this.socket } }];
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);
  }

  async call(input: { rootSessionId: string; receiptIds?: string[]; id?: string; taskId?: string; action?: string; text?: string }): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const req = request({ socketPath: this.socket, path: "/", method: "POST", headers: { "content-type": "application/json" } }, res => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", chunk => { body += chunk; });
        res.on("end", () => {
          try {
            if (res.statusCode !== 200) throw new Error("Native work is unavailable");
            resolve(JSON.parse(body));
          } catch (error) { reject(error); }
        });
      });
      req.setTimeout(15_000, () => req.destroy(new Error("Native work request timed out")));
      req.on("error", reject);
      req.end(JSON.stringify(input));
    });
  }

  dispose() {
    rmSync(this.directory, { recursive: true, force: true });
  }
}

export class BackgroundWork {
  private readonly path: string;
  private saved: z.infer<typeof savedSchema> = { cwd: "", roots: [], tasks: [], receipts: [] };
  private bridges = new Map<string, NativeWorkBridge>();
  private connected = false;
  private refreshing: Promise<BackgroundSnapshot> | null = null;

  constructor(instanceId: string, threadId: string) {
    const directory = join(DATA_DIR, "native-work");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const key = createHash("sha256").update(JSON.stringify([instanceId, threadId])).digest("hex");
    this.path = join(directory, key + ".json");
    try { this.saved = savedSchema.parse(JSON.parse(readFileSync(this.path, "utf8"))); } catch {}
  }

  get cwd() { return this.saved.cwd; }
  get roots() { return this.saved.roots; }
  get disconnectedRoots() { return this.saved.roots.filter(root => !this.bridges.has(root)); }

  attach(bridge: NativeWorkBridge, root: string, cwd: string) {
    this.bridges.set(root, bridge);
    this.saved.cwd = cwd;
    if (!this.saved.roots.includes(root)) this.saved.roots.push(root);
    this.persist();
  }

  detach(bridge: NativeWorkBridge) {
    for (const [root, attached] of this.bridges) {
      if (attached === bridge) this.bridges.delete(root);
    }
    this.connected = false;
  }

  private persist() {
    const next = this.path + ".tmp";
    writeFileSync(next, JSON.stringify(this.saved), { mode: 0o600 });
    renameSync(next, this.path);
  }

  snapshot(): BackgroundSnapshot {
    return { tasks: this.saved.tasks, receipts: this.saved.receipts, connected: this.connected,
      ...(!this.connected && this.saved.roots.length ? { error: "Native work state is not confirmed" } : {}) };
  }

  refresh(): Promise<BackgroundSnapshot> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.readNative().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  private async readNative(): Promise<BackgroundSnapshot> {
    if (!this.bridges.size) return this.snapshot();
    try {
      for (const rootSessionId of this.saved.roots) {
        const bridge = this.bridges.get(rootSessionId);
        if (!bridge) throw new Error("Root executor is disconnected");
        const response = z.object({ tasks: z.array(taskSchema), receipts: z.array(receiptSchema) }).parse(await bridge.call({
          rootSessionId, receiptIds: this.saved.receipts.map(receipt => receipt.id),
        }));
        for (const task of response.tasks) {
          const index = this.saved.tasks.findIndex(prior => prior.id === task.id);
          if (index < 0) this.saved.tasks.push(task);
          else this.saved.tasks[index] = task;
        }
        for (const receipt of response.receipts) {
          const index = this.saved.receipts.findIndex(prior => prior.id === receipt.id);
          if (index >= 0) this.saved.receipts[index] = receipt;
        }
      }
      this.connected = true;
      this.persist();
    } catch {
      this.connected = false;
    }
    return this.snapshot();
  }

  async control(input: { id: string; taskId: string; action: "steer" | "interrupt"; text?: string }): Promise<BackgroundReceipt> {
    const existing = this.saved.receipts.find(receipt => receipt.id === input.id);
    if (existing) {
      if (existing.taskId !== input.taskId || existing.action !== input.action) throw new Error("Receipt already belongs to another control");
      return existing;
    }
    await this.refresh();
    const concurrent = this.saved.receipts.find(receipt => receipt.id === input.id);
    if (concurrent) {
      if (concurrent.taskId !== input.taskId || concurrent.action !== input.action) throw new Error("Receipt already belongs to another control");
      return concurrent;
    }
    const task = this.saved.tasks.find(task => task.id === input.taskId);
    const bridge = task ? this.bridges.get(task.rootSessionId) : null;
    if (!this.connected || !bridge || !task || task.status !== "running") throw new Error("Work is not available in this chat");
    const receipt: BackgroundReceipt = { id: input.id, taskId: input.taskId, action: input.action, status: "uncertain", createdAt: Date.now() };
    this.saved.receipts.push(receipt);
    this.persist();
    try {
      const response = z.object({ receipt: receiptSchema }).parse(await bridge.call({ rootSessionId: task.rootSessionId, ...input }));
      Object.assign(receipt, response.receipt);
    } catch {
      this.connected = false;
    }
    this.persist();
    return receipt;
  }
}
