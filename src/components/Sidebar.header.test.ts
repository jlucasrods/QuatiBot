import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";
import type { SidebarDensity } from "@/lib/sidebar-preferences";
import { StoreProvider } from "@/state/store";

const fixture = vi.hoisted(() => ({
  density: "comfortable" as SidebarDensity,
  advanced: true,
}));

vi.mock("@/lib/sidebar-preferences", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/sidebar-preferences")>(),
  useSidebarDensity: () => fixture.density,
}));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => fixture.advanced, setAdvancedMode: () => {} }));
import { Sidebar } from "./Sidebar";

const render = () => renderToStaticMarkup(
  createElement(StoreProvider, null, createElement(Sidebar, { open: true, onClose: () => {} })),
);

beforeEach(() => {
  fixture.density = "comfortable";
  fixture.advanced = true;
  vi.stubGlobal("window", { innerWidth: 1280, location: { protocol: "http:", search: "" } });
  setLocale("en");
});

afterEach(() => {
  vi.unstubAllGlobals();
  setLocale("en");
});

describe("sidebar header", () => {
  it.each(["comfortable", "compact", "icons"] as const)(
    "keeps collapse, activity and add but no density menu at %s density in Advanced mode",
    (density) => {
      fixture.density = density;
      const html = render();
      expect(html).toContain(density === "icons" ? 'aria-label="Expand sidebar"' : 'aria-label="Collapse sidebar to avatars"');
      expect(html).toContain('aria-label="Active Threads"');
      expect(html).toContain('aria-label="New or share"');
      expect(html).not.toContain("Choose sidebar density");
      expect(html).not.toContain('title="Sidebar density"');
    },
  );

  it.each(["comfortable", "compact"] as const)("keeps only add in Simple mode at %s density", (density) => {
    fixture.advanced = false;
    fixture.density = density;
    const html = render();
    expect(html).not.toContain('aria-label="Collapse sidebar to avatars"');
    expect(html).not.toContain('aria-label="Active Threads"');
    expect(html).toContain('aria-label="New or share"');
  });

  it("still offers Expand on an icons rail in Simple mode, so the rail is never a dead end", () => {
    fixture.advanced = false;
    fixture.density = "icons";
    const html = render();
    expect(html).toContain('aria-label="Expand sidebar"');
    expect(html).not.toContain('aria-label="Active Threads"');
  });
});

describe("sidebar top row", () => {
  it.each(["comfortable", "compact", "icons"] as const)("keeps header actions aligned at %s density", (density) => {
    fixture.density = density;
    const html = render();
    const row = html.slice(html.indexOf("data-sidebar-top-row"), html.indexOf('aria-label="New or share"'));
    expect(row).toContain("data-sidebar-top-buttons");
    expect(row).toContain("items-center");
    if (density === "icons") {
      expect(row).toContain("flex-col");
      expect(row).not.toContain("data-sidebar-top-spacer");
    } else {
      expect(row).toContain("h-12");
      expect(row.indexOf("data-sidebar-top-spacer")).toBeLessThan(row.indexOf("data-sidebar-top-buttons"));
    }
    expect(html).toContain('aria-label="New or share"');
    expect(html).toContain('aria-label="Active Threads"');
  });
});

describe("sidebar glass head and foot", () => {
  it.each(["comfortable", "compact", "icons"] as const)(
    "puts the top row and search in the glass head, the places in the glass foot, and the list between at %s density",
    (density) => {
      fixture.density = density;
      const html = render();
      const at = (marker: string) => {
        const index = html.indexOf(marker);
        expect(index, marker).toBeGreaterThan(-1);
        return index;
      };
      const head = at('data-glass-bar="top"');
      const topRow = at("data-sidebar-top-row");
      const search = at('aria-label="Search bots and messages"');
      const list = at('class="glass-scroller ');
      const foot = at('data-glass-bar="bottom"');
      const places = at('data-sidebar-nav="routines"');
      expect(head).toBeLessThan(topRow);
      expect(topRow).toBeLessThan(search);
      expect(search).toBeLessThan(list);
      expect(list).toBeLessThan(foot);
      expect(foot).toBeLessThan(places);
      expect(html.match(/data-glass-frame=""/g)).toHaveLength(1);
      expect(at("data-glass-frame")).toBeLessThan(head);
    },
  );
});

describe("sidebar foot in Simple mode", () => {
  it.each(["comfortable", "compact"] as const)("keeps the profile menu at the bottom (%s)", (density) => {
    fixture.advanced = false;
    fixture.density = density;
    const html = render();
    const foot = html.indexOf('data-glass-bar="bottom"');
    expect(html).not.toContain('data-sidebar-nav="routines"');
    expect(html).not.toContain('data-sidebar-nav="triggers"');
    expect(html.indexOf('aria-label="You"')).toBeGreaterThan(foot);
  });

  it("keeps Routines and Triggers in Advanced mode", () => {
    fixture.advanced = true;
    const html = render();
    expect(html).toContain('data-sidebar-nav="routines"');
    expect(html).toContain('data-sidebar-nav="triggers"');
  });
});
