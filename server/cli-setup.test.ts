import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR, loadConfig } from "./config.ts";
import { acquireDataDirLease } from "./data-dir-lease.ts";
import type { SetupIo } from "./cli-prompts.ts";
import { isSetupComplete, runSetup } from "./cli-setup.ts";

const options = { dataDir: DATA_DIR, port: 8799 };
const configPath = join(DATA_DIR, "config.json");
const models = { default: "fixture/default", options: [{ id: "fixture/default", label: "Default" }, { id: "fixture/selected", label: "Selected" }] };

beforeEach(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  mkdirSync(DATA_DIR, { recursive: true });
});

function fixture(confirm = true) {
  const io: SetupIo = {
    log: vi.fn(), choose: vi.fn().mockResolvedValue(1), confirm: vi.fn().mockResolvedValue(confirm),
    ask: vi.fn(), secret: vi.fn(),
  };
  const inspect = vi.fn().mockResolvedValue({ snapshot: { state: "available", authenticated: true }, models });
  return { io, inspect };
}

describe("OpenCode setup", () => {
  it("selects a discovered model and preserves existing data and native credentials", async () => {
    const original = { profile: { name: "Keep" }, opencodeGo: { apiKey: "old-key" }, instances: { claude: { driver: "claudeAgent" } } };
    writeFileSync(configPath, JSON.stringify(original));
    const { io, inspect } = fixture();

    expect(await runSetup(options, io, { inspect })).toBe(true);
    expect(inspect).toHaveBeenCalledWith("opencodeGo", { driver: "opencodeGo" });
    expect(loadConfig()).toMatchObject({ ...original, defaultModelSelection: { instanceId: "opencodeGo", model: "fixture/selected" } });
    expect(io.secret).not.toHaveBeenCalled();
    expect(await isSetupComplete(DATA_DIR)).toBe(true);
  });

  it.each(["unavailable", "empty", "cancelled"])("preserves settings when setup is %s", async (state) => {
    const original = JSON.stringify({ profile: { name: "Keep" } });
    writeFileSync(configPath, original);
    const { io, inspect } = fixture(false);
    if (state === "unavailable") inspect.mockResolvedValue({ snapshot: { state: "unavailable", reason: "OpenCode V2 required" }, models });
    if (state === "empty") inspect.mockResolvedValue({ snapshot: { state: "available" }, models: { default: "", options: [] } });

    if (state === "cancelled") expect(await runSetup(options, io, { inspect })).toBe(false);
    else await expect(runSetup(options, io, { inspect })).rejects.toThrow();
    expect(readFileSync(configPath, "utf8")).toBe(original);
    const lease = acquireDataDirLease(DATA_DIR);
    expect(lease.release()).toBe(true);
  });

  it("does not consider an old engine selection configured", async () => {
    writeFileSync(configPath, JSON.stringify({ defaultModelSelection: { instanceId: "codex", model: "old" } }));
    expect(await isSetupComplete(DATA_DIR)).toBe(false);
  });
});
