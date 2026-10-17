# QuatiBot automation over MCP

`pnpm quati mcp` serves the QuatiBot automation tools over stdin and stdout. An external MCP client can use this interface to inspect bots and conversations, submit work and wait for results. The backend must be running.

Select the destination explicitly with `QUATIBOT_URL`. Use a scoped session token through `QUATIBOT_TOKEN` when authentication is required. Do not paste tokens into prompts or commit them in client configuration.

The CLI can save a paired session token to an owner-readable file:

```sh
pnpm quati pair
pnpm quati connect https://quati.example.org --code PAIRING_CODE --out /private/path/session-token
```

Use the intended server's pairing code. `pnpm quati help connect` describes the connection options, including client-only scope. Protect token files and revoke sessions that no longer need access.

This stdio automation server is separate from OpenCode's extension inventory and from the internal browser, VM, data and coordination tools supplied to active bot turns. Adding it to an MCP client does not configure providers or change global OpenCode settings.
