import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureDirs } from "../../config.ts";
import type { ProviderInstance } from "../../contracts.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { recordEvents } from "../../testing/events.ts";
import { createOpenCodeDriver } from "./opencode-go.ts";

const cli = join(import.meta.dirname, "../../testing/fake-acp-cli.ts");
const driver = createOpenCodeDriver(async () => ({ default: "fixture/model", options: [{ id: "fixture/model", label: "Fixture" }] }));

describe("OpenCode V2 ACP turns", () => {
  let home: string;
  let instance: ProviderInstance;

  beforeEach(() => {
    ensureDirs();
    chmodSync(cli, 0o755);
    home = mkdtempSync(join(tmpdir(), "quati-opencode-turn-"));
  });

  afterEach(async () => {
    await instance?.dispose();
    await removeTempDir(home);
  });

  const create = async (environment: Record<string, string> = {}) => {
    instance = await driver.create({
      instanceId: "opencodeGo", displayName: "OpenCode fixture", enabled: true,
      config: { cli, fullAuto: false },
      environment: {
        HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"),
        FAKE_ACP_AGENT_NAME: "OpenCode", FAKE_ACP_AGENT_VERSION: "2.0.31", FAKE_ACP_VERSION: "2.0.31",
        FAKE_ACP_MODELS: "fixture/model", FAKE_ACP_DUMP: join(home, "dump.json"),
        FAKE_ACP_RPC_DUMP: join(home, "rpc.json"), ...environment,
      },
    });
    return recordEvents(instance.adapter);
  };

  it("streams text and tools, then reuses the native conversation", async () => {
    const recorder = await create();
    for (const text of ["Hello", "Continue"]) {
      const { turnId } = await instance.adapter.sendTurn({ threadId: "thread", text, cwd: home });
      expect(await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId)).toMatchObject({ ok: true });
    }
    const methods: string[] = JSON.parse(readFileSync(join(home, "rpc.json"), "utf8"));
    expect(methods.filter((method) => method === "session/new")).toHaveLength(1);
    expect(methods.filter((method) => method === "session/prompt")).toHaveLength(2);
    expect(recorder.events.some((event) => event.type === "content.delta")).toBe(true);
    expect(recorder.events.some((event) => event.type === "item.started" && event.itemType === "tool")).toBe(true);
  });

  it("loads a native cursor with the original working directory", async () => {
    const recorder = await create();
    await instance.adapter.sendTurn({ threadId: "thread", text: "Continue", cwd: home, resumeCursor: "fake-acp-session" });
    await recorder.until((event) => event.type === "turn.completed");
    const methods: string[] = JSON.parse(readFileSync(join(home, "rpc.json"), "utf8"));
    expect(methods).toContain("session/load");
    const session = JSON.parse(readFileSync(join(home, "dump.json.session.json"), "utf8"));
    expect(session.cwd).toBe(home);
  });

  it.each([
    { kind: "execute", title: "shell" },
    { kind: "read", title: "git push origin release" },
  ])("keeps the semantic kind of a $kind tool", async ({ kind, title }) => {
    const command = "git push origin release";
    const recorder = await create({ FAKE_ACP_TOOL_CALLS: JSON.stringify([{ name: command, kind, input: { command }, ok: true }]) });
    await instance.adapter.sendTurn({ threadId: "thread", text: "Report fixture tools", cwd: home });
    await recorder.until((event) => event.type === "turn.completed");

    expect(recorder.events.filter((event) => event.type === "item.started" && event.itemType === "tool"))
      .toMatchObject([{ title, summary: command }]);
  });

  it("passes internal browser, computer and Android MCPs only to the session", async () => {
    const recorder = await create();
    const server = { command: process.execPath, args: ["fixture-mcp"], env: { FIXTURE_TOKEN: "session-secret" } };
    await instance.adapter.sendTurn({
      threadId: "thread", text: "Use my tools", cwd: home,
      integrations: { browser: server, localComputer: server, phone: server },
    });
    expect(await recorder.until((event) => event.type === "turn.completed")).toMatchObject({ ok: true });
    const session = JSON.parse(readFileSync(join(home, "dump.json.session.json"), "utf8"));
    expect(session.mcpServers).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "browser", env: [{ name: "FIXTURE_TOKEN", value: "session-secret" }] }),
      expect.objectContaining({ name: "computer" }),
      expect.objectContaining({ name: "phone", env: [{ name: "FIXTURE_TOKEN", value: "session-secret" }] }),
    ]));
  });

  it.each(["exit-early", "fail-after-text"])("finishes a failed %s turn without hanging", async (mode) => {
    const recorder = await create({ FAKE_ACP_MODE: mode });
    await instance.adapter.sendTurn({ threadId: "thread", text: "Hello", cwd: home });
    expect(await recorder.until((event) => event.type === "turn.completed")).toMatchObject({ ok: false });
  });

  it.each([
    { message: "The request was cancelled by the client.", data: undefined, expected: "The request was cancelled by the client." },
    { message: "The request was cancelled by the client.", data: { details: "The request was cancelled by the client." }, expected: "The request was cancelled by the client." },
    { message: "The request was cancelled by the client.", data: { details: "Failed to save a file" }, expected: "The request was cancelled by the client.: Failed to save a file (session/prompt)" },
    { message: "Failed after the request was cancelled by the client.", data: undefined, expected: "Failed after the request was cancelled by the client. (session/prompt)" },
  ])("preserves the cancellation boundary for $expected", async ({ message, data, expected }) => {
    const failure = join(home, "rpc-failure.json");
    writeFileSync(failure, JSON.stringify({ code: -32603, message, data }));

    const recorder = await create({ FAKE_ACP_RPC_FAILURE_FILE: failure });
    await instance.adapter.sendTurn({ threadId: "thread", text: "Hello", cwd: home });
    await recorder.until((event) => event.type === "turn.completed");

    expect(recorder.events.filter((event) => event.type === "runtime.error")).toMatchObject([{ message: expected }]);
  });
});
