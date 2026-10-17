# Distribution

Build the Linux web application and Node bundle from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm build:server
node scripts/smoke-packaged-server.mjs
```

The smoke check uses a disposable workspace and runs the bundled application without the checkout's `node_modules`. Confirm that both the frontend assets and API are served by the Node process.

The npm artifact builder is `node scripts/build-npm-package.mjs`. Inspect its output before publishing: include the compiled application, LICENSE, NOTICE, LICENSING.md and applicable third-party notices. Do not include credentials, vault keys, personal data directories or local environment files.

Repository releases are published at <https://github.com/jlucasrods/QuatiBot/releases>. Publishing artifacts or deploying infrastructure is an explicit operator action.
