import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import type { ModelSelection } from "./contracts.ts";
import { readyToRun, selectDefaultModelSelection, withNewBotEffort, type SelectableInstance } from "./default-model-selection.ts";

const primary: SelectableInstance = {
  instanceId: "opencodeGo", driverKind: "opencodeGo",
  snapshot: { state: "available", authenticated: true },
  models: { default: "fixture/default", options: [{ id: "fixture/default", label: "Default" }, { id: "fixture/selected", label: "Selected" }] },
  capabilities: { effortLevels: ["low", "high"], modelVariants: true },
};
const secondary: SelectableInstance = { ...primary, instanceId: "second-opencode" };
const preferred = { instanceId: primary.instanceId, model: "fixture/selected" };
const setup = { instanceId: "", model: "" };

describe("new bot default model selection", () => {
  it.each(["low", "high"] as const)("preserves a saved model and supported %s effort", effort => {
    const saved = { ...preferred, effort };
    const result = selectDefaultModelSelection([secondary, primary], saved);
    expect(result).toEqual(saved);
    expect(result).not.toBe(saved);
  });

  it("preserves opaque variants for native ACP validation", () => {
    const saved = { ...preferred, variant: "provider-specific" };
    expect(selectDefaultModelSelection([primary], saved)).toEqual(saved);
    expect(selectDefaultModelSelection([{ ...primary, capabilities: {} }], saved)).toEqual(setup);
    expect(saved.variant).toBe("provider-specific");
  });

  it.each([
    { label: "missing capabilities", capabilities: undefined },
    { label: "no effort control", capabilities: {} },
    { label: "empty effort list", capabilities: { effortLevels: [] } },
    { label: "changed effort support", capabilities: { effortLevels: ["low"] as const } },
  ])("omits stale effort for $label without mutating the saved preference", ({ capabilities }) => {
    const saved = { ...preferred, effort: "high" as const };
    expect(selectDefaultModelSelection([{ ...primary, capabilities }], saved)).toEqual(preferred);
    expect(saved.effort).toBe("high");
  });

  it.each([
    { label: "missing instance", instances: [secondary] },
    { label: "unavailable instance", instances: [{ ...primary, snapshot: { state: "unavailable" as const } }] },
    { label: "signed-out instance", instances: [{ ...primary, snapshot: { state: "available" as const, authenticated: false } }] },
    { label: "disabled instance", instances: [{ ...primary, enabled: false }] },
    { label: "removed model", instances: [{ ...primary, models: { default: "fixture/new", options: [] } }] },
  ])("returns setup for a saved $label instead of silently selecting another instance", ({ instances }) => {
    expect(selectDefaultModelSelection([secondary, ...instances], preferred)).toEqual(setup);
  });

  it("uses the first runnable instance when there is no saved choice", () => {
    const signedOut: SelectableInstance = { ...primary, snapshot: { state: "available", authenticated: false } };
    expect(selectDefaultModelSelection([signedOut, secondary])).toEqual({ instanceId: secondary.instanceId, model: "fixture/default" });
    expect(selectDefaultModelSelection([primary, secondary])).toEqual({ instanceId: primary.instanceId, model: "fixture/default" });
    expect(selectDefaultModelSelection([signedOut])).toEqual({ instanceId: primary.instanceId, model: "fixture/default" });
    expect(readyToRun(signedOut)).toBe(false);
    expect(selectDefaultModelSelection([])).toEqual(setup);
  });

  it("never automatically selects a disabled or unavailable instance", () => {
    const disabled = { ...primary, enabled: false };
    expect(readyToRun(disabled)).toBe(false);
    expect(selectDefaultModelSelection([disabled, secondary])).toEqual({ instanceId: secondary.instanceId, model: "fixture/default" });
    expect(selectDefaultModelSelection([disabled])).toEqual(setup);
    expect(selectDefaultModelSelection([{ ...primary, snapshot: { state: "unavailable" } }])).toEqual(setup);
  });

  it("treats an empty saved choice as unset but leaves incomplete choices in setup", () => {
    expect(selectDefaultModelSelection([primary], setup)).toEqual({ instanceId: primary.instanceId, model: "fixture/default" });
    for (const saved of [{ instanceId: primary.instanceId, model: "" }, { instanceId: "", model: preferred.model }]) {
      expect(selectDefaultModelSelection([primary], saved)).toEqual(setup);
    }
  });

  it("accepts catalog defaults outside the options and skips blank model IDs", () => {
    const defaultOnly = { ...primary, models: { default: "fixture/default", options: [] } };
    expect(selectDefaultModelSelection([defaultOnly], { instanceId: primary.instanceId, model: "fixture/default" })).toEqual({ instanceId: primary.instanceId, model: "fixture/default" });
    const empty = { ...primary, models: { default: " ", options: [{ id: "", label: "Empty" }, { id: " ", label: "Blank" }] } };
    expect(selectDefaultModelSelection([empty])).toEqual(setup);
    expect(selectDefaultModelSelection([{ ...empty, models: { default: "", options: [...empty.models.options, { id: "fixture/first", label: "First" }] } }])).toEqual({ instanceId: primary.instanceId, model: "fixture/first" });
  });
});

describe("default model selection wiring", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const signatures = ["function selectableInstances<", "async function defaultSelection("];
  const code = signatures.map(signature => {
    const start = source.indexOf(`\n${signature}`);
    const end = source.indexOf("\n}\n", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    return source.slice(start + 1, end + 2);
  }).join("\n");
  const compiled = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;

  it("applies instance enablement and uses supplied inventories without another probe", async () => {
    const describeInstances = vi.fn(async () => [primary, secondary]);
    const select = new Function("cfg", "registry", "providerConfigs", "selectDefaultModelSelection", `${compiled}; return defaultSelection;`)(
      { defaultModelSelection: preferred }, { describe: describeInstances }, () => ({ opencodeGo: { enabled: false } }), selectDefaultModelSelection,
    );
    await expect(select()).resolves.toEqual(setup);
    await expect(select(null, [primary, secondary])).resolves.toEqual({ instanceId: secondary.instanceId, model: "fixture/default" });
    expect(describeInstances).toHaveBeenCalledTimes(1);
  });
});

describe("new bot effort default", () => {
  const selection: ModelSelection = { instanceId: primary.instanceId, model: "fixture/default" };

  it("adds workspace effort only when the engine offers it", () => {
    expect(withNewBotEffort(selection, "high", ["low", "high"])).toEqual({ ...selection, effort: "high" });
  });

  it("preserves explicit effort and native variants", () => {
    expect(withNewBotEffort({ ...selection, effort: "low" }, "high", ["low", "high"])).toEqual({ ...selection, effort: "low" });
    const variant = { ...selection, variant: "minimal" };
    expect(withNewBotEffort(variant, "high", ["high"])).toEqual(variant);
  });

  it.each([
    { effort: undefined, offered: ["high"] as const },
    { effort: "max" as const, offered: ["low", "high"] as const },
    { effort: "high" as const, offered: undefined },
  ])("leaves unconfigured or unsupported effort unchanged: $effort", ({ effort, offered }) => {
    expect(withNewBotEffort(selection, effort, offered)).toEqual(selection);
  });
});
