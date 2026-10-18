// No import from server/drivers: they pull in the whole provider stack.
import { hasNativeAutoReview, supportsApprovalMode } from "../../shared/approval-mode.ts";

export interface EngineCapabilities {
  resume: boolean;
  nativeReviewer: boolean;
  full: boolean;
  edits: boolean;
  stepCap?: number;
  subagents: boolean;
}

type EngineRow = Pick<EngineCapabilities, "resume" | "stepCap">;

const ENGINES: Readonly<Record<string, EngineRow>> = {
  opencodeGo: { resume: true },
};

export const ENGINE_KINDS: readonly string[] = Object.keys(ENGINES);

export function engineCapabilities(driverKind: string | undefined): EngineCapabilities {
  const row = driverKind !== undefined && Object.hasOwn(ENGINES, driverKind) ? ENGINES[driverKind] : undefined;
  return {
    resume: row?.resume ?? false,
    nativeReviewer: hasNativeAutoReview(driverKind),
    full: supportsApprovalMode(driverKind, "full"),
    edits: supportsApprovalMode(driverKind, "edits"),
    ...(row?.stepCap === undefined ? {} : { stepCap: row.stepCap }),
    subagents: false,
  };
}
