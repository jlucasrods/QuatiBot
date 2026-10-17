// Bundles each harness-server entry point into a self-contained ESM file: the
// packaged app ships no node_modules. Entry points keep their exact relative
// paths under dist-server, where the server locates each proxy by path.
import { build } from "esbuild";
import { rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const server = join(root, "server");
rmSync(join(root, "dist-server", "enterprise"), { recursive: true, force: true });
rmSync(join(root, "dist-server", "model-catalog"), { recursive: true, force: true });

// yaml's Node export is CommonJS with dynamic requires that cannot run once
// inlined into ESM; its browser export is the same parser without them.
const yamlEsmPlugin = {
  name: "yaml-esm",
  setup(build) {
    build.onResolve({ filter: /^yaml$/ }, () => ({
      path: join(root, "node_modules", "yaml", "browser", "index.js"),
    }));
  },
};

// Every file run as its own process.
const ENTRY_POINTS = [
  "index.ts",
  "message-search.worker.ts",
  // the `quatibot` command
  "quatibot.ts",
  "pair-cli.ts",
  "workspace-backup.worker.ts",
  // the QUATI Cloud Pro home image's entry point
  "cloud-home-start.ts",
  // the container image's entry point
  "server-launcher.ts",
  // Imported directly by the packaged smoke probes. An explicit root sibling,
  // because tsc may emit its own copy under dist-server/server/.
  "proxy-paths.ts",
  // the hook helper Claude Code runs at PostToolUse/PreCompact/SessionStart/Stop
  "hooks/quati-hook.ts",
  "container-mcp.ts",
  "permission-proxy.ts",
  "mcp-gate.ts",
  "mcp-remote-proxy.ts",
  "harness-mcp-proxy.ts",
  "drivers/agents-proxy.ts",
  "drivers/dweb-proxy.ts",
  "drivers/phone-proxy.ts",
];

await build({
  entryPoints: ENTRY_POINTS.map((entry) => join(server, entry)),
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  outbase: server,
  outdir: join(root, "dist-server"),
  // Written after tsc, replacing its output for these entry points.
  allowOverwrite: true,
  logLevel: "info",
  plugins: [yamlEsmPlugin],
});

// External MCP clients launch this as an independent stdio process, so release
// users need no repository, TypeScript, pnpm or node_modules.
await build({
  entryPoints: [join(root, "scripts", "mcp-server.ts")],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile: join(root, "dist-server", "mcp-server.js"),
  allowOverwrite: true,
  logLevel: "info",
});

writeFileSync(join(root, "dist-server", "package.json"), '{"type":"module"}\n');
