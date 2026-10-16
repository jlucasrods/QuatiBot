import { expect, it } from "vitest";
import { canWorkOnCloud } from "../../shared/cloud-computer.ts";
import { BUILT_IN_DRIVERS } from "./builtIn.ts";
import { createOpenCodeDriver } from "./acp/opencode-go.ts";

it("exposes browser and computer tools through the OpenCode engine", async () => {
  const driver = createOpenCodeDriver(async () => ({ default: "", options: [] }));
  const instance = await driver.create({ instanceId: "caps", displayName: "OpenCode", enabled: true, config: driver.defaultConfig(), environment: {} });
  try {
    expect(instance.adapter.capabilities).toMatchObject({ computerMcp: true, localComputerMcp: true, dataMcp: true, nativeImageInput: true });
    expect(canWorkOnCloud({ computerMcp: instance.adapter.capabilities.computerMcp })).toBe(true);
    expect(BUILT_IN_DRIVERS.map((entry) => entry.driverKind)).toEqual(["opencodeGo"]);
  } finally {
    await instance.dispose();
  }
});
