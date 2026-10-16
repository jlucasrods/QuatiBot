import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import type { InstanceInfo } from "@/state/store";
import { EnginesSettings } from "./EnginesSettings";

const fixture = vi.hoisted(() => ({ instances: [] as InstanceInfo[] }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  useStore: () => ({ state: fixture, refreshInstances: async () => {}, refreshModels: async () => {} }),
}));
afterEach(() => vi.unstubAllGlobals());

it("keeps native provider configuration in OpenCode and offers a CLI path override", () => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("navigator", { userAgent: "Linux" });
  fixture.instances = [{
    instanceId: "opencodeGo", driverKind: "opencodeGo", displayName: "OpenCode V2", cliDefault: "opencode",
    snapshot: { state: "available", authenticated: true }, models: { default: "fixture/model", options: [] },
  }];

  const html = renderToStaticMarkup(createElement(EnginesSettings));
  expect(html).toContain("OpenCode V2 owns model providers");
  expect(html).toContain("opencode auth login");
  expect(html).toContain('placeholder="opencode"');
  expect(html).toContain("https://opencode.ai/v2/docs/");
  expect(html).not.toContain('type="password"');
});
