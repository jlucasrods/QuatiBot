// The Cloud home image's entry point: a root supervisor of two `quati` children, the server on 127.0.0.1:8799 and the Caddy
// edge on 0.0.0.0:8080, the only listener the network reaches, always forwarding X-Forwarded-*, so no remote request gets
// loopback trust. Secrets never ride a child's environment (/proc/<pid>/environ stays readable by the same user): the
// server reads them from an inherited pipe. Root runs and trusts only the image's code, never the volume's.
import { spawn, type ChildProcess } from "node:child_process";
import { chownSync, readFileSync, statSync, type Stats } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CLOUD_SECRETS_FD_ENV, cloudHomeConfiguration, cloudHomeHost, cloudHomeSecrets, prepareCloudHomeVolume,
  withoutCloudSecrets, withoutIgnoredCloudKeys, type CloudHomeConfig,
} from "./cloud-home.ts";
import { restartPolicy } from "./restart.ts";

const SERVICE_USER = "quati";
const SECRETS_FD = 3;

/** uid/gid from /etc/passwd; Node has no getpwnam. */
export function passwdIds(passwd: string, name: string): { uid: number; gid: number } | null {
  for (const line of passwd.split("\n")) {
    const [user, , uid, gid] = line.split(":");
    if (user === name && /^\d+$/.test(uid ?? "") && /^\d+$/.test(gid ?? "")) return { uid: Number(uid), gid: Number(gid) };
  }
  return null;
}

/** An allow-list by name, so a secret the platform adds later never reaches the server. */
const SERVER_ENV_NAMES = new Set([
  "PATH", "SHELL", "HOSTNAME", "LANG", "LANGUAGE", "TZ", "TERM", "TMPDIR", "NO_COLOR", "NODE_ENV", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
  "AGENT_BROWSER_EXECUTABLE_PATH", "QUATI_STATIC_DIR", "QUATI_DATA_DIR",
  "QUATI_CLOUD_ROLE", "QUATI_CLOUD_MACHINE_ID", "QUATI_CLOUD_ADMIN_URL", "QUATI_CLOUD_IMAGE", "QUATI_PUBLIC_URL", "QUATI_WEBHOOK_PUBLIC_URL",
  "QUATI_CLOUD_BOAT_URL", "QUATI_CLOUD_VOICE_URL", "QUATI_CLOUD_DECIDER_URL", "QUATI_CLOUD_AI_URL", "QUATI_TTS_DEFAULT_VOICE",
  "QUATI_HIGHLEVEL_RELAY_URL",
]);
export function serverEnvironmentAllowed(name: string): boolean {
  return SERVER_ENV_NAMES.has(name) || name.startsWith("LC_");
}

export function cloudHomeChildEnvironments(config: CloudHomeConfig, env: NodeJS.ProcessEnv, home: string) {
  const offered = withoutCloudSecrets(withoutIgnoredCloudKeys(env));
  const allowed = Object.fromEntries(Object.entries(offered).filter(([name, value]) => value !== undefined && serverEnvironmentAllowed(name)));
  const dropped = Object.keys(offered).filter((name) => !serverEnvironmentAllowed(name) && name !== "HOME").sort();
  const server: NodeJS.ProcessEnv = {
    ...allowed, HOME: home, QUATI_DATA_DIR: env.QUATI_DATA_DIR || posix.join(home, ".quatibot"),
    QUATI_PORT: "8799", QUATI_WEBHOOK_PORT: "8800", QUATI_PUBLIC_URL: config.publicOrigin,
    QUATI_WEBHOOK_PUBLIC_URL: env.QUATI_WEBHOOK_PUBLIC_URL || config.publicOrigin,
    [CLOUD_SECRETS_FD_ENV]: String(SECRETS_FD),
  };
  const edge: NodeJS.ProcessEnv = {
    PATH: env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: "/tmp/quati-edge",
    XDG_DATA_HOME: "/tmp/quati-edge/data", XDG_CONFIG_HOME: "/tmp/quati-edge/config",
    QUATI_CLOUD_PUBLIC_HOST: cloudHomeHost(config),
  };
  return { server, edge, secrets: cloudHomeSecrets(env), dropped };
}

/** Each file and every folder above it must be root's and not writable by others, and never on the `quati`-owned volume:
 * otherwise `quati` could rewrite what runs as root at the next start. */
