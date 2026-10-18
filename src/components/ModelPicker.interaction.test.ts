import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Bot, InstanceInfo } from "@/state/store";

const fixture = vi.hoisted(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  return {
    values: [] as unknown[], index: 0, own: 0, instances: [] as InstanceInfo[],
    dispatch: vi.fn(), refreshInstances: vi.fn(), refreshModels: vi.fn<() => Promise<void>>(),
  };
});
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = fixture.index++;
    if (!(index in fixture.values)) fixture.values[index] = typeof initial === "function" ? initial() : initial;
    return [fixture.values[index], (next: unknown) => {
      fixture.values[index] = typeof next === "function" ? next(fixture.values[index]) : next;
    }];
  },
  useEffect: () => {},
}));
vi.mock("./MenuMotion", () => ({ useMenuMotion: (open: boolean) => ({ shown: open, closing: false, className: "" }) }));
vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  useStore: () => ({
    state: { instances: fixture.instances, bots: [], modelVariantSessions: {} },
    dispatch: fixture.dispatch, refreshInstances: fixture.refreshInstances, refreshModels: fixture.refreshModels,
  }),
}));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => true, setAdvancedMode: () => {} }));

const { LOCAL_PROBE_TIMEOUT_MS, ModelPicker, offersLocalModels, probeLocalModels } = await import("./ModelPicker");

type Node = ReactElement<Record<string, unknown> & { children?: ReactNode }>;
function nodes(value: ReactNode): Node[] {
  return Children.toArray(value).flatMap((child) => {
    if (!isValidElement(child)) return [];
    const node = child as Node;
    return [node, ...nodes(node.props.children)];
  });
}

const official = { id: "fixture/test", label: "Fixture model" };
const local = { id: "ollama/qwen3", label: "qwen3 (Ollama)", custom: true };
const bot: Bot = {
  id: "atlas", threadId: "thread-atlas", name: "Atlas", title: "", description: "", notifications: true,
  color: "green", unread: false, modelSelection: { instanceId: "opencodeGo", model: official.id }, messages: [],
};

function render() {
  fixture.values.length = Math.min(fixture.values.length, fixture.own);
  let tree: ReactNode = null;
  function Capture() {
    fixture.index = 0;
    tree = ModelPicker({ bot, threadId: bot.threadId });
    fixture.own = fixture.index;
    return tree;
  }
  const html = renderToStaticMarkup(createElement(Capture));
  return { html, nodes: nodes(tree) };
}

function open() {
  const trigger = render().nodes.find((node) => node.props["data-tour"] === "model")!;
  (trigger.props.onClick as () => void)();
  return render();
}

beforeEach(() => {
  fixture.values = [];
  fixture.index = 0;
  fixture.own = 0;
  fixture.dispatch = vi.fn();
  fixture.refreshInstances = vi.fn(() => Promise.resolve());
  fixture.refreshModels = vi.fn(() => Promise.resolve());
  fixture.instances = [{
    instanceId: "opencodeGo", driverKind: "opencodeGo", displayName: "OpenCode", access: "subscription",
    snapshot: { state: "available", version: "2.0.31", authenticated: true },
    models: { default: official.id, options: [official, local] },
  }];
});
afterEach(() => vi.useRealTimers());
afterAll(() => vi.unstubAllGlobals());

describe("OpenCode model picker", () => {
  it.each(["signed out", "unavailable"])("shows OpenCode-owned setup when %s", (state) => {
    fixture.instances[0].snapshot = state === "signed out"
      ? { state: "available", authenticated: false }
      : { state: "unavailable", reason: "OpenCode CLI not found" };

    const { html } = open();
    expect(html).toContain("OpenCode V2");
    expect(html).toContain("Models and credentials are managed by OpenCode");
    expect(html).toContain("opencode auth login");
    expect(html.slice(html.indexOf("data-model-picker-content"))).not.toContain(">Fixture model<");
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it("selects a local model discovered by OpenCode for this conversation", () => {
    const entry = open().nodes.find((node) => node.props["data-model-local-entry"])!;
    (entry.props.onClick as () => void)();
    const row = render().nodes.find((node) => (node.props.option as { id?: string } | undefined)?.id === local.id)!;
    (row.props.onPick as () => void)();

    expect(fixture.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      type: "setModel", botId: "atlas", threadId: "thread-atlas", selection: { instanceId: "opencodeGo", model: local.id },
    }));
  });

  it("re-probes local models and reports an empty result", async () => {
    let answer!: () => void;
    fixture.refreshModels = vi.fn(() => new Promise<void>((resolve) => { answer = resolve; }));
    const entry = open().nodes.find((node) => node.props["data-model-local-entry"])!;
    (entry.props.onClick as () => void)();
    expect(fixture.refreshModels).toHaveBeenCalledExactlyOnceWith("opencodeGo");
    expect(render().html).toContain("Looking for local models…");

    fixture.instances[0].models.options = [official];
    answer();
    for (let index = 0; index < 20; index++) await Promise.resolve();
    expect(render().html).toContain("No local models found");
    expect(render().html).not.toContain("Looking for local models…");
  });

  it.each([0, 1])("offers local models only when OpenCode lists them (%i)", (count) => {
    expect(offersLocalModels(fixture.instances[0], count)).toBe(count > 0);
    expect(offersLocalModels(undefined, count)).toBe(false);
  });

  it("bounds a stalled refresh and contains a rejected refresh", async () => {
    vi.useFakeTimers();
    let settled = false;
    void probeLocalModels("opencodeGo", () => new Promise(() => {})).then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(LOCAL_PROBE_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    await expect(probeLocalModels("opencodeGo", () => Promise.reject(new Error("offline")))).resolves.toBeUndefined();
  });
});
