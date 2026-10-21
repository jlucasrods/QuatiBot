import type { ChildProcess } from "node:child_process";
import { z } from "zod";

const handleSchema = z.object({
  ui: z.string().min(1),
  url: z.string(),
  previewUrl: z.string(),
  botId: z.string(),
  dataDir: z.string(),
  logPath: z.string(),
});

export function waitForUiLaunch(child: ChildProcess, timeoutMs: number): Promise<z.infer<typeof handleSchema>> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";

    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.off("data", onOutput);
      child.stderr?.off("data", onStderr);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const fail = (reason: string) => {
      cleanup();
      reject(new Error(`UI launcher ${reason}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    };
    const onOutput = (chunk: Buffer) => {
      stdout += String(chunk);
      let handle: z.infer<typeof handleSchema>;
      try {
        handle = handleSchema.parse(JSON.parse(stdout));
      } catch {
        return;
      }
      cleanup();
      resolve(handle);
    };
    const onStderr = (chunk: Buffer) => {
      stderr += String(chunk);
    };
    const onError = (error: Error) => {
      fail(`could not start: ${error.message}`);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      fail(`exited (${signal ?? code}) before printing a handle`);
    };
    const timer = setTimeout(() => fail(`printed no handle within ${timeoutMs}ms`), timeoutMs);

    child.stdout?.on("data", onOutput);
    child.stderr?.on("data", onStderr);
    child.once("error", onError);
    child.once("exit", onExit);

    if (child.exitCode !== null || child.signalCode !== null) onExit(child.exitCode, child.signalCode);
  });
}
