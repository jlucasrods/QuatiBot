# Docker deployment

Linux x86-64 with Docker Engine and Docker Compose 2.17 or newer. The image includes Node.js 24, OpenCode V2, the agent's Chrome browser, and ffmpeg.

## Local access

From the repository root:

```sh
cp deploy/.env.example deploy/.env
docker compose -f deploy/docker-compose.yml up -d --build
```

Open `http://localhost:8080`. The default published ports bind only to the host's loopback interface. Caddy forwards requests to the backend's private loopback listeners; the backend still requires pairing.

Generate a browser pairing code:

```sh
docker compose -f deploy/docker-compose.yml exec quati node dist-server/pair-cli.js
```

Configure providers and extensions using the container's OpenCode:

```sh
docker compose -f deploy/docker-compose.yml exec quati opencode auth login
docker compose -f deploy/docker-compose.yml exec quati opencode mcp add NAME --global --url URL
```

The container has its own OpenCode configuration. It does not automatically read the host's configuration or credentials.

## Public HTTPS

Point a domain to the Linux host, allow inbound TCP ports 80 and 443, and set `deploy/.env`:

```dotenv
QUATI_BIND_ADDRESS=0.0.0.0
QUATI_HTTP_PORT=80
QUATI_HTTPS_PORT=443
QUATI_SITE=quati.example.org
QUATI_PUBLIC_URL=https://quati.example.org
```

Replace the example domain with one you own. Apply with the same Compose command. Caddy obtains and renews the TLS certificate. Pairing, session permissions, and revocation remain enforced by QuatiBot; HTTPS does not grant access.

An operator-owned tunnel or reverse proxy can instead forward to the default loopback HTTP port. Set `QUATI_PUBLIC_URL` to its external HTTPS origin and retain the loopback bindings. No managed account or tunnel service is required.

## Persistence and operation

The `data` volume stores `/data`: QuatiBot's workspace, encrypted credentials, browser profiles, and OpenCode's configuration, authentication and sessions. The other volumes store Caddy certificates and state. Treat all volumes as private; do not use `down --volumes` when keeping data.

```sh
docker compose -f deploy/docker-compose.yml logs -f quati
docker compose -f deploy/docker-compose.yml stop
docker compose -f deploy/docker-compose.yml up -d --build
```

Agent terminal commands execute inside the application container. The browser and its recordings are available there. Local VM management is not configured by this example: it does not install a container runtime or expose the host's Docker/Podman socket. Use the direct Linux installation when the backend needs to manage local VMs; mounting a runtime socket would grant extensive control over the host.

See [self-hosting](../docs/self-hosting.md) and [security](../docs/security.md).
