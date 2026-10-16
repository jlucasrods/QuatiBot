import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  describeSpawnFailure,
} from "./procs.ts";

describe("spawn ENOENT", () => {
  const enoent = () => Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" });

  it("names a missing working folder instead of blaming the install (MOCA-309)", () => {
    const missing = join(mkdtempSync(join(tmpdir(), "omb-procs-")), "deleted-project");
    expect(describeSpawnFailure(enoent(), "/home/u/.openmausbot/tools/npm/bin/codex", missing)).toEqual({
      message: `This chat's working folder no longer exists: ${missing}. Choose another folder in the bot's settings, or create it again.`,
      setup: false,
    });
  });

  it("still reports a missing CLI when the working folder exists", () => {
    const failure = describeSpawnFailure(enoent(), "codex", tmpdir());
    expect(failure).toEqual({ message: "`codex` isn't installed, or isn't on this app's PATH", setup: true });
    expect(describeSpawnFailure(enoent(), "codex")).toEqual(failure);
  });

  it("really is what node reports for a missing cwd", async () => {
    const missing = join(mkdtempSync(join(tmpdir(), "omb-procs-")), "gone");
    const error = await new Promise<NodeJS.ErrnoException>((resolve) => {
      spawn(process.execPath, ["--version"], { cwd: missing }).once("error", resolve);
    });
    expect(error.code).toBe("ENOENT");
    expect(describeSpawnFailure(error, process.execPath, missing).setup).toBe(false);
  });
});
