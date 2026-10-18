import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { verificationServerEnvironment } from "../scripts/control-quati.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

describe("operator service credentials", () => {
  let home = "";
  let base = "";
  let child: ChildProcess | undefined;
  let provider: Server | undefined;
  let output = "";
  const calls: Array<{ path: string; credential: string | undefined }> = [];

  async function api(path: string, body?: unknown) {
    return fetch(`${base}${path}`, {
      method: body === undefined ? "GET" : "PUT",
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  beforeAll(async () => {
    provider = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        const path = req.url ?? "";
        const credential = req.headers.authorization ?? req.headers["xi-api-key"];
        calls.push({ path, credential: typeof credential === "string" ? credential : undefined });
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(path === "/v1/systemone"
          ? { answers: { answer: { type: "noul", noul: 0.96 } } }
          : { voices: [{ voice_id: "fixture-voice", name: "Fixture voice" }] }));
      });
    });
    await new Promise<void>((resolve) => provider!.listen(0, "127.0.0.1", resolve));
    const address = provider.address();
    if (!address || typeof address === "string") throw new Error("missing fixture address");
    const providerUrl = `http://127.0.0.1:${address.port}`;

    home = mkdtempSync(join(tmpdir(), "quati-service-credentials-"));
    mkdirSync(join(home, "tmp"));
    writeFileSync(join(home, "config.json"), JSON.stringify({
      decider: { baseUrl: providerUrl },
      tts: { voice: "fixture-voice" },
    }));
    const port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [join(import.meta.dirname, "index.ts")], {
      cwd: join(import.meta.dirname, ".."),
      env: { ...verificationServerEnvironment(process.env, home, port), QUATI_ELEVENLABS_API: `${providerUrl}/v1` },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.on("data", (chunk) => { output += chunk; });
    child.stderr!.on("data", (chunk) => { output += chunk; });
    await vi.waitFor(async () => {
      if (child!.exitCode !== null) throw new Error(`fixture exited: ${output}`);
      expect((await api("/api/health")).status).toBe(200);
    }, { timeout: 20_000 });
  }, 30_000);

  afterAll(async () => {
    if (child) await waitForExit(child, { signal: "SIGTERM" });
    if (provider) await new Promise<void>((resolve) => provider!.close(() => resolve()));
    if (home) await removeTempDir(home);
  });

  it("saves encrypted credentials, uses only the operator endpoints and disables services when keys are cleared", async () => {
    const saved = await api("/api/config", { decider: { key: "tsk_fixture_decision" }, tts: { key: "fixture_voice_key" } });
    expect(saved.status).toBe(200);
    const config = await saved.json();
    expect(config).toMatchObject({ decider: { configured: true, enabled: true }, tts: { configured: true, ready: true } });
    const checked = await fetch(`${base}/api/decider/test`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(await checked.json()).toMatchObject({ ok: true });
    expect(await (await api("/api/tts/voices")).json()).toEqual({ voices: [{ id: "fixture-voice", label: "Fixture voice" }] });
    expect(calls).toContainEqual({ path: "/v1/systemone", credential: "Bearer tsk_fixture_decision" });
    expect(calls).toContainEqual({ path: "/v1/voices", credential: "fixture_voice_key" });

    const disk = readFileSync(join(home, "config.json"), "utf8");
    for (const secret of ["tsk_fixture_decision", "fixture_voice_key"]) {
      expect(disk).not.toContain(secret);
      expect(JSON.stringify(config)).not.toContain(secret);
    }
    const cleared = await api("/api/config", { decider: { key: "" }, tts: { key: "" } });
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toMatchObject({ decider: { configured: false, enabled: false }, tts: { configured: false, ready: false } });
  });

  it("refuses enabling decisions or synthesizing voice without a credential", async () => {
    const before = calls.length;
    expect((await api("/api/config", { decider: { enabled: true } })).status).toBe(400);
    const spoken = await fetch(`${base}/api/tts/speak`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Fixture speech" }),
    });
    expect(spoken.status).toBe(409);
    expect(calls.length).toBe(before);
  });
});
