import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { readConfigSecrets, saveConfigSecrets } from "./config-secrets.ts";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

it("persists encrypted auxiliary credentials without touching an old desktop vault", () => {
  const home = mkdtempSync(join(tmpdir(), "quati-server-secrets-"));
  homes.push(home);
  writeFileSync(join(home, "credentials.bin"), "old-os-ciphertext");
  saveConfigSecrets(home, { decider: { key: "fake-jev-secret" }, tts: { key: "fake-voice-secret" } });
  saveConfigSecrets(home, { tts: { key: "" } });

  expect(readConfigSecrets(home)).toEqual({ decider: { key: "fake-jev-secret" }, tts: { key: "" } });
  expect(readFileSync(join(home, "credentials.enc"), "utf8")).not.toContain("fake-jev-secret");
  expect(readFileSync(join(home, "credentials.bin"), "utf8")).toBe("old-os-ciphertext");
  if (process.platform !== "win32") {
    for (const file of ["credentials.enc", "credentials-key"]) expect(statSync(join(home, file)).mode & 0o777).toBe(0o600);
  }
});

it.each(["missing", "wrong", "malformed"])("refuses reads and writes with a %s vault key", (key) => {
  const home = mkdtempSync(join(tmpdir(), "quati-server-secrets-"));
  homes.push(home);
  saveConfigSecrets(home, { decider: { key: "fake-jev-secret" } });
  const before = readFileSync(join(home, "credentials.enc"));
  if (key === "missing") rmSync(join(home, "credentials-key"));
  else writeFileSync(join(home, "credentials-key"), key === "wrong" ? "a".repeat(64) : "invalid");

  expect(() => readConfigSecrets(home)).toThrow("cannot be decrypted");
  expect(() => saveConfigSecrets(home, { decider: { key: "replacement" } })).toThrow("cannot be decrypted");
  expect(readFileSync(join(home, "credentials.enc"))).toEqual(before);
});
