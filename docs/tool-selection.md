# Tool selection

A bot's tool selection limits the tools that QuatiBot can expose or dispatch for that bot. An empty selection policy means the default available set. Available tools also depend on enabled features, the bot's environment and active turn authority.

Selectors identify native tools as `native:TOOL` and MCP tools as `mcp:SERVER:TOOL`. Use the identifiers offered by the tool picker rather than guessing display labels. The configuration parser validates selector structure.

QuatiBot gates its internal session MCP tools. Native OpenCode tool availability and permissions belong to OpenCode; a QuatiBot selection is not a promise that arbitrary native tools can be filtered through ACP. Unsupported restrictions are refused rather than represented as enforced.

Global OpenCode MCP activation is controlled separately in **Extensões**. Its switches apply to QuatiBot bot sessions on their next message. Plugin and skill configuration stays in OpenCode.

Tool selection and [approval settings](approval-levels.md) do not replace server-user permissions or the VM's isolation boundary.
