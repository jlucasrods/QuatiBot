import type { SendTurnInput } from "../contracts.ts";
import { canUseMcpServer } from "../../shared/tool-scope.ts";
import { gateServer } from "../mcp-gate-config.ts";

export interface TurnStdioMcpServer {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** Internal Quati tools injected into the native engine session. */
export function turnStdioMcpServers(turn: SendTurnInput): TurnStdioMcpServer[] {
  const servers: TurnStdioMcpServer[] = [];
  const add = (name: string, server: { command: string; args: string[]; env?: Record<string, string> } | undefined) => {
    if (server) servers.push({ name, command: server.command, args: server.args, env: server.env ?? {} });
  };
  add("agents", turn.integrations?.agents);
  add("browser", turn.integrations?.browser);
  add("data", turn.integrations?.data);
  add("computer", turn.integrations?.localComputer);
  add("phone", turn.integrations?.phone);
  if (turn.toolScope === undefined) return servers;
  return servers.filter((server) => canUseMcpServer(turn.toolScope, server.name)).map((server) => {
    const gated = gateServer({ name: server.name, server: { command: server.command, args: server.args, env: server.env },
      threadId: turn.threadId, budget: 0, toolScope: turn.toolScope, nodeEnv: {} });
    if (!gated) throw new Error("Tool selection requires an MCP gate.");
    return { name: server.name, command: gated.command, args: gated.args, env: gated.env };
  });
}
