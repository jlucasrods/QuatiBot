import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { json, readBody } from "../harness/http.ts";
import { createPresetStore } from "../presets.ts";
import { requiredScope } from "../request-auth.ts";
import { parsePackageDocument } from "../../shared/package-format.ts";
import { createBotPresetRoutes } from "./bot-presets.ts";
import { dispatchRoutes } from "./table.ts";

const library = () => parsePackageDocument(JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "shared", "package-fixtures", "library-only.v2.json"), "utf8")));
const servers: Server[] = [];
const folders: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

async function serve() {
  const folder = mkdtempSync(join(tmpdir(), "quati-preset-routes-"));
  folders.push(folder);
  const presets = createPresetStore(join(folder, "presets.json"));
  const routes = [createBotPresetRoutes({ presets })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const handled = await dispatchRoutes(routes, {
      req, res, url, path: url.pathname, method: req.method ?? "GET",
      auth: { kind: "loopback", scopes: ["admin", "client"] }, json, readBody,
    });
    if (!handled) json(res, 404, { from: "inline routes" });
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, presets };
}

describe("/api/bot-presets through the route table", () => {
  it("lists imported file presets", async () => {
    const { base, presets } = await serve();
    expect(await (await fetch(`${base}/api/bot-presets`)).json()).toEqual({ presets: [] });
    presets.register(library(), { source: "file", installId: "file-1" });
    const listed = ((await (await fetch(`${base}/api/bot-presets`)).json()) as { presets: Array<{ source: string; publisherName?: string }> }).presets;
    expect(listed.map((preset) => [preset.source, preset.publisherName])).toEqual([["file", undefined]]);
  });

  it("removes an imported preset and leaves other paths to the next handler", async () => {
    const { base, presets } = await serve();
    const file = presets.register(library(), { source: "file", installId: "file-1" }).added[0]!.id;
    const remove = async (id: string) => { const response = await fetch(`${base}/api/bot-presets/${id}`, { method: "DELETE" }); return [response.status, await response.json()]; };
    expect(await remove(file)).toEqual([200, { ok: true }]);
    expect(await remove(file)).toEqual([404, { error: "That preset is no longer available. Choose another starting role." }]);
    expect(presets.list().map((row) => row.id)).toEqual([]);
    expect(await (await fetch(`${base}/api/bot-presets`, { method: "POST" })).json()).toEqual({ from: "inline routes" });
    expect(await (await fetch(`${base}/api/bot-presets/x/y`, { method: "DELETE" })).json()).toEqual({ from: "inline routes" });
  });

  it("is for admins only, like the New bot defaults, and so is creating a bot from a preset", () => {
    expect(requiredScope("GET", "/api/bot-presets")).toBe("admin");
    expect(requiredScope("DELETE", "/api/bot-presets/p1")).toBe("admin");
    expect(requiredScope("POST", "/api/bots")).toBe("admin");
    expect(requiredScope("POST", "/api/teams/export")).toBe("admin");
  });
});
