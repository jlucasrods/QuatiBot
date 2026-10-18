import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";
import { afterEach, expect, it } from "vitest";
import {
  CLOUD_HOME_MARKER, CLOUD_IGNORED_KEYS, cloudHomeConfiguration, cloudHomeConfigured,
  cloudHomeHost, cloudHomeOffersPlace, cloudHomePlaceRefusal, firstCloudTurnPatch, prepareCloudHomeVolume,
  withoutIgnoredCloudKeys,
} from "./cloud-home.ts";
import { cloudHomeChildEnvironments, codeTrustProblem, passwdIds, spawnWithSecrets } from "./cloud-home-start.ts";
import { RESTART_EXIT_CODE, restartPolicy } from "./restart.ts";
import { resolveRequestAuth } from "./request-auth.ts";
import { SessionRegistry } from "./sessions.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { portableWorkspaceConfig, restoredWorkspaceConfig } from "./workspace-backup-policy.ts";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await removeTempDir(directory); });
const directory = () => { const value = mkdtempSync(join(tmpdir(), "quati-cloud-home-")); directories.push(value); return value; };

// Shapes exactly as quati-cloud's provisioner writes them.
const secret = "S".repeat(43);
const machineId = "3f9c2a4e-8b1d-4c6e-9a7f-2d5e8c1b0a93";
const contract = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  QUATI_CLOUD_ROLE: "home", QUATI_CLOUD_MACHINE_ID: machineId, QUATI_CLOUD_ADMIN_URL: "https://cloud.example.test",
  QUATI_PUBLIC_URL: "https://quati-u-1a2b3c4d5e6f.fly.dev", QUATI_CLOUD_BOOTSTRAP_SECRET: secret, ...extra,
});
// A platform gateway's settings, as an Admin from before Cloud Pro dropped
// included AI wrote them. A Cloud home ignores them.
const token = `quati_cloudai_${"t".repeat(43)}`;
const gatewayUrl = "https://cloud.example.test/api/cloud/gateway/g0123456789abcdef0123456789abcd";
const withGateway = (extra: NodeJS.ProcessEnv = {}) => contract({ QUATI_HOSTED_MODEL_URL: gatewayUrl, QUATI_HOSTED_MODEL_TOKEN: token,
  QUATI_HOSTED_MODELS: JSON.stringify({ anthropic: ["claude-sonnet-5"], openai: ["gpt-5.6-sol"], openrouter: ["anthropic/claude-sonnet-5"] }), ...extra });


it("is off on every ordinary server and desktop", () => {
  expect(cloudHomeConfigured({})).toBe(false);
  expect(cloudHomeConfiguration({})).toBeNull();
  expect(cloudHomeConfiguration({ QUATI_PUBLIC_URL: "https://selfhosted.example.test", QUATI_HOSTED_MODELS: "{}" })).toBeNull();
});

it("reads the Admin's contract", () => {
  expect(cloudHomeConfiguration(contract())).toEqual({
    machineId, adminOrigin: "https://cloud.example.test", publicOrigin: "https://quati-u-1a2b3c4d5e6f.fly.dev", bootstrapSecret: secret, warnings: [],
  });
  expect(cloudHomeConfiguration(contract({ QUATI_CLOUD_ADMIN_URL: "https://cloud.example.test/" }))!.adminOrigin).toBe("https://cloud.example.test");
});

it("ignores a platform gateway's settings with one warning, whatever they hold, and never serves them", () => {
  const all = cloudHomeConfiguration(withGateway())!;
  expect(Object.keys(all).sort()).toEqual(["adminOrigin", "bootstrapSecret", "machineId", "publicOrigin", "warnings"]);
  expect(all.warnings).toEqual(["ignoring QUATI_HOSTED_MODEL_URL, QUATI_HOSTED_MODEL_TOKEN, QUATI_HOSTED_MODELS: Cloud Pro includes no AI; people sign in with their own Claude or ChatGPT account, or an API key"]);
  for (const stray of [{ QUATI_HOSTED_MODEL_TOKEN: token }, { QUATI_HOSTED_MODEL_TOKEN: "sk-ant-api03-platform-key" }, { QUATI_HOSTED_MODELS: "{not json" },
    { QUATI_HOSTED_MODEL_URL: "https://gateway.attacker.test/v1" }, { QUATI_HOSTED_MODELS: "" }]) {
    const config = cloudHomeConfiguration(contract(stray))!;
    expect(config.warnings).toEqual([expect.stringMatching(new RegExp(`^ignoring ${Object.keys(stray)[0]}: Cloud Pro includes no AI`))]);
    const value = Object.values(stray)[0];
    if (value) expect(JSON.stringify(config)).not.toContain(value);
  }
  expect(Object.keys(withoutIgnoredCloudKeys(withGateway())).filter((key) => (CLOUD_IGNORED_KEYS as readonly string[]).includes(key))).toEqual([]);
  expect(withoutIgnoredCloudKeys(withGateway())).toEqual(contract());
});

