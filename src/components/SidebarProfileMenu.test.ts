import { describe, expect, it, vi } from "vitest";
import { profileInitials, profileLabel, profileMenuItems } from "./SidebarProfileMenu";

describe("profile identity", () => {
  it.each([
    [{ name: "Milind Soni" }, "MS", "Milind Soni"],
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
    [true, "OpenMausBot Cloud", ["usage", "apps", "shortcuts", "about", "settings", "account"]],
    [false, null, ["apps", "shortcuts", "about", "settings"]],
  ] as const)("offers the available local actions (usage: %s, account: %s)", (usage, account, keys) => {
    const actions = { onUsage: vi.fn(), onApps: vi.fn(), onSettings: vi.fn(), onShortcuts: vi.fn(), onAbout: vi.fn(), onAccount: vi.fn() };
    const items = profileMenuItems({ usage, account, ...actions });
    expect(items.map(item => item.key)).toEqual(keys);
    expect(items.find(item => item.key === "apps")?.label).toBe("Extensões");

    for (const item of items) item.onSelect();
    expect(actions.onSettings).toHaveBeenCalledOnce();
    expect(actions.onApps).toHaveBeenCalledOnce();
    expect(actions.onShortcuts).toHaveBeenCalledOnce();
    expect(actions.onAbout).toHaveBeenCalledOnce();
    expect(actions.onUsage).toHaveBeenCalledTimes(usage ? 1 : 0);
    expect(actions.onAccount).toHaveBeenCalledTimes(account ? 1 : 0);
    expect(items.filter(item => item.separatorBefore).map(item => item.key)).toEqual(account ? ["account"] : []);
  });
});
