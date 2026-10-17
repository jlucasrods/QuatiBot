# OpenCode V2 integration

## Ownership

- OpenCode owns providers, authentication, model access and native tools.
- QuatiBot owns bot profiles, chat history, channels, routines, memory and
  internal browser/computer/data MCP integrations.
- QuatiBot starts `opencode acp` with stdio JSON-RPC. Both the CLI version
  and ACP agent version must be 2.x.
- Model IDs come from ACP `configOptions` (`model`); variant choices come from
  the active session. IDs are passed through unchanged.
- Conversation continuation uses `session/load` and its original working directory.

Configure providers using the [OpenCode V2 documentation](https://opencode.ai/v2/docs/)
on the server machine. After changing native authentication, refresh models in
QuatiBot. No API key entry or native auth-file deletion is offered here.
Old QuatiBot engine/provider settings are ignored without deleting saved secrets.

Boat, self-hosted VPS and Composio clients, routes and connection flows are not
included in this fork. Their old stored settings are inert; removing support does
not delete credentials or terminate remote resources. Decision model/Jev and local
agent-browser/isolated-VM tools remain independent of this removal.

Session MCPs are supplied with `session/new`/`session/load`. Browser and computer
tools retain QuatiBot's tool-selection and approval boundaries. Bot-owned
workspaces disable project configuration so generated files cannot reconfigure
subsequent turns. Owned attachment/bot directories use V2 `additionalDirectories`.
Full Access adds a process-local V2 `permissions` override, never a global config edit.

## Linux web runtime

The UI and Node backend run without Electron. `pnpm build && pnpm start` serves
both on loopback port 8799. OpenCode's terminal runs on the backend host. Computer
tools can use only the agent's browser or its CUA container, never the physical
host desktop. Docker/Podman and the sandbox image are required for VM use; there
is no host-control fallback. The `record_screen` agent tool encodes browser/VM
frames as a replayable WebM attachment using server-side ffmpeg.

Auxiliary service credentials use the encrypted server vault. Website logins
retain their encrypted vault, bot grants and domain restrictions. Both vaults
reject unreadable data rather than replacing it with an empty store. The old
Electron vault is left untouched and is not migrated.

## Extensions

OpenCode owns MCP definitions, authentication, plugins and skills. Quati no
longer edits/imports MCP definitions, signs into HighLevel, or imports Claude
MCPs/skills. Old stored settings and credentials are preserved but not mounted.

The Extensions panel lists user-global OpenCode MCP definitions and plugins.
Skills come from OpenCode's native skill API, filtered to global skill directories
and local sources declared in user-global config. HTTP skill catalogs lack source
attribution in that API and are not included in this filtered list.
Project entries and secrets (commands, URLs, headers, environments, plugin options
and skill content) are not sent to the interface.

MCP switches persist only activation preferences in Quati. At the next chat
turn, OpenCode receives complete native server definitions with `disabled`
overridden through the ACP process environment. Changed environment fingerprints
restart only that conversation's ACP process and reload its session. In-flight
turns and other OpenCode clients are not changed. Configured/enabled does not
claim that a connection has succeeded; manage OAuth and credentials in OpenCode.

## Isolated smoke check

```sh
node --experimental-strip-types scripts/control-quati.ts launch
# Use the printed URL explicitly in a second terminal:
pnpm control:quati doctor --url http://127.0.0.1:PORT
pnpm control:quati new-bot --name OpenCodeProbe --url http://127.0.0.1:PORT
pnpm control:quati send --bot BOT_ID --text hello --url http://127.0.0.1:PORT
pnpm control:quati wait --bot BOT_ID --timeout 30 --url http://127.0.0.1:PORT
```

Doctor should expose only `opencodeGo` (the stored instance/driver identifier).
The wait should report `settled` and contain `hello from fake acp`.
`FAKE_ACP_*` variables script the repository-owned ACP peer; this proves the real
QuatiBot API/chat flow, not a paid model response. Native OpenCode handshake
can be checked separately in a disposable home without using personal credentials.