it.each<[string, NodeJS.ProcessEnv]>([
  ["only one key", { QUATI_CLOUD_MACHINE_ID: machineId }],
  ["no role", { ...contract(), QUATI_CLOUD_ROLE: undefined }],
  ["the desktop role", contract({ QUATI_CLOUD_ROLE: "desktop" })],
  ["no public URL", { ...contract(), QUATI_PUBLIC_URL: undefined }],
  ["an http Admin", contract({ QUATI_CLOUD_ADMIN_URL: "http://cloud.example.test" })],
  ["an Admin URL with a path", contract({ QUATI_CLOUD_ADMIN_URL: "https://cloud.example.test/api" })],
  ["an Admin URL with credentials", contract({ QUATI_CLOUD_ADMIN_URL: "https://user:pass@cloud.example.test" })],
  ["an http public URL", contract({ QUATI_PUBLIC_URL: "http://quati-u-1a2b3c4d5e6f.fly.dev" })],
  ["a machine id with a slash", contract({ QUATI_CLOUD_MACHINE_ID: "home/../x" })],
  ["a short secret", contract({ QUATI_CLOUD_BOOTSTRAP_SECRET: "S".repeat(42) })],
  ["a secret with padding", contract({ QUATI_CLOUD_BOOTSTRAP_SECRET: `${"S".repeat(42)}=` })],
  ["the desktop app", contract({ QUATI_DESKTOP_PARENT: "1" })],
  ["a hosted team workspace too", contract({ QUATI_ADMIN_URL: "https://cloud.example.test" })],
  ["a hosted team workspace with a gateway", withGateway({ QUATI_ADMIN_URL: "https://cloud.example.test", QUATI_ADMIN_WORKSPACE: "acme", QUATI_ADMIN_MEMBERSHIP: "portal" })],
])("refuses to start with %s", (_why, env) => {
  expect(() => cloudHomeConfiguration(env)).toThrow(/Cloud home configuration is invalid/);
});

it("never echoes a secret or token in its refusal", () => {
  for (const env of [contract({ QUATI_CLOUD_BOOTSTRAP_SECRET: `${secret}!` }), withGateway({ QUATI_CLOUD_BOOTSTRAP_SECRET: `${secret}!` })]) {
    try { cloudHomeConfiguration(env); expect.unreachable(); }
    catch (error) { expect(String(error)).not.toContain(secret); expect(String(error)).not.toContain(token); }
  }
});


it("offers the built-in browser and cloud computers, never this computer or a Local VM", () => {
  expect((["cloud", "vm", "local", "browser"] as const).filter(cloudHomeOffersPlace)).toEqual(["cloud", "browser"]);
  expect(cloudHomePlaceRefusal("cloud")).toBeUndefined();
  expect(cloudHomePlaceRefusal("browser")).toBeUndefined();
});

it("refuses the places it never offers with what is true there, not a setup step", () => {
  const local = cloudHomePlaceRefusal("local")!, vm = cloudHomePlaceRefusal("vm")!;
  expect(local).toBe("This computer isn't a place on My Cloud. Set Works on to Auto, Cloud computer or Browser, or lend your computer under Settings → Quati Cloud.");
  expect(vm).toBe("Bots on My Cloud can't use a Local VM. Set Works on to Auto, Cloud computer or Browser.");
  for (const text of [local, vm]) {
    expect(text).not.toMatch(/configure|Computer panel|install|set (?:it|one) up/i);
    // A failed turn shows the first 160 characters of its error.
    expect(text.length).toBeLessThanOrEqual(160);
  }
});


