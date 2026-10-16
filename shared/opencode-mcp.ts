/** Public metadata only; OpenCode owns MCP configuration, credentials and connections. */
export interface OpenCodeMcpServer {
  name: string;
  type: "local" | "remote";
  status: "configured" | "disabled";
  enabled?: boolean;
}

/** Global OpenCode extension metadata, without configuration values or skill content. */
export interface OpenCodeExtensions {
  servers: OpenCodeMcpServer[];
  plugins: Array<{ name: string }>;
  skills: Array<{ id: string; name: string }>;
}
