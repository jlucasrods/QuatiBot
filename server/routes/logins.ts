// No answer ever carries a password or a 2FA key: a saved secret is only ever replaced.
import { LOGIN_FIELD_MAX, loginPlace, normalizeLoginHost, type LoginBots, type LoginSummary } from "../../shared/logins.ts";
import type { LoginPatch, NewLogin } from "../login-store.ts";
import { parseTotpKey, type TotpKey } from "../totp.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface LoginRouteDeps {
  list(): LoginSummary[];
  create(input: NewLogin): LoginSummary;
  update(id: string, patch: LoginPatch): LoginSummary | null;
  remove(id: string): boolean;
  botExists(id: string): boolean;
}

const ID = /^[\w-]{1,128}$/u;

export const LOGIN_ERRORS = {
  site: "Enter the address of the login page, such as accounts.example.com.",
  password: "Enter the password.",
  long: `Usernames and passwords can be at most ${LOGIN_FIELD_MAX} characters.`,
  totp: "That 2FA key is not valid. Paste the setup key (letters A–Z and digits 2–7) or the otpauth:// address from the site's QR code.",
  bots: "Choose every bot, or bots that exist.",
  exactHost: "exactHost must be true or false.",
  unavailable: "This external login is no longer available. Save a local login in Settings instead.",
} as const;

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** Absent leaves it; "" or null clears it. */
export function parseTotpField(value: unknown): Parsed<TotpKey | null | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (value === null || (typeof value === "string" && !value.trim())) return { ok: true, value: null };
  const key = parseTotpKey(value);
  return key ? { ok: true, value: key } : { ok: false, error: LOGIN_ERRORS.totp };
}

export function parseLoginFields(body: Record<string, unknown>, options: { passwordRequired: boolean }): Parsed<{ username?: string; password?: string }> {
  const username = body.username;
  const password = body.password;
  if (username !== undefined && typeof username !== "string") return { ok: false, error: "username must be text" };
  if (password !== undefined && typeof password !== "string") return { ok: false, error: LOGIN_ERRORS.password };
  if (options.passwordRequired && !password) return { ok: false, error: LOGIN_ERRORS.password };
  if (password !== undefined && !password) return { ok: false, error: LOGIN_ERRORS.password };
  if ((username?.length ?? 0) > LOGIN_FIELD_MAX || (password?.length ?? 0) > LOGIN_FIELD_MAX) return { ok: false, error: LOGIN_ERRORS.long };
  return { ok: true, value: { ...(username === undefined ? {} : { username: username.trim() }), ...(password === undefined ? {} : { password }) } };
}

function parseBots(value: unknown, exists: (id: string) => boolean): Parsed<LoginBots | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (value === "all") return { ok: true, value: "all" };
  if (!Array.isArray(value) || value.length > 500 || !value.every((id) => typeof id === "string" && ID.test(id) && exists(id))) {
    return { ok: false, error: LOGIN_ERRORS.bots };
  }
  return { ok: true, value: [...new Set(value as string[])] };
}

function isJson(req: { headers: Record<string, string | string[] | undefined> }): boolean {
  return String(req.headers["content-type"] ?? "").split(";", 1)[0]!.trim().toLowerCase() === "application/json";
}

export function createLoginRoutes(deps: LoginRouteDeps): RouteHandler {
  return async ({ req, res, path, method, json, readBody }) => {
    if (path !== "/api/logins" && !path.startsWith("/api/logins/")) return PASS;
    res.setHeader("cache-control", "no-store");
    if (path === "/api/logins" && method === "GET") {
      return json(res, 200, { logins: deps.list() });
    }
    // JSON only, so a form posted from another local page cannot add or change one.
    if (method !== "GET" && method !== "DELETE" && !isJson(req)) return json(res, 415, { error: "content-type must be application/json" });
    if (path === "/api/logins" && method === "POST") {
      const body = await readBody(req, 16_384);
      if (!body || typeof body !== "object" || Array.isArray(body)) return json(res, 400, { error: "send the login as a JSON object" });
      const host = normalizeLoginHost(body.site);
      if (!host) return json(res, 400, { error: LOGIN_ERRORS.site });
      const fields = parseLoginFields(body, { passwordRequired: true });
      if (!fields.ok) return json(res, 400, { error: fields.error });
      const totp = parseTotpField(body.totp);
      if (!totp.ok) return json(res, 400, { error: totp.error });
      const bots = parseBots(body.bots ?? "all", deps.botExists);
      if (!bots.ok) return json(res, 400, { error: bots.error });
      if (body.exactHost !== undefined && typeof body.exactHost !== "boolean") return json(res, 400, { error: LOGIN_ERRORS.exactHost });
      const login = deps.create({
        ...loginPlace(host, [], body.exactHost === true), username: fields.value.username ?? "", password: fields.value.password!,
        totp: totp.value ?? null, source: "settings", bots: bots.value ?? "all",
      });
      return json(res, 201, { login });
    }
    const id = path.slice("/api/logins/".length);
    if (/^1password(?::|%3a)/iu.test(id)) return json(res, 410, { error: LOGIN_ERRORS.unavailable });
    if (!ID.test(id)) return json(res, 404, { error: "no such login" });
    if (method === "DELETE") {
      return deps.remove(id) ? json(res, 200, { ok: true }) : json(res, 404, { error: "no such login" });
    }
    if (method !== "PATCH") return json(res, 405, { error: "method not allowed" });
    const body = await readBody(req, 16_384);
    if (!body || typeof body !== "object" || Array.isArray(body)) return json(res, 400, { error: "send the change as a JSON object" });
    const fields = parseLoginFields(body, { passwordRequired: false });
    if (!fields.ok) return json(res, 400, { error: fields.error });
    const totp = parseTotpField(body.totp);
    if (!totp.ok) return json(res, 400, { error: totp.error });
    const bots = parseBots(body.bots, deps.botExists);
    if (!bots.ok) return json(res, 400, { error: bots.error });
    if (body.exactHost !== undefined && typeof body.exactHost !== "boolean") return json(res, 400, { error: LOGIN_ERRORS.exactHost });
    const login = deps.update(id, {
      ...fields.value,
      ...(totp.value === undefined ? {} : { totp: totp.value }),
      ...(bots.value === undefined ? {} : { bots: bots.value }),
      ...(body.exactHost === undefined ? {} : { exactHost: body.exactHost }),
    });
    return login ? json(res, 200, { login }) : json(res, 404, { error: "no such login" });
  };
}
