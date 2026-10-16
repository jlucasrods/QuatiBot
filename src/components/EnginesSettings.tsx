import { useState } from "react";
import { api, useStore, type InstanceInfo } from "@/state/store";
import { t } from "@/lib/i18n";
import { EngineCard, RefreshEngines } from "./EngineLibrary";

function OpenCodeSettings({ instance }: { instance: InstanceInfo }) {
  const { refreshInstances } = useStore();
  const [cli, setCli] = useState(instance.cli ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/instances/${encodeURIComponent(instance.instanceId)}`, { method: "PATCH", body: JSON.stringify({ cli: cli.trim() }) });
      await refreshInstances({ reportErrors: true });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return <EngineCard instance={instance}>
    <p className="text-[13px] leading-relaxed text-ink-secondary">OpenCode V2 owns model providers, credentials and local endpoints. Configure them in OpenCode, then refresh the models here.</p>
    <code className="mt-3 block text-[12px] text-ink">opencode auth login</code>
    {instance.snapshot.reason && <p role="status" className="mt-3 text-[12px] text-warning">{instance.snapshot.reason}</p>}
    <a href="https://opencode.ai/v2/docs/" target="_blank" rel="noreferrer" className="mt-3 block text-[12px] text-accent-text">OpenCode V2 documentation</a>
    <label className="mt-4 block text-[12px] text-ink-secondary">
      {t("engines.setCli")}
      <input value={cli} onChange={(event) => setCli(event.target.value)} placeholder="opencode" disabled={busy} className="mt-2 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 font-mono text-[12px] text-ink" />
    </label>
    <button onClick={save} disabled={busy || cli === (instance.cli ?? "")} className="mt-3 rounded-lg bg-raised px-3 py-1.5 text-[13px] text-ink disabled:opacity-50">{busy ? t("common.checking") : t("common.save")}</button>
    {error && <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p>}
  </EngineCard>;
}

export function EnginesSettings() {
  const { state } = useStore();
  return <div className="flex min-w-0 flex-col gap-6 pb-2">
    <div className="flex items-start justify-between gap-3 px-4">
      <h1 className="text-[22px] font-semibold tracking-tight text-ink">OpenCode V2</h1>
      <RefreshEngines />
    </div>
    {state.instances.filter((instance) => instance.driverKind === "opencodeGo").map((instance) => <OpenCodeSettings key={instance.instanceId} instance={instance} />)}
  </div>;
}
