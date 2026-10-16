import {
  spawn,
  execFile,
  type ChildProcess,
  type ChildProcessByStdio,
  type ExecFileOptions,
  type SpawnOptions,
} from "node:child_process";
import { existsSync } from "node:fs";
import type { Readable, Writable } from "node:stream";
import { join } from "node:path";
import { resolveCliSpawn, type ResolvedSpawn } from "./env-path.ts";

export function resolveCli(cli: string, args: string[] = [], env?: NodeJS.ProcessEnv): ResolvedSpawn {
  return resolveCliSpawn(cli, args, env);
}

// Only spawnCli makes a private POSIX group; a plain child may share ours, so never signal its group.
const cliGroups = new WeakSet<ChildProcess>();
const stopping = new WeakMap<ChildProcess, Promise<boolean>>();

const MAX_ENDED_SESSIONS = 4_096;
const engineSessions = { live: new Set<number>(), ended: new Set<number>() };

/** POSIX session ids of the engines that run bots' turns (each leads its own session). A server opened by any
 * process in one counts as the bot's, even after the shell that started it exits. */
export function botEngineSessions(): { live: ReadonlySet<number>; ended: ReadonlySet<number> } {
  return engineSessions;
}

function rememberEngineSession(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) return;
  engineSessions.live.add(pid);
  child.once("exit", () => {
    engineSessions.live.delete(pid);
    engineSessions.ended.add(pid);
    if (engineSessions.ended.size > MAX_ENDED_SESSIONS) engineSessions.ended.delete(engineSessions.ended.values().next().value!);
  });
}

/** `bot`: an engine running bots' turns, whose own servers that bot's browser may open on a server host.
 * `openmausbot`: everything else (logins, probes, the browser engine itself). */
export type CliOwner = "bot" | "openmausbot";

export function spawnCli(
  cli: string,
  args: string[],
  opts: SpawnOptions,
  owner: CliOwner = "openmausbot",
): ChildProcessByStdio<Writable, Readable, Readable> {
  const resolved = resolveCli(cli, args);
  const child = spawn(resolved.command, resolved.args, {
    ...opts,
    detached: true,
  }) as ChildProcessByStdio<Writable, Readable, Readable>;
  cliGroups.add(child);
  if (owner === "bot") rememberEngineSession(child);

  // A process can close stdin before the final buffered write completes.
  child.stdin?.on("error", () => {});
  return child;
}

export function execCli(
  cli: string,
  args: string[],
  opts: ExecFileOptions,
  cb: (err: Error | null, stdout: string, stderr?: string) => void,
): void {
  const resolved = resolveCli(cli, args);
  execFile(resolved.command, resolved.args, { ...opts, encoding: "utf8" }, (err, stdout, stderr) =>
    cb(err, stdout, stderr),
  );
}

/** Node reports a missing cwd as the CLI's own ENOENT, so pass `cwd` to tell a moved folder from a missing CLI. */
type SpawnFailure = { message: string; setup: boolean };

export function describeSpawnFailure(err: NodeJS.ErrnoException, cli: string, cwd?: string): SpawnFailure {
  if (err.code === "ENOENT") {
    if (cwd && !existsSync(cwd))
      return { message: `This chat's working folder no longer exists: ${cwd}. Choose another folder in the bot's settings, or create it again.`, setup: false };
    return { message: `\`${cli}\` isn't installed, or isn't on this app's PATH`, setup: true };
  }
  if (err.code === "EACCES" || err.code === "EPERM")
    return { message: `\`${cli}\` isn't executable — check its file permissions`, setup: true };
  return { message: `spawn failed: ${err.message}`, setup: false };
}

/** timeoutMs is the TERM grace; SIGKILL gets one more second. Helpers that detach into another group are not covered. */
export function killCliTree(child: ChildProcess, timeoutMs = 5_000): Promise<boolean> {
  const existing = stopping.get(child);
  if (existing) return existing;
  const pid = child.pid;
  if (!pid) return Promise.resolve(true);
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return Promise.resolve(false);

  const run = stopCliTree(child, pid, Number.isFinite(timeoutMs) ? Math.max(0, timeoutMs) : 5_000);
  stopping.set(child, run);
  // Remember success, so a delayed caller cannot signal a reused PID/group.
  void run.then((stopped) => { if (!stopped) stopping.delete(child); });
  return run;
}

async function stopCliTree(child: ChildProcess, pid: number, timeoutMs: number): Promise<boolean> {
  const exited = () => child.exitCode !== null || child.signalCode !== null;

    const group = cliGroups.has(child);
    const settled = () => {
      if (!exited()) return false;
      if (!group) return true;
      try {
        process.kill(-pid, 0);
        return false;
      } catch (error) {
        // EPERM and other failures do not prove that the group is gone.
        return (error as NodeJS.ErrnoException).code === "ESRCH";
      }
    };
    const signal = (value: NodeJS.Signals) => {
      try {
        if (group) process.kill(-pid, value);
        else child.kill(value);
      } catch {
        try { child.kill(value); } catch {}
      }
    };
    const wait = async (ms: number) => {
      const deadline = Date.now() + ms;
      while (!settled()) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          // Timers run before libuv's poll phase reads SIGCHLD: a blocked loop reaches the deadline with the exit unread.
          await new Promise((resolve) => setImmediate(resolve));
          return settled();
        }
        await exitOrDelay(child, Math.min(25, remaining));
      }
      return true;
    };
    if (settled()) return true;
    signal("SIGTERM");
    if (await wait(timeoutMs)) return true;
    signal("SIGKILL");
    return wait(1_000);}

function exitOrDelay(child: ChildProcess, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      child.off("exit", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    child.once("exit", done);
  });
}

/** True once the process itself has exited, within `ms`; members it left in its group are not counted. */
export async function waitForExit(child: ChildProcess, ms: number): Promise<boolean> {
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  const deadline = Date.now() + ms;
  while (!exited() && Date.now() < deadline) await exitOrDelay(child, Math.min(250, deadline - Date.now()));
  if (!exited()) await new Promise((resolve) => setImmediate(resolve));
  return exited();
}

/** Unix socket on POSIX, named pipe on Windows (Node cannot listen on a filesystem socket path there: EACCES). */
export function brokerSocketPath(dataDir: string, tag: string): string {
  return join(dataDir, `perm-${tag}.sock`);
}
