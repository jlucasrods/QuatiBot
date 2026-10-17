import { useEffect, useState } from "react";
import { defaultDeviceLabel, isConnected, newAttemptId, pairWithCode, readSessionState, reasonWorthShowing, type SessionState } from "../lib/session";

const input = "mt-1 w-full rounded-md border border-hairline/40 bg-inset px-3 py-2 text-[14px] text-ink outline-none focus:border-accent-border";
const fieldLabel = "mt-4 block text-[12px] font-medium text-ink-secondary";

export function PairPage({ initialCode, reason }: { initialCode: string | null; reason?: string }) {
  const [code, setCode] = useState(initialCode ?? "");
  const [label, setLabel] = useState(defaultDeviceLabel());
  const [session, setSession] = useState<SessionState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attemptId, setAttemptId] = useState(() => newAttemptId());

  useEffect(() => {
    void readSessionState().then(setSession);
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    const result = await pairWithCode({ code, label, attemptId });
    setBusy(false);
    if (result.ok) {
      location.replace("/");
      return;
    }
    setError(result.error);
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-app px-6 text-ink">
      <div className="w-full max-w-[420px]">
        <h1 className="text-[20px] font-semibold">Connect to QuatiBot</h1>
        <p className="mt-1.5 text-[13.5px] leading-relaxed text-ink-secondary">
          Enter the pairing code shown on the server. Codes work once and expire after five minutes.
        </p>
        {reasonWorthShowing(reason) && !isConnected(session) && <p className="mt-3 text-[13px] text-ink-secondary">{reasonWorthShowing(reason)}</p>}
        {isConnected(session) ? (
          <p className="mt-4 text-[13.5px]">This browser is already connected. <a href="/" className="text-accent underline">Open the app</a></p>
        ) : (
          <form onSubmit={submit}>
            <label className={fieldLabel} htmlFor="pair-code">Pairing code</label>
            <input id="pair-code" value={code} onChange={event => {
              setCode(event.target.value);
              setAttemptId(newAttemptId());
            }} placeholder="XXXX-XXXX-XXXX" autoComplete="one-time-code" autoCapitalize="characters" spellCheck={false} className={`${input} font-mono text-[15px] tracking-[0.12em]`} />
            <label className={fieldLabel} htmlFor="pair-label">This device</label>
            <input id="pair-label" value={label} onChange={event => setLabel(event.target.value)} maxLength={80} className={input} />
            {error && <p role="alert" className="mt-3 text-[13px] text-danger">{error}</p>}
            <button type="submit" disabled={busy || code.replace(/[^a-z0-9]/gi, "").length < 12} className="mt-5 w-full rounded-md bg-accent px-4 py-2 text-[14px] font-medium text-accent-ink disabled:opacity-50">
              {busy ? "Connecting…" : "Connect"}
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
