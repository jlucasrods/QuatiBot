import { emailGateDone } from "@/lib/onboarding-status";
import { currentStep } from "@/lib/guided-tour";
import { welcomeDue, type WelcomeViewer } from "@/lib/onboarding";
import type { AppState } from "@/state/store";

export function cornerPopupWaits(state: AppState,
  { quiet = false, idle = false, viewer }: { quiet?: boolean; idle?: boolean; viewer?: WelcomeViewer | null } = {}): boolean {
  const record = state.config?.onboarding;
  const busy = idle && (state.bots.some(bot => bot.busy || bot.tasks?.some(task => task.busy))
    || state.groups.some(group => group.working || group.busyBotId));
  const setup = state.welcomeOpen || state.tourOpen || (Boolean(record?.completedAt) && currentStep(record) !== null)
    || welcomeDue(state.config, { remoteClient: false, legacyDone: emailGateDone(), ...(viewer ? { hosted: viewer.hosted, canSave: viewer.canSave, cloudHome: viewer.cloudHome } : {}) });
  return !state.connected || !state.config || setup || busy || quiet
    || state.appSettingsOpen || state.settingsOpen || state.newBotOpen || state.pluginsOpen || state.triggersOpen || state.shortcutsOpen;
}