it("treats a request the edge forwards as remote, whatever Host it claims", () => {
  const sessions = new SessionRegistry({ file: join(directory(), "sessions.json") });
  const request = (headers: Record<string, string>) => ({ method: "GET", headers, socket: { remoteAddress: "127.0.0.1", remoteFamily: "IPv4" } }) as unknown as IncomingMessage;
  const url = new URL("http://localhost/api/bots");
  // What Caddy sends upstream: the public Host plus X-Forwarded-*.
  for (const headers of [
    { host: "home-7f3k2.fly.dev", "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https" },
    { host: "localhost:8799", "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https" },
  ]) {
    const result = resolveRequestAuth(request(headers), { sessions, cookieName: "quati_session_x", streamPath: "/api/events", url });
    expect(result.auth).toBeNull();
    expect(result.status).toBe(403);
  }
});


it("binds a fresh volume to its machine and refuses anyone else's data", () => {
  const home = directory();
  mkdirSync(join(home, "lost+found"));
  writeFileSync(join(home, ".bashrc"), "");
  expect(prepareCloudHomeVolume(home, "home-7f3k2")).toBe("new");
  expect(JSON.parse(readFileSync(join(home, CLOUD_HOME_MARKER), "utf8"))).toEqual({ version: 1, machine: "home-7f3k2" });
  expect(prepareCloudHomeVolume(home, "home-7f3k2")).toBe("existing");
  expect(() => prepareCloudHomeVolume(home, "home-other")).toThrow(/another Cloud machine/);
  const unmarked = directory();
  writeFileSync(join(unmarked, "notes.txt"), "someone's data");
  expect(() => prepareCloudHomeVolume(unmarked, "home-7f3k2")).toThrow(/Refusing to adopt/);
  expect(readFileSync(join(unmarked, "notes.txt"), "utf8")).toBe("someone's data");
});

it("gives the edge only its routing name and the server the contract, never a gateway's settings or a secret", () => {
  const relay = { QUATI_CLOUD_BOAT_TOKEN: `box_omb_${"b".repeat(43)}`, QUATI_CLOUD_VOICE_TOKEN: `quati_voice_${"v".repeat(43)}`, QUATI_CLOUD_DECIDER_TOKEN: `quati_decide_${"d".repeat(43)}`,
    QUATI_CLOUD_AI_TOKEN: `quati_ai_${"a".repeat(43)}` };
  const config = cloudHomeConfiguration(withGateway())!;
  const { server, edge, secrets } = cloudHomeChildEnvironments(config, { ...withGateway(), ...relay, PATH: "/usr/bin" }, "/data");
  expect(server).toMatchObject({ HOME: "/data", QUATI_DATA_DIR: "/data/.quatibot", QUATI_PORT: "8799", QUATI_WEBHOOK_PORT: "8800",
    QUATI_PUBLIC_URL: "https://quati-u-1a2b3c4d5e6f.fly.dev", QUATI_WEBHOOK_PUBLIC_URL: "https://quati-u-1a2b3c4d5e6f.fly.dev", QUATI_CLOUD_SECRETS_FD: "3" });
  for (const key of CLOUD_IGNORED_KEYS) expect(server).not.toHaveProperty(key);
  expect(JSON.stringify(server)).not.toContain(token);
  expect(secrets).toEqual({ QUATI_CLOUD_BOOTSTRAP_SECRET: secret, ...relay });
  for (const value of Object.values(secrets)) {
    expect(JSON.stringify(server)).not.toContain(value);
    expect(JSON.stringify(edge)).not.toContain(value);
  }
  expect(edge.QUATI_CLOUD_PUBLIC_HOST).toBe(cloudHomeHost(config));
  expect(JSON.stringify(edge)).not.toContain(token);
  expect(JSON.stringify(edge)).not.toContain(secret);
  expect(passwdIds("root:x:0:0::/root:/bin/sh\nquati:x:1001:1002::/data:/bin/bash\n", "quati")).toEqual({ uid: 1001, gid: 1002 });
  expect(passwdIds("root:x:0:0::/root:/bin/sh\n", "quati")).toBeNull();
});

