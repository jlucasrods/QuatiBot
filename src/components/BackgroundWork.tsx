import { useEffect, useState } from "react";
import type { BackgroundReceipt, BackgroundSnapshot } from "../../shared/background-work.ts";
import { api } from "@/state/store";
import { t } from "@/lib/i18n";

export function BackgroundWork({ botId, threadId }: { botId: string; threadId: string }) {
  const receiptKey = `background-receipts:${botId}:${threadId}`;
  const [snapshot, setSnapshot] = useState<BackgroundSnapshot | null>(() => {
    try {
      const receipts: BackgroundReceipt[] = JSON.parse(sessionStorage.getItem(receiptKey) ?? "[]");
      return { tasks: [], receipts: Array.isArray(receipts) ? receipts : [], connected: false };
    } catch {
      return null;
    }
  });
  const [text, setText] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (snapshot) sessionStorage.setItem(receiptKey, JSON.stringify(snapshot.receipts));
  }, [receiptKey, snapshot]);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const next = await api<BackgroundSnapshot>(`/api/bots/${botId}/background-work`, {
          method: "POST", body: JSON.stringify({ threadId }), signal: controller.signal,
        });
        if (!controller.signal.aborted) setSnapshot(previous => ({ ...next, receipts: [
          ...next.receipts,
          ...(previous?.receipts.filter(receipt => !next.receipts.some(saved => saved.id === receipt.id)) ?? []),
        ] }));
      } catch {
        if (!controller.signal.aborted) setSnapshot(previous => previous ? { ...previous, connected: false } : null);
      }
      if (!controller.signal.aborted) timer = setTimeout(refresh, 2500);
    };
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [botId, threadId]);

  const control = async (taskId: string, action: "steer" | "interrupt") => {
    const local: BackgroundReceipt = { id: crypto.randomUUID(), taskId, action, status: "uncertain", createdAt: Date.now() };
    setSnapshot(previous => previous ? { ...previous, receipts: [...previous.receipts, local] } : previous);
    setPending(taskId);
    setError("");
    try {
      const { receipt } = await api<{ receipt: BackgroundReceipt }>(`/api/bots/${botId}/background-work`, {
        method: "POST", body: JSON.stringify({ threadId, control: { id: local.id, taskId, action,
          ...(action === "steer" ? { text: text[taskId] } : {}) } }),
      });
      setSnapshot(previous => previous ? { ...previous, receipts: previous.receipts.map(saved => saved.id === receipt.id ? receipt : saved) } : previous);
      if (action === "steer" && receipt.status === "accepted") setText(previous => ({ ...previous, [taskId]: "" }));
    } catch {
      setError(t("background.controlUncertain"));
      setSnapshot(previous => previous ? { ...previous, connected: false } : previous);
    } finally {
      setPending(null);
    }
  };

  if (!snapshot?.tasks.length) return null;
  const active = snapshot.tasks.filter(task => task.status === "running" || task.status === "unknown").length;
  return <details className="relative z-[1] -mb-5 rounded-t-3xl bg-composer px-4 pb-7 pt-3 text-sm ring-1 ring-composer-ring">
    <summary className="cursor-pointer font-medium">{t("background.title")} ({active})</summary>
    {!snapshot.connected && <p role="status" className="mt-2 text-ink-secondary">{t("background.disconnected")}</p>}
    {error && <p role="alert" className="mt-2 text-ink-secondary">{error}</p>}
    <div className="mt-3 max-h-[min(45vh,24rem)] space-y-3 overflow-y-auto overscroll-contain">{snapshot.tasks.map(task => {
      const receipts = snapshot.receipts.filter(receipt => receipt.taskId === task.id);
      const interruptPending = task.status === "running" && receipts.some(receipt => receipt.action === "interrupt" && receipt.status !== "rejected");
      const uncertain = receipts.some(receipt => receipt.status === "uncertain" || receipt.status === "pending");
      const disabled = !snapshot.connected || pending === task.id || uncertain || task.status !== "running";
      return <details key={task.id} className="rounded-lg border border-hairline p-3">
        <summary className="cursor-pointer">{task.description} · {interruptPending ? t("background.interruptPending") : t(`background.${task.status}`)}</summary>
        <p className="mt-2 text-xs text-ink-secondary">{task.agent} {task.model} · {new Date(task.createdAt).toLocaleString()}</p>
        {task.completedAt && <p className="text-xs text-ink-secondary">{new Date(task.completedAt).toLocaleString()}</p>}
        {task.result && <pre className="mt-2 whitespace-pre-wrap break-words font-sans">{task.result}</pre>}
        {task.error && <p role="status" className="mt-2">{task.error}</p>}
        {uncertain && <p role="status" className="mt-2">{t("background.controlUncertain")}</p>}
        {task.status === "running" && <div className="mt-3 space-y-2">
          <textarea aria-label={t("background.message")} value={text[task.id] ?? ""} disabled={disabled}
            onChange={event => setText(previous => ({ ...previous, [task.id]: event.target.value }))}
            className="w-full rounded-lg border border-hairline bg-app p-2"/>
          <div className="flex gap-2">
            <button type="button" className="ui-pill" disabled={disabled || !text[task.id]?.trim() || interruptPending} onClick={() => void control(task.id, "steer")}>{t("background.send")}</button>
            <button type="button" className="ui-pill" disabled={disabled || interruptPending} onClick={() => void control(task.id, "interrupt")}>{t("background.interrupt")}</button>
          </div>
        </div>}
        {receipts.map(receipt => <p key={receipt.id} className="mt-2 text-xs text-ink-secondary">{receipt.action === "interrupt" ? t("background.interrupt") : t("background.send")} · {t(`background.${receipt.status}`)}</p>)}
      </details>;
    })}</div>
  </details>;
}
