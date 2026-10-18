import { DEFAULT_OUTBOUND_POLICY } from "../../shared/outbound.ts";
import { readBotActivity } from "../activity.ts";
import { activityCsv, activityEntries, parseActivityWhat, readAdminActivityRange } from "../admin-activity.ts";
import { browserEngineStatus, ensureChrome, installAgentBrowserBinary, resolveAgentBrowserBinary } from "../browser-engine.ts";
import { DATA_DIR, EVENTS_DIR, NATIVE_DIR, type AppConfig } from "../config.ts";
import { boundRetentionDays, decisionsCsv, readDecisionRange, readDecisions } from "../decision-log.ts";
import { editionForMembers, editionStatus } from "../enterprise.ts";
import type { OutboundCounts } from "../outbound-counts.ts";
import type { Store } from "../store.ts";
import { readThreadEvents } from "../thread-events.ts";
import { parseUsageRange } from "../usage-ledger.ts";
import type { ConfigStatus } from "./config.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface StatusRouteDeps {
  store: Pick<Store, "bot" | "bots" | "tasks" | "groupByThread">;
  cfg: AppConfig;
  outboundCounts: Pick<OutboundCounts, "today">;
  staticDir: string | null;
  sharedWorkspaceFullAccessEnabled(): boolean;
  adminActivityRecording(): boolean;
  configStatus(): ConfigStatus;
  broadcast(payload: Record<string, unknown>): void;
  browserEngineInstall: { get(): Promise<void> | null; set(install: Promise<void> | null): void };
  browserEngineInstallError: { set(error: string | null): void };
}

