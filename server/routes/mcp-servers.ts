import { z } from "zod";
import type { OpenCodeExtensions, OpenCodeMcpServer } from "../../shared/opencode-mcp.ts";
import { PASS, type RouteHandler } from "./table.ts";

export function createMcpServerRoutes(deps: {
  listServers(): Promise<OpenCodeMcpServer[]>;
  listExtensions(): Promise<OpenCodeExtensions>;
  setEnabled(name: string, enabled: boolean): void;
}): RouteHandler {
  return async ({ req, res, path, method, json, readBody }) => {
    const extensions = path === "/api/opencode/extensions";
    if (!extensions && path !== "/api/mcp/servers" && !path.startsWith("/api/mcp/servers/")) return PASS;
    res.setHeader("Cache-Control", "no-store");
    if (method === "PATCH" && path.startsWith("/api/mcp/servers/")) {
      const name = decodeURIComponent(path.slice("/api/mcp/servers/".length));
      const parsed = z.object({ enabled: z.boolean() }).strict().safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "Expected an enabled boolean." });
      const servers = await deps.listServers();
      if (!servers.some((server) => server.name === name)) return json(res, 404, { error: "Global MCP server not found." });
      deps.setEnabled(name, parsed.data.enabled);
      return json(res, 200, { name, enabled: parsed.data.enabled, scope: "quati", applies: "next_turn" });
    }
    if (method !== "GET" || (!extensions && path !== "/api/mcp/servers")) {
      return json(res, 405, { error: "MCP servers are configured exclusively in OpenCode." });
    }
    try {
      const result = extensions ? await deps.listExtensions() : { servers: await deps.listServers() };
      return json(res, 200, { ...result, scope: "global", activationScope: "quati" });
    } catch {
      return json(res, 503, { error: "Could not read global extensions from OpenCode V2." });
    }
  };
}
