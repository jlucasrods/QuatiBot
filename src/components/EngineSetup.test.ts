import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { EngineSetup, needsCli, needsSignIn } from "./EngineSetup";
import { StoreProvider, type InstanceInfo } from "@/state/store";

afterEach(() => vi.unstubAllGlobals());

it.each([
  [{ state: "unavailable" as const }, true, false],
  [{ state: "available" as const, authenticated: false }, false, true],
  [{ state: "available" as const, authenticated: true }, false, false],
])("reports native OpenCode readiness %j", (snapshot, cli, auth) => {
  const instance: InstanceInfo = { instanceId: "opencodeGo", driverKind: "opencodeGo", displayName: "OpenCode V2", snapshot, models: { default: "", options: [] } };
  expect(needsCli(instance)).toBe(cli);
  expect(needsSignIn(instance)).toBe(auth);
});

it("directs provider setup to OpenCode without credential forms", () => {
  vi.stubGlobal("window", { quati: {} });
  const instance: InstanceInfo = { instanceId: "opencodeGo", driverKind: "opencodeGo", displayName: "OpenCode V2", snapshot: { state: "available", authenticated: false }, models: { default: "", options: [] } };
  const html = renderToStaticMarkup(createElement(StoreProvider, null, createElement(EngineSetup, { instance })));
  expect(html).toContain("opencode auth login");
  expect(html).toContain("https://opencode.ai/v2/docs/");
  expect(html).not.toContain("<input");
});
