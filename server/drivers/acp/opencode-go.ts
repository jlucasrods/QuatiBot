import { execFile } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { ATTACHMENTS_DIR } from "../../attachments.ts";
import { cloudHomeConfigured } from "../../cloud-home.ts";
import { DATA_DIR, OPENCODE_PROVIDER_ENV } from "../../config.ts";
import { hostedWorkspaceConfigured } from "../../enterprise.ts";
import type { ModelCatalog, ProviderErrorCode } from "../../contracts.ts";
import { killCliTree, spawnCli } from "../../procs.ts";
import { globalMcpConfigFromEntries, openCodeApi, openCodeConfigDirectory } from "../../opencode-mcp.ts";
import { createAcpDriver, offeredModels, type AccountErrorCode, type AcpSupport } from "./core.ts";

const NO_MODELS: ModelCatalog = { default: "", options: [] };
let discoveryFolder: Promise<string> | null = null;

export type OpenCodeCatalogLoader = (
  environment: Record<string, string | undefined>,
  cli: string,
) => Promise<ModelCatalog>;

export function preferredOpenCodeModel(offered: readonly string[], current?: string | null): string {
  return current && offered.includes(current) ? current : offered[0] ?? "";
}

export function catalogFromOpenCodeSession(result: unknown): { options: ModelCatalog["options"]; current: string | null } | null {
  const configOptions = (result as { configOptions?: Array<{ id?: string; type?: string; currentValue?: string; options?: unknown }> } | null)?.configOptions;
  const model = configOptions?.find((option) => option.id === "model" && option.type === "select");
  const ids = offeredModels(result, "model");
  if (!model || !ids.length) return null;

  const names = new Map<string, string>();
  const visit = (entries: unknown) => {
    if (!Array.isArray(entries)) return;
    for (const raw of entries) {
      if (!raw || typeof raw !== "object") continue;
      const entry = raw as { value?: unknown; name?: unknown; options?: unknown };
      if (typeof entry.value === "string" && typeof entry.name === "string") names.set(entry.value, entry.name);
      else visit(entry.options);
    }
  };
  visit(model.options);

  const options = [...new Set(ids)].filter((id) => /^[^\s/]+\/\S+$/u.test(id)).map((id) => ({ id, label: names.get(id) || id }));
  return options.length ? { options, current: model.currentValue ?? null } : null;
}

function runGit(directory: string, args: string[]): Promise<void> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  return new Promise((done, reject) => {
    execFile("git", [
      "-c", "user.name=Quati", "-c", "user.email=model-discovery@quati.invalid",
      "-c", "commit.gpgsign=false", "-c", `core.hooksPath=${join(directory, ".git", "no-hooks")}`, ...args,
    ], { cwd: directory, env: { ...env, GIT_TERMINAL_PROMPT: "0" }, timeout: 10_000, windowsHide: true }, (error) => {
      if (error) reject(error);
      else done();
    });
  });
}

/** OpenCode groups non-Git directories into one project; discovery must not become a user's last session. */
function discoveryDirectory(): Promise<string> {
  discoveryFolder ??= (async () => {
    const directory = join(DATA_DIR, "providers", "opencode", "discovery");
    mkdirSync(directory, { recursive: true });
    const marker = join(directory, ".quati-project");
    if (!existsSync(marker)) {
      await runGit(directory, ["init", "-q"]);
      await runGit(directory, ["commit", "-q", "--allow-empty", "--no-verify", "-m", "Quati model discovery"]);
      writeFileSync(marker, "OpenCode model discovery project.\n");
    }
    return directory;
  })();
  return discoveryFolder;
}

