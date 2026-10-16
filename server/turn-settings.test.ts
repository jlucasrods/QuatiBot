import { expect, it } from "vitest";
import { loadConfig } from "./config.ts";
import { settingsTurnFields } from "./turn-settings.ts";

it.each([1, 5, 10])("passes the internal MCP timeout of %s minutes", (minutes) => {
  const cfg = loadConfig();
  cfg.mcp = { callTimeoutMinutes: minutes };
  expect(settingsTurnFields(cfg)).toMatchObject({ mcpCallTimeoutMs: minutes * 60_000 });
});
