import { describe, expect, it } from "vitest";

import { routineRunsOn } from "./routine-display";

describe("where a routine runs", () => {

  it("on a desktop, a routine starts while QuatiBot is open there", () => {
    expect(routineRunsOn({ roomGoal: false })).toEqual({
      label: "This computer", hint: "Starts while QuatiBot is open here.",
    });
    expect(routineRunsOn({ roomGoal: false, runOn: "cloud" })).toEqual({
      label: "Cloud computer", hint: "Runs the whole job on the bot's cloud computer while QuatiBot is open.",
    });
    expect(routineRunsOn({ roomGoal: false, computer: "vm" }).label).toBe("The bot's virtual machine");
    expect(routineRunsOn({ roomGoal: true }).label).toBe("This computer, with the whole group");
  });

  it("never names Boat or a cloud runner", () => {
      for (const input of [{ runOn: "cloud" }, { computer: "cloud" }, {}]) {
        const { label, hint } = routineRunsOn({ roomGoal: false, ...input });
        expect(`${label} ${hint}`).not.toMatch(/boat|runner|VM\b/i);
      }
  });
});
