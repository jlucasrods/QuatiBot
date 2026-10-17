# Run QuatiBot

## Requirements

- Linux and Node.js 24 or newer.
- pnpm 10.33, as specified by `package.json`.
- OpenCode V2 installed and authenticated for the user running the backend.

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

Open `http://127.0.0.1:8799` in a browser. The Node server serves both the compiled frontend and API. Use the pairing code printed by the server when the browser asks for one.

`QUATI_DATA_DIR` selects the workspace directory; its default is `~/.quatibot`. Keep this directory private and persistent. `--port` selects the HTTP port:

```sh
QUATI_DATA_DIR=/srv/quatibot pnpm start --port 8799
```

## Docker

The [Docker deployment guide](../deploy/README.md) provides a Linux x86-64 Compose stack with persistent storage, OpenCode V2, the agent browser and optional public HTTPS. The application container does not manage host VMs by default.

## Remote access

Run the server behind an HTTPS reverse proxy, a tunnel configured by its operator, or Tailscale. Keep the backend port private and forward HTTP and WebSocket traffic. A public address does not grant access: remote browsers need a paired session.

Pass the externally reachable origin when starting the server:

```sh
pnpm start --public-url https://quati.example.org
```

Generate a device code from the server host:

```sh
pnpm quati pair --public-url https://quati.example.org
pnpm quati sessions
pnpm quati sessions revoke SESSION_ID
```

Pairing codes are short-lived and single-use. Send them only to the intended person. `pair --client` grants chat and approvals without administrative settings. Revoking a session signs that device out.

For a private tailnet, an authenticated Tailscale installation can serve HTTPS with `pnpm start --tailscale`. For an operator-owned domain, `--domain HOST` starts the Caddy integration and requires DNS and the necessary inbound ports. Use one access method per launch.

See [security](security.md) for credential storage and [computer environments](computer-use-integration.md) for browser and VM dependencies.
