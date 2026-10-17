# Contributing to QuatiBot

QuatiBot is a Linux-only web application with a Node 24 backend and React UI.
OpenCode V2 owns model providers, authentication, plugins, skills and external
MCP definitions. Keep contributions focused and preserve upstream attribution.

## Development

```sh
git clone https://github.com/jlucasrods/QuatiBot
cd QuatiBot
corepack pnpm install --frozen-lockfile
corepack pnpm dev:server
# In another terminal:
corepack pnpm dev
```

To build and serve the UI and API from one process:

```sh
corepack pnpm build
corepack pnpm start
```

Use OpenCode V2 for real conversations. Never put model-provider secrets into
QuatiBot configuration. Default data lives in `~/.quatibot`; `QUATI_DATA_DIR`
selects another directory. Do not move, delete or overwrite another workspace
as part of development or verification.

## Verification

Follow [the isolated verification guide](docs/verification/README.md).
Extend related tests for behavior changes. Use the fake ACP CLI for deterministic
driver and HTTP tests; use a disposable browser profile for browser checks.
Never verify mutations against a personal or production workspace.

## License

Contributions use Apache-2.0 unless an existing third-party license applies.
Keep the applicable notices in `LICENSE`, `NOTICE` and `third_party/`.
The upstream proprietary enterprise directory is not part of this fork.