export async function probeOpenCodeSession(
  cli: string,
  environment: Record<string, string | undefined>,
  folder?: string,
  timeoutMs = 20_000,
): Promise<unknown> {
  const cwd = folder ?? await discoveryDirectory();
  return new Promise((done, reject) => {
    const child = spawnCli(cli, ["acp"], { cwd, env: environment, stdio: ["pipe", "pipe", "pipe"] });
    let settled = false;
    let buffer = "";
    let nextId = 0;
    const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
    const write = (message: unknown) => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    const finish = (error: Error | null, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      void killCliTree(child);
      if (error) reject(error);
      else done(value);
    };
    const timer = setTimeout(() => finish(new Error("OpenCode did not list its models in time")), timeoutMs);
    timer.unref?.();
    child.on("error", (error) => finish(error));
    child.stdin.on("error", (error) => finish(error));
    child.on("close", (code) => finish(new Error(`OpenCode exited ${code} while listing its models`)));
    child.stderr.resume();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let message: { id?: number; method?: string; result?: unknown; error?: { message?: string } };
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id !== undefined && message.method) {
          write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "method not found" } });
          continue;
        }
        const waiter = message.id !== undefined ? pending.get(message.id) : undefined;
        if (!waiter) continue;
        pending.delete(message.id!);
        if (message.error) waiter.reject(new Error(message.error.message ?? "ACP request failed"));
        else waiter.resolve(message.result);
      }
    });
    const request = (method: string, params: unknown) => new Promise<unknown>((resolveRequest, rejectRequest) => {
      const id = ++nextId;
      pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
      write({ jsonrpc: "2.0", id, method, params });
    });
    void (async () => {
      const initialized = await request("initialize", {
        protocolVersion: 1,
        clientInfo: { name: "quatibot", version: "0.0.0" },
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      });
      const version = (initialized as { agentInfo?: { version?: string } })?.agentInfo?.version;
      if (!version || !/^v?2\./u.test(version)) throw new Error("QuatiBot requires OpenCode V2.");
      return request("session/new", { cwd, mcpServers: [] });
    })().then((result) => finish(null, result), (error: Error) => finish(error));
  });
}

export async function discoverOpenCodeModels(environment: Record<string, string | undefined>, cli = "opencode"): Promise<ModelCatalog> {
  const live = catalogFromOpenCodeSession(await probeOpenCodeSession(cli, environment));
  return live ? { default: preferredOpenCodeModel(live.options.map((option) => option.id), live.current), options: live.options } : NO_MODELS;
}

export async function canRunOpenCode(environment: Record<string, string | undefined>, cli: string, discover: OpenCodeCatalogLoader = discoverOpenCodeModels): Promise<boolean> {
  try {
    return (await discover(environment, cli)).options.length > 0;
  } catch {
    return false;
  }
}

export function resetOpenCodeModelCache(): void {
  discoveryFolder = null;
}

export function openCodeProviderKeysAllowed(state: { cloudHome: boolean; hostedWorkspace: boolean; organisationManaged: boolean; sharedSignIn: boolean }): boolean {
  return !state.cloudHome && !state.hostedWorkspace && !state.organisationManaged && !state.sharedSignIn;
}

let providerKeysAllowed = () => openCodeProviderKeysAllowed({
  cloudHome: cloudHomeConfigured(), hostedWorkspace: hostedWorkspaceConfigured(), organisationManaged: false, sharedSignIn: false,
});

export function setOpenCodeProviderKeyPolicy(allowed: () => boolean): void {
  providerKeysAllowed = allowed;
}

function withinFolder(path: string, folder: string): boolean {
  const rest = relative(resolve(folder), resolve(path));
  return rest === "" || (rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest));
}

/** Bot-written project files must not configure the engine for subsequent conversations. */
export function openQuatiOwnsWorkingFolder(cwd: string): boolean {
  return [join(DATA_DIR, "workspaces"), join(DATA_DIR, "task-workspaces")].some((root) => withinFolder(cwd, root) && resolve(cwd) !== resolve(root));
}

export function openCodeOwnedDirectories(botId?: string, cwd?: string): string[] {
  const directories = [ATTACHMENTS_DIR];
  if (botId && /^[\w-][\w.-]*$/u.test(botId) && botId !== "..") directories.push(join(DATA_DIR, "workspaces", botId));
  return cwd ? directories.filter((directory) => !withinFolder(cwd, directory)) : directories;
}

export function describeOpenCodeAccountError(code: AccountErrorCode, model?: string): string {
  switch (code) {
    case "invalid_credentials":
      return "Configure this model's provider in OpenCode with `opencode auth login`, then refresh models.";
    case "insufficient_funds":
      return "This model's provider has no remaining credit. Add credit there or select another OpenCode model.";
    case "inactive_subscription":
      return "This model requires an active provider subscription. Renew it there or select another OpenCode model.";
    case "quota_or_region_restriction":
      return `The provider's usage limit or region restriction blocks ${model || "this model"}. Select another OpenCode model or try later.`;
  }
}

/** An ACP process retains credentials; changing native login must start a fresh process. */
function openCodeLoginsFingerprint(env: Record<string, string | undefined>): string {
  const home = env.HOME || env.USERPROFILE || homedir();
  try {
    const stat = statSync(join(env.XDG_DATA_HOME || join(home, ".local", "share"), "opencode", "auth.json"));
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return "-";
  }
}

