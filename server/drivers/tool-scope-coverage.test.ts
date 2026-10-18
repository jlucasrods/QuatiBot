import { expect, it } from "vitest";
import { assertToolScopeSupported, TOOL_SCOPE_SUPPORT } from "../../shared/tool-scope-support.ts";
import { BUILT_IN_DRIVERS } from "./builtIn.ts";

it("covers every registered adapter and refuses unsupported native restrictions", () => {
  expect(Object.keys(TOOL_SCOPE_SUPPORT).sort()).toEqual(BUILT_IN_DRIVERS.map((driver) => driver.driverKind).sort());
  for (const engine of Object.keys(TOOL_SCOPE_SUPPORT)) {
    expect(assertToolScopeSupported(engine, undefined)).toBeUndefined();
    expect(() => assertToolScopeSupported(engine, { allow: "all" })).toThrow();
    expect(() => assertToolScopeSupported(engine, { allow: [] })).toThrow(/not supported/);
    expect(() => assertToolScopeSupported(engine, { deny: ["native:read"] })).toThrow(/not supported/);
    expect(assertToolScopeSupported(engine, { allow: ["native:*", "mcp:notes:read"] })).toEqual({ allow: ["native:*", "mcp:notes:read"] });
  }
});

it.each(["someFutureEngine", "constructor", "__proto__"])("refuses tool selection for %s", (engine) => {
  expect(assertToolScopeSupported(engine, undefined)).toBeUndefined();
  expect(() => assertToolScopeSupported(engine, { allow: ["native:*", "mcp:notes:read"] })).toThrow(/not supported/);
});
