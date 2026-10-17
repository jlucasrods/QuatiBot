# Development

Use Linux, Node.js 24+ and the pnpm version specified in `package.json`.

```sh
pnpm install --frozen-lockfile
pnpm dev:server
```

In a separate terminal:

```sh
pnpm dev
```

Vite serves the development frontend; the backend owns application data and OpenCode sessions. For the single-process web build:

```sh
pnpm build
pnpm start
```

The bundled server is built with `pnpm build:server`. `node scripts/smoke-packaged-server.mjs` exercises the compiled server, frontend assets, CLI and workers in an isolated workspace.

Follow [isolated verification](verification/README.md) before claiming a server or conversation change works. Complement related tests when changing behavior, and keep credentials and personal workspace data out of fixtures.

The documentation site lives in `apps/docs`. Its content describes supported behavior and operational requirements. Keep navigation and local links consistent with the published pages.
