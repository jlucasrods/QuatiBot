import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { PairPage } from "./PairPage";

const pair = vi.hoisted(() => vi.fn());
vi.mock("../lib/session", async original => ({ ...await original<typeof import("../lib/session")>(), pairWithCode: pair }));

it.each([
  { code: null, value: "", disabled: true },
  { code: "ABCD", value: "ABCD", disabled: true },
  { code: "ABCD-EFGH-JK23", value: "ABCD-EFGH-JK23", disabled: false },
])("requires confirmation of pairing code $code", ({ code, value, disabled }) => {
  const html = renderToStaticMarkup(createElement(PairPage, { initialCode: code }));
  expect(html).toContain(`value="${value}"`);
  expect(html).toContain("Pairing code");
  expect(html).toContain("This device");
  expect(/<button[^>]* disabled=""/.test(html)).toBe(disabled);
  expect(pair).not.toHaveBeenCalled();
});

it("shows an expired-session reason alongside the pairing form", () => {
  const html = renderToStaticMarkup(createElement(PairPage, { initialCode: null, reason: "This session has expired." }));
  expect(html).toContain("This session has expired.");
  expect(html).toContain("Codes work once");
});