it("gives the server only an allow-listed environment: a secret added later, a test's key or anything unknown never reaches it", () => {
  const config = cloudHomeConfiguration(contract())!;
  const env = { ...contract(), PATH: "/usr/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", NODE_ENV: "production", QUATI_STATIC_DIR: "/app/dist",
    QUATI_CLOUD_BOAT_URL: "https://cloud.example.test/boat", QUATI_TTS_DEFAULT_VOICE: "alloy", QUATI_CLOUD_AI_URL: "https://cloud.example.test/api/cloud/services/ai",
    QUATI_CLOUD_FUTURE_SECRET: "later", QUATI_TEST_CLOUD_LEFT_BEHIND_KEY: "k".repeat(43), FLY_API_TOKEN: "fly", SOME_TOKEN: "t", HOME: "/root" };
  const { server, dropped } = cloudHomeChildEnvironments(config, env, "/data");
  expect(server).toMatchObject({ PATH: "/usr/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", NODE_ENV: "production", QUATI_STATIC_DIR: "/app/dist",
    QUATI_CLOUD_ROLE: "home", QUATI_CLOUD_MACHINE_ID: machineId, QUATI_CLOUD_ADMIN_URL: "https://cloud.example.test",
    QUATI_CLOUD_BOAT_URL: "https://cloud.example.test/boat", QUATI_TTS_DEFAULT_VOICE: "alloy", QUATI_CLOUD_AI_URL: "https://cloud.example.test/api/cloud/services/ai", HOME: "/data" });
  for (const name of ["QUATI_CLOUD_FUTURE_SECRET", "QUATI_TEST_CLOUD_LEFT_BEHIND_KEY", "FLY_API_TOKEN", "SOME_TOKEN"]) {
    expect(server).not.toHaveProperty(name);
    expect(dropped).toContain(name);
  }
  expect(dropped).not.toContain("QUATI_CLOUD_BOOTSTRAP_SECRET");
});

it("the root supervisor runs and trusts only root's code, never the volume's or anything quati could rewrite", () => {
  const files = ["/usr/local/bin/node", "/app/dist-server/cloud-home-start.js", "/app/dist-server/index.js", "/usr/local/bin/caddy", "/app/cloud/Caddyfile"];
  const image = (overrides: Record<string, { uid: number; mode: number }> = {}) => (path: string) =>
    overrides[path] ?? { uid: 0, mode: path.includes(".") || path.endsWith("node") || path.endsWith("caddy") ? 0o100755 : 0o40755 };
  expect(codeTrustProblem(files, "/data", image())).toBeNull();
  expect(codeTrustProblem(files, "/data", image({ "/app/dist-server/index.js": { uid: 1001, mode: 0o100644 } }))).toBe("/app/dist-server/index.js is not root's");
  expect(codeTrustProblem(files, "/data", image({ "/app/dist-server/cloud-home-start.js": { uid: 0, mode: 0o100666 } }))).toBe("/app/dist-server/cloud-home-start.js is writable by others than root");
  expect(codeTrustProblem(files, "/data", image({ "/app/dist-server": { uid: 1001, mode: 0o40755 } }))).toBe("/app/dist-server is not root's");
  expect(codeTrustProblem(files, "/data", image({ "/app": { uid: 0, mode: 0o40777 } }))).toBe("/app is writable by others than root");
  expect(codeTrustProblem(["/tmp/caddy"], "/data", image({ "/tmp": { uid: 0, mode: 0o41777 } }))).toBeNull();
  expect(codeTrustProblem([...files, "/data/.local/bin/caddy"], "/data", image())).toBe("/data/.local/bin/caddy is on the volume");
  expect(codeTrustProblem(files, "/data", () => { throw new Error("ENOENT"); })).toBe("/usr/local/bin/node cannot be checked");
});

it("the Cloud launcher starts the server again only when it asks to after a restore, and only a few times in a row", () => {
  const launcher = readFileSync(join(import.meta.dirname, "cloud-home-start.ts"), "utf8");
  expect(launcher).toContain("const policy = restartPolicy();");
  expect(launcher).toContain("if (!policy.again(code, stopping)) return false;");
  for (const code of [0, 1, null]) expect(restartPolicy().again(code)).toBe(false);
  expect(restartPolicy().again(RESTART_EXIT_CODE, true)).toBe(false);
  const policy = restartPolicy(() => 0);
  expect([1, 2, 3, 4, 5, 6].map(() => policy.again(RESTART_EXIT_CODE, false))).toEqual([true, true, true, true, true, false]);
});