export function codeTrustProblem(files: readonly string[], home: string, stat: (path: string) => Pick<Stats, "uid" | "mode"> = statSync): string | null {
  const volume = posix.join(home, "/");
  for (const file of files) {
    if (file === home || file.startsWith(volume)) return `${file} is on the volume`;
    for (let path = file; ; path = dirname(path)) {
      let owner: Pick<Stats, "uid" | "mode">;
      try { owner = stat(path); } catch { return `${path} cannot be checked`; }
      if (owner.uid !== 0) return `${path} is not root's`;
      // A folder with the sticky bit (/tmp) lets nobody replace root's files.
      if (owner.mode & 0o022 && !(path !== file && owner.mode & 0o1000)) return `${path} is writable by others than root`;
      if (dirname(path) === path) break;
    }
  }
  return null;
}

/** Secrets go over an inherited pipe, never the environment; it is written and closed at once. */
export function spawnWithSecrets(command: string, args: string[], env: NodeJS.ProcessEnv, secrets: Record<string, string>,
  ids?: { uid: number; gid: number } | null, capture = false): ChildProcess {
  const child = spawn(command, args, { env,
    stdio: capture ? ["inherit", "pipe", "pipe", "pipe"] : ["inherit", "inherit", "inherit", "pipe"],
    ...(ids ? { uid: ids.uid, gid: ids.gid } : {}) });
  const pipe = child.stdio[SECRETS_FD] as NodeJS.WritableStream | null;
  pipe?.on("error", () => {});
  pipe?.end(JSON.stringify(secrets));
  return child;
}

export function startCloudHome(env: NodeJS.ProcessEnv = process.env) {
  process.umask(0o077);
  const config = cloudHomeConfiguration(env);
  if (!config) throw new Error("This image runs a My Cloud machine for Quati Cloud; set its boot contract (docs/cloud-pro.md).");
  // Logged here once: the server child never sees what they are about.
  for (const warning of config.warnings) console.warn(`cloud home: ${warning}`);
  const home = env.HOME || "/data";
  let ids: { uid: number; gid: number } | null = null;
  if (process.getuid?.() === 0) {
    ids = passwdIds(readFileSync("/etc/passwd", "utf8"), SERVICE_USER);
    if (!ids) throw new Error(`The ${SERVICE_USER} user is missing from this image.`);
    // Only the mount point changes owner; anything inside keeps its owner.
    const stat = statSync(home);
    if (stat.uid !== ids.uid || stat.gid !== ids.gid) chownSync(home, ids.uid, ids.gid);
    process.setgroups?.([]);
    // The volume is prepared as `quati`, so what it creates is theirs.
    process.setegid!(ids.gid);
    process.seteuid!(ids.uid);
    try { prepareCloudHomeVolume(home, config.machineId); } finally {
      process.seteuid!(0);
      process.setegid!(0);
    }
  } else {
    prepareCloudHomeVolume(home, config.machineId);
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const edgeBin = env.QUATI_CLOUD_EDGE_BIN || "/usr/local/bin/caddy";
  const edgeConfig = env.QUATI_CLOUD_EDGE_CONFIG || "/app/cloud/Caddyfile";
  if (ids) {
    const problem = codeTrustProblem([process.execPath, fileURLToPath(import.meta.url), join(here, "index.js"), edgeBin, edgeConfig], home);
    if (problem) throw new Error(`This image's code is not safe to run as root: ${problem}. Rebuild it with docker build --target cloud-home.`);
  }
  const { server, edge, secrets, dropped } = cloudHomeChildEnvironments(config, env, home);
  // Names only, never values: what the server does not get from here.
  if (dropped.length) console.log(`cloud home: not passed to the server: ${dropped.join(", ")}`);
  const children: ChildProcess[] = [];
  let stopping = false;
  const stop = (failed: boolean) => {
    if (stopping) return;
    stopping = true;
    process.exitCode = failed ? 1 : 0;
    for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
    const force = setTimeout(() => { for (const child of children) if (child.exitCode === null) child.kill("SIGKILL"); }, 20_000);
    force.unref();
  };
  const watch = (child: ChildProcess, again?: (code: number | null) => boolean) => {
    children.push(child);
    child.once("error", () => stop(true));
    child.once("exit", (code) => {
      children.splice(children.indexOf(child), 1);
      if (!again?.(code)) stop(true);
    });
  };
  const policy = restartPolicy();
  const runServer = () => {
    watch(spawnWithSecrets(process.execPath, [join(here, "index.js")], server, secrets, ids), (code) => {
      if (!policy.again(code, stopping)) return false;
      runServer();
      return true;
    });
  };
  runServer();
  watch(spawn(edgeBin, ["run", "--config", edgeConfig, "--adapter", "caddyfile"],
    { env: edge, stdio: "inherit", ...(ids ? { uid: ids.uid, gid: ids.gid } : {}) }));
  process.once("SIGTERM", () => stop(false));
  process.once("SIGINT", () => stop(false));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { startCloudHome(); } catch (error) {
    console.error(`Cloud home startup failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
