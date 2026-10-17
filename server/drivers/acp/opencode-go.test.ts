import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { recordEvents } from "../../testing/events.ts";
import {
  catalogFromOpenCodeSession, createOpenCodeDriver, discoverOpenCodeModels, openCodeOwnedDirectories,
  openQuatiOwnsWorkingFolder, preferredOpenCodeModel, probeOpenCodeSession,
} from "./opencode-go.ts";
import { DATA_DIR } from "../../config.ts";

const CLI = join(import.meta.dirname, "../../testing/fake-acp-cli.ts");
const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function environment() {
  const home = mkdtempSync(join(tmpdir(), "quati-opencode-v2-"));
  scratch.push(home);
  return { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"),
    FAKE_ACP_AGENT_NAME: "OpenCode", FAKE_ACP_AGENT_VERSION: "2.0.31", FAKE_ACP_VERSION: "2.0.31",
    FAKE_ACP_MODELS: "fixture/default,fixture/alternate", FAKE_ACP_DUMP: join(home, "dump.json") };
}

describe("OpenCode V2 models", () => {
  it("reads grouped ACP models with opaque provider/model/variant IDs", () => {
    expect(catalogFromOpenCodeSession({ configOptions: [{ id: "model", type: "select", currentValue: "provider/model/high", options: [
      { group: "Provider", options: [{ value: "provider/model/high", name: "Model high" }, { value: "provider/other", name: "Other" }] },
    ] }] })).toEqual({ current: "provider/model/high", options: [{ id: "provider/model/high", label: "Model high" }, { id: "provider/other", label: "Other" }] });
  });

  it.each([null, {}, { models: { availableModels: [{ modelId: "legacy" }] } }])("handles an empty ACP catalog: %j", (session) => {
    expect(catalogFromOpenCodeSession(session)).toBeNull();
  });

  it.each([
    { current: "provider/paid", expected: "provider/paid" },
    { current: "unavailable", expected: "provider/first" },
  ])("respects the native model preference: $current", ({ current, expected }) => {
    expect(preferredOpenCodeModel(["provider/first", "provider/paid"], current)).toBe(expected);
  });

  it("discovers models through ACP", async () => {
    const env = environment();
    expect(await discoverOpenCodeModels(env, CLI)).toEqual({ default: "fixture/default", options: [
      { id: "fixture/default", label: "fixture/default" }, { id: "fixture/alternate", label: "fixture/alternate" },
    ] });
  });

  it.each(["1.18.18", "3.0.0", "unknown"])("rejects unsupported ACP version %s", async (version) => {
    const env = { ...environment(), FAKE_ACP_AGENT_VERSION: version };
    await expect(probeOpenCodeSession(CLI, env, env.HOME)).rejects.toThrow("requires OpenCode V2");
  });
});

describe("OpenCode session", () => {
  it("uses the selected model, native effort and injected MCP servers", async () => {
    const env = { ...environment(), FAKE_ACP_VARIANTS: JSON.stringify({ "fixture/alternate": {
      currentValue: "low", options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }],
    } }) };
    const driver = createOpenCodeDriver(async () => ({ default: "fixture/default", options: [
      { id: "fixture/default", label: "Default" }, { id: "fixture/alternate", label: "Alternate" },
    ] }));
    const instance = await driver.create({ instanceId: "opencodeGo", displayName: "OpenCode", enabled: true, config: driver.decodeConfig({ cli: CLI }), environment: env });
    const events = recordEvents(instance.adapter);
    try {
      await instance.adapter.sendTurn({ threadId: "v2-thread", text: "Hello", model: "fixture/alternate", variant: "high", cwd: env.HOME });
      expect(await events.until((event) => event.type === "turn.completed")).toMatchObject({ ok: true });
      const dump = JSON.parse(readFileSync(env.FAKE_ACP_DUMP, "utf8"));
      expect(dump.argv).toContain("acp");
    } finally {
      await instance.dispose();
    }
  });

  it("keeps bot directories separate from external projects", () => {
    expect(openQuatiOwnsWorkingFolder(join(DATA_DIR, "workspaces", "bot"))).toBe(true);
    expect(openQuatiOwnsWorkingFolder(join(DATA_DIR, "workspaces-elsewhere", "bot"))).toBe(false);
    expect(openCodeOwnedDirectories("bot", "/external/project")).toContain(join(DATA_DIR, "workspaces", "bot"));
  });
});
