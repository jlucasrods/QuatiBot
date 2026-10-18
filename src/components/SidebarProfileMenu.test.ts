import { describe, expect, it, vi } from "vitest";
import { profileInitials, profileLabel, profileMenuItems } from "./SidebarProfileMenu";

describe("profile identity", () => {
  it.each([
    [{ name: "Alex Morgan" }, "AM", "Alex Morgan"],
    [{ name: "Ada Byron Lovelace" }, "AB", "Ada Byron Lovelace"],
    [{ email: "you@x.dev" }, "Y", "you@x.dev"],
    [{ name: "   ", email: "you@x.dev" }, "Y", "you@x.dev"],
    [{}, "?", "You"],
    [undefined, "?", "You"],
  ])("shows initials and label for %j", (profile, initials, label) => {
    expect(profileInitials(profile)).toBe(initials);
    expect(profileLabel(profile)).toBe(label);
  });
});

describe("profile menu", () => {
  it.each([
    [true, ["usage", "apps", "shortcuts", "about", "settings"]],
    [false, ["apps", "shortcuts", "about", "settings"]],
  ] as const)("offers the available local actions (usage: %s)", (usage, keys) => {
    const actions = { onUsage: vi.fn(), onApps: vi.fn(), onSettings: vi.fn(), onShortcuts: vi.fn(), onAbout: vi.fn() };
    const items = profileMenuItems({ usage, ...actions });
    expect(items.map(item => item.key)).toEqual(keys);
    expect(items.find(item => item.key === "apps")?.label).toBe("Extensões");

    for (const item of items) item.onSelect();
    expect(actions.onSettings).toHaveBeenCalledOnce();
    expect(actions.onApps).toHaveBeenCalledOnce();
    expect(actions.onShortcuts).toHaveBeenCalledOnce();
    expect(actions.onAbout).toHaveBeenCalledOnce();
    expect(actions.onUsage).toHaveBeenCalledTimes(usage ? 1 : 0);
  });
});
