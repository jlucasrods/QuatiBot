# Agent browser and isolated VM

## Browser

The agent uses a dedicated Chromium instance with its own profile, cookies, tabs and downloads. Enable the browser for the bot. Browser interactions and screenshots are provided by the backend, independently of the browser displaying the QuatiBot interface.

For a managed engine installation, use:

```sh
pnpm quati browser install
pnpm quati browser status
```

Linux may require Chromium system libraries. Install system dependencies deliberately for the server user and keep the browser sandbox enabled. Browser logins are restricted by their allowed sites and bot grants.

## Local VM

The Local VM runs a Cua desktop in an isolated container. Its backend supports Docker or Podman. The runtime, sandbox image and a running container are required; a Docker binary alone is not a ready VM.

The computer panel provides lifecycle controls, a web viewer and VM files. Persistent homes are stored in the data directory. Mouse and keyboard operations target the sandbox. An unavailable VM produces an error instead of controlling the operator's desktop.

Auto execution can choose supported agent environments. Explicit VM selection requires a usable VM. OpenCode terminal commands use the backend host unless a command explicitly enters the container.

## Screenshots and recordings

Browser and VM tools return screenshots from their own environment. The `record_screen` coordination tool records `browser` or `vm`, for an integer duration from 1 to 30 seconds. It requires `ffmpeg` on the backend host and saves a WebM attachment in the bot's attachment directory.

The recording route rechecks active turn authority and the selected environment while capturing. A live preview is separate from a saved, replayable video. Recordings can contain sensitive page or application content; share them intentionally.
