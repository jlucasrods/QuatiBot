# Local builds

Build the Linux web application and Node bundle from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm build:server
node scripts/smoke-packaged-server.mjs
```

The smoke check uses a disposable workspace and runs the bundled application without the checkout's `node_modules`. Confirm that both the frontend assets and API are served by the Node process.

For a local Docker image, follow [Docker deployment](../deploy/README.md). CI checks the application and browser directly on Linux; it does not build containers, publish packages or create releases.
