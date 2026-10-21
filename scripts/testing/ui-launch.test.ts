import { ChildProcess, spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { waitForUiLaunch } from "./ui-launch.ts";

afterEach(() => vi.useRealTimers());

const HANDLE = {
  ui: "/fixture/ui.json", url: "http://127.0.0.1:1234", previewUrl: "http://127.0.0.1:1235",
  botId: "fixture-bot", dataDir: "/fixture", logPath: "/fixture/server.log",
};

it("waits for the complete handle and releases startup listeners and its deadline", async () => {
  vi.useFakeTimers();
  const child = Object.assign(new ChildProcess(), { stdout: new PassThrough(), stderr: new PassThrough() });
  const ready = waitForUiLaunch(child, 600_000);
  const handle = JSON.stringify(HANDLE);

  child.stdout.write(handle.slice(0, 12));
  expect(vi.getTimerCount()).toBe(1);
  child.stdout.write(handle.slice(12));

  expect(await ready).toEqual(HANDLE);
  expect(vi.getTimerCount()).toBe(0);
  expect(child.stdout.listenerCount("data")).toBe(0);
  expect(child.stderr.listenerCount("data")).toBe(0);
  expect(child.listenerCount("exit")).toBe(0);
  expect(child.listenerCount("error")).toBe(0);
});

it.each([
  { name: "nonzero exit", event: "exit", args: [1, null], message: "exited (1)" },
  { name: "exit without a handle", event: "exit", args: [0, null], message: "exited (0)" },
  { name: "signal", event: "exit", args: [null, "SIGTERM"], message: "exited (SIGTERM)" },
  { name: "spawn failure", event: "error", args: [new Error("ENOENT")], message: "could not start: ENOENT" },
])("rejects $name immediately instead of retrying until the deadline", async ({ event, args, message }) => {
  vi.useFakeTimers();
  const child = Object.assign(new ChildProcess(), { stdout: new PassThrough(), stderr: new PassThrough() });
  const ready = waitForUiLaunch(child, 600_000);
  child.stderr.write("ENOSPC: watcher limit reached");
  child.emit(event, ...args);

  await expect(ready).rejects.toThrow(message);
  await expect(ready).rejects.toThrow("ENOSPC: watcher limit reached");
  expect(vi.getTimerCount()).toBe(0);
  expect(child.listenerCount("exit")).toBe(0);
  expect(child.listenerCount("error")).toBe(0);
});

it.each(["", "{", '{"ui":"/incomplete"}'])("times out a live launcher with incomplete output %j", async output => {
  vi.useFakeTimers();
  const child = Object.assign(new ChildProcess(), { stdout: new PassThrough(), stderr: new PassThrough() });
  const ready = waitForUiLaunch(child, 100);
  child.stdout.write(output);
  child.stderr.write("still starting");
  const rejected = expect(ready).rejects.toThrow("printed no handle within 100ms");

  await vi.advanceTimersByTimeAsync(100);
  await rejected;
  await expect(ready).rejects.toThrow("still starting");
  expect(vi.getTimerCount()).toBe(0);
  expect(child.stdout.listenerCount("data")).toBe(0);
});

it("rejects a launcher that has already exited", async () => {
  const child = Object.assign(new ChildProcess(), { exitCode: 2 });
  await expect(waitForUiLaunch(child, 600_000)).rejects.toThrow("exited (2)");
});

it("reports a real CLI startup error without waiting for the launch deadline", async () => {
  const child = spawn(process.execPath, ["--experimental-strip-types", "scripts/control-quati.ts", "ui", "launch", "--entry", "invalid-fixture"], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  await expect(waitForUiLaunch(child, 600_000)).rejects.toThrow("unknown --entry");
});
