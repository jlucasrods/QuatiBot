import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { useStore } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { McpServersPanel } from "./McpServersPanel";
export interface ToolkitCard {
    slug: string;
    label: string;
    blurb: string;
    logo: string | null;
    noAuth?: boolean;
    domain: string | null;
    categories?: string[];
}
export function ServiceIcon({ card, className = "size-11" }: {
    card: Pick<ToolkitCard, "logo" | "domain" | "label">;
    className?: string;
}) {
    const [stage, setStage] = useState(card.logo ? 0 : card.domain ? 1 : 2);
    if (stage === 0 && card.logo) {
        return (<img src={card.logo} alt="" loading="lazy" className={cn("rounded-xl object-contain", className)} onError={() => setStage(1)}/>);
    }
    if (stage === 1 && card.domain) {
        return (<img src={`https://www.google.com/s2/favicons?domain=${card.domain}&sz=64`} alt="" loading="lazy" className={cn("rounded-xl object-contain", className)} onError={() => setStage(2)}/>);
    }
    return (<div className={cn("flex items-center justify-center rounded-xl bg-raised text-[15px] font-semibold text-ink-secondary", className)}>
      {card.label.slice(0, 1).toUpperCase()}
    </div>);
}
export function PluginsPanel() {
    const { dispatch } = useStore();
    const dialogRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        const dialog = dialogRef.current;
        const focusable = () => Array.from(dialog?.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? []).filter((element) => element.getClientRects().length > 0);
        const controls = focusable();
        (controls.find((element) => element.matches("input")) ?? controls[0] ?? dialog)?.focus();
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                event.preventDefault();
                dispatch({ type: "togglePlugins", open: false });
                return;
            }
            if (event.key !== "Tab" || !dialog)
                return;
            const items = focusable();
            if (items.length === 0) {
                event.preventDefault();
                dialog.focus();
                return;
            }
            const first = items[0];
            const last = items.at(-1)!;
            if (!items.some((element) => element === document.activeElement)) {
                event.preventDefault();
                (event.shiftKey ? last : first).focus();
            }
            else if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            }
            else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        };
        window.addEventListener("keydown", onKeyDown);
        return () => {
            window.removeEventListener("keydown", onKeyDown);
            returnFocus?.focus();
        };
    }, [dispatch]);
    return (<div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div aria-hidden="true" className="glass-scrim pointer-events-none absolute inset-0"/>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="plugins-title" tabIndex={-1} className="glass-surface relative flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-hairline/40">
        <div className="flex items-center justify-between border-b border-hairline/40 px-5 py-4">
          <h2 id="plugins-title" className="text-[17px] font-semibold text-ink">Extensões</h2>
          <button type="button" aria-label={t("connectors.closeAria")} onClick={() => dispatch({ type: "togglePlugins", open: false })} className="rounded-lg p-2 text-ink-secondary hover:bg-control"><X size={18}/></button>
        </div>
        <div className="space-y-5 overflow-y-auto p-5">
        <McpServersPanel />
        </div>
      </div>
    </div>);
}