const support = (loadCatalog: OpenCodeCatalogLoader): AcpSupport => ({
  driverKind: "opencodeGo",
  displayName: "OpenCode V2",
  models: NO_MODELS,
  defaultCli: "opencode",
  minimumMajorVersion: 2,
  images: true,
  nativeSource: "opencode.acp",
  loginNote: "Configure providers in OpenCode V2 with `opencode auth login`, then refresh models.",
  install: { docsUrl: "https://opencode.ai/v2/docs/", signInCommand: "opencode auth login" },
  spawnArgs: () => ["acp"],
  credentialEnv: ["OPENCODE_API_KEY", ...OPENCODE_PROVIDER_ENV],
  selectModel: { configId: "model" },
  fallbackModel: (sessionConfig) => catalogFromOpenCodeSession(sessionConfig)?.current ?? null,
  modelVariants: true,
  transformEnv: (env) => {
    if (!providerKeysAllowed()) {
      for (const key of ["OPENCODE_API_KEY", ...OPENCODE_PROVIDER_ENV]) delete env[key];
    }
  },
  spawnFingerprint: openCodeLoginsFingerprint,
  toolScopeSessionParams: (turn, _initialized, _hasMcp, { cwd }) => ({ additionalDirectories: openCodeOwnedDirectories(turn.botId, cwd) }),
  applyTurnEnv: async (env, { fullAuto, cwd, cli, openCodeMcp }) => {
    if (openQuatiOwnsWorkingFolder(cwd)) env.OPENCODE_DISABLE_PROJECT_CONFIG = "1";
    if (!fullAuto && !Object.keys(openCodeMcp ?? {}).length) return;

    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT || "{}") as Record<string, unknown>;
    if (openCodeMcp && Object.keys(openCodeMcp).length) {
      const servers = globalMcpConfigFromEntries(await openCodeApi(cli, cwd, "/api/config", env), openCodeConfigDirectory(env));
      const overrides = Object.fromEntries(Object.entries(servers)
        .filter(([name]) => Object.hasOwn(openCodeMcp, name))
        .map(([name, server]) => [name, { ...server, disabled: !openCodeMcp[name] }]));
      // OpenCode V2 replaces same-name MCP definitions, so retain every native transport/auth field.
      const mcp = typeof config.mcp === "object" && config.mcp !== null && !Array.isArray(config.mcp) ? config.mcp as Record<string, unknown> : {};
      const inheritedServers = typeof mcp.servers === "object" && mcp.servers !== null && !Array.isArray(mcp.servers) ? mcp.servers : {};
      config.mcp = { ...mcp, servers: { ...inheritedServers, ...overrides } };
    }
    const permissions = Array.isArray(config.permissions) ? config.permissions : [];
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ ...config, ...(fullAuto ? { permissions: [...permissions, { action: "*", resource: "*", effect: "allow" }] } : {}) });
  },
  pickAuthMethod: () => null,
  authFailure: "continue",
  isAuthenticated: (env, config) => canRunOpenCode(env, config.cli, loadCatalog),
  classifyError: classifyOpenCodeError,
  describeAccountError: describeOpenCodeAccountError,
  resolveModels: (environment, config) => loadCatalog(environment, config.cli),
  buildPromptText: (turn) => turn.system ? `${turn.system}\n\n${turn.text}` : turn.text,
});

export function classifyOpenCodeError(error: unknown): ProviderErrorCode | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  switch (code) {
    case -32000:
    case "auth_required":
    case "AUTH_REQUIRED":
    case "INVALID_API_KEY":
    case "UNAUTHORIZED":
      return "invalid_credentials";
    case "SUBSCRIPTION_INACTIVE": return "inactive_subscription";
    case "QUOTA_EXCEEDED":
    case "REGION_RESTRICTED": return "quota_or_region_restriction";
    case "UPSTREAM_UNAVAILABLE":
    case "SERVICE_UNAVAILABLE": return "upstream_outage";
    case "MODEL_CATALOG_UNAVAILABLE": return "model_catalog_outage";
    default: return undefined;
  }
}

export function createOpenCodeDriver(loadCatalog: OpenCodeCatalogLoader = discoverOpenCodeModels) {
  return createAcpDriver(support(loadCatalog));
}

export const OpenCodeDriver = createOpenCodeDriver();
