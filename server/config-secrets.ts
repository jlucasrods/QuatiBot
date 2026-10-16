import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";
import { decryptBrowserState, encryptBrowserState } from "./encrypted-state.ts";

export const SECRET_FIELDS = {
  tts: ["key", "fishKey"],
  decider: ["key", "openrouterKey"],
  imageGen: ["key", "customApiKey"],
  live: ["key"],
} as const;

const secretsSchema = z.record(z.string(), z.record(z.string(), z.string()));

export function readConfigSecrets(dataDir: string) {
  const file = join(dataDir, "credentials.enc");
  if (!existsSync(file)) return {};

  try {
    const key = readFileSync(join(dataDir, "credentials-key"), "utf8").trim();
    if (!/^[0-9a-f]{64}$/.test(key)) throw new Error("invalid key");
    return secretsSchema.parse(JSON.parse(decryptBrowserState(readFileSync(file), key)));
  } catch {
    throw new Error("Server credentials cannot be decrypted. Restore the original credentials key before making changes.");
  }
}

export function saveConfigSecrets(dataDir: string, patch: Record<string, Record<string, string>>) {
  const secrets = readConfigSecrets(dataDir);
  for (const [section, fields] of Object.entries(patch)) secrets[section] = { ...secrets[section], ...fields };

  mkdirSync(dataDir, { recursive: true });
  const keyFile = join(dataDir, "credentials-key");
  const key = existsSync(keyFile) ? readFileSync(keyFile, "utf8").trim() : randomBytes(32).toString("hex");
  if (!/^[0-9a-f]{64}$/.test(key)) throw new Error("Server credentials key is invalid.");
  if (!existsSync(keyFile)) writeFileAtomic(keyFile, `${key}\n`, { mode: 0o600 });
  writeFileAtomic(join(dataDir, "credentials.enc"), encryptBrowserState(JSON.stringify(secrets), key), { mode: 0o600 });
}
