export interface SessionIdlePolicy {
  idleMs: number;
  minimumMs: number;
}

const DEFAULT_IDLE_MS = 10 * 60_000;
const MINIMUM_IDLE_MS = 10_000;
/** setTimeout treats anything above 2^31-1 ms as 1 ms. */
const MAX_TIMER_MS = 2_147_483_647;

function usableMilliseconds(raw: string | undefined): number | null {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 && value <= MAX_TIMER_MS ? value : null;
}

/** Per-harness names (QUATI_CLAUDE_SESSION_IDLE_*, QUATI_ACP_SESSION_IDLE_*) win over QUATI_SESSION_IDLE_MS /
 *  QUATI_SESSION_IDLE_MIN_MS; the floor is the greater of ten seconds and any configured minimum. */
export function sessionIdlePolicy(
  driverPrefix: string,
  env: Record<string, string | undefined> = process.env,
): SessionIdlePolicy {
  const minimumMs = Math.max(
    MINIMUM_IDLE_MS,
    usableMilliseconds(
      env[`QUATI_${driverPrefix}_SESSION_IDLE_MIN_MS`] ?? env.QUATI_SESSION_IDLE_MIN_MS,
    ) ?? 0,
  );
  const configured =
    usableMilliseconds(
      env[`QUATI_${driverPrefix}_SESSION_IDLE_MS`] ?? env.QUATI_SESSION_IDLE_MS,
    ) ?? DEFAULT_IDLE_MS;
  return { idleMs: Math.max(minimumMs, configured), minimumMs };
}