it("records the first finished bot turn once, on a Cloud home only, and a moved workspace never brings its own", () => {
  const now = new Date("2026-09-30T08:00:00.000Z");
  const turn = { cloudHome: true, recorded: undefined, ok: true, known: true, now };
  expect(firstCloudTurnPatch(turn)).toEqual({ onboarding: { firstTurnAt: "2026-09-30T08:00:00.000Z" } });
  expect(firstCloudTurnPatch({ ...turn, cloudHome: false })).toBeNull();
  expect(firstCloudTurnPatch({ ...turn, recorded: "2026-09-29T08:00:00.000Z" })).toBeNull();
  expect(firstCloudTurnPatch({ ...turn, ok: false })).toBeNull();
  expect(firstCloudTurnPatch({ ...turn, known: false })).toBeNull();
  const mac = { language: "en", onboarding: { completedAt: "2026-09-01T00:00:00.000Z", version: 1, firstTurnAt: "2026-08-01T00:00:00.000Z" } };
  expect(restoredWorkspaceConfig(portableWorkspaceConfig(mac), { onboarding: { hintsSeen: ["cloud-setup-hidden"] } }).onboarding)
    .toEqual({ hintsSeen: ["cloud-setup-hidden"] });
  expect(restoredWorkspaceConfig(portableWorkspaceConfig(mac), {}).onboarding).toBeUndefined();
});

// The launcher only runs on Linux (the image); Windows passes descriptors differently.
it.skipIf(process.platform === "win32")("hands the server its secrets over a pipe it reads once: never its environment, never a grandchild's", async () => {
  const dir = mkdtempSync(join(tmpdir(), "quati-cloud-secrets-"));
  try {
    const script = join(dir, "server.mjs");
    const out = join(dir, "out.json");
    // What a server does at startup (takeCloudSecrets), then what an engine
    // it starts could see: its own environment and its parent's starting one.
    writeFileSync(script, `
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
const { takeCloudSecrets } = await import(${JSON.stringify(join(import.meta.dirname, "cloud-home.ts"))});
const secrets = takeCloudSecrets();
const parentEnviron = (pid) => process.platform === "linux"
  ? readFileSync("/proc/" + pid + "/environ", "utf8")
  : execFileSync("ps", ["eww", "-p", String(pid), "-o", "command="]).toString();
const child = spawnSync(process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.env))"], { encoding: "utf8" });
writeFileSync(${JSON.stringify(out)}, JSON.stringify({ secrets, env: process.env, own: parentEnviron(process.pid), child: child.stdout }));
`);
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), QUATI_CLOUD_SECRETS_FD: "3", VISIBLE_PROBE: "visible" };
    const child = spawnWithSecrets(process.execPath, [script], env, { QUATI_CLOUD_BOOTSTRAP_SECRET: secret, QUATI_CLOUD_BOAT_TOKEN: "box_omb_probe-token" });
    await new Promise((resolve) => child.once("exit", resolve));
    const seen = JSON.parse(readFileSync(out, "utf8"));
    expect(seen.secrets).toEqual({ QUATI_CLOUD_BOOTSTRAP_SECRET: secret, QUATI_CLOUD_BOAT_TOKEN: "box_omb_probe-token" });
    if (process.platform !== "win32") expect(seen.own).toContain("VISIBLE_PROBE=visible");
    for (const where of [seen.own, JSON.stringify(seen.env), seen.child]) {
      expect(where).not.toContain(secret);
      expect(where).not.toContain("box_omb_probe-token");
    }
    expect(seen.child).not.toContain("QUATI_CLOUD_SECRETS_FD");
  } finally {
    await removeTempDir(dir);
  }
});

it("captures a child's stdout and stderr when asked, and shares this process's otherwise", async () => {
  const dir = directory();
  const script = join(dir, "streams.mjs");
  writeFileSync(script, `process.stdout.write("stdout marker"); process.stderr.write("stderr marker");`);
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) };
  const run = async (capture: boolean) => {
    const child = spawnWithSecrets(process.execPath, [script], env, { QUATI_CLOUD_BOOTSTRAP_SECRET: secret }, undefined, capture);
    let out = "", err = "";
    child.stdout?.on("data", (chunk) => { out += chunk; });
    child.stderr?.on("data", (chunk) => { err += chunk; });
    await new Promise((resolve) => child.once("close", resolve));
    return { child, out, err };
  };
  const captured = await run(true);
  expect(captured.out).toContain("stdout marker");
  expect(captured.err).toContain("stderr marker");
  const shared = await run(false);
  expect(shared.child.stdout).toBeNull();
  expect(shared.child.stderr).toBeNull();
});
