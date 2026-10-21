# Isolated verification

Mutating verification runs in a disposable fixture. Never point a smoke test, sample chat, credential write or bot edit at the user's live workspace.

## Launch and use a fixture

From the repository root, with Node.js 24+:

```sh
node --experimental-strip-types scripts/control-quati.ts launch
```

The launcher prints a dedicated URL, data directory and logs. It supplies a fake OpenCode ACP process and isolated credentials. Keep the launcher terminal open, and use the printed URL explicitly in another terminal:

```sh
pnpm control:quati doctor --url http://127.0.0.1:PRINTED_PORT
pnpm control:quati new-bot --name Verification --url http://127.0.0.1:PRINTED_PORT
pnpm control:quati send --bot PRINTED_BOT_ID --text "Hello" --url http://127.0.0.1:PRINTED_PORT
pnpm control:quati wait --bot PRINTED_BOT_ID --timeout 30 --url http://127.0.0.1:PRINTED_PORT
```

Stop the launcher with Ctrl-C when finished. It owns the child server and its temporary directories. Do not delete or stop an unrelated process to clean up a fixture.

## Verification scope

- `server/opencode-variants.e2e.test.ts` exercises the real HTTP orchestration with fake ACP, model variants, browser selection and session-only MCP switches.
- `server/config-secrets.test.ts` and `server/login-store.test.ts` exercise encrypted persistence and fail-closed vault behavior.
- `server/bot-logins.test.ts` covers login access boundaries.
- `server/screen-recording.e2e.test.ts` uses an isolated Chromium instance and a replayable recording when its runtime dependencies are available.
- `scripts/smoke-packaged-server.mjs` exercises the bundled web server, assets, workers and CLI without checkout dependencies.

Fake ACP proves the application protocol and orchestration, not real provider inference. A browser test proves browser behavior, not VM behavior. To verify VM lifecycle, interactions and recordings, provide a working container runtime and sandbox image in a disposable environment. Do not claim a missing dependency was validated.

## Run the affected test group

Choose tests from the behavior changed, including its callers and shared helpers:

| Change | Command |
| --- | --- |
| Fixture launcher, startup failures or isolated preview | `pnpm test:fixtures` |
| Saved logins, vault persistence, permissions or fill | `pnpm test:logins` |
| Another feature | `pnpm exec vitest run path/to/related.test.ts path/to/caller.test.ts` |

These groups do not build the app or run unrelated suites. Narrow a group further
with Vitest's name filter, for example `pnpm test:fixtures -t 'startup error'`.
Add a `test:<area>` package script when a feature needs a reusable group rather
than introducing another test runner. Renderer behavior changes still need the
relevant UI test or fixture interaction; launcher tests are not a substitute.

## Full CI checks

Run `pnpm ci:local` only when a full local validation is explicitly requested,
not for every edit or commit. It runs every application check below,
forces a fresh frontend typecheck, runs four application-test shards in parallel,
and continues after failures to report all
failed stages with a nonzero exit code. It uses a temporary HOME and data directory;
the integration fixtures choose their own ports. Linux, Node.js 24+, pnpm, Chrome
and `xvfb-run` are required. Browser fixtures can download pinned browser tools.
Missing dependencies are failures, not successful skips. The documentation site
stays local and is not built by CI or this command.

Remote CI runs only for pull requests, on Linux with Node.js 24; pushes to main do not trigger it. Its required `CI` gate covers static checks, sharded application tests, offline evals (including golden replay and the scripted skill bench), the bundled server smoke, renderer smoke, browser identity and browser-driver checks. Browser checks run directly on the runner, not in containers. Live model evals remain disabled.

Run `pnpm test:evals` for the dedicated eval suite; the application shards do not repeat it. CI retains the eval JUnit report on failure and renderer screenshots as artifacts. Docker images are built locally using `deploy/`; no workflow builds containers, publishes packages or creates releases.

For a UI change, open the fixture in a separate browser context, exercise the affected controls, then close only that context. Inspect only the relevant fixture logs and redact secrets before sharing evidence.
