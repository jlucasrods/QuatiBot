import { describe, expect, it } from "vitest";

import { BUILT_IN_DRIVERS } from "../drivers/builtIn.ts";
import { ENGINE_KINDS, engineCapabilities, type EngineCapabilities } from "./capabilities.ts";

const EXPECTED: Record<string, EngineCapabilities> = {
  opencodeGo: { resume: true, nativeReviewer: false, full: true, edits: false, subagents: false },
};

describe("engineCapabilities", () => {
  it("has exactly one expected row for every registered driver", () => {
    const registered = BUILT_IN_DRIVERS.map((driver) => driver.driverKind).sort();
    expect(registered.length).toBeGreaterThan(0);
    expect([...ENGINE_KINDS].sort()).toEqual(registered);
    expect(Object.keys(EXPECTED).sort()).toEqual(registered);
  });

  it.each(Object.entries(EXPECTED))("%s", (kind, expected) => {
    expect(engineCapabilities(kind)).toEqual(expected);
  });

  it.each([undefined, "someFutureEngine", "constructor", "__proto__"])("answers conservatively for %s", (kind) => {
    expect(engineCapabilities(kind)).toEqual({
      resume: false, nativeReviewer: false, full: true, edits: false, subagents: false,
    });
  });

  it("leaves the turn bound with the provider session and offers no subagents", () => {
    for (const kind of ENGINE_KINDS) {
      const caps = engineCapabilities(kind);
      expect(caps.resume).toBe(true);
      expect(caps).not.toHaveProperty("stepCap");
      expect(caps.subagents).toBe(false);
    }
  });
});
