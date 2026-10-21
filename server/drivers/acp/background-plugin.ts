// OpenCode 2.0.32 exposes these capabilities inside its private ACP executor,
// but ACP session/list omits ancestry and session/cancel cannot stop idle children.
export const backgroundPlugin = String.raw`
import { Plugin } from "@opencode/plugin";
import { createServer } from "node:http";
import { chmodSync } from "node:fs";
import { resolve } from "node:path";

export default Plugin.define({
  id: "quati-background-work",
  async setup(ctx) {
    const socket = ctx.options.socket;
    if (typeof socket !== "string") throw new Error("Missing Quati work socket");
    const receipts = new Map();
    const scan = async (rootID) => {
      const root = await ctx.session.get({ sessionID: rootID });
      if (resolve(root.location.directory) !== resolve(ctx.location.directory)) throw new Error("Root outside executor location");
      const tasks = [];
      const visited = new Set();
      const walk = async (parentID) => {
        if (visited.has(parentID)) return;
        visited.add(parentID);
        const messages = await ctx.session.context({ sessionID: parentID });
        for (const message of messages) {
          if (message.type !== "assistant") continue;
          for (const tool of message.content) {
            if (tool.type !== "tool" || tool.name !== "subagent") continue;
            const childID = tool.state?.metadata?.sessionID;
            if (typeof childID !== "string") continue;
            const child = await ctx.session.get({ sessionID: childID });
            if (child.parentID !== parentID) continue;
            const createdAt = tool.time.ran ?? tool.time.created;
            const nextRun = messages.flatMap(m => m.type === "assistant" ? m.content : [])
              .find(t => t.type === "tool" && t.name === "subagent" && t.state?.metadata?.sessionID === childID &&
                (t.time.ran ?? t.time.created) > createdAt);
            const until = nextRun ? (nextRun.time.ran ?? nextRun.time.created) : Infinity;
            const notification = messages.find(m => m.type === "synthetic" && m.metadata?.source === "subagent" &&
              m.metadata.childID === childID && m.time.created >= createdAt && m.time.created < until);
            const childMessages = await ctx.session.context({ sessionID: childID });
            const idle = childMessages.find(m => m.type === "idle" && m.time.created >= createdAt && m.time.created < until);
            const outcome = notification?.metadata?.state ?? idle?.outcome ?? (!nextRun ? child.outcome : undefined);
            const status = ({ succeeded: "completed", completed: "completed", failed: "failed", interrupted: "interrupted", cancelled: "interrupted" })[outcome]
              ?? (!nextRun && !child.time.idle ? "running" : "unknown");
            const completedAt = notification?.time.created ?? idle?.time.created ?? (!nextRun ? child.time.idle : undefined);
             const result = childMessages.filter(m => m.type === "assistant" && m.time.completed && m.time.created >= createdAt && m.time.created < until)
               .flatMap(m => m.content.filter(c => c.type === "text").map(c => c.text)).join("\n");
             const model = childMessages.findLast(m => m.type === "assistant" && m.time.created >= createdAt && m.time.created < until)?.model
               ?? (!nextRun ? child.model : undefined);
             tasks.push({ id: parentID + ":" + message.id + ":" + tool.id, rootSessionId: rootID, parentSessionId: parentID,
              childSessionId: childID, description: tool.state.input?.description ?? child.title ?? "Subagent",
               agent: tool.state.input?.agent ?? child.agent ?? "", model: model ? model.providerID + "/" + model.id : undefined,
              status, createdAt, completedAt, result: status === "completed" ? result : undefined,
              error: idle?.error?.message });
            await walk(childID);
          }
        }
      };
      await walk(rootID);
      return tasks;
    };
    const server = createServer(async (req, res) => {
      try {
        if (req.method !== "POST") throw new Error("POST required");
        let body = "";
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 100000) throw new Error("Request too large");
        }
        const input = JSON.parse(body);
        const tasks = await scan(input.rootSessionId);
        if (input.action) {
          const task = tasks.find(t => t.id === input.taskId);
          if (!task || task.status !== "running") throw new Error("Work is not running in this root");
          if (!["steer", "interrupt"].includes(input.action) || typeof input.id !== "string") throw new Error("Invalid control");
          const key = "receipt/" + input.rootSessionId + "/" + input.id;
          const stored = await ctx.storage.get(key);
          const existing = receipts.get(key) ?? stored;
          if (existing) {
            if (existing.taskId !== input.taskId || existing.action !== input.action) throw new Error("Receipt belongs to another control");
            res.end(JSON.stringify({ receipt: existing }));
            return;
          }
          const receipt = { id: input.id, taskId: input.taskId, action: input.action, status: "uncertain", createdAt: Date.now() };
          receipts.set(key, receipt);
          await ctx.storage.set(key, receipt);
          if (input.action === "steer") {
            if (typeof input.text !== "string" || !input.text.trim()) throw new Error("Missing steer text");
            const admitted = await ctx.session.prompt({ sessionID: task.childSessionId, text: input.text, delivery: "steer" });
            receipt.nativeId = admitted.id;
          } else {
            await ctx.session.interrupt({ sessionID: task.childSessionId, continue: false });
          }
          receipt.status = "accepted";
          await ctx.storage.set(key, receipt);
          res.end(JSON.stringify({ receipt }));
          return;
        }
        const stored = [];
        for (const id of input.receiptIds ?? []) {
          const receipt = await ctx.storage.get("receipt/" + input.rootSessionId + "/" + id);
          if (receipt) stored.push(receipt);
        }
        res.end(JSON.stringify({ tasks, receipts: stored }));
      } catch {
        res.statusCode = 409;
        res.end(JSON.stringify({ error: "Native work could not be inspected or controlled" }));
      }
    });
    await new Promise((done, fail) => {
      server.once("error", fail);
      server.listen(socket, done);
    });
    chmodSync(socket, 0o600);
    return () => server.close();
  },
});
`;
