import { describe, expect, it } from "vitest";

import { defaultSentinelOut, isInside } from "./paths.ts";

describe("sentinel paths", () => {
  it("keeps Sentinel's files in the platform's state folder, outside the data dir", () => {
    expect(defaultSentinelOut("/Users/quati/.quatibot", "darwin", "/Users/quati", {})).toBe("/Users/quati/Library/Application Support/quatibot-sentinel");
    expect(defaultSentinelOut("/home/quati/.quatibot", "linux", "/home/quati", {})).toBe("/home/quati/.local/state/quatibot-sentinel");
    expect(defaultSentinelOut("/home/quati/.quatibot", "linux", "/home/quati", { XDG_STATE_HOME: "/var/state/quati" })).toBe("/var/state/quati/quatibot-sentinel");
    // a relative XDG_STATE_HOME is invalid by the spec and ignored
    expect(defaultSentinelOut("/home/quati/.quatibot", "linux", "/home/quati", { XDG_STATE_HOME: "state" })).toBe("/home/quati/.local/state/quatibot-sentinel");
    expect(defaultSentinelOut("C:\\Users\\quati\\.quatibot", "win32", "C:\\Users\\quati", { LOCALAPPDATA: "D:\\Local" })).toBe("D:\\Local\\quatibot-sentinel");
  });

  it("gives any other data dir its own subfolder, the same one every time", () => {
    const other = defaultSentinelOut("/srv/quati-data", "linux", "/home/quati", {});
    expect(other).toMatch(/^\/home\/quati\/\.local\/state\/quatibot-sentinel\/data-[0-9a-f]{12}$/);
    expect(defaultSentinelOut("/srv/quati-data", "linux", "/home/quati", {})).toBe(other);
    expect(defaultSentinelOut("/srv/quati-data-2", "linux", "/home/quati", {})).not.toBe(other);
  });

  it("knows when a folder is inside another", () => {
    expect(isInside("/d/quati/sentinel", "/d/quati", "linux")).toBe(true);
    expect(isInside("/d/quati", "/d/quati", "linux")).toBe(true);
    expect(isInside("/d/quati-sentinel", "/d/quati", "linux")).toBe(false);
    expect(isInside("/d", "/d/quati", "linux")).toBe(false);
    expect(isInside("C:\\d\\quati\\x", "C:\\d\\quati", "win32")).toBe(true);
  });
});
