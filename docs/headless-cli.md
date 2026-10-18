# Command-line automation

The `quati` package script runs the same Node CLI as the web server. Use its help output as the reference for command arguments:

```sh
pnpm quati help
pnpm quati doctor
pnpm quati bots
pnpm quati help run
```

Automation can inspect bots, submit work, wait for completion and export results. Use an explicit server URL and an appropriately scoped session when operating remotely. Treat pairing codes, tokens and exported conversation files as secrets.

Team files configure bots, rooms, skills and model selections. Configure model providers and their credentials in OpenCode V2; QuatiBot does not import or export them.

The `mcp` command exposes QuatiBot automation over stdio for another MCP client. This control interface is separate from OpenCode's configured extension inventory and from the internal tools supplied to an active bot session.

For development and mutation testing, use the disposable fixture in [isolated verification](verification/README.md), not the user's running workspace.
