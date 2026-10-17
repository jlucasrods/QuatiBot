import "../testing/scrub-ambient-quati-env.ts";

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

import { removeTempDir } from "../testing/cleanup.ts";
import { HeadlessError } from "./args.ts";
import { explain, namedServer, openClient, readToken } from "./client.ts";

const dir = mkdtempSync(join(tmpdir(), "quati-client-"));
afterAll(() => removeTempDir(dir));

describe("the server and the credential", () => {
  it("takes flags before the environment, and --url before --port", () => {
    expect(namedServer({ url: "https://a.example", port: "1" }, { QUATIBOT_URL: "https://b.example" })).toEqual({ url: "https://a.example" });
    expect(namedServer({ port: "19990" }, { QUATIBOT_URL: "https://b.example" })).toEqual({ port: "19990" });
    expect(namedServer({}, { QUATIBOT_URL: "https://b.example", QUATI_PORT: "1" })).toEqual({ url: "https://b.example" });
    expect(namedServer({}, { QUATI_PORT: "8123" })).toEqual({ port: "8123" });
    expect(namedServer({}, {})).toBeUndefined();
  });

  it("reads the token from --token-file or QUATIBOT_TOKEN, never from the command line", () => {
    const file = join(dir, "token");
    writeFileSync(file, "quati_sess_from_file\n");
    expect(readToken({ "token-file": file }, { QUATIBOT_TOKEN: "quati_sess_env" })).toBe("quati_sess_from_file");
    expect(readToken({}, { QUATIBOT_TOKEN: " quati_sess_env " })).toBe("quati_sess_env");
    expect(readToken({}, {})).toBeUndefined();
    writeFileSync(join(dir, "empty"), "\n");
    expect(() => readToken({ "token-file": join(dir, "empty") }, {})).toThrow("is empty");
    expect(() => readToken({ "token-file": join(dir, "missing") }, {})).toThrow("could not be read (ENOENT)");
  });

  it("sends the token with every call to a named server, and never while looking for one", async () => {
    const request = vi.fn(async () => ({ ok: true }));
    const client = await openClient({ url: "http://127.0.0.1:19990" }, { env: { QUATIBOT_TOKEN: "quati_sess_abc" }, request }, false);
    await client.json("/api/bots?messages=0");
    expect(request).toHaveBeenCalledWith("/api/bots?messages=0", expect.objectContaining({ headers: expect.any(Headers) }), "http://127.0.0.1:19990");
    expect((request.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toEqual(new Headers({ Authorization: "Bearer quati_sess_abc" }));
    await expect(openClient({}, { env: { QUATIBOT_TOKEN: "quati_sess_abc" } }, false)).rejects.toMatchObject({ exitCode: 2, message: expect.stringContaining("never sent while looking") });
    await expect(openClient({ url: "http://10.0.0.5:8799" }, { env: {} }, false)).rejects.toMatchObject({ exitCode: 2, message: expect.stringContaining("Insecure cleartext HTTP") });
    await expect(openClient({ port: "70000" }, { env: {} }, false)).rejects.toMatchObject({ exitCode: 2 });
  });

  it("refuses control-quati's changes on a server it merely found", async () => {
    await expect(openClient({}, { env: {}, requireExplicitForMutations: true }, true))
      .rejects.toMatchObject({ message: "mutating commands require an explicit QuatiBot instance", exitCode: 2 });
  });
});

describe("explain", () => {
  it("turns refusals and unreachable servers into exit codes a script can branch on", async () => {
    const status = (code: number, message = "nope") => Object.assign(new Error(message), { status: code });
    expect(await explain(status(401))).toMatchObject({ exitCode: 5, hint: expect.stringContaining("--token-file") });
    expect(await explain(status(403, "admin scope required"))).toMatchObject({ exitCode: 5, message: "not allowed: admin scope required" });
    expect(await explain(status(409, "stop this bot's turn first"))).toMatchObject({ exitCode: 1, message: "stop this bot's turn first" });
    expect(await explain(status(409, 'QuatiBot API error (409): {"error":"stop this bot\'s turn first","code":"thread_busy"}')))
      .toMatchObject({ exitCode: 1, message: "stop this bot's turn first" });
    expect(await explain(status(403, 'QuatiBot API error (403): {"error":"admin scope required"}'))).toMatchObject({ message: "not allowed: admin scope required" });
    expect(await explain(status(502, "QuatiBot API error (502): <html>Bad gateway</html>"))).toMatchObject({ message: "QuatiBot API error (502): <html>Bad gateway</html>" });
    expect(await explain(status(404, 'QuatiBot API error (404): {"error":"no such bot"}'))).toMatchObject({ exitCode: 2, message: "no such bot" });
    expect(await explain(status(404, "QuatiBot API error (404): not found"))).toMatchObject({ exitCode: 1 });
    expect(await explain(new TypeError("fetch failed"), "http://127.0.0.1:1")).toMatchObject({ exitCode: 5, message: "cannot reach QuatiBot at http://127.0.0.1:1" });
    expect(await explain(Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }))).toMatchObject({ exitCode: 5 });
    const kept = new HeadlessError("as it was", 4, "hint");
    expect(await explain(kept)).toBe(kept);
    const { ToolInputError } = await import("../../scripts/mcp-server.ts");
    expect(await explain(new ToolInputError("send_id must be 16-80 letters"))).toMatchObject({ exitCode: 2 });
  });
});
