import { useState } from "react";
import { browserUnavailableReason } from "@/lib/feature-flags";
import { FolderOpen } from "lucide-react";
import { useStore, type Bot } from "@/state/store";
import { useBotEditor } from "./BotEditorContext";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { McpServersPanel } from "../McpServersPanel";
import { placeFacts, placeViewFor, usePlaceSeat } from "@/lib/place-view";
import { shortPath } from "@/lib/short-path";
import { useDesktopCapabilities } from "../DesktopCapabilities";
import { Switch } from "../SettingsPrimitives";
import { ProposalStatus } from "./ProposalStatus";
import { ToolSelectionCard } from "./ToolSelectionCard";
import { inputCls } from "./field";
import type { useBotSettingsDerived } from "./useBotSettingsDerived";
/**
 * Claude keeps sessions per project folder, so the server pins each task's folder on its first turn. PATCHed directly,
 * not via updateBot: the server validates the path, and a rejected folder must not stick in local state.
 */
function WorkingFolder({ bot }: {
    bot: Bot;
}) {
    const { request: api } = useBotEditor();
    const { capabilities } = useDesktopCapabilities();
    const home = capabilities.host.homeDir;
    const [draft, setDraft] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const canPick = Boolean(undefined);
    const task = bot.tasks?.find((t) => t.threadId === bot.threadId);
    const pinned = task?.cwd;
    const pinnedElsewhere = pinned !== undefined && (pinned ?? undefined) !== bot.cwd;
    const save = async (cwd: string | null) => {
        setSaving(true);
        setError(null);
        try {
            await api(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ cwd }) });
            setDraft(null);
        }
        catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
        finally {
            setSaving(false);
        }
    };
    const pick = async () => {
        { }
    };
    return (<div className="rounded-xl bg-card p-4">
      <div className="text-[15px] font-medium text-ink">Working folder</div>
      <div className="mt-0.5 text-[13px] text-ink-secondary">Where this bot runs its shell and file tools.</div>
      <ProposalStatus bot={bot} kind="chief"/>
      {canPick ? (<div className="mt-3 flex items-center gap-2">
          <div className="min-w-0 flex-1 truncate rounded-lg border border-hairline/40 bg-inset px-3 py-2 font-mono text-[12.5px] text-ink" title={bot.cwd}>
            {bot.cwd ? shortPath(bot.cwd, home) : <span className="text-ink-secondary">Private bot folder</span>}
          </div>
          <button onClick={() => void pick()} disabled={saving} className="flex shrink-0 items-center gap-1.5 rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50">
            <FolderOpen size={14}/> Choose…
          </button>
          {bot.cwd && (<button onClick={() => void save(null)} disabled={saving} className="shrink-0 rounded-lg px-2 py-2 text-[13px] text-ink-secondary hover:text-ink disabled:opacity-50">
              Clear
            </button>)}
        </div>) : (<form className="mt-3 flex items-center gap-2" onSubmit={(e) => {
                e.preventDefault();
                void save((draft ?? bot.cwd ?? "").trim() || null);
            }}>
          <input className={cn(inputCls, "font-mono text-[12.5px]")} placeholder="Private bot folder — or an absolute path" value={draft ?? bot.cwd ?? ""} onChange={(e) => setDraft(e.target.value)}/>
          <button type="submit" disabled={saving || draft === null} className="shrink-0 rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50">
            Save
          </button>
        </form>)}
      {error && <div className="mt-2 text-[12px] text-danger">{error}</div>}
      {pinnedElsewhere && (<div className="mt-2 text-[12px] text-ink-secondary">
          New tasks start here. This task is pinned to {pinned ? <span className="font-mono">{shortPath(pinned, home)}</span> : "the home folder"} — start a new task to use the new folder.
        </div>)}
    </div>);
}
function RecordStepsRow({ on, browserOn, myChrome, onChange }: {
    on: boolean;
    browserOn: boolean;
    myChrome: boolean;
    onChange: (on: boolean) => void;
}) {
    return (<div className="mt-3 flex items-center justify-between gap-4 border-t border-hairline/40 pt-3">
      <div>
        <div className="text-[13.5px] font-medium text-ink">{t("botAccess.recordSteps.title")}</div>
        <div className="mt-0.5 text-[12.5px] text-ink-secondary">
          {!browserOn ? t("botAccess.recordSteps.needsBrowser") : on ? t("botAccess.recordSteps.on") : t("botAccess.recordSteps.off")}
          {browserOn && on && myChrome ? ` ${t("botAccess.recordSteps.myChrome")}` : ""}
        </div>
      </div>
      <Switch checked={on && browserOn} aria-label={t("botAccess.recordSteps.title")} disabled={!browserOn} onClick={() => onChange(!on)} className="disabled:cursor-not-allowed"/>
    </div>);
}
export function AccessSection({ bot, derived, }: {
    bot: Bot;
    derived: ReturnType<typeof useBotSettingsDerived>;
}) {
    const { draft } = useBotEditor();
    const { state, dispatch } = useStore();
    const { patch, canUseBrowser, desktopBrowser, browserBlockedOnWindows, browserFeature, browserAllowed, browserEnabled } = derived;
    const browserInstallable = state.config?.browserEngine?.installable === true;
    const { capabilities } = useDesktopCapabilities();
    const placeSeat = usePlaceSeat(state.config, capabilities.host?.platform ?? "other");
    const worksOn = placeViewFor(placeFacts({
        bot, place: bot.computer ?? "auto", seat: placeSeat, config: state.config, instances: state.instances,
    }));
    const webhooks = state.webhooks.filter((webhook) => webhook.botId === bot.id);
    const alwaysAllow = bot.alwaysAllow ?? [];
    return (<div className="flex flex-col gap-4">
      <div className="rounded-xl bg-card p-4" data-testid="access-works-on">
        <div className="text-[15px] font-medium text-ink">{t("access.worksOn", { name: bot.name, short: worksOn.short })}</div>
        <ProposalStatus bot={bot} kind="owner"/>
        <button type="button" onClick={() => {
            dispatch({ type: "toggleSettings", open: false });
            dispatch({ type: "toggleComputer", open: true });
        }} className="mt-3 rounded-lg bg-control px-3 py-1.5 text-[13px] text-ink hover:bg-raised-hover">
          {t("place.action.openComputerPanel")}
        </button>

      </div>

      <WorkingFolder bot={bot}/>

      <McpServersPanel />
      <ToolSelectionCard key={bot.id} bot={bot} engineKind={derived.engine?.driverKind}/>

      <div className="rounded-xl bg-card p-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-[15px] font-medium text-ink">Browser</div>
            <div className="mt-0.5 text-[13px] text-ink-secondary">
              {!desktopBrowser
            ? browserBlockedOnWindows && !browserInstallable
                ? "Not available on this Windows machine yet: install the browser engine with `openmausbot browser install`."
                : browserUnavailableReason(state.config)
            : !browserFeature
                ? "The built-in browser is switched off under App Settings → Computers."
                : !canUseBrowser
                    ? "This bot's current model cannot use the built-in browser."
                    : bot.computer === "off"
                        ? "Works on is set to Off, so this bot has no browser. Choose another place in the Computer panel to give it one."
                        : browserEnabled
                            ? "This bot has its own browser with its own logins."
                            : "Keep the built-in browser unavailable to this bot."}
            </div>
            <ProposalStatus bot={bot} kind="owner"/>
          </div>
          <Switch checked={browserEnabled && bot.computer !== "off"} aria-label="Give this bot a built-in browser" disabled={bot.computer === "off" ||
            (!browserEnabled && ((!desktopBrowser && !browserInstallable) || !browserFeature || !canUseBrowser))} onClick={() => patch({ browser: !browserAllowed })} title={bot.computer === "off" ? "Works on is set to Off, so this bot has no browser" : undefined} className="disabled:cursor-not-allowed"/>
        </div>
        {!draft && (<RecordStepsRow on={bot.recordBrowserSteps === true} browserOn={browserEnabled && bot.computer !== "off"} myChrome={state.config?.browserEngine?.myChrome === true && (state.config?.browserProfiles ?? []).some((profile) => profile.id === bot.browserProfile && profile.browser === "chrome")} onChange={(recordBrowserSteps) => patch({ recordBrowserSteps })}/>)}
      </div>

      {!draft && <div className="rounded-xl bg-card p-4">
        <div className="text-[15px] font-medium text-ink">Webhooks</div>
        <div className="mt-0.5 text-[13px] text-ink-secondary">Inbound triggers wired to this bot.</div>
        <ProposalStatus bot={bot} kind="owner"/>
        {webhooks.length === 0 ? (<div className="mt-3 rounded-lg bg-inset px-3 py-2 text-[12px] text-ink-secondary">No webhooks for this bot.</div>) : (<div className="mt-3 divide-y divide-hairline/40 overflow-hidden rounded-lg border border-hairline/40">
            {webhooks.map((webhook) => (<div key={webhook.id} className="flex items-center justify-between gap-3 px-3 py-2">
                <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{webhook.name}</span>
                <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium", webhook.enabled ? "bg-accent/15 text-accent-text" : "bg-control text-ink-secondary")}>
                  {webhook.enabled ? "Active" : "Paused"}
                </span>
                <span className="shrink-0 text-[11.5px] tabular-nums text-ink-secondary">
                  {webhook.deliveryCount} deliveries
                </span>
              </div>))}
          </div>)}
      </div>}

      {!draft && <div className="rounded-xl bg-card p-4">
        <div className="text-[15px] font-medium text-ink">Always allowed</div>
        <div className="mt-0.5 text-[13px] text-ink-secondary">Tools this bot no longer asks about.</div>
        <ProposalStatus bot={bot} kind="owner"/>
        {alwaysAllow.length === 0 ? (<div className="mt-3 rounded-lg bg-inset px-3 py-2 text-[12px] text-ink-secondary">Nothing standing yet.</div>) : (<div className="mt-3 divide-y divide-hairline/40 overflow-hidden rounded-lg border border-hairline/40">
            {alwaysAllow.map((entry) => (<div key={entry} className="flex items-center justify-between gap-3 px-3 py-2">
                <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-ink">{entry}</span>
                <button type="button" aria-label={`Remove ${entry} from always allowed`} onClick={() => patch({ alwaysAllow: alwaysAllow.filter((key) => key !== entry) })} className="shrink-0 rounded-md px-2 py-1 text-[12px] text-ink-secondary hover:bg-danger/10 hover:text-danger">
                  Remove
                </button>
              </div>))}
          </div>)}
      </div>}

    </div>);
}
