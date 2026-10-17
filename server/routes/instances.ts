import { z } from "zod";
import { providerIconError } from "../../shared/provider-icon.ts";
import { persistableInstanceConfigs, saveConfig, withInstanceCli, type AppConfig } from "../config.ts";
import type { InstanceConfigMap, ModelSelection } from "../contracts.ts";
import { BUILT_IN_DRIVERS } from "../drivers/builtIn.ts";
import { findCliCandidates, resetPathCache } from "../env-path.ts";
import type { ProviderRegistry } from "../harness/registry.ts";
import type { ProviderAuthSessions } from "../provider-auth-sessions.ts";
import { providerIconPatchSchema, withInstanceIcon } from "../provider-icon.ts";
import type { SessionRegistry } from "../sessions.ts";
import type { Store } from "../store.ts";
import type { BusyFlag, ConfigStatus } from "./config.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface InstanceRouteDeps {
  store: Pick<Store, "bots" | "tasks">;
  cfg: AppConfig;
  registry: Pick<ProviderRegistry, "get" | "refreshModels" | "installRuntime" | "cliTarget">;
  sessions: Pick<SessionRegistry, "isLive">;
  providerAuthSessions: Pick<ProviderAuthSessions, "status" | "start" | "revokeOwner" | "signOut" | "complete" | "cancel">;
  providerConfigBusy: BusyFlag;
  providerInstancesChanging: Pick<Set<string>, "add" | "delete">;
  describeInstances(): Promise<unknown>;
  persistProviderInstance(instanceId: string, instances: InstanceConfigMap): Promise<void>;
  configStatus(): ConfigStatus;
  broadcast(payload: Record<string, unknown>): void;
  testCliBinary(cli: string, driver: (typeof BUILT_IN_DRIVERS)[number] | undefined): Promise<unknown>;
  cliProbeEnvironment(): NodeJS.ProcessEnv;
  threadBusy(botId: string, threadId: string): boolean;
  botForThread(botId: string, threadId: string): Pick<{ modelSelection: ModelSelection }, "modelSelection"> | null;
  activeGroupTurnForBot(botId: string): { threadId: string } | null;
}

const instanceSettings = z.object({ cli: z.string().max(4096).refine((value) => !/[\r\n]/u.test(value)).optional() }).strict();

export function createInstanceRoutes(deps: InstanceRouteDeps): RouteHandler {
  const { cfg, registry, providerConfigBusy, providerInstancesChanging } = deps;
  return async ({ req, res, url, path, method, json, readBody }) => {
    if (method === "GET" && path === "/api/instances") {
      resetPathCache();
      return json(res, 200, { instances: await deps.describeInstances() });
    }
    if (method === "GET" && path === "/api/cli-candidates") {
      if (url.searchParams.get("name") !== "opencode") return json(res, 400, { error: "Only OpenCode V2 is supported." });
      resetPathCache();
      return json(res, 200, { candidates: findCliCandidates("opencode") });
    }
    if (method === "POST" && path === "/api/cli-test") {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) return json(res, 415, { error: "content-type must be application/json" });
      const body = await readBody(req);
      const cli = typeof body?.cli === "string" ? body.cli.trim() : "";
      if (!cli || /[\n\r]/u.test(cli) || body.driver !== "opencodeGo") return json(res, 400, { error: "Supply an OpenCode V2 CLI path and driver opencodeGo." });
      return json(res, 200, await deps.testCliBinary(cli, BUILT_IN_DRIVERS[0]));
    }

    const refresh = /^\/api\/instances\/([\w.-]+)\/refresh-models$/u.exec(path);
    if (method === "POST" && refresh) {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) return json(res, 415, { error: "content-type must be application/json" });
      if (!await registry.refreshModels(refresh[1])) return json(res, 404, { error: "unknown instance" });
      return json(res, 200, { instances: await deps.describeInstances() });
    }

    const icon = /^\/api\/instances\/([\w.-]+)\/icon$/u.exec(path);
    const instance = /^\/api\/instances\/([\w.-]+)$/u.exec(path);
    if (method !== "PATCH" || (!icon && !instance)) return PASS;
    if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) return json(res, 415, { error: "content-type must be application/json" });
    const instanceId = (icon ?? instance)![1];
    if (registry.get(instanceId)?.driverKind !== "opencodeGo") return json(res, 404, { error: "unknown instance" });
    if (providerConfigBusy.get()) return json(res, 409, { error: "provider settings are already being updated" });

    const busy = deps.store.bots.some((bot) => {
      const tasks = deps.store.tasks(bot.id).filter((task) => deps.threadBusy(bot.id, task.threadId));
      return tasks.some((task) => deps.botForThread(bot.id, task.threadId)?.modelSelection.instanceId === instanceId)
        || ((deps.activeGroupTurnForBot(bot.id) || (bot.busy && !tasks.length)) && bot.modelSelection.instanceId === instanceId);
    });
    if (busy) return json(res, 409, { error: "Wait for running bots to finish before changing OpenCode settings." });

    providerConfigBusy.set(true);
    providerInstancesChanging.add(instanceId);
    try {
      if (icon) {
        const parsed = providerIconPatchSchema.safeParse(await readBody(req, 192 * 1024));
        if (!parsed.success) return json(res, 400, { error: "Choose a built-in icon or a PNG, JPEG or WebP image up to 128 KB." });
        const invalid = parsed.data.icon && providerIconError(parsed.data.icon);
        if (invalid) return json(res, 400, { error: invalid });
        const changed = withInstanceIcon(cfg, instanceId, parsed.data.icon);
        if (!changed.ok) return json(res, 404, { error: "unknown instance" });
        saveConfig({ instances: changed.instances }, { replaceInstances: true });
        cfg.instances = changed.instances;
        deps.broadcast({ kind: "config", ...deps.configStatus() });
      } else {
        const parsed = instanceSettings.safeParse(await readBody(req, 16384));
        if (!parsed.success || parsed.data.cli === undefined) return json(res, 400, { error: "Supply a valid CLI path, or an empty string to use opencode on PATH." });
        const changed = withInstanceCli(cfg, instanceId, parsed.data.cli);
        if (!changed.ok) return json(res, 404, { error: "unknown instance" });
        await deps.persistProviderInstance(instanceId, persistableInstanceConfigs(changed.config));
      }
      return json(res, 200, { instances: await deps.describeInstances() });
    } finally {
      providerInstancesChanging.delete(instanceId);
      providerConfigBusy.set(false);
    }
  };
}
