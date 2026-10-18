export { HEADLESS_VERBS as HEADLESS_VERB_NAMES } from "./headless/args.ts";

export const HEADLESS_USAGE = `Drive a running workspace (scripts, CI, other agents):
  quatibot doctor                    check the server answers and an engine is ready
  quatibot bots | channels | models  your bots, your rooms, the engines and their models
  quatibot run BOT "do this"         give a bot one job and wait until it and every teammate it asked are done
  quatibot send BOT "text"           send one message and return at once
  quatibot wait BOT                  wait on work already running
  quatibot messages BOT              the latest messages of a conversation
  quatibot interrupt BOT [--tree]    press Stop (--tree: and every teammate on its job)
  quatibot export BOT --out DIR      write a job's transcripts, files and screens to DIR
  quatibot events [--job THREAD]     the server's live events as JSON lines
  quatibot team apply FILE           make the workspace match a team file (team export writes one)
  quatibot engine set claude --key-env ANTHROPIC_API_KEY   give it an engine without a screen
  quatibot connect URL --code CODE --out FILE              get a token for a workspace elsewhere
  quatibot new-bot | new-channel | set-model | edit | mcp

  Server: --url URL (or QUATIBOT_URL), --port N (or QUATI_PORT), else this computer's.
  Token: QUATIBOT_TOKEN or --token-file FILE. --json prints one JSON document;
  progress goes to stderr (--quiet drops it). quatibot help VERB for the details.`;

export const USAGE = `quatibot — your team of AI bots, ready in a few steps

  quatibot                         set up once, then open your workspace
  quatibot setup [--data-dir DIR]
  quatibot start [the same options as serve]
  quatibot serve [--port 8799] [--data-dir DIR] [--label NAME]
                    [--public-url https://host] [--tailscale | --domain HOST] [--no-pair]
  quatibot pair  [--label NAME] [--client]
                    [--public-url https://host]
  quatibot sessions [revoke ID]
  quatibot status
  quatibot service install [--domain HOST | --tailscale] [--port N] [--data-dir DIR] | uninstall
                    [--sentinel]   (the health scan below, every two minutes, instead of the server)
  quatibot sentinel [--data-dir DIR] [--out DIR] [--once] [--json]   (read-only health scan; see --help)
  quatibot browser install [--with-deps] | status

setup   select an available OpenCode model; keep existing bots and chats
start   same as quatibot: use your saved settings and open the workspace
serve   starts the server without prompts and prints a pairing link + QR code
pair    mints a pairing code against a running server (--client: chat only)
sessions lists paired devices; "sessions revoke ID" signs one out
status  what the server says about itself
service keep the server running across reboots: writes a systemd unit
        (Linux) or a launchd agent (macOS) for the same serve options and
        prints the commands that install it. Install the package
        permanently first (npm install -g quatibot).
browser install: the bots' browser engine (agent-browser, pinned) into the
        data dir, and Chrome for Testing into the user's browser cache.
        --with-deps also installs
        the Linux libraries Chrome needs (run as root once). Then run
        browser install as the user running serve, from that user's home.
        status: what the current user and data directory have.

--tailscale  serve over your tailnet: Tailscale terminates HTTPS and the
             link uses this machine's MagicDNS name (needs Tailscale signed in
             and HTTPS certificates enabled for the tailnet)
--domain     serve at https://HOST on your own domain: a pinned Caddy is
             downloaded once and run alongside the server, and gets the
             certificate itself. Point the domain's DNS at this machine and
             open ports 80 and 443.

--no-open   do not open a browser window
--no-pair   do not print a pairing code
--local     start locally this time, ignoring saved remote-access settings

${HEADLESS_USAGE}

Install once with \`npm install -g quatibot\`, then type \`quatibot\`.
Or run without a global install: \`npx quatibot\`. Node 24+ is required.
`;