export function createStatusRoutes(deps: StatusRouteDeps): RouteHandler {
  const {
    store, outboundCounts, staticDir: STATIC_DIR, sharedWorkspaceFullAccessEnabled, adminActivityRecording,
    configStatus, broadcast, browserEngineInstall, browserEngineInstallError,
  } = deps;
  return async ({ req, res, url, path, method, auth, json }) => {
    let m: RegExpMatchArray | null = null;
    // The packaged app's port fallback: the forked child proves it is ours by echoing its pid.
    if (method === "GET" && path === "/api/health") {
      return json(res, 200, { app: "quatibot", pid: process.pid, static: Boolean(STATIC_DIR), capabilities: {
        guardedMessages: 1, guardedRequests: 1, guardedFullAccess: 1, guardedOnBehalfOf: 1,
        ...(sharedWorkspaceFullAccessEnabled() ? { sharedWorkspaceFullAccess: 1 } : {}),
      } });
    }
    // JSON-only, so a form posted from another local page cannot start the install. One install at a time.
    if (method === "POST" && path === "/api/browser-engine/install") {
      const mediaType = String(req.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase();
      if (mediaType !== "application/json") {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      if (!browserEngineInstall.get()) {
        const status = browserEngineStatus();
        if (status.kind === "unavailable" && !status.installable) return json(res, 409, { error: status.reason });
        browserEngineInstallError.set(null);
        browserEngineInstall.set((async () => {
          const binary = resolveAgentBrowserBinary() ?? await installAgentBrowserBinary({ log: (line) => console.log(line) });
          await ensureChrome(binary, { log: (line) => console.log(line) });
        })().then(
          () => { browserEngineInstallError.set(null); },
          (error: unknown) => { browserEngineInstallError.set(error instanceof Error ? error.message : String(error)); },
        ).finally(() => {
          browserEngineInstall.set(null);
          broadcast({ kind: "config", ...configStatus() });
        }));
        broadcast({ kind: "config", ...configStatus() });
      }
      return json(res, 202, { installing: true });
    }
    if (method === "GET" && path === "/api/edition") {
      // A member learns what is entitled; when the key lapses is for admins.
      const status = editionStatus();
      return json(res, 200, auth.scopes.includes("admin") ? status : editionForMembers(status));
    }

    m = path.match(/^\/api\/threads\/([\w-]+)\/events$/);
    if (m && method === "GET") {
      const threadId = m[1];
      const known =
        store.bots.some((b) => store.tasks(b.id).some((t) => t.threadId === threadId)) ||
        Boolean(store.groupByThread(threadId));
      if (!known) return json(res, 404, { error: "no such thread" });
      const rawLimit = url.searchParams.get("limit");
      const parsedLimit = rawLimit === null ? undefined : Number(rawLimit);
      if (parsedLimit !== undefined && (!Number.isInteger(parsedLimit) || parsedLimit <= 0)) {
        return json(res, 400, { error: "limit must be a positive whole number" });
      }
      const limit = parsedLimit;
      return json(res, 200, readThreadEvents({ eventsDir: EVENTS_DIR, nativeDir: NATIVE_DIR, threadId, limit }));
    }

    if (method === "GET" && path === "/api/decisions") {
      const rawLimit = url.searchParams.get("limit");
      const parsedLimit = rawLimit === null ? undefined : Number(rawLimit);
      if (parsedLimit !== undefined && (!Number.isInteger(parsedLimit) || parsedLimit <= 0)) {
        return json(res, 400, { error: "limit must be a positive whole number" });
      }
      return json(res, 200, { decisions: readDecisions(DATA_DIR, parsedLimit ?? 200) });
    }
    if (method === "GET" && (path === "/api/admin-activity" || path === "/api/admin-activity.csv")) {
      const fromParam = url.searchParams.get("from") || new Date(Date.now() - 29 * 24 * 60 * 60_000).toISOString().slice(0, 10);
      const range = parseUsageRange(fromParam, url.searchParams.get("to"));
      if (!range) return json(res, 400, { error: "from and to must be dates (YYYY-MM-DD), from no later than to, at most a year apart" });
      const what = parseActivityWhat(url.searchParams.get("what"));
      if (!what) return json(res, 400, { error: "what must be all, approvals, decisions, config, people, session, webhook, mcp, engine, bot, budget or visibility" });
      const entries = activityEntries(readDecisionRange(DATA_DIR, range), readAdminActivityRange(DATA_DIR, range), {
        what,
        who: (url.searchParams.get("who") ?? "").slice(0, 200),
      });
      if (path.endsWith(".csv")) {
        const stamp = (date: Date) => date.toISOString().slice(0, 10);
        res.writeHead(200, {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="activity-${stamp(range.from)}-${stamp(range.to)}.csv"`,
          "cache-control": "no-store",
        });
        res.end(activityCsv(entries));
        return;
      }
      const rawLimit = Number(url.searchParams.get("limit") ?? 500);
      const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 5_000) : 500;
      res.setHeader("cache-control", "no-store");
      return json(res, 200, {
        entries: entries.slice(0, limit),
        total: entries.length,
        from: range.from.toISOString(),
        to: range.to.toISOString(),
        retentionDays: boundRetentionDays(),
        recording: adminActivityRecording(),
      });
    }
    if (method === "GET" && path === "/api/decisions.csv") {
      const range = parseUsageRange(url.searchParams.get("from"), url.searchParams.get("to"));
      if (!range) return json(res, 400, { error: "from and to must be YYYY-MM-DD, from no later than to, at most a year apart" });
      const stamp = (date: Date) => date.toISOString().slice(0, 10);
      res.writeHead(200, {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="decisions-${stamp(range.from)}-${stamp(range.to)}.csv"`,
        "cache-control": "no-store",
      });
      res.end(decisionsCsv(readDecisionRange(DATA_DIR, range)));
      return;
    }

    m = path.match(/^\/api\/bots\/([\w-]+)\/activity$/);
    if (m && method === "GET") {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      const rawLimit = url.searchParams.get("limit");
      const parsedLimit = rawLimit === null ? undefined : Number(rawLimit);
      if (parsedLimit !== undefined && (!Number.isInteger(parsedLimit) || parsedLimit <= 0)) {
        return json(res, 400, { error: "limit must be a positive whole number" });
      }
      const threadIds = [...new Set([bot.threadId, ...store.tasks(bot.id).map((task) => task.threadId)])];
      return json(res, 200, {
        rows: readBotActivity({ dataDir: DATA_DIR, eventsDir: EVENTS_DIR, botId: bot.id, threadIds, limit: parsedLimit ?? 300 }),
      });
    }

    m = path.match(/^\/api\/bots\/([\w-]+)\/outbound$/);
    if (m && method === "GET") {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      return json(res, 200, { policy: bot.outbound ?? DEFAULT_OUTBOUND_POLICY, today: outboundCounts.today(bot.id) });
    }
    return PASS;
  };
}
