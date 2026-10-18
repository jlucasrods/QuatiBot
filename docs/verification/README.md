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

## CI checks

CI runs on Linux with Node.js 24. Its required `CI` gate covers static checks, sharded application tests, offline evals (including golden replay and the scripted skill bench), the bundled server smoke, renderer smoke, browser identity and browser-driver checks. Browser checks run directly on the runner, not in containers. Live model evals remain disabled.

Run `pnpm test:evals` for the dedicated eval suite; the application shards do not repeat it. CI retains the eval JUnit report on failure and renderer screenshots as artifacts. Docker images are built locally using `deploy/`; no workflow builds containers, publishes packages or creates releases.

For a UI change, open the fixture in a separate browser context, exercise the affected controls, then close only that context. Inspect only the relevant fixture logs and redact secrets before sharing evidence.
