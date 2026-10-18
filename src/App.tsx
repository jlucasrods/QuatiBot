import { useCallback, useEffect, useRef, useState } from "react";
import { useAdvancedMode } from "@/lib/interface-mode";
import { Loader2, Menu } from "lucide-react";
import { openBot, StoreProvider, useStore } from "@/state/store";
import { useShowThreads } from "@/lib/thread-preferences";
import { useWelcomeViewer, WelcomeGate } from "@/components/onboarding/WelcomeGate";
import { spotlightsQuiet } from "@/lib/onboarding";
import { FirstConversationTour } from "@/components/onboarding/FirstConversationTour";
import { GuidedTour } from "@/components/onboarding/GuidedTour";
import { LiveCallHost } from "@/components/LiveCallHost";
import { ThreadRefsProvider } from "@/components/ThreadRefs";
import { Sidebar } from "@/components/Sidebar";
import { ChatView } from "@/components/ChatView";
import { GroupView } from "@/components/GroupView";
import { SIDEBAR_AND_PANEL_FIT, TWO_SIDE_PANELS_FIT, useMediaQuery } from "@/lib/use-media-query";
import { PluginsPanel } from "@/components/PluginsPanel";
import { ActivityPanel, BotSettingsDialog, ComputerPanel, InspectorPanel, KeyboardShortcutsModal, LocalVmWorkspace, NewBotDialog, preloadScreens, RoutinesPage, SettingsModal, TeamMapPage, TriggersPanel } from "@/components/lazy-screens";
import { WorkspaceBackupRecovery } from "@/components/WorkspaceBackupSettings";
import { NotificationRail, NotificationsPanel } from "@/components/NotificationsPanel";
import { useNotificationFeed } from "@/lib/notification-preferences";
import { DesktopCapabilitiesProvider } from "@/components/DesktopCapabilities";
import { NoEngines } from "@/components/NoEngines";
import { CommandPalette } from "@/components/CommandPalette";
import { setLocale } from "@/lib/i18n";
import { shouldOpenKeyboardShortcuts } from "@/lib/keyboard-shortcuts";
import { effectiveLanguage, useLanguageChoice } from "@/lib/language-preference";
import { botShowsUnread } from "@/lib/bot-unread";
import { useExternalChatLinks } from "@/hooks/use-external-chat-links";
import { ChatNotice } from "@/components/ChatErrorBanner";
function Shell() {
    const { state, dispatch } = useStore();
    const showThreads = useShowThreads();
    const unreadCount = state.bots.filter((bot) => !bot.hidden && botShowsUnread(bot)).length +
        state.groups.filter((group) => group.unread).length;
    const twoSidePanelsFit = useMediaQuery(TWO_SIDE_PANELS_FIT, true);
    const sidebarAndPanelFit = useMediaQuery(SIDEBAR_AND_PANEL_FIT, true);
    useExternalChatLinks(state, dispatch);
    const [drawerOpen, setDrawerOpen] = useState(false);
    const language = effectiveLanguage(useLanguageChoice(), state.config?.language);
    const [, setLocaleEpoch] = useState(0);
    useEffect(() => {
        setLocale(language || globalThis.navigator?.language);
        setLocaleEpoch((epoch) => epoch + 1);
    }, [language]);
    const [paletteOpen, setPaletteOpen] = useState(false);
    const [localVmWorkspaceBotId, setLocalVmWorkspaceBotId] = useState<string | null>(null);
    const menuButtonRef = useRef<HTMLButtonElement>(null);
    const previousViewRef = useRef(state.activeView);
    const calendarOriginRef = useRef<"chat" | "team-map">("chat");
    const group = state.groups.find((g) => g.id === state.selectedId);
    const bot = group ? undefined : (state.bots.find((b) => b.id === state.selectedId) ?? state.bots[0]);
    const notificationFeed = useNotificationFeed() && true;
    const sidePanelOpen = (Boolean(bot) && (state.settingsOpen || state.computerOpen || state.inspectorOpen || state.activityOpen)) || (notificationFeed && state.notificationsOpen);
    const collapseSidebar = sidePanelOpen && !sidebarAndPanelFit;
    const calendarFocus = state.activeView === "routines";
    const advanced = useAdvancedMode();
    useEffect(() => {
        if (!advanced && state.inspectorOpen)
            dispatch({ type: "toggleInspector", open: false });
    }, [advanced, state.inspectorOpen, dispatch]);
    const noEngines = state.connected &&
        state.instances.length > 0 &&
        !state.instances.some((i) => i.snapshot.state === "available");
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.defaultPrevented || e.isComposing || state.shortcutsOpen)
                return;
            if (shouldOpenKeyboardShortcuts(e)) {
                e.preventDefault();
                dispatch({ type: "toggleShortcuts", open: true });
                return;
            }
            const mod = e.metaKey || e.ctrlKey;
            if (!mod)
                return;
            const bots = state.bots.filter((b) => !b.hidden);
            if (e.key === "n" && !e.shiftKey) {
                e.preventDefault();
                dispatch({ type: "toggleNewBot", open: true });
            }
            else if (/^[1-9]$/.test(e.key)) {
                const target = bots[Number(e.key) - 1];
                if (target) {
                    e.preventDefault();
                    openBot(dispatch, target, showThreads);
                }
            }
            else if (e.shiftKey && (e.key === "[" || e.key === "]")) {
                const idx = bots.findIndex((b) => b.id === state.selectedId);
                const next = bots[(idx + (e.key === "]" ? 1 : -1) + bots.length) % bots.length];
                if (next) {
                    e.preventDefault();
                    openBot(dispatch, next, showThreads);
                }
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [state.bots, state.selectedId, state.shortcutsOpen, showThreads, dispatch]);
    useEffect(() => {
    }, [unreadCount]);
    useEffect(() => preloadScreens(), []);
    useEffect(() => {
        setDrawerOpen(false);
    }, [state.selectedId, bot?.threadId, group?.threadId, state.activeView, state.pluginsOpen, state.settingsOpen]);
    useEffect(() => {
        if (state.activeView === "routines" && previousViewRef.current !== "routines") {
            calendarOriginRef.current = previousViewRef.current === "team-map" ? "team-map" : "chat";
        }
        previousViewRef.current = state.activeView;
    }, [state.activeView]);
    useEffect(() => {
        if (localVmWorkspaceBotId &&
            (state.activeView !== "chat" || state.selectedId !== localVmWorkspaceBotId)) {
            setLocalVmWorkspaceBotId(null);
        }
    }, [localVmWorkspaceBotId, state.activeView, state.selectedId]);
    const openLocalVmWorkspace = (botId: string) => {
        dispatch({ type: "toggleComputer", open: false });
        setLocalVmWorkspaceBotId(botId);
    };
    const openComputerFromWorkspace = (botId: string) => {
        setLocalVmWorkspaceBotId(null);
        dispatch({ type: "select", id: botId });
        dispatch({ type: "toggleComputer", open: true });
    };
    const closeCalendar = useCallback(() => {
        if (calendarOriginRef.current === "team-map") {
            dispatch({ type: "showTeamMap" });
            return;
        }
        dispatch({ type: "select", id: state.selectedId });
    }, [dispatch, state.selectedId]);
    const openCalendarRoom = useCallback((id: string) => {
        dispatch({ type: "select", id });
    }, [dispatch]);
    const nativeViewOverlayOpen = drawerOpen ||
        paletteOpen ||
        state.settingsOpen ||
        state.computerOpen ||
        state.inspectorOpen ||
        state.activityOpen ||
        state.appSettingsOpen ||
        state.pluginsOpen ||
        state.triggersOpen;
    useEffect(() => {
        return undefined;
    }, [dispatch]);
    useEffect(() => {
        return undefined;
    }, [dispatch]);
    return (<div className="flex h-full flex-col">
      {null}
      <div className="relative flex min-h-0 flex-1">
      {!calendarFocus && <button type="button" ref={menuButtonRef} aria-label="Open bot list" aria-expanded={drawerOpen} onClick={() => setDrawerOpen(true)} className="absolute left-3 top-3 z-30 rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink md:hidden">
        <Menu size={18}/>
      </button>}
      {drawerOpen && !calendarFocus && (<div aria-hidden onMouseDown={(e) => e.target === e.currentTarget && setDrawerOpen(false)} className="absolute inset-0 z-30 bg-black/50 md:hidden"/>)}
      {!calendarFocus && <Sidebar collapseToIcons={collapseSidebar} open={drawerOpen} onClose={() => {
                setDrawerOpen(false);
                menuButtonRef.current?.focus();
            }}/>}
      {state.activeView === "team-map" ? (<TeamMapPage />) : state.activeView === "routines" ? (<RoutinesPage onBack={closeCalendar} onOpenRoom={openCalendarRoom}/>) : localVmWorkspaceBotId ? (<LocalVmWorkspace primaryBotId={localVmWorkspaceBotId} overlayOpen={nativeViewOverlayOpen} onClose={() => setLocalVmWorkspaceBotId(null)} onOpenComputer={openComputerFromWorkspace}/>) : noEngines ? (<NoEngines />) : group ? (<GroupView key={group.id} group={group}/>) : bot ? (<ChatView bot={bot}/>) : (<main className="relative flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-3 bg-app text-ink-secondary">
          {null}
          <div className="w-full max-w-md"><ChatNotice notice={state.notice}/></div>
          <Loader2 size={20} className="animate-spin"/>
          <div className="text-[14px]">
            {state.connected ? "No bots yet" : "Connecting to the bot server…"}
          </div>
          {!state.connected && (<div className="text-[12px]">
              Start it with <code className="rounded bg-raised px-1.5 py-0.5">pnpm dev:server</code>
            </div>)}
        </main>)}
      {/* Sibling panels need distinct keys: two keyed `bot.id` collide in React's keyed reconciliation. */}
      {state.settingsOpen && bot && (<BotSettingsDialog key={`settings:${bot.id}`} bot={bot} overlay={(state.inspectorOpen || state.computerOpen || (notificationFeed && state.notificationsOpen)) && !twoSidePanelsFit}/>)}
      {state.computerOpen && bot && (<ComputerPanel key={`computer:${bot.id}`} bot={bot} onOpenVmWorkspace={openLocalVmWorkspace}/>)}
      {state.inspectorOpen && bot && <InspectorPanel key={bot.threadId} bot={bot}/>}
      {state.activityOpen && bot && <ActivityPanel key={`activity:${bot.id}`} bot={bot}/>}
      {notificationFeed && !calendarFocus && state.notificationsOpen && <NotificationsPanel />}
      {notificationFeed && !calendarFocus && <NotificationRail />}
      {state.appSettingsOpen && <SettingsModal />}
      {null}
      {null}
      {state.pluginsOpen && <PluginsPanel />}
      {state.triggersOpen && <TriggersPanel />}
      {state.newBotOpen && <NewBotDialog />}
      {state.shortcutsOpen && (<KeyboardShortcutsModal open={state.shortcutsOpen} onClose={() => dispatch({ type: "toggleShortcuts", open: false })}/>)}
      {/* After the modals: same z-50 tier, so DOM order keeps the palette on top. */}
      <CommandPalette onOpenChange={setPaletteOpen}/>
      {/* Blink resolves -webkit-app-region in DOM order, so this no-drag twin after the headers cuts the drawer button back out. */}
      {!calendarFocus && <span aria-hidden data-drawer-button-no-drag className="pointer-events-none absolute left-3 top-3 size-[30px] md:hidden"/>}
      </div>
      {/* Last child on purpose: Blink resolves -webkit-app-region in DOM order, so no-drag buttons must follow every drag region. */}</div>);
}
function Application() {
    const viewer = useWelcomeViewer();
    return (<DesktopCapabilitiesProvider>
      <StoreProvider>
        <ThreadRefsProvider>
          <Shell />
        </ThreadRefsProvider>
        <WelcomeGate viewer={viewer}/>
        <GuidedTour />
        <LiveCallHost />
        <FirstConversationTour quiet={spotlightsQuiet(viewer)}/>
      </StoreProvider>
    </DesktopCapabilitiesProvider>);
}
export default function App() {
    return <WorkspaceBackupRecovery><Application /></WorkspaceBackupRecovery>;
}
