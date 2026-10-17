import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import type { AppSettingsSection } from "@/state/store";
import type { Switch } from "./SettingsPrimitives";
import { SECTIONS, SIMPLE_HIDDEN_SECTIONS, SIMPLE_PAGES, SettingsModal, revealSettingsBlock } from "./SettingsModal";

const fixture = vi.hoisted(() => ({
  section: "general" as AppSettingsSection,
  advancedMode: false,
  config: { features: { browser: false }, browserEngine: { kind: "bundled", installable: true } } as Record<string, unknown>,
  api: vi.fn(),
  dispatch: vi.fn(),
  switches: [] as ComponentProps<typeof Switch>[],
  ownerOrAdmin: null as boolean | null,
}));

vi.mock("./DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({ capabilities: {} }) }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  api: fixture.api,
  useStore: () => ({ state: { appSettingsSection: fixture.section, instances: [], bots: [], config: fixture.config }, dispatch: fixture.dispatch }),
}));
vi.mock("@/lib/interface-mode", () => ({
  useAdvancedMode: () => fixture.advancedMode,
  setAdvancedMode: vi.fn(),
}));

vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => fixture.ownerOrAdmin }));
vi.mock("./SettingsPrimitives", async (importOriginal) => {
  const original = await importOriginal<typeof import("./SettingsPrimitives")>();
  return {
    ...original,
    Switch: (props: ComponentProps<typeof Switch>) => {
      fixture.switches.push(props);
      return createElement(original.Switch, props);
    },
  };
});
// Each page's own content has its own tests; here a marker says which ran.
const { marker } = vi.hoisted(() => ({
  marker: (name: string) => () => `MARKER:${name};`,
}));
vi.mock("./EnginesSettings", () => ({ EnginesSettings: marker("engines") }));
vi.mock("./DecisionModelSettings", () => ({ DecisionModelSettings: marker("decisionModel") }));
vi.mock("./CustomDomainSettings", () => ({ CustomDomainSettings: marker("remoteAccess") }));
vi.mock("./LocalComputerSection", () => ({ LocalComputerSection: marker("computer") }));
vi.mock("./ActivitySection", () => ({ ActivitySection: marker("activity") }));
vi.mock("./UsageSection", () => ({ UsageSection: marker("usage") }));
vi.mock("./WorkspaceBackupSettings", () => ({ WorkspaceBackupSettings: marker("backups") }));
vi.mock("./RoomTurnTimeoutSettings", () => ({ RoomTurnTimeoutSettings: () => null }));

beforeEach(() => {
  vi.clearAllMocks();
  fixture.section = "general";
  fixture.advancedMode = false;
  fixture.config = { features: { browser: false }, browserEngine: { kind: "bundled", installable: true } };
  fixture.switches = [];
  fixture.ownerOrAdmin = null;
  fixture.api.mockResolvedValue({});
  vi.stubGlobal("window", {});
  vi.stubGlobal("document", { documentElement: { dataset: {} } });
  setLocale("en");
});

afterEach(() => {
  vi.unstubAllGlobals();
  setLocale("en");
});

const render = () => renderToStaticMarkup(createElement(SettingsModal));
const pages = (html: string) => [...html.matchAll(/data-settings-page="([^"]+)"/g)].map((match) => match[1]);
const currentPage = (html: string) => html.match(/data-settings-page="([^"]+)" aria-current="page"/)?.[1];
const blocks = (html: string) => [...html.matchAll(/data-settings-block="([^"]+)"/g)].map((match) => match[1]);
const markers = (html: string) => [...html.matchAll(/MARKER:([^;]+);/g)].map((match) => match[1]);

