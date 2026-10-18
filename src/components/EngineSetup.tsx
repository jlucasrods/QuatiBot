import { useState } from "react";
import { Check, Copy, ExternalLink, TerminalSquare } from "lucide-react";
import { type EngineInstall, type InstanceInfo } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { copyText } from "@/lib/copy-text";
import { RefreshEngines } from "./EngineLibrary";
export function installCommandFor(install: EngineInstall | undefined): string | null {
    const platform = install?.platform ?? undefined;
    return platform === "darwin" || platform === "win32" || platform === "linux" ? install?.command?.[platform] ?? null : null;
}
export function needsSignIn(instance: InstanceInfo | undefined): boolean {
    return instance?.snapshot.state === "available" && instance.snapshot.authenticated === false;
}
export function offersSignIn(instance: InstanceInfo | undefined): boolean {
    return Boolean(instance?.driverKind === "opencodeGo" && needsSignIn(instance));
}
export function needsCli(instance: InstanceInfo | undefined): boolean {
    return instance?.snapshot.state !== "available";
}
export function CommandRow({ command, actionLabel, compact = false, allowTerminal = true }: {
    command: string;
    actionLabel: string;
    compact?: boolean;
    allowTerminal?: boolean;
}) {
    const [copied, setCopied] = useState(false);
    const canOpen = allowTerminal && false;
    const copy = async () => {
        setCopied(await copyText(command) === "copied");
    };
    return (<div className={cn("mt-3 flex min-w-0 items-center gap-2 rounded-lg border border-hairline/50 bg-app p-2", compact && "text-xs")}>
      <code className="min-w-0 flex-1 truncate font-mono text-ink-secondary" title={command}>{command}</code>
      <button type="button" onClick={() => void copy()} aria-label={t("engineSetup.copyCommand")} className="rounded p-1 text-ink-secondary hover:bg-control">
        {copied ? <Check size={14}/> : <Copy size={14}/>}
      </button>
      {canOpen && <button type="button" onClick={() => void undefined} aria-label={actionLabel} className="rounded p-1 text-ink-secondary hover:bg-control"><TerminalSquare size={14}/></button>}
    </div>);
}
export function EngineUpdateNotice({ update, className }: {
    update: NonNullable<InstanceInfo["snapshot"]["update"]>;
    instance?: InstanceInfo;
    className?: string;
    quiet?: boolean;
}) {
    return <div className={className}><p>{update.title}</p><p>{update.message}</p><CommandRow command={update.command} actionLabel={t("engineSetup.openUpdate")} compact/></div>;
}
export function EngineSetup({ instance, className, unframed = false, description }: {
    instance: InstanceInfo;
    className?: string;
    intent?: "cloud" | "inject";
    unframed?: boolean;
    description?: string;
}) {
      return (<div className={cn(!unframed && "rounded-xl border border-hairline/40 bg-control/30 p-3", className)}>
      <div className="text-sm font-semibold text-ink">OpenCode V2</div>
      <p className="mt-1 text-xs leading-relaxed text-ink-secondary">
        {description ?? "Install OpenCode V2 and configure providers on the computer running QuatiBot. Models and credentials are managed by OpenCode, not here."}
      </p>
      {instance.snapshot.reason && <p role="alert" className="mt-2 text-xs text-danger">{instance.snapshot.reason}</p>}
      <CommandRow command="opencode auth login" actionLabel={t("engineSetup.openSignIn")} allowTerminal={true}/>
      <div className="mt-3"><RefreshEngines /></div>
      <a href="https://opencode.ai/v2/docs/" target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-xs text-accent hover:underline"><ExternalLink size={12}/>{t("engineSetup.viewGuide")}</a>
    </div>);
}
