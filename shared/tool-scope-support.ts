import { narrowsNativeTools, parseToolScope, type ToolScope } from "./tool-scope.ts";

/** Native contracts and app-supplied MCP gates are separate capabilities. */
export const TOOL_SCOPE_SUPPORT = {
  opencodeGo: "mcp",
} as const;

export function assertToolScopeSupported(engine: string, value: unknown): ToolScope | undefined {
  const parsed = parseToolScope(value);
  if (!parsed.ok) throw new Error(parsed.error);
  if (parsed.scope !== undefined) {
    if (!Object.hasOwn(TOOL_SCOPE_SUPPORT, engine)) {
      if (parsed.scope.allow !== undefined || parsed.scope.deny?.length) throw new Error(`${engine}: tool selection is not supported by this engine. Choose a supported engine.`);
    } else if (narrowsNativeTools(parsed.scope)) {
      throw new Error(`${engine}: native tool selection is not supported by this engine. Keep native:* in the selection or choose a supported engine.`);
    }
  }
  return parsed.scope;
}
