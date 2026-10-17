import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runPair, type CliOptions } from "./cli.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const code = "ABCD-EFGH-JKLM";
const advertised = "https://current.example.test/pair#code=" + code;
let dataDir: string;
let options: CliOptions;
let pairingStatus: number;
let publicLink: string | null;
const request = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.resetAllMocks();
  dataDir = mkdtempSync(join(process.env.HOME!, "cli-pair-"));
  vi.stubEnv("QUATI_DATA_DIR", dataDir);
  options = { command: "pair", port: 18451, dataDir, tailscale: false, client: false, pair: true, json: false };
  pairingStatus = 200;
  publicLink = advertised;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  request.mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === "http://127.0.0.1:18451/api/health") return Response.json({ app: "quatibot", pid: 12345 });
    if (url === "http://127.0.0.1:18451/api/auth/pairing" && init?.method === "POST") {
      return Response.json({ code, expiresAt: Date.now() + 300_000, url: publicLink, error: "Pairing refused" }, { status: pairingStatus });
    }
    throw new Error(`Unexpected fixture request: ${url}`);
  });
  vi.stubGlobal("fetch", request);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await removeTempDir(dataDir);
});

it.each([
  { client: false, expected: { label: "Browser" } },
  { client: true, expected: { label: "Browser", scopes: ["client"] } },
])("mints a browser pairing with client scope $client", async ({ client, expected }) => {
  expect(await runPair({ ...options, client, label: "Browser" })).toBe(0);
  const submissions = request.mock.calls.filter(([, init]) => init?.method === "POST");
  expect(submissions).toHaveLength(1);
  expect(JSON.parse(String(submissions[0][1]?.body))).toEqual(expected);
  const printed = vi.mocked(console.log).mock.calls.map(([line]) => String(line)).join("\n");
  expect(printed).toContain(`pairing code:  ${code}`);
  expect(printed).toContain(advertised);
  expect(printed).toMatch(/[▀▄█]/);
});

it.each([
  { publicUrl: undefined, serverLink: advertised, expected: advertised },
  { publicUrl: "https://override.example.test", serverLink: advertised, expected: `https://override.example.test/pair#code=${code}` },
  { publicUrl: undefined, serverLink: null, expected: `http://127.0.0.1:18451/pair#code=${code}` },
])("prints the reachable link $expected", async ({ publicUrl, serverLink, expected }) => {
  publicLink = serverLink;
  expect(await runPair({ ...options, publicUrl })).toBe(0);
  expect(vi.mocked(console.log).mock.calls.map(([line]) => String(line)).join("\n")).toContain(expected);
});

it("reports a refused pairing request", async () => {
  pairingStatus = 403;
  await expect(runPair(options)).rejects.toThrow("server refused to mint a pairing code: Pairing refused");
});

it("requires a running backend before requesting a code", async () => {
  request.mockResolvedValue(Response.json({}, { status: 503 }));
  expect(await runPair(options)).toBe(1);
  expect(request.mock.calls.every(([, init]) => init?.method !== "POST")).toBe(true);
});
