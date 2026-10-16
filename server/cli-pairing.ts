// What `openmausbot serve` and `openmausbot pair` print for a pairing code. A browser on this computer is no longer the
// owner just by being here, so it signs in once with the link printed for it.
import qrcode from "qrcode-terminal";

export function normalizePublicOrigin(raw: string): string | null {
  const value = raw.trim();
  // Reject control characters before URL parsing can silently remove them.
  // eslint-disable-next-line no-control-regex
  if (!/^https:\/\/[^/]/i.test(value) || /[\s\u0000-\u001f\u007f\\?#@]/.test(value)) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/") return null;
    if (!host || host === "localhost" || host.endsWith(".localhost") || host === "0.0.0.0" || host.startsWith("127.")) return null;
    if (host === "[::]" || host === "[::1]" || /^\[::ffff:(?:0:0|7f[0-9a-f]{2}:[0-9a-f]+)\]$/.test(host)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** The guided start's one sign-in, for the browser it opens on this computer. */
export function browserSignInLines(localUrl: string, code: string, expiresAt: number): string {
  return [
    "Sign in from a browser on this computer with this link (single use, until",
    `${new Date(expiresAt).toLocaleTimeString()}): ${localUrl}`,
    `or type the code ${code} on the sign-in page. Later: openmausbot pair`,
  ].join("\n");
}

export function qrToString(text: string): string {
  let out = "";
  qrcode.generate(text, { small: true }, (rendered: string) => {
    out = rendered;
  });
  return out;
}

export function pairingBlock(input: { code: string; url: string | null; localUrl?: string | null; expiresAt: number; hint?: string | null }): string {
  const lines = [`pairing code:  ${input.code}`, `expires:       ${new Date(input.expiresAt).toLocaleTimeString()} (single use)`];
  if (input.localUrl) lines.push(`this computer: ${input.localUrl}`);
  if (input.url) {
    lines.push(`open or scan:  ${input.url}`, "", qrToString(input.url));
  } else {
    lines.push("open:          /pair on the address you use for this server, and type the code");
    if (input.hint) lines.push(`               (${input.hint})`);
  }
  return lines.join("\n");
}
