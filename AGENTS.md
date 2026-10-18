# QuatiBot agent notes

Before claiming a server or conversation change works, follow
[`docs/verification/README.md`](docs/verification/README.md). Always launch an
isolated fixture; never verify mutations against the user's live app or data.

## Before every commit

Run `pnpm ci:local` from the repository root before committing. It forces a fresh
TypeScript check and runs four application-test shards in parallel, offline evals, packaged smoke
and real UI/browser checks in disposable environments. Linux, Node.js 24+, pnpm,
Chrome and `xvfb-run` are required. Browser fixtures may download their pinned tools.
Do not substitute an incremental typecheck or silently skip unavailable checks.
Report failures or missing dependencies explicitly; never claim the run passed
when it did not. No Docker, publication or paid model inference is part of this command.

## Architecture

QuatiBot is a Linux web app: the React UI talks to a Node backend that owns
workspace persistence, turn orchestration and streamed events. In production
the backend also serves the built UI. OpenCode V2 runs model turns over ACP;
QuatiBot exposes browser, VM, data and coordination tools through session MCP
servers. See [`docs/architecture.md`](docs/architecture.md) and
[`docs/opencode-v2.md`](docs/opencode-v2.md) for execution boundaries.

### Repository map

| Directory | Responsibility |
|---|---|
| `src/` | React frontend; `components/` contains UI, `state/` client state, `lib/` client helpers, `locales/` translations and `pair/` device pairing. |
| `server/` | Node backend; `quatibot.ts` is the CLI entry, `index.ts` wires the application, and `routes/` contains extracted HTTP endpoints. |
| `server/drivers/` | Agent runtime integration, including OpenCode V2 and the ACP transport in `acp/`. |
| `server/runtime/` | Assignment lifecycle, execution levels, durable runtime state and agent envelopes/reports. |
| `server/harness/` | Provider registry, provider event bus and harness HTTP endpoints. |
| `server/host/` | Host-side tool integrations and capabilities mounted into agent sessions. |
| `server/browser/` | QuatiBot's Chrome/CDP driver, browser service, egress policy and live viewers; `server/browser-*.ts` also supports the agent-browser engine. |
| `server/data/` | Data workspace tools and query integration. |
| `server/decider/`, `server/sentinel/` | Coordination decisions and execution monitoring/detectors. |
| `server/testing/`, `src/testing/` | Disposable fixtures and test helpers; tests also live beside the code they cover. |
| `shared/` | Contracts, schemas and pure logic shared by frontend and backend. |
| `scripts/` | Builds, dependency preparation, CI, verification, CLI/MCP automation and maintenance; `testing/` contains verification harnesses. |
| `evals/` | Agent-behavior scenarios, runners, scorers, golden cases and opt-in live evaluations. |
| `skills/` | Bundled instructions used by bots inside QuatiBot, not development-agent instructions. |
| `public/` | Static web/PWA assets and noVNC redistribution notice. |
| `third_party/` | Applicable vendor licenses and provenance; its README records current uses and Cua coverage limits. |
| `docs/` | Architecture, operations, security and development guides; `verification/` defines isolated validation workflows. |
| `apps/docs/` | Documentation website, with its own `AGENTS.md`. |
| `deploy/` | Self-hosted Docker Compose/Caddy configuration and example environment. |
| `.github/` | CI workflows, contribution templates and ownership configuration. |
| `.tmpexp/` | Tracked scratch experiments, not application entry points or supported tooling. |

`dist/`, `dist-server/`, `dist-native/`, `node_modules/` and
`.quati-scratch/` are generated or local working directories, not source.
Old desktop/cloud directories left in a local checkout are not evidence of
supported runtimes; check tracked files and current build entry points.

## Keep these notes current

Update this file in the same change whenever directories, entry points,
runtime ownership, build/verification commands or agent workflows change.
Remove obsolete guidance instead of appending contradictory instructions.
Verify paths and commands against tracked files and `package.json`; do not
describe generated files or local leftovers as supported architecture.
Keep this overview concise and update linked guides when their details also
change. Put directory-specific rules in the nearest `AGENTS.md` rather than
duplicating them here.

More specific `AGENTS.md` files override this note within their directories.
