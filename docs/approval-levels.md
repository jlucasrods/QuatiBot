# Approvals

QuatiBot displays permission requests from the active OpenCode turn. Review the requested action and resource before allowing it. A client session can answer approvals without receiving administrative settings access.

Ask and Auto operate with OpenCode's configured permission rules and the requests it sends through ACP. Full Access adds a permissive rule to that bot process's OpenCode configuration. This is a process-local permission change, not a global configuration edit.

Remembered allowances and tool selection are not operating-system isolation. Terminal commands execute with the backend user's permissions. Use an appropriately restricted server account and review the working directory and available tools.

Browser and VM actions are distinct from terminal commands. Their internal tool authority is checked against the originating bot and turn. Selecting the VM does not move OpenCode's terminal into the VM.
