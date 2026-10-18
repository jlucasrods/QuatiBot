import { spawn } from "node:child_process";
import { globSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const rendererTests = [
  ...globSync("scripts/testing/*ui.e2e.test.ts", { cwd: root }).sort(),
  "scripts/testing/browser-evidence.e2e.test.ts",
  "scripts/testing/browser-identity.e2e.test.ts",
  "scripts/testing/vm-preview.e2e.test.ts",
];

export const checks = [
  { name: "Fresh frontend typecheck", args: ["exec", "tsc", "-b", "--force"] },
  { name: "Server typecheck", args: ["exec", "tsc", "-p", "tsconfig.server.json"] },
  { name: "Eval typecheck", args: ["exec", "tsc", "-p", "evals/tsconfig.json"] },
  { name: "Locale catalogs", args: ["i18n:check"] },
  { name: "Lint", args: ["lint"] },
  { name: "Application build", args: ["build"] },
  {
    name: "Application tests",
    parallel: [1, 2, 3, 4].map(shard => ({
      name: `Application tests ${shard}/4`,
      args: ["exec", "vitest", "run", `--shard=${shard}/4`],
    })),
  },
  { name: "Offline evals and golden replay", args: ["test:evals"] },
  { name: "Live eval safety gate", args: ["eval", "--live"], outputIncludes: "live tier skipped" },
  { name: "Packaged server smoke", args: ["test:packaged-server"] },
  { name: "Renderer and browser identity", args: ["exec", "vitest", "run", ...rendererTests], env: { QUATI_UI_E2E: "1" } },
  {
    name: "Browser driver (headless and headed)",
    command: "xvfb-run",
    args: ["-a", "pnpm", "exec", "vitest", "run", "server/browser/cdp/s4-", "server/browser/checklist.e2e", "server/browser/viewers/viewers.e2e"],
    env: { QUATI_CDP_E2E: "1" },
  },
];

function runCommand(command, args, options) {
  return new Promise(resolve => {
    const child = spawn(command, args, options);
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", chunk => { stdout += chunk; });
    child.stderr?.on("data", chunk => { stderr += chunk; });
    child.once("error", error => resolve({ status: null, error, stdout, stderr }));
    child.once("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

export async function runLocalCi(run = runCommand) {
  if (process.platform !== "linux" || Number(process.versions.node.split(".")[0]) < 24) {
    console.error("Local CI requires Linux and Node.js 24 or newer.");
    return 1;
  }

  const home = mkdtempSync(join(tmpdir(), "quati-local-ci-"));
  const failures = [];
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    ["PATH", "LANG", "LC_ALL", "TZ", "TMPDIR", "NODE_NO_WARNINGS", "QUATI_CDP_CHROME"].includes(key)));

  try {
    for (const check of checks) {
      console.log(`\nLocal CI: ${check.name}`);
      await Promise.all((check.parallel ?? [check]).map(async stage => {
        const result = await run(stage.command ?? "pnpm", stage.args, {
          cwd: root,
          stdio: stage.outputIncludes ? "pipe" : "inherit",
          encoding: "utf8",
          env: {
            ...environment,
            HOME: home,
            QUATI_DATA_DIR: join(home, "data"),
            XDG_CONFIG_HOME: join(home, ".config"),
            XDG_CACHE_HOME: join(home, ".cache"),
            XDG_DATA_HOME: join(home, ".local/share"),
            XDG_STATE_HOME: join(home, ".local/state"),
            DISPLAY: "",
            WAYLAND_DISPLAY: "",
            QUATI_EVAL_LIVE: "0",
            QUATI_UI_E2E: "0",
            QUATI_CDP_E2E: "0",
            ...stage.env,
          },
        });

        if (stage.outputIncludes) {
          process.stdout.write(result.stdout ?? "");
          process.stderr.write(result.stderr ?? "");
        }

        if (result.status !== 0 || result.error || (stage.outputIncludes && !result.stdout?.includes(stage.outputIncludes))) {
          failures.push(stage.name);
          console.error(result.error?.message ?? `${stage.name} failed (${result.signal ?? result.status}).`);
        }
      }));
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }

  console.log(failures.length ? `\nLocal CI failed: ${failures.join(", ")}` : "\nLocal CI passed.");
  return failures.length ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await runLocalCi();
}
