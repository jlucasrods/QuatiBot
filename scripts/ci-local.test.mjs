import { existsSync, globSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { checks, runLocalCi } from "./ci-local.mjs";

describe("local CI", () => {
  it.each([
    ["success", { status: 0, stdout: "live tier skipped" }, 0],
    ["failure", { status: 1 }, 1],
    ["missing dependency", { status: null, error: new Error("ENOENT") }, 1],
    ["interrupted check", { status: null, signal: "SIGTERM" }, 1],
    ["missing live skip", { status: 0, stdout: "" }, 1],
  ])("reports %s without skipping subsequent stages", async (_name, result, expected) => {
    vi.stubEnv("OPENAI_API_KEY", "fixture-parent-secret");
    vi.stubEnv("QUATI_EVAL_LIVE", "1");
    vi.stubEnv("DISPLAY", ":99");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const run = vi.fn(() => result);

    try {
      expect(await runLocalCi(run)).toBe(expected);
      expect(run).toHaveBeenCalledTimes(checks.flatMap(check => check.parallel ?? [check]).length);
      const homes = new Set(run.mock.calls.map(([, , options]) => options.env.HOME));
      expect(homes.size).toBe(1);
      expect(existsSync([...homes][0])).toBe(false);
      for (const [, , options] of run.mock.calls) {
        expect(options.env.QUATI_EVAL_LIVE).toBe("0");
        expect(options.env).not.toHaveProperty("OPENAI_API_KEY");
        expect(options.env.DISPLAY).toBe("");
        expect(options.env.QUATI_DATA_DIR).toBe(`${options.env.HOME}/data`);
      }
    } finally {
      log.mockRestore();
      error.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it.each([0, 1])("waits for all four concurrent shards when one exits %s", async status => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const releases = [];
    const run = vi.fn((_command, args) => {
      if (args.some(arg => arg.startsWith("--shard="))) {
        return new Promise(resolve => { releases.push(resolve); });
      }
      return { status: 0, stdout: "live tier skipped" };
    });

    try {
      const finished = runLocalCi(run);
      await vi.waitFor(() => expect(releases).toHaveLength(4));
      expect(run.mock.calls.some(([, args]) => args.includes("test:evals"))).toBe(false);
      releases[0]({ status });
      for (const release of releases.slice(1)) release({ status: 0 });
      expect(await finished).toBe(status);
      expect(run.mock.calls.some(([, args]) => args.includes("test:evals"))).toBe(true);
    } finally {
      for (const release of releases) release({ status: 0 });
      log.mockRestore();
      error.mockRestore();
    }
  });

  it("covers the dedicated CI browser suites without Docker or docs builds", () => {
    const workflow = parse(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));
    const commands = checks.flatMap(check => check.parallel ?? [check]).map(check => `${check.command ?? "pnpm"} ${check.args.join(" ")}`).join("\n");
    for (const job of ["ui-smoke", "browser-identity", "browser-driver"]) {
      const source = workflow.jobs[job].steps.map(step => step.run ?? "").join("\n");
      const files = source.match(/(?:scripts|server)\/[\w./-]+(?:\.test\.ts)?/g) ?? [];
      for (const file of files.filter(file => file.startsWith("scripts/testing/") || file.startsWith("server/browser/"))) {
        expect(commands).toContain(file);
      }
    }
    expect(commands).toContain("tsc -b --force");
    expect(commands).toContain("tsc -p evals/tsconfig.json");
    expect(commands).toContain("xvfb-run -a pnpm");
    for (const shard of [1, 2, 3, 4]) expect(commands).toContain(`--shard=${shard}/4`);
    expect(commands).not.toMatch(/docker|docs:build/);
    expect(existsSync(new URL("../.github/workflows/docs.yml", import.meta.url))).toBe(false);
    expect(readFileSync(new URL("../AGENTS.md", import.meta.url), "utf8")).toContain("pnpm ci:local");
  });

  it("requires every renderer suite locally and on PRs", () => {
    const workflow = parse(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));
    const renderer = checks.find(check => check.env?.QUATI_UI_E2E === "1");
    const files = globSync("scripts/testing/*ui.e2e.test.ts", { cwd: new URL("..", import.meta.url) }).sort();

    expect(renderer.args.filter(arg => arg.endsWith("ui.e2e.test.ts"))).toEqual(files);
    expect(renderer.args).toContain("scripts/testing/vm-preview.e2e.test.ts");
    const commands = workflow.jobs["ui-smoke"].steps.map(step => step.run ?? "").join("\n");
    expect(commands).toContain("scripts/testing/*ui.e2e.test.ts");
    expect(commands).toContain("scripts/testing/vm-preview.e2e.test.ts");
    expect(commands.indexOf("vite build")).toBeLessThan(commands.indexOf("vitest run"));
  });
});
