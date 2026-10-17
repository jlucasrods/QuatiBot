// Resolve spawned proxies only here: esbuild inlines modules into entry bundles, so a relative path must be anchored at the server root.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const SERVER_ROOT = dirname(fileURLToPath(import.meta.url));

export function resolveProxy(relative: string): string {
  const source = join(SERVER_ROOT, `${relative}.ts`);
  return existsSync(source) ? source : join(SERVER_ROOT, `${relative}.js`);
}

export const SPAWNED_PROXIES = {
  harnessMcp: resolveProxy("harness-mcp-proxy"),
  permission: resolveProxy("permission-proxy"),
  containerMcp: resolveProxy("container-mcp"),
  agents: resolveProxy("drivers/agents-proxy"),
  dweb: resolveProxy("drivers/dweb-proxy"),
  mcpGate: resolveProxy("mcp-gate"),
  mcpRemote: resolveProxy("mcp-remote-proxy"),
  phone: resolveProxy("drivers/phone-proxy"),
  hook: resolveProxy("hooks/quati-hook"),
} as const;
