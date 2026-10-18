import { expect, it } from "vitest";
import {
  CLOUD_IGNORED_KEYS, cloudHomeConfiguration, cloudHomeConfigured,
  cloudHomeOffersPlace, cloudHomePlaceRefusal, firstCloudTurnPatch, withoutIgnoredCloudKeys,
} from "./cloud-home.ts";
import { portableWorkspaceConfig, restoredWorkspaceConfig } from "./workspace-backup-policy.ts";

const secret = "S".repeat(43);
const machineId = "3f9c2a4e-8b1d-4c6e-9a7f-2d5e8c1b0a93";
const contract = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  QUATI_CLOUD_ROLE: "home", QUATI_CLOUD_MACHINE_ID: machineId, QUATI_CLOUD_ADMIN_URL: "https://cloud.example.test",
  QUATI_PUBLIC_URL: "https://quati-u-1a2b3c4d5e6f.fly.dev", QUATI_CLOUD_BOOTSTRAP_SECRET: secret, ...extra,
});
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
    expect(text.length).toBeLessThanOrEqual(160);
  }
});

it("records the first finished bot turn once, without importing onboarding from a moved workspace", () => {
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
