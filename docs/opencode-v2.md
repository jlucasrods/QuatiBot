# OpenCode integration

## Providers and models

Install OpenCode V2 for the user running QuatiBot and configure providers in OpenCode. Authenticate with OpenCode's own interface or `opencode auth login`.

QuatiBot discovers the models offered by ACP and lets each bot or conversation select a model and its available variant. It requires OpenCode major version 2. Provider credentials and model definitions belong to OpenCode.

The backend communicates over `opencode acp` using ACP session creation, loading, configuration options, prompt updates and permission requests. Session reuse depends on the working directory, environment and injected internal tools.

## Sessions and context

OpenCode owns its context window and automatic compaction. QuatiBot keeps the conversation history for display and recovery, but its local byte budgets do not compact or replace an OpenCode session. Normal turns and executor restarts resume the saved native session and send only new input.

Recovery replay creates a replacement session only when OpenCode explicitly reports that the saved session no longer exists. Authentication, configuration and temporary transport failures do not authorize replay. Editing or rewinding a conversation still deliberately branches its context.

Manual compaction sends the native ACP `/compact` command to the existing session. HTTP acceptance starts the operation; the compaction tool step records OpenCode's completion or failure notification. A prompt response without native completion confirmation is not reported as successful compaction. Manual compaction never reconstructs a missing session.

## Global extensions

The profile menu's **Extensões** panel lists global user MCP servers, plugins and skills from OpenCode. Project extension definitions are not included in this global inventory. MCP rows show configured or disabled state; configured does not mean connected.

MCP switches are QuatiBot preferences. A change applies to all its bot conversations on their next message. It does not interrupt a running turn or change OpenCode's global files, credentials or other clients.

To apply an MCP switch, the backend uses the complete native definition with a process-local `disabled` override. A changed environment starts an ACP process with the new preferences and loads the conversation session.

Plugins and skills are read-only in the panel. Configure them in OpenCode. Skills are listed when the native API identifies their global source; remote catalogs without attributable provenance are not part of the list. The browser receives names and safe metadata, not commands, headers, environment variables, secret URLs or skill contents.

## Internal agent tools

QuatiBot supplies its browser, sandbox computer, data and coordination tools for the session. Their availability follows bot settings and execution authority. They are not written to the user's global OpenCode configuration.

Approval settings govern QuatiBot's orchestration and ACP permission requests. Terminal commands still execute on the backend host; selecting a computer VM does not relocate the terminal.

## Native background work

OpenCode 2.0.32 is the verified baseline for native background subagents. The
native `subagent` tool creates work and continues an existing child with
`sessionID`; these children are not Quati bots. The **Work in progress** panel
expands upward from the message box, lists work runs, shows final output, sends a message to the same child and
interrupts only the selected child. An accepted interrupt remains pending until
the native state confirms termination. It does not undo file changes.

ACP remains the conversation transport. Quati opts into native child updates and
keeps the executor alive while children run, including after the main reply.
Supplementary controls and recovery use a bundled OpenCode plugin inside that
same private executor, through a private per-process Unix socket. The integration
does not discover OpenCode's private address or credentials, contact the global
service, or modify the user's plugin configuration.

Work identity includes the native parent message and tool call, not just the child
session. Recovery reads native tool metadata and terminal outcomes without
creating a prompt or restarting a job. Missing events and disconnected executors
are not proof of success. Controls have persistent admission receipts; uncertain
delivery is never automatically retried. UI and MCP controls share conversation
authorization, and a native session ID alone does not grant access.

The MCP tools are `background_tasks_list`, `background_task_details`,
`background_task_steer` and `background_task_interrupt`. Creation and continuation
still use OpenCode's native `subagent` tool. Executor configuration changes that
would replace a still-running native root are refused until its children finish
or are interrupted; an explicit new root keeps previous work separately tracked.

Isolated verification against OpenCode 2.0.32 used a deterministic loopback model:
two simultaneous children, another main prompt, steering the original child,
interrupting only the other child, completion while idle, a child permission
request answered after the main reply, and recovery after executor restart. A
separate browser context exercised the real chat panel, native steering receipts
and selective interruption. No live account or user workspace was used.
