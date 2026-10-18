import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShortcutHint, shortcutLabel } from "./ShortcutHint";

afterEach(() => vi.unstubAllGlobals());

describe("shortcut hints", () => {
  it.each([
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X)", "⌘ N", "⌘ /"],
    ["Mozilla/5.0 (Windows NT 10.0)", "Ctrl N", "Ctrl /"],
    ["Mozilla/5.0 (X11; Linux x86_64)", "Ctrl N", "Ctrl /"],
  ])("uses the browser's bindings for %s", (userAgent, newBot, help) => {
    vi.stubGlobal("navigator", { userAgent });
    expect(shortcutLabel("new-bot")).toBe(newBot);
    expect(shortcutLabel("shortcuts-cheat-sheet")).toBe(help);
    expect(shortcutLabel("close-panel")).toBe("Esc");
    const html = renderToStaticMarkup(createElement(ShortcutHint, { id: "new-bot" }));
    expect(html).toContain('<kbd aria-hidden="true"');
    expect(html).toContain(newBot);
  });

  it("does not invent a hint for an unknown action", () => {
    expect(shortcutLabel("not-a-binding")).toBeUndefined();
    expect(renderToStaticMarkup(createElement(ShortcutHint, { id: "not-a-binding" }))).toBe("");
  });
});
