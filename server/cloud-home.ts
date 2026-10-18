import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Surface } from "../shared/wire.ts";
import { writeFileAtomic } from "./atomic.ts";

/** Any of these switches the server into Cloud home mode; then all are required. */
export const CLOUD_HOME_KEYS = ["QUATI_CLOUD_ROLE", "QUATI_CLOUD_MACHINE_ID", "QUATI_CLOUD_ADMIN_URL", "QUATI_CLOUD_BOOTSTRAP_SECRET"] as const;
/** A platform model gateway's settings: a Cloud home logs one warning, and neither it nor anything it starts sees them. */
export const CLOUD_IGNORED_KEYS = ["QUATI_HOSTED_MODEL_URL", "QUATI_HOSTED_MODEL_TOKEN", "QUATI_HOSTED_MODELS"] as const;
export const CLOUD_HOME_MARKER = ".quati-cloud-home.json";

export interface CloudHomeConfig {
  machineId: string;
  adminOrigin: string;
  publicOrigin: string;
  bootstrapSecret: string;
  warnings: string[];
}

export function cloudHomeConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return CLOUD_HOME_KEYS.some((key) => env[key] !== undefined);
}

function invalid(why: string): never {
  throw new Error(`Cloud home configuration is invalid: ${why}.`);
}

function exactHttpsOrigin(raw: string | undefined, name: string): string {
  let url: URL;
  try {
    if (!raw || raw !== raw.trim()) throw new Error();
    url = new URL(raw);
  } catch { return invalid(`${name} must be an https origin`); }
  if (url.protocol !== "https:" || url.username || url.password || (raw !== url.origin && raw !== `${url.origin}/`)) {
    invalid(`${name} must be an exact https origin with no path`);
  }
  return url.origin;
}

/** Null on any machine that is not a Cloud home; throws, so the server refuses to start, on a partial or invalid one. */
export function cloudHomeConfiguration(env: NodeJS.ProcessEnv = process.env): CloudHomeConfig | null {
  if (!cloudHomeConfigured(env)) return null;
  if (env.QUATI_DESKTOP_PARENT === "1") invalid("the desktop app cannot run as a Cloud home machine");
  if ([env.QUATI_ADMIN_URL, env.QUATI_ADMIN_WORKSPACE, env.QUATI_ADMIN_MEMBERSHIP].some(value => value !== undefined)) invalid("a Cloud home is not a hosted team workspace; remove QUATI_ADMIN_URL, QUATI_ADMIN_WORKSPACE and QUATI_ADMIN_MEMBERSHIP");
  if (env.QUATI_CLOUD_ROLE !== "home") invalid('QUATI_CLOUD_ROLE must be "home"; this image runs the home machine');
  const machineId = env.QUATI_CLOUD_MACHINE_ID ?? "";
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/.test(machineId)) invalid("QUATI_CLOUD_MACHINE_ID must be the Admin's machine id (letters, digits, dashes)");
  const adminOrigin = exactHttpsOrigin(env.QUATI_CLOUD_ADMIN_URL, "QUATI_CLOUD_ADMIN_URL");
  const publicOrigin = exactHttpsOrigin(env.QUATI_PUBLIC_URL, "QUATI_PUBLIC_URL");
  const bootstrapSecret = env.QUATI_CLOUD_BOOTSTRAP_SECRET ?? "";
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(bootstrapSecret)) invalid("QUATI_CLOUD_BOOTSTRAP_SECRET must be at least 256 bits of base64url");
  const warnings: string[] = [];
  const ignored = CLOUD_IGNORED_KEYS.filter((key) => env[key] !== undefined);
  if (ignored.length) warnings.push(`ignoring ${ignored.join(", ")}: Cloud Pro includes no AI; people sign in with their own Claude or ChatGPT account, or an API key`);
  return { machineId, adminOrigin, publicOrigin, bootstrapSecret, warnings };
}

export { CLOUD_HOME_SECRET_KEYS, CLOUD_SECRETS_FD_ENV, cloudHomeSecrets, takeCloudSecrets, withoutCloudSecrets } from "./cloud-secrets.ts";

export function withoutIgnoredCloudKeys(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const kept = { ...env };
  for (const key of CLOUD_IGNORED_KEYS) delete kept[key];
  return kept;
}

export { cloudHomeOffersPlace } from "../shared/cloud-home.ts";

/** In the person's words; a turn's error shows 160 characters, so each fits. */
export function cloudHomePlaceRefusal(place: Surface): string | undefined {
  if (place === "local") return "This computer isn't a place on My Cloud. Set Works on to Auto, Cloud computer or Browser, or lend your computer under Settings → Quati Cloud.";
  if (place === "vm") return "Bots on My Cloud can't use a Local VM. Set Works on to Auto, Cloud computer or Browser.";
  return undefined;
}

/** Recorded once in this Cloud's own onboarding record, which never travels with Move to Cloud, so moved-in turns never count. */
export function firstCloudTurnPatch(turn: { cloudHome: boolean; recorded: string | undefined; ok: boolean; known: boolean; now?: Date }): { onboarding: { firstTurnAt: string } } | null {
  if (!turn.cloudHome || turn.recorded || !turn.ok || !turn.known) return null;
  return { onboarding: { firstTurnAt: (turn.now ?? new Date()).toISOString() } };
}

// useradd seeds these shell files and a fresh Fly volume carries lost+found; anything else is someone's data.
const ADOPTABLE = new Set(["lost+found", ".bash_logout", ".bashrc", ".profile"]);

/** Binds the volume to this machine on first boot and refuses any other machine's after; never deletes or rewrites data. */
export function prepareCloudHomeVolume(home: string, machineId: string): "new" | "existing" {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const marker = join(home, CLOUD_HOME_MARKER);
  if (existsSync(marker)) {
    const stat = lstatSync(marker);
    let saved: unknown;
    try {
      if (!stat.isFile() || stat.size > 4096) throw new Error();
      saved = JSON.parse(readFileSync(marker, "utf8"));
    } catch { throw new Error("This volume's Cloud marker is unreadable. No data was changed."); }
    if ((saved as { machine?: unknown })?.machine !== machineId) throw new Error("This volume belongs to another Cloud machine. No data was changed.");
    return "existing";
  }
  if (readdirSync(home).some((name) => !ADOPTABLE.has(name))) {
    throw new Error("Refusing to adopt a data volume that was not made for this Cloud machine. No data was changed.");
  }
  writeFileAtomic(marker, JSON.stringify({ version: 1, machine: machineId }) + "\n", { mode: 0o600 });
  return "new";
}

/** What the edge proxy may answer for: the machine's own public name. */
export function cloudHomeHost(config: Pick<CloudHomeConfig, "publicOrigin">): string {
  return new URL(config.publicOrigin).hostname;
}
