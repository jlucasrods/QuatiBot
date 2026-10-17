import { expect, it } from "vitest";
import { allowedScopes, parseAllowList } from "./session-membership.ts";

it.each([
  { input: undefined, expected: [] },
  { input: " Alice@Example.test, @TEAM.test\nBob@Example.test ", expected: ["alice@example.test", "@team.test", "bob@example.test"] },
])("normalizes saved membership entries", ({ input, expected }) => {
  expect(parseAllowList(input)).toEqual(expected);
});

it.each([
  { email: "ALICE@example.test", scopes: ["admin", "client"] },
  { email: "person@team.test", scopes: ["client"] },
  { email: "@team.test", scopes: null },
  { email: "person@otherteam.test", scopes: null },
  { email: "stranger@example.test", scopes: null },
  { email: "invalid", scopes: null },
])("retains local session membership for $email", ({ email, scopes }) => {
  expect(allowedScopes(email, { admins: ["alice@example.test"], members: ["@team.test"] })).toEqual(scopes);
});
