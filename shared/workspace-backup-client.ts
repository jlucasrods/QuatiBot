// Exact app-owned browser state that belongs in an encrypted full backup.
// Never include cookies, authentication tokens, connection caches or unknown keys.
export const WORKSPACE_BACKUP_CLIENT_KEYS = [
  "quati-drafts",
  "quati-draft-attachments",
  "quati-draft-send-ids",
  "quati-draft-channel-modes",
  "quati-skin",
  "quati-show-threads",
  "quati-show-run-card",
  "quati-send-key",
  "quati-color-user-bubbles",
  "quati-chat-width",
  "quatibot.sidebarDensity",
  "quatibot.sidebarToolsLayout",
  "quatibot.sidebarCollapsedSections.v1",
  "quatibot.sidebarSectionOrder.v1",
  "quati-analytics-opt-out",
  "quatibot.remote-voice.v1",
] as const;

export type WorkspaceBackupClientState = Partial<Record<(typeof WORKSPACE_BACKUP_CLIENT_KEYS)[number], string>>;
