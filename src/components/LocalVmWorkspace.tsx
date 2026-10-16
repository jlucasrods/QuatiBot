import { useEffect, useState } from "react";
import { Monitor, X } from "lucide-react";
import { api, useStore, type Bot } from "@/state/store";
import { initialLocalVmWorkspaceSlots, reconcileLocalVmWorkspaceSlots, selectLocalVmWorkspaceSlot, readyLocalVmViewerUrl, type LocalVmWorkspaceSlots } from "@/lib/local-vm-workspace";
import { Select } from "./Select";
function VmPane({ bot, bots, onSelect, onOpenComputer }: {
    bot: Bot | undefined;
    bots: Bot[];
    onSelect(id: string | null): void;
    onOpenComputer(id: string): void;
}) {
    const [viewer, setViewer] = useState<string | null>(null);
    const [error, setError] = useState("");
    useEffect(() => {
        const controller = new AbortController();
        setViewer(null);
        setError("");
        if (!bot)
            return;
        const refresh = async () => {
            try {
                const status = await api(`/api/bots/${bot.id}/local-computer`, { signal: controller.signal });
                if (controller.signal.aborted)
                    return;
                const url = readyLocalVmViewerUrl(status);
                if (!url) {
                    setViewer(null);
                    setError("Start this bot's isolated VM from its Computer panel.");
                    return;
                }
                const target = new URL(url, location.origin);
                const params = new URLSearchParams(target.hash.slice(1));
                params.set("readonly", "1");
                target.hash = params.toString();
                setViewer(`${target.pathname}${target.search}${target.hash}`);
                setError("");
            }
            catch {
                if (!controller.signal.aborted)
                    setError("The VM viewer is unavailable.");
            }
        };
        void refresh();
        const timer = setInterval(() => void refresh(), 5000);
        return () => { controller.abort(); clearInterval(timer); };
    }, [bot?.id]);
    return <section className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-hairline bg-inset">
    <header className="flex items-center gap-2 border-b border-hairline p-3">
      <Select value={bot?.id ?? ""} aria-label="VM bot" onChange={event => onSelect(event.target.value || null)}>
        <option value="">Select a bot</option>
        {bots.map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
      </Select>
      {bot && <button className="ui-button" onClick={() => onOpenComputer(bot.id)}>Open computer</button>}
    </header>
    {viewer ? <iframe title={`${bot?.name ?? "Bot"} isolated VM`} src={viewer} className="min-h-0 w-full flex-1 border-0"/>
            : <p role="status" className="p-4 text-sm text-ink-secondary">{error || "Select a bot with an isolated VM."}</p>}
  </section>;
}
export function LocalVmWorkspace({ primaryBotId, overlayOpen, onClose, onOpenComputer }: {
    primaryBotId: string;
    overlayOpen: boolean;
    onClose(): void;
    onOpenComputer(botId: string): void;
}) {
    const { state } = useStore();
    const bots = state.bots.filter(bot => bot.computer === "vm" && !bot.hidden);
    const [slots, setSlots] = useState<LocalVmWorkspaceSlots>(() => initialLocalVmWorkspaceSlots(bots, primaryBotId));
    useEffect(() => {
        setSlots(current => reconcileLocalVmWorkspaceSlots(current, bots));
    }, [state.bots]);
    return <main className="flex h-full min-w-0 flex-1 flex-col bg-app">
    <header className="flex items-center gap-3 border-b border-hairline px-5 py-3">
      <Monitor size={18}/>
      <div className="flex-1"><h1 className="font-semibold">Isolated VMs</h1><p className="text-xs text-ink-secondary">Watch-only. Open a computer to take control of that VM.</p></div>
      <button aria-label="Close VM view" className="ui-button" onClick={onClose}><X size={18}/></button>
    </header>
    <div className="grid min-h-0 flex-1 grid-cols-2 gap-3 p-3" inert={overlayOpen}>
      {([0, 1] as const).map(index => <VmPane key={index} bot={bots.find(bot => bot.id === slots[index])} bots={bots} onSelect={id => setSlots(current => selectLocalVmWorkspaceSlot(current, index, id))} onOpenComputer={onOpenComputer}/>)}
    </div>
  </main>;
}
