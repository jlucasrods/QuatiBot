import { mcpCallTimeoutMinutes, type AppConfig } from "./config.ts";
import { correctiveRounds } from "./host/loop-guard.ts";

/** Runtime limits for QuatiBot's internal tools. */
export function settingsTurnFields(cfg: AppConfig): {
  mcpCallTimeoutMs: number;
  toolErrorCorrectiveRounds: number;
  openCodeMcp?: Record<string, boolean>;
} {
  return {
    mcpCallTimeoutMs: mcpCallTimeoutMinutes(cfg) * 60_000,
    toolErrorCorrectiveRounds: correctiveRounds(cfg),
    ...(cfg.openCodeMcp ? { openCodeMcp: cfg.openCodeMcp } : {}),
  };
}
