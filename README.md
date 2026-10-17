<h1 align="center">QuatiBot</h1>

<p align="center">
  <img src="public/app-icon.svg" alt="QuatiBot mascot" width="160" />
</p>

<p align="center">
  AI bots that get work done.<br />
  Chat, memory, routines, a dedicated browser and isolated VMs — all from a web interface.
</p>

## Get started

Requires Linux, Node.js 24+, pnpm 10.33 and
[OpenCode V2](https://opencode.ai/v2/docs/).

Configure your model providers in OpenCode (`opencode auth login`), then run:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm build
corepack pnpm start
```

Open **http://127.0.0.1:8799** and choose a model for your bots.
One Node process serves the interface and API.

Data is stored in `~/.quatibot`. Set `QUATI_DATA_DIR` to use another directory.
Keep the default loopback address; remote deployments require authentication
and HTTPS.

## Tools and extensions

- **Browser:** a dedicated profile for each bot, with screenshots and live viewing.
- **Local VM:** an isolated desktop, prepared through Local VM settings. Requires
  Docker or Podman and the CUA sandbox image.
- **Recordings:** save browser or VM clips as WebM attachments. Requires `ffmpeg`.
- **Extensions:** discover global MCP servers, plugins and skills configured in
  OpenCode. MCP switches affect only QuatiBot sessions, starting with the next turn.
- **Optional services:** Jev for fast decisions, voice and image generation.

Terminal commands run on the server, not automatically inside a VM. Bots cannot
control your physical desktop.

## Credentials

Model-provider credentials stay in OpenCode. Configure optional service keys
and website logins in QuatiBot settings; they are encrypted on the server.
Website logins follow bot and domain grants. Keep the vault keys safe:
unreadable vaults cannot be overwritten as empty stores.

## Development

```sh
corepack pnpm dev:server
# In another terminal:
corepack pnpm dev
```

See [integration details](docs/opencode-v2.md) and
[isolated verification](docs/verification/README.md).

## License

[Apache-2.0](LICENSE). Based on [OpenMausBot](https://github.com/milind-soni/OpenMausBot)
by Milind Soni and contributors. Original attribution is retained in [NOTICE](NOTICE).
