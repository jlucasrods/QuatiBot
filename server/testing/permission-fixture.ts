import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect } from "vitest";
import { launchVerificationServer } from "../../scripts/control-quati.ts";

export async function launchPermissionFixture() {
  const fixture = await launchVerificationServer();
  const { url, dataDir } = fixture.info;
  const wrapper = join(dataDir, "permission-opencode.mjs");
  writeFileSync(wrapper, [
    "#!/usr/bin/env node",
    'process.env.FAKE_ACP_MODE = "controlled";',
    'process.env.FAKE_ACP_CONTROL_KEY = "thread";',
    `process.env.FAKE_ACP_CONTROL_DIR = ${JSON.stringify(dataDir)};`,
    `await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/testing/fake-acp-cli.ts")).href)});`,
  ].join("\n"), { mode: 0o700 });

  try {
    const response = await fetch(`${url}/api/instances/opencodeGo`, {
      method: "PATCH", headers: { "content-type": "application/json", origin: url },
      body: JSON.stringify({ cli: wrapper }),
    });
    expect(response.status).toBe(200);
  } catch (error) {
    await fixture.close();
    throw error;
  }

  const get = async (path: string) => {
    const response = await fetch(url + path);
    expect(response.ok).toBe(true);
    return JSON.parse(await response.text());
  };
  const start = async (bot: { id: string; threadId: string }, threadId = bot.threadId) => {
    const dump = join(dataDir, `${threadId}.json`);
    rmSync(dump, { force: true });
    const response = await fetch(`${url}/api/bots/${bot.id}/messages`, {
      method: "POST", headers: { "content-type": "application/json", origin: url },
      body: JSON.stringify({ threadId, text: "Hold this verification task while native command approvals are exercised." }),
    });
    expect(response.status).toBe(202);
    await expect.poll(() => existsSync(dump), { timeout: 15_000 }).toBe(true);
    return threadId;
  };
  const ask = async (threadId: string, command: string, input = {}, tool = "shell") => {
    const previous = new Set<string>((await get("/api/decisions")).decisions.map((row: { requestId: string }) => row.requestId));
    const key = randomUUID();
    writeFileSync(join(dataDir, `${threadId}.permission.json`), JSON.stringify({ key, tool, input: { command, ...input } }));

    let id = "";
    await expect.poll(async () => {
      const messages = (await get(`/api/threads/${threadId}/messages?limit=100`)).messages;
      const card = messages.find((message: { card?: { requestId?: string; answered?: boolean } }) => message.card?.requestId && !message.card.answered)?.card;
      const decision = (await get("/api/decisions")).decisions.find((row: { requestId: string; threadId?: string }) =>
        row.threadId === threadId && !previous.has(row.requestId));
      id = card?.requestId ?? decision?.requestId ?? "";
      return id;
    }, { timeout: 10_000 }).toBeTruthy();

    const answer = () => {
      const file = join(dataDir, `${key}.answer`);
      return existsSync(file) ? readFileSync(file, "utf8") : undefined;
    };
    const reply = async () => {
      await expect.poll(answer, { timeout: 10_000 }).toBeTruthy();
      return answer();
    };
    return { id, answer, reply };
  };
  return { fixture, start, ask };
}
