// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AppState, Bot, InstanceInfo } from "@/state/store";

const captured = vi.hoisted(() => ({ posts: 0, paths: [] as string[], held: false, stopped: false, aborted: 0, finish: undefined as (() => void) | undefined }));
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useCaptionChrome: () => ({ padClass: undefined }),
  useDesktopCapabilities: () => ({
    ready: true,
    capabilities: {
      host: { platform: "linux", label: "Host", session: "unknown", packaged: false, homeDir: "/home/fixture" },
      windowChrome: "browser",
      screenPreview: { available: false, interaction: "none" },
      dictation: { available: false, engine: "none", onDevice: false },
      localComputer: { available: false, support: "unsupported", enabled: false, status: "unavailable" },
    },
  }),
}));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => false, setAdvancedMode: () => {} }));
vi.mock("./AndroidDevicePanel", () => ({ AndroidDevicePanel: () => null, useAndroidUsbDevices: () => ({ devices: [] }) }));
vi.mock("./BrowserPanel", () => ({ BrowserPanel: () => null }));
vi.mock("./CloudBackendPicker", () => ({ CloudBackendPicker: () => null }));
vi.mock("./bot-settings/RoutinesSection", () => ({ RoutinesSection: () => null }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  api: async (path: string, init?: RequestInit) => {
    if (path.startsWith("/api/bots/bot/local-computer/screenshot")) {
      if (init?.method === "POST") {
        captured.posts++;
        captured.paths.push(path);
        if (captured.held) {
          init.signal?.addEventListener("abort", () => captured.aborted++);
          return new Promise<{ image: string }>((resolve) => {
            captured.finish = () => resolve({ image: "data:image/png;base64,FINISHED" });
          });
        }
      }
      return { image: "data:image/png;base64,POLLED" };
    }
    if (path.startsWith("/api/bots/bot/local-computer?")) return captured.stopped
      ? { ready: false, mode: "shared", container: "stopped", resumable: true, stop_reason: "idle" }
      : { ready: true };
    return {};
  },
}));

const { ComputerPanel } = await import("./ComputerPanel");
const { BotEditorStore, initialState } = await import("@/state/store");

const bot = {
  id: "bot", threadId: "thread", name: "Fixture", title: "", description: "", color: "green",
  notifications: true, unread: false, busy: true, computer: "vm", messages: [],
  modelSelection: { instanceId: "opencodeGo", model: "m" },
  tasks: [{ threadId: "thread", title: "Thread", createdAt: 1, approvalMode: "ask" }],
} as unknown as Bot;
const engine = {
  instanceId: "opencodeGo", driverKind: "opencodeGo", displayName: "OpenCode", access: "subscription",
  snapshot: { state: "available", version: "1", authenticated: true },
  models: { default: "m", options: [{ id: "m", label: "M" }] },
  capabilities: { computerMcp: true, browserMcp: true },
} as InstanceInfo;

let root: Root;
let value: Parameters<typeof BotEditorStore>[0]["value"];
const render = (shown: Bot) => {
  flushSync(() => root.render(createElement(BotEditorStore, { value, children: createElement(ComputerPanel, { bot: shown }) })));
};
const tick = () => new Promise((resolve) => setImmediate(resolve));
const settle = async () => {
  for (let i = 0; i < 10; i++) {
    await vi.advanceTimersByTimeAsync(0);
    await tick();
  }
};
const preview = () => document.querySelector("img[alt=\"Fixture's screen\"]")?.getAttribute("src");

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  const state: AppState = {
    ...initialState,
    bots: [bot],
    selectedId: bot.id,
    instances: [engine],
    config: { box: { configured: true } } as AppState["config"],
  };
  value = { state, dispatch: vi.fn(), flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} };
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  render(bot);
  await settle();
});
afterAll(() => {
  root.unmount();
  vi.useRealTimers();
});

describe("Computer panel isolated VM screenshots", () => {
  it("starts from its own capture", () => {
    expect(captured.posts).toBe(1);
    expect(preview()).toBe("data:image/png;base64,POLLED");
  });

  it("refreshes screenshots while the bot is working", async () => {
    await vi.advanceTimersByTimeAsync(12_000);
    await settle();
    expect(captured.posts).toBeGreaterThan(1);
    expect(preview()).toBe("data:image/png;base64,POLLED");
  });

  it("does not change the preview's conversation when a sibling is added", async () => {
    const posts = captured.posts;
    render({ ...bot, tasks: [...bot.tasks!, { threadId: "sibling", title: "Other", createdAt: 2, approvalMode: "ask" }] } as Bot);
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();
    expect(captured.posts).toBeGreaterThan(posts);
    expect(captured.paths.every((path) => path.endsWith("?threadId=thread"))).toBe(true);
    expect(preview()).toBe("data:image/png;base64,POLLED");
  });

  it("keeps an in-flight capture when only the bot's busy state changes", async () => {
    captured.held = true;
    await vi.advanceTimersByTimeAsync(3_000);
    await settle();
    expect(captured.finish).toBeTypeOf("function");
    const posts = captured.posts;

    render({ ...bot, busy: false });
    await settle();
    expect(captured.aborted).toBe(0);
    expect(captured.posts).toBe(posts);

    captured.held = false;
    captured.finish?.();
    await settle();
    expect(preview()).toBe("data:image/png;base64,FINISHED");
  });

  it("explains that a resumable VM is stopped rather than unavailable", async () => {
    captured.stopped = true;
    try {
      render({ ...bot, threadId: "stopped" });
      await settle();
      expect(document.body.textContent).toContain("The Local VM is stopped");
      expect(document.body.textContent).toContain("Stopped after inactivity");
      expect(document.body.textContent).not.toContain("isn't available for this bot");
    } finally {
      captured.stopped = false;
    }
  });
});
