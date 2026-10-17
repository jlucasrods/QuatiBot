# QuatiBot — OpenCode V2

This fork uses **OpenCode V2 exclusively**, through its local ACP interface.
Every chat turn is processed by OpenCode. QuatiBot provides bots, conversations,
channels, memory, routines and tool integrations; it does not implement a second
model client.

## Setup

1. Install [OpenCode V2](https://opencode.ai/v2/docs/) on the machine running QuatiBot.
2. Configure providers and sign in **in OpenCode**, for example with `opencode auth login`.
3. Start QuatiBot and refresh its models. Select an available model and variant
   for each bot or conversation.

QuatiBot discovers models from ACP `session/new` configuration options. It
does not accept model-provider keys, install another engine, inject local-provider
configuration, or edit OpenCode's global configuration. OpenCode V1, Claude Code,
Codex and other engine adapters are not supported.

Existing provider secrets are left untouched on disk, but are not
used or migrated. Configure those providers yourself in OpenCode. Boat, self-hosted
VPS and Composio integrations are removed, including their remote lifecycle and
connection flows. Existing secrets and remote resources are not deleted.

Decision model/Jev, voice, image generation, the built-in browser and local
isolated VMs remain available. There is no physical desktop, mouse or keyboard
control. External tools are configured through OpenCode.

Browser and computer tools are passed to OpenCode for the ACP session. Configure
other MCP servers, plugins and skills in OpenCode. The Extensions panel lists
global entries; its MCP switches affect only Quati sessions, on the next turn,
without editing OpenCode configuration or changing other clients.

## Run on Linux

Requires Linux, Node.js 24+, pnpm 10.33 and OpenCode V2.

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm build
corepack pnpm start
```

Open http://127.0.0.1:8799. One Node process serves the built interface and API.
Keep the default loopback address. Remote deployments require authentication and
HTTPS; do not expose the trusted-local development server to the internet.

QuatiBot uses `~/.quatibot` by default and `QUATI_*` environment variables.
Existing workspaces are not moved or deleted. To reuse one explicitly, start with
`QUATI_DATA_DIR=/path/to/your/workspace corepack pnpm start`; back it up first.
Old environment-variable names are not imported automatically.

OpenCode terminal commands run on the backend host, not automatically inside a
VM. The agent browser has its own profile. Isolated desktops require Docker or
Podman and the CUA sandbox image, prepared through Local VM settings. A missing
sandbox never falls back to controlling the host desktop.

Screenshots and live viewers work through the backend. The agent's `record_screen`
tool saves 1–30 second WebM clips of its browser or VM; it requires `ffmpeg` on
the server. Recordings are attachments, not captures of the user's desktop.

## Credentials

Model providers and authentication belong to OpenCode. Auxiliary service keys
(Jev, voice and image generation) are stored encrypted in the server data
directory as `credentials.enc`, with a separate `credentials-key` file; both
have owner-only permissions. Website logins use the existing encrypted login
vault and bot/domain grants. Keep the original keys: unreadable vaults fail
closed and cannot be overwritten as empty stores.

The old Electron OS vault is ignored and left untouched. Re-enter any needed
auxiliary keys in web settings; there is no automatic migration. Vault files
are excluded from workspace exports.

## Development

Product analytics are removed in this fork. Local diagnostic logs and
conversation token/cost history remain available; provider plan allowances are
not queried.

Automatic updates, phone-app setup/downloads and product help/feedback links are
removed. Install new builds manually. Electron and native desktop packaging are
not included.

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm dev:server
# In another terminal:
corepack pnpm dev
```

See [the OpenCode integration](docs/opencode-v2.md) and
[isolated verification](docs/verification/README.md). Never run mutation checks
against your personal workspace.

## Upstream

Based on [OpenMausBot](https://github.com/milind-soni/OpenMausBot) by Milind Soni
and its contributors. QuatiBot is an independent fork, not an official release.
Licensed under [Apache-2.0](LICENSE).
Original attribution notices are retained in [NOTICE](NOTICE). The separately
licensed upstream enterprise directory is not included in this fork.