describe("Settings in Simple mode", () => {
  it("groups the web settings into four simple pages", () => {
    const html = render();
    expect(pages(html)).toEqual(["general", "appearance", "ai", "computers"]);
    expect(SIMPLE_PAGES.length).toBeLessThanOrEqual(5);
    expect(html).not.toContain("data-settings-group=");
    expect(html).not.toContain("data-settings-section=");
    for (const hidden of ["usage", "backups", "experimental", "workspaces", "skills"]) expect(html).not.toContain(`value="${hidden}"`);
    const picker = html.match(/<select aria-label="Settings"[\s\S]*?<\/select>/)![0];
    expect([...picker.matchAll(/<option value="([^"]+)"/g)].map((match) => match[1])).toEqual(["general", "appearance", "ai", "computers"]);
  });

  it("files every Advanced page under one Simple page, or hides it", () => {
    const placed = SIMPLE_PAGES.flatMap((page) => page.sections);
    expect(new Set(placed).size).toBe(placed.length);
    const hidden = SECTIONS.map((entry) => entry.id).filter((id) => !placed.includes(id));
    expect(hidden).toEqual(["skills", "usage", "backups", "workspaces", "experimental"]);
    for (const id of hidden) expect(SIMPLE_HIDDEN_SECTIONS).toContain(id);
  });

  it("keeps General as it is, Advanced mode switch first", () => {
    const html = render();
    expect(currentPage(html)).toBe("general");
    expect(html.indexOf('aria-label="Advanced mode"')).toBeGreaterThan(0);
    expect(html.indexOf('aria-label="Advanced mode"')).toBeLessThan(html.indexOf("Language"));
    expect(blocks(html)).toEqual(["general"]);
  });

  it("stacks Model providers and Decision model on AI, each under its heading", () => {
    fixture.section = "engines";
    const html = render();
    expect(currentPage(html)).toBe("ai");
    expect(blocks(html)).toEqual(["engines", "decisionModel"]);
    const headings = [...html.matchAll(/<h3[^>]*>([^<]+)<\/h3>/g)].map((match) => match[1]);
    expect(headings).toEqual(["Model providers", "Decision model"]);
    expect(markers(html).filter((name) => name === "engines" || name === "decisionModel")).toEqual(["engines", "decisionModel"]);
  });

  it("stacks Remote access, Local VM, the built-in browser and Logins on Computers", () => {
    fixture.section = "remoteAccess";
    const html = render();
    expect(currentPage(html)).toBe("computers");
    expect(blocks(html)).toEqual(["remoteAccess", "computer", "browser", "logins"]);
    const headings = [...html.matchAll(/<h3[^>]*>([^<]+)<\/h3>/g)].map((match) => match[1]);
    expect(headings).toEqual(["Remote access", "Local VM", "Built-in browser", "Logins"]);
    expect(html).toContain('aria-label="Enable the built-in browser"');
  });

  it("drops Account when nothing on it is shown", () => {
    vi.stubGlobal("window", {});
    fixture.config = { ...fixture.config, cloudHome: true };
    expect(pages(render())).toEqual(["general", "appearance", "ai", "computers"]);
  });

  it.each<[AppSettingsSection, string]>([
    ["general", "general"],
    ["appearance", "appearance"],
    ["engines", "ai"],
    ["connections", "ai"],
    ["decisionModel", "ai"],
    ["remoteAccess", "computers"],
    ["remote", "computers"],
    ["computer", "computers"],
  ])("lands a deep link to %s on %s", (section, page) => {
    fixture.section = section;
    const html = render();
    expect(currentPage(html)).toBe(page);
    expect(blocks(html)).toContain(section === "remote" ? "remoteAccess" : section === "connections" ? "engines" : section);
  });

  it.each<[AppSettingsSection, string]>([
    ["usage", "usage"],
    ["backups", "backups"],
    ["experimental", "skillAuthoring"],
  ])("opens a hidden page (%s) for as long as it is the open one", (section, content) => {
    fixture.section = section;
    const html = render();
    expect(pages(html)).toEqual(["general", "appearance", "ai", "computers", section]);
    expect(currentPage(html)).toBe(section);
    if (content === "skillAuthoring") expect(html).toContain("Bots may write their own skills");
    else expect(markers(html)).toContain(content);
  });

  it("scrolls a later section of a stacked page into view, and starts a page at its top", () => {
    const scrollIntoView = vi.fn();
    const querySelector = vi.fn(() => ({ scrollIntoView }));
    const scroller = { scrollTop: 320, querySelector };
    revealSettingsBlock(scroller, "decisionModel", 1);
    expect(querySelector).toHaveBeenCalledWith('[data-settings-block="decisionModel"]');
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" });
    revealSettingsBlock(scroller, "engines", 0);
    expect(scroller.scrollTop).toBe(0);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });
});

describe("the built-in browser switch", () => {
  const browserSwitch = () => fixture.switches.find((props) => props["aria-label"] === "Enable the built-in browser");

  it.each([false, true])("writes features.browser from Computers (advanced: %s)", async (advanced) => {
    fixture.advancedMode = advanced;
    fixture.section = "computer";
    const html = render();
    if (advanced) {
      expect(html.indexOf('aria-label="Enable the built-in browser"')).toBeLessThan(html.indexOf("MARKER:computer;"));
    } else {
      expect(html.indexOf("MARKER:computer;")).toBeLessThan(html.indexOf('aria-label="Enable the built-in browser"'));
    }
    const toggle = browserSwitch()!;
    expect(toggle.checked).toBe(false);
    toggle.onClick!({} as never);
    await vi.waitFor(() => expect(fixture.dispatch).toHaveBeenCalledWith({ type: "configStatus", config: {} }));
    expect(fixture.api).toHaveBeenCalledWith("/api/config", {
      method: "PATCH",
      body: JSON.stringify({ features: { browser: true } }),
    });
  });

  it("is no longer on Experimental, which keeps skill drafting", () => {
    fixture.advancedMode = true;
    fixture.section = "experimental";
    const html = render();
    expect(html).not.toContain('aria-label="Enable the built-in browser"');
    expect(html).toContain("Bots may write their own skills");
    expect(browserSwitch()).toBeUndefined();
  });

  it("is found by searching for the browser under Local VM in Advanced", () => {
    const computer = SECTIONS.find((entry) => entry.id === "computer")!;
    const experimental = SECTIONS.find((entry) => entry.id === "experimental")!;
    expect(computer.keywords).toContain("browser");
    expect(experimental.keywords).not.toContain("browser");
  });
});
