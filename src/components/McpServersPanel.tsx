import { useEffect, useState } from "react";
import { BookOpen, Box, Paperclip, RefreshCw } from "lucide-react";
import type { OpenCodeExtensions } from "../../shared/opencode-mcp";
import { api } from "@/state/store";
import { Switch } from "./SettingsPrimitives";

const TABS = [{ id: "servers", label: "MCP" }, { id: "plugins", label: "Plugins" }, { id: "skills", label: "Habilidades" }] as const;

export function McpServersPanel() {
  const [extensions, setExtensions] = useState<OpenCodeExtensions | null>(null);
  const [tab, setTab] = useState<(typeof TABS)[number]["id"]>("servers");
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setExtensions(null);
    setError(null);
    api<OpenCodeExtensions>("/api/opencode/extensions", { signal: controller.signal }).then(
      (result) => { if (!controller.signal.aborted) setExtensions(result); },
      () => { if (!controller.signal.aborted) setError("Não foi possível consultar as extensões globais do OpenCode."); },
    );
    return () => controller.abort();
  }, [refresh]);

  const toggle = async (name: string, enabled: boolean) => {
    setSaving(name);
    setError(null);
    try {
      await api(`/api/mcp/servers/${encodeURIComponent(name)}`, { method: "PATCH", body: JSON.stringify({ enabled }) });
      setExtensions((current) => current && ({ ...current, servers: current.servers.map((server) => server.name === name ? { ...server, enabled } : server) }));
    } catch {
      setError("Não foi possível alterar a ativação do MCP no Quati.");
    } finally {
      setSaving(null);
    }
  };

  const items = extensions?.[tab];
  const Icon = tab === "servers" ? Paperclip : tab === "plugins" ? Box : BookOpen;
  return (
    <section className="space-y-6">
      <p className="text-[13px] text-ink-secondary">Extensões globais do OpenCode disponíveis para os bots.</p>
      <div className="flex items-center justify-between gap-3">
        <div role="tablist" aria-label="Extensões" className="flex gap-1">
          {TABS.map(({ id, label }) => <button key={id} type="button" role="tab" id={`extension-tab-${id}`}
            aria-selected={tab === id} aria-controls={`extension-panel-${id}`} onClick={() => setTab(id)}
            className={`rounded-md px-3 py-1 text-[13px] ${tab === id ? "bg-control text-ink" : "text-ink-secondary hover:bg-control/50"}`}>{label}</button>)}
        </div>
        <button type="button" className="ui-button" onClick={() => setRefresh((value) => value + 1)} disabled={saving !== null} aria-label="Atualizar extensões">
          <RefreshCw size={14} />
        </button>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-[12px]">
        <span className="text-ink-secondary">Disponível para todos os projetos</span>
        <a className="text-ink-secondary underline" href={tab === "skills" ? "https://opencode.ai/v2/docs/skills" : "https://opencode.ai/v2/docs/config"} target="_blank" rel="noreferrer">
          {tab === "skills" ? "Como adicionar habilidades" : "Gerenciar no OpenCode"}
        </a>
      </div>
      {error && <p role="alert" className="text-[13px] text-danger">{error}</p>}
      <div role="tabpanel" id={`extension-panel-${tab}`} aria-labelledby={`extension-tab-${tab}`}>
        {!extensions && !error ? <p role="status">Carregando extensões…</p>
          : items?.length === 0 ? <p className="text-[13px] text-ink-secondary">Nenhum item global configurado no OpenCode.</p>
          : <ul className="divide-y divide-hairline rounded-lg border border-hairline bg-inset px-4">
            {items?.map((item) => <li key={"id" in item ? item.id : item.name} className="flex items-center justify-between gap-3 py-4">
              <span className="flex min-w-0 items-center gap-3 text-[13px] font-medium text-ink"><Icon size={16} className="shrink-0 text-ink-tertiary" />{item.name}</span>
              {tab === "servers" && "type" in item && <Switch aria-label={`Usar ${item.name} nos bots do Quati`}
                checked={item.enabled ?? item.status !== "disabled"} disabled={saving !== null}
                onClick={() => void toggle(item.name, !(item.enabled ?? item.status !== "disabled"))} />}
            </li>)}
          </ul>}
      </div>
      {tab === "servers" && <p className="text-[12px] text-ink-tertiary">Ativar ou desativar afeta apenas os bots do Quati, a partir da próxima mensagem. Não altera o OpenCode global nem outros clientes. Ativado não significa conectado.</p>}
      {tab === "skills" && <p className="text-[12px] text-ink-tertiary">Apenas habilidades com origem global identificável. Catálogos remotos sem essa informação não aparecem nesta lista.</p>}
    </section>
  );
}
