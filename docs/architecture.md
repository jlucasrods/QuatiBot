# Architecture

## Processes

The React frontend displays bots, conversations, rooms, routines, approvals and execution state. A Node backend persists workspace state, orchestrates turns and streams updates to the browser. A production build serves the frontend and API from the same Node process.

OpenCode V2 executes model turns through ACP. The backend starts `opencode acp`, creates or loads a session with its working directory, selects the model and variant, and forwards prompts. ACP updates become conversation events, tool activity and approval requests.

## Ownership

OpenCode owns provider authentication, model availability and native extension configuration. QuatiBot owns bot profiles, conversation presentation, workspace state, routines and its internal agent tools.

Browser, sandbox computer, data and coordination tools are supplied as session MCP servers. Global OpenCode MCP definitions are read from OpenCode; QuatiBot activation preferences apply to its bot sessions. See [the OpenCode contract](opencode-v2.md).

## Execution boundaries

Terminal commands run on the backend host through OpenCode, with the session's working directory and permissions. A selected VM does not automatically move terminal commands into that VM.

The agent browser has a separate Chromium profile. Desktop interactions target an isolated container VM. Browser and VM screenshots and recordings capture those environments, not the operator's desktop.

## Coordination and persistence

Rooms and delegated work share the backend coordinator. Tool requests carry the originating bot and conversation authority; a pending approval does not grant authority to another conversation. Routines execute through the same turn orchestration and require the backend to be running.

Workspace files, transcripts and local usage records live under the configured data directory. Website logins and auxiliary service keys have separate encrypted vaults. See [storage and access](security.md).
