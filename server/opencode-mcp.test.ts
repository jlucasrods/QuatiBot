import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { globalExtensionMetadata, globalMcpConfigFromEntries, globalMcpServersFromEntries, listOpenCodeGlobalExtensions, openCodeConfigDirectory } from "./opencode-mcp.ts";
import * as procs from "./procs.ts";

const directory = "/fixture/config/opencode";

it("queries the native service's initialized skill registry", async () => {
  const configDirectory = openCodeConfigDirectory();
  const exec = vi.spyOn(procs, "execCli").mockImplementation((_cli, args, _options, callback) => {
    const data = args.at(-1) === "/api/config" ? [] : args.at(-1) === "/api/skill"
      ? { data: [{ id: "review", name: "Review", path: join(configDirectory, "skills/review/SKILL.md") }] }
      : { data: [] };
    callback(null, JSON.stringify(data));
  });

  try {
    const extensions = await listOpenCodeGlobalExtensions("opencode", "/fixture");
    expect(extensions.skills).toEqual([{ id: "review", name: "Review" }]);
    for (const [, args] of exec.mock.calls) {
      expect(args.slice(0, 2)).toEqual(["api", "get"]);
    }
  } finally {
    exec.mockRestore();
  }
});

describe("global OpenCode MCP metadata", () => {
  it("uses only global documents in native precedence order, without copying credentials", () => {
    const entries = [
      { type: "document", path: join(directory, "opencode.json"), info: { mcp: { servers: {
        notes: { type: "local", command: ["first"], environment: { TOKEN: "secret" } },
        disabled: { type: "remote", url: "https://secret.invalid", disabled: true },
      } } } },
      { type: "document", path: join(directory, "opencode.jsonc"), info: { mcp: { servers: {
        notes: { type: "remote", url: "https://secret.invalid", headers: { Authorization: "secret" } },
      } } } },
      { type: "document", path: "/project/opencode.json", info: { mcp: { servers: { notes: { type: "local" }, project: { type: "local" } } } } },
      { type: "document", path: "/etc/opencode/opencode.json", info: { mcp: { servers: { system: { type: "remote" } } } } },
      { type: "document", info: { mcp: { servers: { inline: { type: "local" } } } } },
      { type: "directory", path: directory },
    ];

    expect(globalMcpServersFromEntries(entries, directory)).toEqual([
      { name: "disabled", type: "remote", status: "disabled" },
      { name: "notes", type: "remote", status: "configured" },
    ]);
  });

  it.each([{ entries: [] }, { entries: [{ type: "document", path: join(directory, "opencode.json"), info: {} }] }])("accepts an empty global catalog: %j", ({ entries }) => {
    expect(globalMcpServersFromEntries(entries, directory)).toEqual([]);
  });

  it.each([{ entries: null }, { entries: {} }, { entries: [{ type: "document", info: { mcp: { servers: { secret: { type: "invalid", token: "secret" } } } } }] }])("rejects an unsupported response without exposing it: %j", ({ entries }) => {
    expect(() => globalMcpServersFromEntries(entries, directory)).toThrow("OpenCode returned an unsupported configuration response.");
  });
});

it("retains complete native definitions for process-local overrides, not for the UI", () => {
  const definition = { type: "remote", url: "https://example.invalid", headers: { Authorization: "secret" }, oauth: false, disabled: true };
  const entries = [{ type: "document", path: join(directory, "opencode.jsonc"), info: { mcp: { servers: { notes: definition } } } }];
  expect(globalMcpConfigFromEntries(entries, directory)).toEqual({ notes: definition });
  expect(JSON.stringify(globalMcpServersFromEntries(entries, directory))).not.toContain("secret");
});

it("lists global plugins and skills without returning their options, paths or content", () => {
  const entries = [{ type: "document", path: join(directory, "opencode.jsonc"), info: {
    plugins: ["opencode-dcp@2", { package: "@team/tools", options: { secret: "private" } }], skills: ["~/shared-skills"],
  } }, { type: "document", path: "/project/opencode.json", info: { plugins: ["project-only"] } }];
  const skill = { id: "review", name: "Review", path: join(directory, "skills/review/SKILL.md"), content: "private" };
  expect(globalExtensionMetadata(entries, { data: [skill, { ...skill, id: "project", path: "/project/.opencode/skills/project/SKILL.md" }] }, { data: [] }, directory, "/fixture", "/project")).toEqual({
    servers: [], plugins: [{ name: "@team/tools" }, { name: "opencode-dcp" }], skills: [{ id: "review", name: "Review" }],
  });
});
