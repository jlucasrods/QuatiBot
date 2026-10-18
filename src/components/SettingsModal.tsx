import { useEffect, useRef, useState } from "react";
import { Archive, CircleUser, Coins, FlaskConical, LockKeyhole, Monitor, Palette, ScrollText, Search, Sparkles, TabletSmartphone, Terminal, User, X, Zap, BookOpen } from "lucide-react";
import { api, useStore, type AppSettingsSection, type ConfigStatus } from "@/state/store";
import { builtInBrowserEnabled, routinesInConversationEnabled, showToolCallsEnabled, skillAuthoringEnabled, skillsLibraryEnabled } from "@/lib/feature-flags";
import { localeChoices, type LocaleKey } from "@/locales";
import { t } from "@/lib/i18n";
import { withTourReset } from "@/lib/guided-tour";
import { completionPatch } from "@/lib/onboarding";
import { DecisionModelSettings } from "./DecisionModelSettings";
import { EnginesSettings } from "./EnginesSettings";
import { LocalComputerSection } from "./LocalComputerSection";
import { ActivitySection } from "./ActivitySection";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import { CustomDomainSettings } from "./CustomDomainSettings";
import { BrowserProfilesManager } from "./BrowserProfilesManager";
import { BuiltInBrowserRow, NewBrowserSettings } from "./BrowserSettingsRows";
import { LoginsSettings } from "./LoginsSettings";
import { Card, SettingRow, Switch } from "./SettingsPrimitives";
import { LearnedSkillsSettings } from "./ShareLearnedSkillsSettings";
import { effortLabel } from "./ModelPicker";
import { EFFORT_LEVELS, isEffortLevel } from "../../shared/wire";
import { shortcutLabel } from "./ShortcutHint";
import { UsageSection } from "./UsageSection";
import { SkillsSection } from "./SkillsSection";
import { SkinPicker } from "./SkinPicker";
import { ChatWidthRow, FontRow, SidebarToolsLayoutRow } from "./AppearanceSelectRows";
import { setColorUserBubbles, useColorUserBubbles } from "@/lib/user-bubble-preference";
import { RoomTurnTimeoutSettings } from "./RoomTurnTimeoutSettings";
import { McpCallTimeoutSettings } from "./McpCallTimeoutSettings";
import { AboutMeSettings } from "./AboutMeSettings";
import { ThreadConcurrencySettings } from "./ThreadConcurrencySettings";
import { AutomaticRecoverySettings } from "./AutomaticRecoverySettings";
import { ThreadCleanupSettings } from "./ThreadCleanupSettings";
import { DefaultBotSettings } from "./NewBotDialog";
import { WorkspaceBackupSettings } from "./WorkspaceBackupSettings";
import { cn } from "@/lib/cn";
import { glassPopupFrameStyle } from "@/lib/glass-popup";
import { NotificationRows } from "./NotificationSettingsRows";
import { setShowThreads, useShowThreadsChoice } from "@/lib/thread-preferences";
import { setAdvancedMode, useAdvancedMode } from "@/lib/interface-mode";
import { parseSidebarDensity, setPinnedCircles, setSidebarDensity, setUniversalPins, SIDEBAR_DENSITIES, usePinnedCircles, useSidebarDensity, useUniversalPins, type SidebarDensity } from "@/lib/sidebar-preferences";
import { setShowRunCard, useShowRunCard } from "@/lib/run-card-preferences";
import { parseSendKey, SEND_KEYS, sendKeyLabel, setSendKey, useSendKey } from "@/lib/send-key";
import { effectiveLanguage, setLanguageChoice, useLanguageChoice } from "@/lib/language-preference";
import { Select } from "./Select";
// labelKey, not a label: t() reads the active pack when called, so a label resolved at module scope would freeze the
// boot language.
export type SettingsGroup = "you" | "ai" | "computers" | "account";
export const SETTINGS_GROUPS: Array<{
    id: SettingsGroup;
    labelKey: LocaleKey;
}> = [
    { id: "you", labelKey: "settings.group.you" },
    { id: "ai", labelKey: "settings.group.ai" },
    { id: "computers", labelKey: "settings.group.computers" },
    { id: "account", labelKey: "settings.group.account" },
];
export const SECTIONS: Array<{
    id: AppSettingsSection;
    group: SettingsGroup;
    labelKey: LocaleKey;
    icon: typeof User;
    keywords: string[];
}> = [
    { id: "general", group: "you", labelKey: "settings.section.general", icon: User, keywords: ["profile", "name", "email", "about me", "about", "suggestions", "suggested", "memory", "effort", "new bots", "reasoning", "threads", "parallel", "concurrency", "cleanup", "retention", "event log", "event-log", "log size", "automatic recovery", "backup model", "fallback", "routines", "conversation", "schedule"] },
    { id: "appearance", group: "you", labelKey: "settings.section.appearance", icon: Palette, keywords: ["skin", "theme", "appearance", "chat width", "width", "wide", "full width", "bubble", "bubbles", "tools", "tool calls", "threads", "show threads", "hide threads", "sidebar", "density", "compact", "comfortable", "avatars", "display", "run", "this run", "run card", "commands", "notifications", "sound", "sounds", "mute", "silent", "chime", "pinned", "circles", "universal", "groups", "top", "send", "enter", "return", "shift+enter", "ctrl+enter", "cmd+enter", "⌘+enter", "new line", "keyboard", "ime", "japanese", "message color", "my messages", "toolbar", "tools layout", "footer", "routines", "triggers", "team map"] },
    { id: "remoteAccess", group: "you", labelKey: "settings.section.remoteAccess", icon: TabletSmartphone, keywords: ["device", "client", "host", "pair", "https", "secure", "tailscale", "wifi", "remote", "advanced", "domain", "dns", "self-hosted", "server", "caddy"] },
    { id: "engines", group: "ai", labelKey: "settings.section.engines", icon: Terminal, keywords: ["models", "model providers", "engines", "claude", "codex", "grok", "providers", "cli", "sign in", "subscription"] },
    { id: "decisionModel", group: "ai", labelKey: "settings.section.decisionModel", icon: Zap, keywords: ["decision", "jev", "typesafe", "routing", "auto", "rooms", "who answers"] },
    { id: "skills", group: "ai", labelKey: "settings.section.skills", icon: BookOpen, keywords: ["skills", "library", "assign", "agent skills", "skill md"] },
    { id: "computer", group: "computers", labelKey: "settings.section.computer", icon: Monitor, keywords: ["vm", "virtual", "desktop", "browser", "built-in browser", "profiles", "browser profiles"] },
    { id: "logins", group: "computers", labelKey: "settings.section.logins", icon: LockKeyhole, keywords: ["logins", "login", "passwords", "password", "sign in", "2fa", "one-time code", "totp", "fill_login", "1password", "vault"] },
    { id: "usage", group: "account", labelKey: "settings.section.usage", icon: Coins, keywords: ["tokens", "cost", "history", "model", "used"] },
    { id: "backups", group: "account", labelKey: "settings.section.backups", icon: Archive, keywords: ["export", "import", "restore", "full backup", "password", "recovery"] },
    { id: "activity", group: "account", labelKey: "settings.section.activity", icon: ScrollText, keywords: ["activity", "audit", "log", "history", "who changed", "approvals", "decisions", "admin"] },
    { id: "experimental", group: "account", labelKey: "settings.section.experimental", icon: FlaskConical, keywords: ["early", "preview", "learn", "skill", "authoring"] },
];
export type SimpleSettingsPage = {
    id: string;
    labelKey: LocaleKey;
    icon: typeof User;
    sections: AppSettingsSection[];
};
export const SIMPLE_PAGES: SimpleSettingsPage[] = [
    { id: "general", labelKey: "settings.section.general", icon: User, sections: ["general"] },
    { id: "appearance", labelKey: "settings.section.appearance", icon: Palette, sections: ["appearance"] },
    { id: "ai", labelKey: "settings.group.ai", icon: Sparkles, sections: ["engines", "decisionModel"] },
    { id: "computers", labelKey: "settings.group.computers", icon: Monitor, sections: ["remoteAccess", "computer", "logins"] },
    { id: "account", labelKey: "settings.group.account", icon: CircleUser, sections: ["people", "activity"] },
];
export const SIMPLE_HIDDEN_SECTIONS: readonly AppSettingsSection[] = ["usage", "backups", "experimental", "skills"];
export function simpleSettingsPages(available: ReadonlyArray<(typeof SECTIONS)[number]>, open: AppSettingsSection): SimpleSettingsPage[] {
    const allowed = new Set(available.map((entry) => entry.id));
    const pages = SIMPLE_PAGES
        .map((page) => ({ ...page, sections: page.sections.filter((id) => allowed.has(id)) }))
        .filter((page) => page.sections.length > 0);
    const hidden = SIMPLE_HIDDEN_SECTIONS.includes(open) ? available.find((entry) => entry.id === open) : undefined;
    if (hidden)
        pages.push({ id: hidden.id, labelKey: hidden.labelKey, icon: hidden.icon, sections: [hidden.id] });
    return pages;
}
export function revealSettingsBlock(scroller: {
    scrollTop: number;
    querySelector: (selector: string) => {
        scrollIntoView?: (options: ScrollIntoViewOptions) => void;
    } | null;
}, section: AppSettingsSection, indexInPage: number): void {
    if (indexInPage <= 0) {
        scroller.scrollTop = 0;
        return;
    }
    scroller.querySelector(`[data-settings-block="${section}"]`)?.scrollIntoView?.({ block: "start" });
}
function simplePageMatches(page: SimpleSettingsPage, query: string): boolean {
    if (!query)
        return true;
    if (t(page.labelKey).toLowerCase().includes(query))
        return true;
    return page.sections.some((id) => {
        const entry = SECTIONS.find((candidate) => candidate.id === id);
        return entry ? sectionMatches(entry, query) : false;
    });
}
export function sectionMatches(section: (typeof SECTIONS)[number], query: string): boolean {
    if (!query)
        return true;
    return [t(section.labelKey), ...section.keywords].some((part) => part.toLowerCase().includes(query));
}
function ProfileFields() {
    const { state, dispatch } = useStore();
    const [name, setName] = useState(state.config?.profile?.name ?? "");
    const [email, setEmail] = useState(state.config?.profile?.email ?? "");
    useEffect(() => {
        setName(state.config?.profile?.name ?? "");
        setEmail(state.config?.profile?.email ?? "");
    }, [state.config?.profile?.name, state.config?.profile?.email]);
    const save = () => {
        void fetch("/api/config", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ profile: { name: name.trim(), email: email.trim().toLowerCase() } }),
        })
            .then((r) => {
            if (!r.ok)
                throw new Error("Profile save failed");
            return r.json();
        })
            .then((config: ConfigStatus) => {
            if (config.profile)
                dispatch({ type: "profileSaved", profile: { name: config.profile.name, email: config.profile.email } });
        })
            .catch(() => { });
    };
    const inputClass = "w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[14px] text-ink placeholder:text-ink-secondary focus:outline-none";
    return (<div className="flex flex-col gap-3">
      <input aria-label={t("settings.profile.name")} value={name} onChange={(e) => setName(e.target.value)} onBlur={save} placeholder={t("settings.profile.name")} className={inputClass}/>
      <input type="email" aria-label={t("phone.signIn.email")} value={email} onChange={(e) => setEmail(e.target.value)} onBlur={save} placeholder="you@example.com" className={inputClass}/>
      <AboutMeSettings />
    </div>);
}
function NewBotEffortRow() {
    const { state, dispatch } = useStore();
    const current = state.config?.newBots?.effort ?? "";
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const save = async (value: string) => {
        if (saving)
            return;
        setSaving(true);
        setError("");
        try {
            const config: ConfigStatus = await api("/api/config", {
                method: "PATCH",
                body: JSON.stringify({ newBots: { effort: isEffortLevel(value) ? value : null } }),
            });
            dispatch({ type: "configStatus", config });
        }
        catch (cause) {
            setError(cause instanceof Error ? cause.message : t("settings.newBotEffort.error"));
        }
        finally {
            setSaving(false);
        }
    };
    return (<SettingRow title={t("settings.newBotEffort.title")} subtitle={t("settings.newBotEffort.subtitle")} message={error ? <p role="alert" className="text-danger">{error}</p> : null}>
      <Select size="sm" className="w-full max-w-[240px]" value={current} disabled={saving} aria-label={t("settings.newBotEffort.aria")} onChange={(event) => void save(event.target.value)}>
        <option value="">{t("settings.newBotEffort.default")}</option>
        {EFFORT_LEVELS.map((level) => (<option key={level} value={level}>
            {effortLabel(level)}
          </option>))}
      </Select>
    </SettingRow>);
}
function ReplayAppTourButton() {
    const { state, dispatch } = useStore();
    const [saving, setSaving] = useState(false);
    const [failed, setFailed] = useState(false);
    return (<div>
      <button disabled={saving} onClick={() => {
            setSaving(true);
            setFailed(false);
            void api("/api/config", {
                method: "PUT",
                body: JSON.stringify({ onboarding: {
                        ...(!state.config?.onboarding?.completedAt ? completionPatch().onboarding : {}),
                        hintsSeen: withTourReset(state.config?.onboarding),
                    } }),
                signal: AbortSignal.timeout(10000),
            })
                .then((config) => {
                dispatch({ type: "configStatus", config });
                dispatch({ type: "toggleTour", open: true });
            })
                .catch(() => setFailed(true))
                .finally(() => setSaving(false));
        }} className="ui-button">
        {t("settings.welcome.appTour")}
      </button>
      {failed && <p role="alert" className="mt-2 text-[13px] text-danger">{t("onboarding.tour.error")}</p>}
    </div>);
}
function ReplayTourRow() {
    const { dispatch } = useStore();
    return (<SettingRow title={t("settings.welcome.title")} subtitle={t("settings.welcome.subtitle")}>
      <div className="flex flex-wrap justify-end gap-2">
        <ReplayAppTourButton />
        <button onClick={() => dispatch({ type: "toggleWelcome", open: true })} className="ui-button">
          {t("settings.welcome.replay")}
        </button>
      </div>
    </SettingRow>);
}
function LanguageRow() {
    const { state } = useStore();
    const current = effectiveLanguage(useLanguageChoice(), state.config?.language);
    return (<SettingRow title={t("settings.language.title")} subtitle={t("settings.language.subtitle")}>
      <Select size="sm" className="w-full max-w-[240px]" value={current} aria-label={t("settings.language.aria")} onChange={(event) => setLanguageChoice(event.target.value)}>
        <option value="">{t("settings.language.system")}</option>
        {localeChoices.map(({ code, label }) => (<option key={code} value={code}>
            {label}
          </option>))}
      </Select>
    </SettingRow>);
}
function SendKeyRow() {
    const sendKey = useSendKey();
    return (<SettingRow title={t("settings.sendKey.title")} subtitle={t("settings.sendKey.subtitle", { key: sendKeyLabel("mod-enter") })}>
      <Select size="sm" className="w-full max-w-[240px]" value={sendKey} aria-label={t("settings.sendKey.title")} onChange={(event) => setSendKey(parseSendKey(event.target.value))}>
        {SEND_KEYS.map((mode) => (<option key={mode} value={mode}>{sendKeyLabel(mode)}</option>))}
      </Select>
    </SettingRow>);
}
function ColorUserBubblesRow() {
    const enabled = useColorUserBubbles();
    return (<SettingRow title={t("settings.userBubbles.title")} subtitle={t("settings.userBubbles.subtitle")}>
      <Switch checked={enabled} aria-label={t("settings.userBubbles.aria")} onClick={() => setColorUserBubbles(!enabled)}/>
    </SettingRow>);
}
function AdvancedModeRow() {
    const enabled = useAdvancedMode();
    return (<SettingRow className="rounded-2xl border border-accent-border/40 bg-raised-hover/40 py-4" title={t("settings.advancedMode.title")} subtitle={t("settings.advancedMode.subtitle")}>
      <Switch checked={enabled} aria-label={t("settings.advancedMode.title")} onClick={() => setAdvancedMode(!enabled)}/>
    </SettingRow>);
}
function ShowThreadsRow() {
    const enabled = useShowThreadsChoice();
    return (<SettingRow title={t("settings.threadDisplay.title")} subtitle={t("settings.threadDisplay.subtitle")}>
      <Switch checked={enabled} aria-label={t("settings.threadDisplay.show")} onClick={() => setShowThreads(!enabled)}/>
    </SettingRow>);
}
function PinnedCirclesRow() {
    const enabled = usePinnedCircles();
    return (<SettingRow title={t("settings.pinnedCircles.title")} subtitle={t("settings.pinnedCircles.subtitle")}>
      <Switch checked={enabled} aria-label={t("settings.pinnedCircles.title")} onClick={() => setPinnedCircles(!enabled)}/>
    </SettingRow>);
}
const SIDEBAR_DENSITY_LABEL_KEYS: Record<SidebarDensity, LocaleKey> = {
    comfortable: "sidebar.density.comfortable",
    compact: "sidebar.density.compact",
    icons: "sidebar.density.iconsOnly",
};
function SidebarDensityRow() {
    const density = useSidebarDensity();
    return (<SettingRow title={t("sidebar.density.title")} subtitle={t("settings.sidebarDensity.subtitle")}>
      <Select size="sm" className="w-full max-w-[240px]" value={density} aria-label={t("sidebar.density.chooseAria")} onChange={(event) => setSidebarDensity(parseSidebarDensity(event.target.value))}>
        {SIDEBAR_DENSITIES.map((option) => (<option key={option} value={option}>{t(SIDEBAR_DENSITY_LABEL_KEYS[option])}</option>))}
      </Select>
    </SettingRow>);
}
function RunCardRow() {
    const enabled = useShowRunCard();
    return (<SettingRow title={t("settings.runCard.title")} subtitle={t("settings.runCard.subtitle")}>
      <Switch checked={enabled} aria-label={t("settings.runCard.show")} onClick={() => setShowRunCard(!enabled)}/>
    </SettingRow>);
}
function UniversalPinsRow() {
    const enabled = useUniversalPins();
    return (<SettingRow title={t("settings.universalPins.title")} subtitle={t("settings.universalPins.subtitle")}>
      <Switch checked={enabled} aria-label={t("settings.universalPins.title")} onClick={() => setUniversalPins(!enabled)}/>
    </SettingRow>);
}
function RoutinesInConversationRow() {
    const { state, dispatch } = useStore();
    const enabled = routinesInConversationEnabled(state.config);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const toggle = async () => {
        if (saving)
            return;
        setSaving(true);
        setError("");
        try {
            const config: ConfigStatus = await api("/api/config", {
                method: "PATCH",
                body: JSON.stringify({ features: { routinesInConversation: !enabled } }),
            });
            dispatch({ type: "configStatus", config });
        }
        catch (cause) {
            setError(cause instanceof Error ? cause.message : t("settings.routinesInConversation.error"));
        }
        finally {
            setSaving(false);
        }
    };
    return (<SettingRow title={t("settings.routinesInConversation.title")} subtitle={t("settings.routinesInConversation.subtitle")} message={error ? <p role="alert" className="text-danger">{error}</p> : null}>
      <Switch checked={enabled} aria-label={t("settings.routinesInConversation.aria")} disabled={saving} onClick={() => void toggle()} className="disabled:cursor-wait disabled:opacity-50"/>
    </SettingRow>);
}
function ToolCallsRow() {
    const { state, dispatch } = useStore();
    const enabled = showToolCallsEnabled(state.config);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const toggle = async () => {
        if (saving)
            return;
        setSaving(true);
        setError("");
        try {
            const config: ConfigStatus = await api("/api/config", {
                method: "PATCH",
                body: JSON.stringify({ features: { showToolCalls: !enabled } }),
            });
            dispatch({ type: "configStatus", config });
        }
        catch (cause) {
            setError(cause instanceof Error ? cause.message : t("settings.toolCalls.error"));
        }
        finally {
            setSaving(false);
        }
    };
    return (<SettingRow title={t("settings.toolCalls.title")} subtitle={<>{t("settings.toolCalls.subtitle")} {t("settings.toolCalls.detail")}</>} message={error ? <p role="alert" className="text-danger">{error}</p> : null}>
      <Switch checked={enabled} aria-label={t("settings.toolCalls.aria")} disabled={saving} onClick={() => void toggle()} className="disabled:cursor-wait disabled:opacity-50"/>
    </SettingRow>);
}
function ExperimentalFeaturesRow() {
    const { state, dispatch } = useStore();
    const skillAuthoring = skillAuthoringEnabled(state.config);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const toggle = async (next: boolean) => {
        if (saving)
            return;
        setSaving(true);
        setError("");
        try {
            const config: ConfigStatus = await api("/api/config", {
                method: "PATCH",
                body: JSON.stringify({ features: { skillAuthoring: next } }),
            });
            dispatch({ type: "configStatus", config });
        }
        catch (cause) {
            setError(cause instanceof Error ? cause.message : t("settings.experimental.error"));
        }
        finally {
            setSaving(false);
        }
    };
    return (<Card title={t("settings.experimental.title")} subtitle={t("settings.experimental.subtitle")}>
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-[14px] font-medium text-ink">{t("settings.experimental.skillAuthoring")}</div>
          <div className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">
            {t("settings.experimental.skillAuthoringDetail")}
          </div>
        </div>
        <Switch checked={skillAuthoring} aria-label={t("settings.experimental.skillAuthoringAria")} disabled={saving} onClick={() => void toggle(!skillAuthoring)} className="disabled:cursor-wait disabled:opacity-50"/>
      </div>
      {error ? <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p> : null}
      <LearnedSkillsSettings />
      <NewBrowserSettings />
    </Card>);
}
function BrowserProfilesRow() {
    const { state } = useStore();
    const profiles = state.config?.browserProfiles ?? [];
    if (!builtInBrowserEnabled(state.config) && profiles.length === 0)
        return null;
    return (<Card title={t("settings.profiles.title")} subtitle={t("settings.profiles.sharedSubtitle")}>
      <BrowserProfilesManager />
    </Card>);
}
/** Security: the report never holds credential values; the desktop shell does not read secret fields. */
function DiagnosticsRow() {
    const [exporting] = useState(false);
    const [result] = useState<{
        kind: "success" | "error";
        message: string;
    } | null>(null);
    const exportDiagnostics = async () => {
        return;
    };
    return (<SettingRow title={t("settings.diagnostics.title")} subtitle={t("settings.diagnostics.subtitle")} message={result ? (<p role={result.kind === "error" ? "alert" : "status"} className={cn("break-all", result.kind === "error" ? "text-danger" : "text-success")}>
          {result.message}
        </p>) : null}>
      <button onClick={() => void exportDiagnostics()} disabled={exporting} aria-label={t("settings.diagnostics.aria")} className="ui-button">
        {exporting ? t("settings.diagnostics.exporting") : t("settings.diagnostics.export")}
      </button>
    </SettingRow>);
}
export function SettingsModal() {
    const { state, dispatch } = useStore();
    const advanced = useAdvancedMode();
    const section: AppSettingsSection = state.appSettingsSection === "remote"
        ? "remoteAccess"
        : state.appSettingsSection === "connections" ? "engines" : state.appSettingsSection;
    const dialogRef = useRef<HTMLDivElement>(null);
    const scrollRef = useRef<HTMLDivElement>(null);
    const [query, setQuery] = useState("");
    useEffect(() => undefined, []);
    useEffect(() => undefined, []);
    const q = query.trim().toLowerCase();
    const ownerOrAdmin = useOwnerOrAdmin();
    const baseSections = SECTIONS.filter((_entry) => true)
        .filter((entry) => entry.id !== "people" || true)
        .filter((entry) => entry.id !== "activity" || (ownerOrAdmin === true));
    const availableSections = baseSections.filter((entry) => entry.id !== "skills" || skillsLibraryEnabled(state.config));
    const visibleSections = availableSections.filter((entry) => sectionMatches(entry, q));
    const simplePages = advanced ? [] : simpleSettingsPages(availableSections, section);
    const visiblePages = simplePages.filter((page) => simplePageMatches(page, q));
    const currentPage = simplePages.find((page) => page.sections.includes(section));
    const sectionLabelKey = advanced
        ? SECTIONS.find((entry) => entry.id === section)?.labelKey
        : currentPage?.labelKey;
    const nextVisibleSection = advanced
        ? visibleSections.some((entry) => entry.id === section) ? undefined : visibleSections[0]?.id
        : currentPage && visiblePages.includes(currentPage)
            ? undefined
            : visiblePages[0] && (visiblePages[0].sections.find((id) => visibleSections.some((entry) => entry.id === id)) ?? visiblePages[0].sections[0]);
    useEffect(() => {
        if (nextVisibleSection)
            dispatch({ type: "toggleAppSettings", open: true, section: nextVisibleSection });
    }, [dispatch, nextVisibleSection]);
    const sectionIndex = currentPage?.sections.indexOf(section) ?? 0;
    useEffect(() => {
        if (scrollRef.current)
            revealSettingsBlock(scrollRef.current, section, advanced ? 0 : sectionIndex);
    }, [advanced, section, sectionIndex]);
    useEffect(() => {
        const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        const dialog = dialogRef.current;
        const search = dialog?.querySelector<HTMLInputElement>("[data-settings-search]");
        if (search?.checkVisibility())
            search.focus();
        else
            dialog?.focus();
        const onKey = (event: KeyboardEvent) => {
            // A child editor owns Escape and its focus trap, including while saving.
            if (event.defaultPrevented || (dialog && [...dialog.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]')]
                .some(child => child.getClientRects().length)))
                return;
            if (event.key === "Escape") {
                event.preventDefault();
                dispatch({ type: "toggleAppSettings", open: false });
                return;
            }
            if (event.key !== "Tab" || !dialog)
                return;
            const focusable = Array.from(dialog.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])')).filter((element) => element.checkVisibility());
            if (focusable.length === 0) {
                event.preventDefault();
                dialog.focus();
                return;
            }
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            const active = document.activeElement;
            if (event.shiftKey && (active === first || !dialog.contains(active))) {
                event.preventDefault();
                last.focus();
            }
            else if (!event.shiftKey && active === last) {
                event.preventDefault();
                first.focus();
            }
        };
        window.addEventListener("keydown", onKey);
        return () => {
            window.removeEventListener("keydown", onKey);
            previousFocus?.focus();
        };
    }, [dispatch]);
    const openSection = (id: AppSettingsSection) => dispatch({ type: "toggleAppSettings", open: true, section: id });
    const renderSection = (id: AppSettingsSection) => {
        switch (id) {
            case "general":
                return (<>
            <AdvancedModeRow /><Card title={t("settings.profile.title")} subtitle={t("settings.profile.sharedSubtitle")}>
              <ProfileFields />
            </Card>

            <LanguageRow />
            <NewBotEffortRow />

            <DefaultBotSettings />

            <Card title={t("settings.roomTurns.title")} subtitle={t("settings.roomTurns.subtitle")}>
              <RoomTurnTimeoutSettings />
            </Card>

            <Card title={t("settings.mcpCalls.title")} subtitle={t("settings.mcpCalls.subtitle")}>
              <McpCallTimeoutSettings />
            </Card>
            <ThreadConcurrencySettings />

            {<RoutinesInConversationRow />}

            <AutomaticRecoverySettings />
            <ThreadCleanupSettings />

            {<ReplayTourRow />}
            <DiagnosticsRow />
          </>);
            case "appearance":
                return (<>
            <Card title={t("settings.skin.title")} subtitle={t("settings.skin.subtitle")}>
              <SkinPicker />
            </Card>

            <FontRow />
            <ChatWidthRow />
            <ColorUserBubblesRow />
            <SendKeyRow />
            <SidebarDensityRow />
            {advanced && <SidebarToolsLayoutRow />}
            {advanced && <ShowThreadsRow />}
            <PinnedCirclesRow />
            <UniversalPinsRow />
            <NotificationRows />
            {<ToolCallsRow />}
            <RunCardRow />
          </>);
            case "experimental":
                return <ExperimentalFeaturesRow />;
            case "decisionModel":
                return <DecisionModelSettings />;
            case "engines":
                return <EnginesSettings />;
            case "backups":
                return <><WorkspaceBackupSettings /></>;
            case "remoteAccess":
                return <>{<CustomDomainSettings />}</>;
            case "computer":
                return advanced
                    ? <><BuiltInBrowserRow /><BrowserProfilesRow /><LocalComputerSection /></>
                    : <LocalComputerSection />;
            case "logins":
                return <LoginsSettings />;
            case "usage":
                return <UsageSection />;
            case "skills":
                return skillsLibraryEnabled(state.config) ? <SkillsSection /> : null;
            case "activity":
                return <ActivitySection />;
            default:
                return null;
        }
    };
    const blockHeading = (labelKey: LocaleKey) => (<h3 className="px-4 text-[13px] font-semibold uppercase tracking-[0.06em] text-ink-secondary">{t(labelKey)}</h3>);
    return (<div className="glass-popup-frame" style={glassPopupFrameStyle()} onMouseDown={(e) => e.target === e.currentTarget && dispatch({ type: "toggleAppSettings", open: false })}>
      {/* A sibling, not the parent: a backdrop-filter on an ancestor would stop the pop-up's own glass from seeing the app behind it. */}
      <div aria-hidden="true" className="glass-scrim pointer-events-none absolute inset-0"/>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="app-settings-title" tabIndex={-1} className="glass-surface glass-popup animate-pop-in relative flex overflow-hidden rounded-[24px] outline-none">
        <span id="app-settings-title" className="sr-only">{t("settings.title")}</span>
        <nav className="glass-rail hidden min-h-0 w-[200px] shrink-0 flex-col gap-1 overflow-y-auto border-r border-hairline/30 p-3 sm:flex">
          <div className="shrink-0 px-2 py-3 text-[15px] font-semibold text-ink">
            {t("settings.title")}
          </div>
          <div className="mb-2 mt-1 flex min-h-8 shrink-0 items-center gap-2 rounded-lg border border-transparent bg-control/70 px-2.5 py-2 focus-within:border-focus">
            <Search size={14} className="shrink-0 text-ink-secondary"/>
            <input data-settings-search value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => {
            if (e.key !== "Escape")
                return;
            e.stopPropagation();
            if (query)
                setQuery("");
            else
                dispatch({ type: "toggleAppSettings", open: false });
        }} placeholder={t("settings.search")} aria-label={t("settings.searchAria")} className="w-full bg-transparent text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none"/>
          </div>
          {(advanced ? visibleSections.length === 0 : visiblePages.length === 0) && (<div className="px-2.5 py-4 text-[12.5px] leading-relaxed text-ink-secondary">
              {t("settings.noMatch", { query: query.trim() })}
            </div>)}
          {advanced ? SETTINGS_GROUPS.map((group) => {
            const entries = visibleSections.filter((entry) => entry.group === group.id);
            if (entries.length === 0)
                return null;
            return (<div key={group.id} role="group" aria-labelledby={`settings-group-${group.id}`} data-settings-group={group.id} className="flex flex-col gap-0.5 pb-2">
                <div id={`settings-group-${group.id}`} className="px-2.5 pb-1 pt-2 text-[11px] font-medium uppercase tracking-[0.08em] text-ink-tertiary">
                  {t(group.labelKey)}
                </div>
                {entries.map(({ id, labelKey, icon: Icon }) => (<button key={id} data-settings-section={id} onClick={() => openSection(id)} aria-current={section === id ? "page" : undefined} className={cn("cursor-pointer flex min-h-9 items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] transition-colors motion-reduce:transition-none", section === id ? "bg-control text-ink" : "text-ink-secondary hover:bg-control/50 hover:text-ink")}>
                    <Icon size={15} className="shrink-0"/>
                    {t(labelKey)}
                  </button>))}
              </div>);
        }) : (<div className="flex flex-col gap-0.5 pb-2">
              {visiblePages.map((page) => {
                const Icon = page.icon;
                const current = page === currentPage;
                return (<button key={page.id} data-settings-page={page.id} onClick={() => openSection(page.sections[0]!)} aria-current={current ? "page" : undefined} className={cn("cursor-pointer flex min-h-9 items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] transition-colors motion-reduce:transition-none", current ? "bg-control text-ink" : "text-ink-secondary hover:bg-control/50 hover:text-ink")}>
                    <Icon size={15} className="shrink-0"/>
                    {t(page.labelKey)}
                  </button>);
            })}
            </div>)}
        </nav>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-hairline/30 px-3 py-3 sm:pl-9">
            {advanced ? (<Select className="min-w-0 sm:hidden" aria-label={t("settings.title")} value={section} onChange={(event) => {
                setQuery("");
                openSection(event.target.value as AppSettingsSection);
            }}>
                {SETTINGS_GROUPS.map((group) => {
                const entries = availableSections.filter((entry) => entry.group === group.id);
                return entries.length === 0 ? null : (<optgroup key={group.id} label={t(group.labelKey)}>
                      {entries.map(({ id, labelKey }) => (<option key={id} value={id}>{t(labelKey)}</option>))}
                    </optgroup>);
            })}
              </Select>) : (<Select className="min-w-0 sm:hidden" aria-label={t("settings.title")} value={currentPage?.id ?? ""} onChange={(event) => {
                setQuery("");
                const page = simplePages.find((candidate) => candidate.id === event.target.value);
                if (page)
                    openSection(page.sections[0]!);
            }}>
                {simplePages.map((page) => (<option key={page.id} value={page.id}>{t(page.labelKey)}</option>))}
              </Select>)}
            <span className="hidden text-[15px] font-semibold text-ink sm:block">
              {sectionLabelKey ? t(sectionLabelKey) : null}
            </span>
            <button onClick={() => dispatch({ type: "toggleAppSettings", open: false })} aria-label={t("settings.close")} title={`${t("settings.close")} (${shortcutLabel("close-panel")})`} className="ui-icon-button cursor-pointer shrink-0">
              <X size={18}/>
            </button>
          </div>

          <div ref={scrollRef} className="flex flex-1 flex-col gap-4 overflow-y-auto px-3 py-4 sm:px-5 sm:pb-5">
            {advanced ? (renderSection(section)) : currentPage ? (currentPage.sections.map((id) => {
            const stacked = currentPage.sections.length > 1;
            const labelKey = SECTIONS.find((entry) => entry.id === id)?.labelKey;
            return (<section key={id} data-settings-block={id} className="flex scroll-mt-2 flex-col gap-4">
                    {stacked && labelKey ? blockHeading(labelKey) : null}
                    {renderSection(id)}
                    {id === "computer" && (<div data-settings-block="browser" className="flex flex-col gap-4 pt-2">
                        {blockHeading("settings.experimental.browser")}
                        <BuiltInBrowserRow />
                        <BrowserProfilesRow />
                      </div>)}
                  </section>);
        })) : null}
          </div>
        </div>
      </div>
    </div>);
}
