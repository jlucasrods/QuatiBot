import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";

vi.mock("./DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({ capabilities: {} }) }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  api: vi.fn(),
  useStore: () => ({ state: { appSettingsSection: "decisionModel", instances: [] }, dispatch: vi.fn() }),
}));


beforeEach(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("document", { documentElement: { dataset: {} } });
  setLocale("en");
});

afterEach(() => {
  vi.unstubAllGlobals();
  setLocale("en");
});

it.each(["decision", "jev", "typesafe", "rooms"])("finds Decision model by searching for %s", async (query) => {
  const { SECTIONS, sectionMatches } = await import("./SettingsModal");
  const decisionModel = SECTIONS.find((entry) => entry.id === "decisionModel")!;
  expect(sectionMatches(decisionModel, query)).toBe(true);
});

it("keeps Jev credentials and room routing available in Decision model", async () => {
  const { SettingsModal } = await import("./SettingsModal");
  const html = renderToStaticMarkup(createElement(SettingsModal));
  expect(html).toContain("Jev API key");
  expect(html).toContain("TypeSafe Jev");
  expect(html).toContain("https://typesafe.ai");
  expect(html).toContain(">Save</button>");
  expect(html).toContain(">Test</button>");
  expect(html).toContain("Who answers in rooms");
});
