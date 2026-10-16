import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/** Captures only frames supplied by the agent browser or an isolated VM, never a host display. */
export async function recordScreenClip(capture: () => Promise<Buffer>, output: string, seconds: number) {
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 30) throw new Error("Recording duration must be 1–30 seconds.");
  const first = await capture();
  mkdirSync(dirname(output), { recursive: true });
  const encoder = spawn("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-n", "-f", "image2pipe", "-framerate", "2", "-i", "pipe:0",
    "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-an", "-c:v", "libvpx-vp9", "-deadline", "realtime", output,
  ], { stdio: ["pipe", "ignore", "ignore"] });
  const finished = new Promise<boolean>((resolve) => {
    encoder.once("error", () => resolve(false));
    encoder.once("exit", (code) => resolve(code === 0));
  });
  let inputFailed = false;
  encoder.stdin.on("error", () => { inputFailed = true; });
  const timeout = setTimeout(() => encoder.kill("SIGKILL"), 60_000);
  try {
    const started = Date.now();
    for (let frame = 0; frame < seconds * 2; frame++) {
      const image = frame === 0 ? first : await capture();
      if (inputFailed || encoder.exitCode !== null || encoder.stdin.destroyed) throw new Error("Video encoder is unavailable. Install ffmpeg on the server.");
      if (!encoder.stdin.write(image)) await once(encoder.stdin, "drain");
      await delay(Math.max(0, started + (frame + 1) * 500 - Date.now()));
    }
    encoder.stdin.end();
    if (!await finished) throw new Error("Could not encode the recording. Check ffmpeg on the server.");
    return { path: output, format: "webm" as const, seconds };
  } catch (error) {
    encoder.kill("SIGKILL");
    await finished;
    rmSync(output, { force: true });
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
