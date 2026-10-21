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
