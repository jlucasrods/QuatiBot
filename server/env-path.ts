import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

function nvmBinDirs(): string[] {
  try {
    const base = join(homedir(), ".nvm", "versions", "node");
    return readdirSync(base)
      .filter((v) => v.startsWith("v"))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map((v) => join(base, v, "bin"));
  } catch {
    return [];
  }
}

/** A sealed test fixture sees only its own PATH, OMB_EXTRA_PATH, app-managed dirs and its temporary home, never this machine's CLIs. */
function sealedFixture(): boolean {
  return process.env.OMB_TEST_SEALED_PATH === "1";
}

function knownDirs(): string[] {
  const home = homedir();
  return [
    join(home, ".local", "bin"), // claude installer default
    join(home, ".npm-global", "bin"), // npm prefix ~/.npm-global (claude, opencode)

    join(home, ".opencode", "bin"), // opencode installer
    ...(sealedFixture() ? [] : [
      "/usr/local/bin", // brew Intel / classic installs
    ]),
    join(home, ".volta", "bin"),
    join(home, ".bun", "bin"),
    join(home, ".asdf", "shims"),
    join(home, ".local", "share", "mise", "shims"), // mise installer
    join(home, ".deno", "bin"),
    join(home, "bin"),
    ...nvmBinDirs(),
  ];
}

let cached: string | null = null;
let probed = false;
let loginShellPath: string | null = null;

// App-managed dirs (its own npm prefix) go first, so an engine installed there wins over an older copy.
const registeredDirs: string[] = [];

export function registerPathDir(dir: string): void {
  if (registeredDirs.includes(dir)) return;
  registeredDirs.unshift(dir);
  resetPathCache();
}

/** `probed` resets too, or a rescan would drop rc-file PATH entries and never probe the login shell again. */
export function resetPathCache(): void {
  cached = null;
  probed = false;
}

export function augmentedPath(): string {
  if (cached === null) {
    cached = mergePaths([
      ...registeredDirs.filter((d) => existsSync(d)),
      ...(process.env.OMB_EXTRA_PATH ? process.env.OMB_EXTRA_PATH.split(delimiter) : []),
      ...(process.env.PATH ? process.env.PATH.split(delimiter) : []),
      // Keep the last login-shell result while a rescan re-probes, or rc-only CLIs vanish for the response that triggered it.
      ...(loginShellPath ? loginShellPath.split(delimiter) : []),
      ...knownDirs().filter((d) => existsSync(d)),
    ]);
  }
  if (!probed && !process.env.VITEST && !sealedFixture()) {
    probed = true;
    probeLoginShellPath();
  }
  return cached;
}

function mergePaths(parts: string[]): string {
  return [...new Set(parts.filter(Boolean))].join(delimiter);
}

function probeLoginShellPath(): void {
  const shell = process.env.SHELL || "/bin/bash";
  // -l -i: nvm and friends live in .zshrc/.bashrc, which only interactive shells read; a marker isolates $PATH from rc noise.
  execFile(
    shell,
    ["-l", "-i", "-c", 'printf "__OMB_PATH__%s" "$PATH"'],
    { timeout: 5000 },
    (err, stdout) => {
      if (err || !stdout) return;
      const m = /__OMB_PATH__([^\n]*)/.exec(stdout);
      if (!m || !m[1]) return;
      loginShellPath = m[1];
      cached = mergePaths([...(cached ?? "").split(delimiter), ...m[1].split(delimiter)]);
    },
  );
}

export function resetPathCacheForTests(): void {
  cached = null;
  probed = false;
  loginShellPath = null;
  registeredDirs.length = 0;
}

export function userHome(env: Record<string, string | undefined> = process.env): string {
  return env.HOME || homedir();
}

export function harnessHome(name: string, env: Record<string, string | undefined> = process.env): string {
  return join(userHome(env), `.${name}`);
}

export function findCliCandidates(name: string): string[] {
  if (!name || /[\n\r]/.test(name)) return [];
  if (/[/\\]/.test(name) || /^[a-zA-Z]:/.test(name)) return [name];
  const exts = [""];
  const out: string[] = [];
  for (const dir of augmentedPath().split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = join(dir, name + ext);
      if (existsSync(p)) {
        out.push(p);
        break;
      }
    }
  }
  return out;
}


export interface ResolvedSpawn {
  command: string;
  args: string[];
}

/** A mini tokenizer, never a shell: quotes group segments; no escapes, no substitution, nothing evaluated. */
export function splitCliString(cli: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  for (const ch of cli.trim()) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (cur) out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}

export function resolveCliSpawn(cli: string, args: string[], _env?: NodeJS.ProcessEnv): ResolvedSpawn {
  // An existing file wins over the tokenizer: candidate paths with spaces arrive unquoted.
  const trimmed = cli.trim();
  if (trimmed.includes(" ") && existsSync(trimmed)) return { command: trimmed, args };
  // One tokenizer pass; the head is never re-split, and fixed args go first so a wrapper's subcommand leads.
  const split = splitCliString(cli);
  if (split.length > 1 || split[0] !== trimmed) {
    const [head, ...fixed] = split;
    if (!head) return { command: cli, args };
    return { command: head, args: [...fixed, ...args] };
  }
  return { command: cli, args };
}
