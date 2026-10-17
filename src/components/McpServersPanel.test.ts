import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import { McpServersPanel } from "./McpServersPanel";
import { Switch } from "./SettingsPrimitives";

const fixture = vi.hoisted(() => ({ values: [] as unknown[], index: 0, effects: [] as Array<() => unknown>, api: vi.fn() }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = fixture.index++;
    if (!(index in fixture.values)) fixture.values[index] = initial;
    return [fixture.values[index], (next: unknown) => {
      fixture.values[index] = typeof next === "function" ? next(fixture.values[index]) : next;
    }];
  },
  useEffect: (effect: () => unknown) => { fixture.effects.push(effect); },
}));
vi.mock("@/state/store", () => ({ api: fixture.api }));

type Node = ReactElement<{ children?: ReactNode; [key: string]: unknown }>;
function nodes(value: ReactNode): Node[] {
  return Children.toArray(value).flatMap((child) => {
    if (!isValidElement(child)) return [];
    const node = child as Node;
    return [node, ...nodes(node.props.children)];
  });
}

function render() {
  let tree: ReactNode = null;
  function Capture() {
    fixture.index = 0;
    fixture.effects = [];
    tree = McpServersPanel();
    return tree;
  }
  const html = renderToStaticMarkup(createElement(Capture));
  return { html, nodes: nodes(tree) };
}

beforeEach(() => {
  vi.clearAllMocks();
  fixture.values = [];
  fixture.index = 0;
  fixture.effects = [];
  fixture.api.mockResolvedValue({
    servers: [{ name: "notes", type: "local", status: "configured", enabled: true }],
    plugins: [{ name: "opencode-dcp" }], skills: [{ id: "review", name: "Review" }],
  });
});

it("loads global extensions and switches an MCP only for Quati", async () => {
  render();
  for (const effect of fixture.effects) effect();
  await Promise.resolve();
  expect(fixture.api).toHaveBeenCalledWith("/api/opencode/extensions", expect.objectContaining({ signal: expect.any(AbortSignal) }));
  const loaded = render();
  expect(loaded.html).toContain("notes");
  const toggle = loaded.nodes.find((node) => node.type === Switch)!;
  expect(toggle.props.checked).toBe(true);
  await (toggle.props.onClick as () => Promise<void>)();
  await Promise.resolve();
  expect(fixture.api).toHaveBeenLastCalledWith("/api/mcp/servers/notes", { method: "PATCH", body: JSON.stringify({ enabled: false }) });
  expect(render().nodes.find((node) => node.type === Switch)!.props.checked).toBe(false);
});

it.each(["plugins", "skills"])("shows %s without configuration controls", async (tab) => {
  render();
  for (const effect of fixture.effects) effect();
  await Promise.resolve();
  const button = render().nodes.find((node) => node.props.id === `extension-tab-${tab}`)!;
  (button.props.onClick as () => void)();
  const selected = render();
  expect(selected.html).toContain(tab === "plugins" ? "opencode-dcp" : "Review");
  expect(selected.nodes.some((node) => node.type === Switch)).toBe(false);
});

it("keeps the previous activation visible when saving fails", async () => {
  render();
  for (const effect of fixture.effects) effect();
  await Promise.resolve();
  fixture.api.mockRejectedValueOnce(new Error("unavailable"));
  const toggle = render().nodes.find((node) => node.type === Switch)!;
  await (toggle.props.onClick as () => Promise<void>)();
  await Promise.resolve();
  const failed = render();
  expect(failed.nodes.find((node) => node.type === Switch)!.props.checked).toBe(true);
  expect(failed.html).toContain('role="alert"');
});
