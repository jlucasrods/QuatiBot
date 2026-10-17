# QuatiBot documentation site

The site uses Next.js 16 and Fumadocs. Product guides live in `content/docs`; the repository's `docs/` directory covers operation, architecture and isolated verification.

## Development

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm docs:dev
```

Open `http://localhost:3000`. Navigation is defined by the content directories' `meta.json` files.

## Build and serve

```sh
pnpm docs:build
pnpm --filter @quatibot/docs types:check
pnpm --filter @quatibot/docs start
```

The documentation site is separate from the QuatiBot backend. It serves public guides, not workspace data or credentials. Deploy it as a Next.js application with `apps/docs` as its project root; choose the hosting account and domain explicitly.

Guides describe supported behavior and operational requirements. Keep local links and navigation aligned with the available pages. Use the repository's isolated verification guide for examples that write application state.
