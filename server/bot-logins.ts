import { loginPageCheck, loginPlace, loginSite, type LoginPlace } from "../shared/logins.ts";
import type { FillCandidate } from "./login-fill.ts";
import type { LoginStore } from "./login-store.ts";
import type { LoginRouteDeps } from "./routes/logins.ts";

/** What the bot's browser shows while the person answers a sign-in card. */
export interface ObservedPage {
  host: string;
  /** It has a password box, shown or not yet, or a username or email box: a sign-in page, or its first step. */
  signIn: boolean;
}

const OBSERVE_PAGE = `JSON.stringify({ href: location.href, signIn: Boolean(document.querySelector('input[type="password"], input[type="email"], input[autocomplete~="username"], input[autocomplete~="email"]')) })`;

/** Null when nothing a login could be filled on is open. */
export async function observeSignInPage(engine: (args: string[]) => Promise<Record<string, unknown> | null>): Promise<ObservedPage | null> {
  let value: unknown;
  try { value = (await engine(["eval", OBSERVE_PAGE]))?.result; } catch { return null; }
  for (let depth = 0; depth < 2 && typeof value === "string"; depth++) {
    try { value = JSON.parse(value); } catch { return null; }
  }
  const page = value as { href?: unknown; signIn?: unknown } | null;
  if (typeof page?.href !== "string") return null;
  const check = loginPageCheck(page.href);
  return check.ok ? { host: check.pageHost, signIn: page.signIn === true } : null;
}

/** A sign-in page on another site than the card's, which a login saved from the card fills only once the person, shown
 * that host on the card, confirms it: a page the bot chose must not receive a password saved for the site the card names. */
export function cardSignInElsewhere(cardHost: string, observed: ObservedPage | null): string | null {
  return observed?.signIn && loginSite(observed.host) !== loginSite(cardHost) ? observed.host : null;
}

/** Where a login saved from a sign-in card fills: the card's site, the sign-in page open on that site (else the card's
 * own host), and a sign-in page on another site when the person confirmed it. */
export function cardLoginPlace(cardHost: string, observed: ObservedPage | null, confirmedHost: unknown): LoginPlace {
  const onSite = observed?.signIn && loginSite(observed.host) === loginSite(cardHost) ? observed.host : cardHost;
  const elsewhere = cardSignInElsewhere(cardHost, observed);
  return loginPlace(cardHost, [onSite, ...(elsewhere && confirmedHost === elsewhere ? [elsewhere] : [])]);
}

/** Saved logins as each bot may use them. */
export class BotLogins {
  readonly store: LoginStore;

  constructor(store: LoginStore) {
    this.store = store;
  }

  /** Where each login the bot may use fills, with its username. */
  sitesFor(botId: string): Array<LoginPlace & { username: string }> {
    return this.store.sitesFor(botId);
  }

  /** Secrets are read only when one is filled. */
  async candidates(botId: string, pageHost: string): Promise<FillCandidate[]> {
    return this.store.usableFor(pageHost, botId).map((login): FillCandidate => ({
      id: login.id, site: login.site, hosts: login.hosts, exactHost: login.exactHost, username: login.username, source: login.source,
      secrets: async () => ({ password: login.password, totp: login.totp ?? null }),
    }));
  }

  markUsed(id: string): void {
    this.store.markUsed(id);
  }

  routes(botExists: (id: string) => boolean): LoginRouteDeps {
    return {
      list: () => this.store.list(),
      create: (input) => this.store.create(input),
      update: (id, patch) => this.store.update(id, patch),
      remove: (id) => this.store.remove(id),
      botExists,
    };
  }
}
