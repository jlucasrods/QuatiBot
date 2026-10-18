import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";

import { launchVerificationServer } from "../scripts/control-quati.ts";

it("a queued self-POST does not lift the running webhook's unattended mark", async () => {
  const fixture = await launchVerificationServer();
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method,
      headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: JSON.parse(await response.text()) };
  };

  try {
    const cli = join(fixture.info.dataDir, "unattended-opencode.mjs");
    writeFileSync(cli, [
      "#!/usr/bin/env node",
      'process.env.FAKE_ACP_MODE = "controlled";',
      'process.env.FAKE_ACP_CONTROL_KEY = "thread";',
      `process.env.FAKE_ACP_CONTROL_DIR = ${JSON.stringify(fixture.info.dataDir)};`,
      `await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/testing/fake-acp-cli.ts")).href)});`,
    ].join("\n"), { mode: 0o700 });
    expect((await api("PATCH", "/api/instances/opencodeGo", { cli })).status).toBe(200);

    const bot = (await api("GET", "/api/bots?messages=0")).body.bots[0];
    expect((await api("PATCH", `/api/bots/${bot.id}`, {
      approvalMode: "auto", modelSelection: { instanceId: "opencodeGo", model: "fixture/default" },
    })).status).toBe(200);
    const hook = await api("POST", "/api/webhooks", {
      name: "Nightly build", prompt: "Handle the incoming build event", botId: bot.id, runOn: "quati",
    });
    expect(hook.status).toBe(201);
    const delivered = await fetch(hook.body.credential.url, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "failed" }),
    });
    expect(delivered.status).toBe(202);
    const { runId } = JSON.parse(await delivered.text());

    let threadId = "";
    await expect.poll(async () => {
      const run = (await api("GET", "/api/routines")).body.runs.find((candidate: { id: string }) => candidate.id === runId);
      threadId = run?.threadId ?? "";
      return threadId && existsSync(join(fixture.info.dataDir, `${threadId}.json`));
    }, { timeout: 20_000 }).toBeTruthy();

    const queued = await api("POST", `/api/bots/${bot.id}/messages`, { threadId, text: "continue" });
    expect(queued.status).toBe(202);
    expect(queued.body).toMatchObject({ queued: true, threadId });
    expect(queued.body.steered).toBeUndefined();

    const key = "unattended-after-queued-post";
    writeFileSync(join(fixture.info.dataDir, `${threadId}.permission.json`), JSON.stringify({ key, input: { command: "ls -la ./dist" } }));
    const messages = async () => (await api("GET", `/api/threads/${threadId}/messages`)).body.messages;
    await expect.poll(async () => (await messages()).some((message: { card?: { requestId?: string } }) => message.card?.requestId), { timeout: 20_000 }).toBe(true);
    const card = (await messages()).find((message: { card?: { requestId?: string } }) => message.card?.requestId);
    expect(card.card.answered).toBeUndefined();
    expect(existsSync(join(fixture.info.dataDir, `${key}.answer`))).toBe(false);
    expect((await api("DELETE", `/api/bots/${bot.id}/queue/${queued.body.queueId}`, { threadId })).status).toBe(200);
    expect((await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId })).status).toBe(200);
  } finally {
    await fixture.close();
  }
}, 60_000);
