import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DATA_DIR, instanceConfigs, loadConfig, parseStoredConfig, saveConfig, type AppConfig } from "./config.ts";
import type { InstanceConfig, ModelCatalog, ProviderSnapshot } from "./contracts.ts";
import { acquireDataDirLease } from "./data-dir-lease.ts";
import { ProviderRegistry } from "./harness/registry.ts";
import { BUILT_IN_DRIVERS } from "./drivers/builtIn.ts";
import { defaultSetupIo, SetupCancelled, type SetupIo } from "./cli-prompts.ts";

type Inspection = { snapshot: ProviderSnapshot; models: ModelCatalog };
interface SetupDependencies {
  inspect(id: string, entry: InstanceConfig): Promise<Inspection>;
}

async function inspect(id: string, entry: InstanceConfig): Promise<Inspection> {
  const registry = new ProviderRegistry(BUILT_IN_DRIVERS);
  try {
    await registry.load({ [id]: entry });
    const provider = registry.get(id);
    if (!provider) throw new Error("OpenCode V2 could not be loaded. Check its CLI path in Settings.");
    return { snapshot: await provider.snapshot(), models: provider.models };
  } finally {
    await registry.disposeAll();
  }
}

function checkStoredConfig(dataDir: string): void {
  if (resolve(dataDir) !== resolve(DATA_DIR)) throw new Error("Setup data directory mismatch. Restart the CLI with --data-dir.");
  try {
    parseStoredConfig(JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error("Existing config.json could not be read or validated. Repair it before continuing.");
  }
}

export async function isSetupComplete(dataDir: string): Promise<boolean> {
  checkStoredConfig(dataDir);
  const cfg = loadConfig();
  const saved = cfg.defaultModelSelection;
  const instances = instanceConfigs(cfg);
  return !!(saved && Object.hasOwn(instances, saved.instanceId) && instances[saved.instanceId]?.enabled !== false);
}

export function readCliStartup(dataDir: string): AppConfig["cliStartup"] {
  checkStoredConfig(dataDir);
  return loadConfig().cliStartup;
}

export function saveCliStartup(dataDir: string, settings: NonNullable<AppConfig["cliStartup"]>): void {
  const lease = acquireDataDirLease(dataDir);
  try {
    checkStoredConfig(dataDir);
    saveConfig({ cliStartup: settings });
  } finally {
    lease.release();
  }
}

export async function runSetup(
  options: { dataDir: string; port: number },
  io: SetupIo = defaultSetupIo(),
  deps: SetupDependencies = { inspect },
): Promise<boolean> {
  const lease = acquireDataDirLease(options.dataDir);
  try {
    checkStoredConfig(options.dataDir);
    const cfg = loadConfig();
    const instances = instanceConfigs(cfg);
    const entries = Object.entries(instances).filter(([, entry]) => entry.enabled !== false);
    if (!entries.length) throw new Error("Enable OpenCode V2 in Settings before running setup.");

    io.log("\nQuatiBot uses OpenCode V2 over ACP.");
    io.log("Configure providers, credentials and local endpoints in OpenCode, using `opencode auth login` when needed.");
    const selected = entries.length === 1 ? 0 : await io.choose("Choose OpenCode instance", entries.map(([id, entry]) => entry.displayName ?? id));
    const [id, entry] = entries[selected]!;
    const state = await deps.inspect(id, entry);
    if (state.snapshot.state !== "available") throw new Error(state.snapshot.reason || "Install OpenCode V2 and make it available on PATH.");
    if (!state.models.options.length) throw new Error("OpenCode has no available models. Configure its providers, then run setup again.");

    let query = "";
    let model: string;
    for (;;) {
      const matches = state.models.options.filter((option) => `${option.label} ${option.id}`.toLowerCase().includes(query.toLowerCase())).slice(0, 20);
      const preferred = cfg.defaultModelSelection?.instanceId === id ? cfg.defaultModelSelection.model : state.models.default;
      const pick = await io.choose("Choose your model", [...matches.map((option) => option.label), "Search models…"], Math.max(0, matches.findIndex((option) => option.id === preferred)));
      if (pick < matches.length) {
        model = matches[pick]!.id;
        break;
      }
      query = (await io.ask("Model name or ID (Enter shows all): ")).trim();
    }

    io.log(`Default for new bots: ${entry.displayName ?? id} / ${model}`);
    if (!await io.confirm("Save this setup?", true)) throw new SetupCancelled();
    saveConfig({ defaultModelSelection: { instanceId: id, model } });
    io.log("Setup saved. Existing bots and conversations were not changed.");
    return true;
  } catch (error) {
    if (!(error instanceof SetupCancelled)) throw error;
    io.log("Setup cancelled. No settings were changed.");
    return false;
  } finally {
    lease.release();
  }
}
