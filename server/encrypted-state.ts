import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export function decryptBrowserState(data: Buffer, key: string): string {
  if (data.length < 29) throw new Error("Saved encrypted state is too short.");
  const decipher = createDecipheriv("aes-256-gcm", createHash("sha256").update(key).digest(), data.subarray(0, 12));
  decipher.setAuthTag(data.subarray(data.length - 16));
  return Buffer.concat([decipher.update(data.subarray(12, data.length - 16)), decipher.final()]).toString("utf8");
}

export function encryptBrowserState(text: string, key: string): Buffer {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", createHash("sha256").update(key).digest(), nonce);
  const body = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]);
}
