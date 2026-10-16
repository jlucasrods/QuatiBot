import { expect, it } from "vitest";
import { acpNativeIncomingLogMessage } from "./core.ts";

it("redacts MCP catalog replies and errors before native logging", () => {
  const message = { jsonrpc: "2.0", id: 7, result: { result: { servers: [{ env: { TOKEN: "session-secret" } }] } } };
  expect(JSON.stringify(acpNativeIncomingLogMessage(message, new Set([7])))).not.toContain("session-secret");
  expect(acpNativeIncomingLogMessage({ id: 7, error: { message: "session-secret" } }, new Set([7])))
    .toEqual({ id: 7, jsonrpc: undefined, error: "[MCP catalog error omitted]" });
});
