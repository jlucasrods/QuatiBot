import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BotLogins, cardLoginPlace, cardSignInElsewhere, observeSignInPage } from "./bot-logins.ts";
import { LoginStore } from "./login-store.ts";
import { FakeLoginPage, LOGIN_FORM } from "./testing/fake-login-page.ts";

let page: FakeLoginPage | null = null;
afterEach(() => { page?.close(); page = null; });

describe("local logins available to a bot", () => {
  it.each([
    ["pepper", "accounts.example.com", true],
    ["pepper", "login.microsoftonline.com", true],
    ["pepper", "www.example.com", false],
    ["quill", "accounts.example.com", false],
    ["pepper", "evil.test", false],
  ])("respects bot %s and host %s when selecting a login", async (botId, host, allowed) => {
    const dir = mkdtempSync(join(tmpdir(), "quati-bot-logins-"));
    try {
      const store = new LoginStore({ dataDir: dir, now: () => 7 });
      const login = store.create({
        site: "example.com", hosts: ["accounts.example.com", "login.microsoftonline.com"], exactHost: true,
        username: "alice", password: "fixture-password", source: "card", bots: ["pepper"],
      });
      const logins = new BotLogins(store);

      const candidates = await logins.candidates(botId, host);
      expect(candidates.map((candidate) => candidate.id)).toEqual(allowed ? [login.id] : []);
      expect(logins.sitesFor(botId).map((site) => site.username)).toEqual(botId === "pepper" ? ["alice"] : []);
      if (allowed) {
        expect(await candidates[0]!.secrets()).toEqual({ password: "fixture-password", totp: null });
        logins.markUsed(login.id);
        expect(store.list()[0]!.lastUsedAt).toBe(7);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a login saved from a sign-in card", () => {
  it("fills on the card's site, at the sign-in page open on that site", () => {
    expect(cardLoginPlace("example.com", { host: "accounts.example.com", signIn: true }, undefined))
      .toEqual({ site: "example.com", hosts: ["accounts.example.com"], exactHost: false });
    expect(cardLoginPlace("example.com", { host: "www.example.com", signIn: false }, undefined))
      .toEqual({ site: "example.com", hosts: ["example.com"], exactHost: false });
    expect(cardLoginPlace("example.com", null, undefined)).toEqual({ site: "example.com", hosts: ["example.com"], exactHost: false });
  });

  it("adds a sign-in page on another site only when the person confirmed that host", () => {
    const microsoft = { host: "login.microsoftonline.com", signIn: true };
    expect(cardSignInElsewhere("example.com", microsoft)).toBe("login.microsoftonline.com");
    expect(cardLoginPlace("example.com", microsoft, "login.microsoftonline.com"))
      .toEqual({ site: "example.com", hosts: ["example.com", "login.microsoftonline.com"], exactHost: false });
    expect(cardLoginPlace("example.com", microsoft, undefined).hosts).toEqual(["example.com"]);
    expect(cardLoginPlace("example.com", microsoft, "evil.test").hosts).toEqual(["example.com"]);
    expect(cardSignInElsewhere("example.com", { host: "evil.test", signIn: false })).toBeNull();
    expect(cardLoginPlace("example.com", { host: "evil.test", signIn: false }, "evil.test").hosts).toEqual(["example.com"]);
  });
});

describe("the bot's open page", () => {
  it("is read as its host and whether it shows a password, username or email box, only for a page a login could be filled on", async () => {
    page = new FakeLoginPage("https://login.microsoftonline.com/common/oauth2/authorize?client_id=x", LOGIN_FORM);
    expect(await observeSignInPage((args) => page!.engine(args))).toEqual({ host: "login.microsoftonline.com", signIn: true });
    page.navigate("https://login.example.net/u/login/identifier", `<form><input name="username" autocomplete="username"><button>Continue</button></form>`);
    expect(await observeSignInPage((args) => page!.engine(args))).toEqual({ host: "login.example.net", signIn: true });
    page.navigate("https://example.com/dashboard", "<h1>Hello</h1>");
    expect(await observeSignInPage((args) => page!.engine(args))).toEqual({ host: "example.com", signIn: false });
    page.navigate("http://example.com/login", LOGIN_FORM);
    expect(await observeSignInPage((args) => page!.engine(args))).toBeNull();
    expect(await observeSignInPage(async () => null)).toBeNull();
    expect(await observeSignInPage(async () => { throw new Error("The browser did not answer."); })).toBeNull();
  });
});
