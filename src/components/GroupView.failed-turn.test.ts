import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Bot, InstanceInfo, Message } from "@/state/store";

const fixture = vi.hoisted(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  return { instances: [] as InstanceInfo[], bots: [] as Bot[] };
});
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({
    state: { ...original.initialState, instances: fixture.instances, bots: fixture.bots },
    dispatch: vi.fn(), refreshInstances: vi.fn(), refreshModels: vi.fn(),
  }) };
});
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: true, platform: "other" }, localComputer: { available: false, reasonCode: "x", message: "" } }, ready: true }),
  useCaptionChrome: () => ({}),
}));


const { RoomToolChip } = await import("./GroupView");
const { FailedTurnRow } = await import("./ChatView");

const opencode = {
  instanceId: "opencodeGo", driverKind: "opencodeGo", displayName: "OpenCode",
  snapshot: { state: "available", authenticated: false },
  models: { default: "fixture/default", options: [] },
} as InstanceInfo;
fixture.instances = [opencode];
fixture.bots = [{ id: "lead", name: "Lead", modelSelection: { instanceId: "opencodeGo", model: "fixture/default" } } as Bot];

const failed = (name: string, patch: Partial<NonNullable<Message["tool"]>> = {}): Message => ({
  id: "failed", role: "bot", kind: "activity", at: 1,
  from: { botId: "lead", name: "Lead", color: "blue" },
  tool: { name, ok: false, ...patch },
});
const room = (message: Message) => renderToStaticMarkup(createElement(RoomToolChip, { message, roomId: "room" }));

describe("a member's failed turn in a room", () => {
  const signedOut = failed("error: Not logged in · Please run /login", { setup: true });

  it("says the engine is signed out and offers the sign-in, not the CLI's /login text", () => {
    const markup = room(signedOut);
    expect(markup).toContain("OpenCode isn&#x27;t signed in yet. Sign in below, then send your message again.");
    expect(markup).toContain("opencode auth login");
    expect(markup).not.toContain('data-testid="tool-activity"');
    const errorClasses = markup.match(/<span class="([^"]*)">OpenCode isn/)?.[1];
    expect(errorClasses).toContain("break-words");
    expect(errorClasses).not.toContain("truncate");
    const details = markup.indexOf("<details");
    expect(details).toBeGreaterThan(-1);
    expect(markup.indexOf("Not logged in")).toBeGreaterThan(details);
  });

  it("is the very row a direct chat shows for the same failure", () => {
    expect(room(signedOut)).toBe(renderToStaticMarkup(createElement(FailedTurnRow, { tool: signedOut.tool!, engine: opencode })));
  });

  it("shows a plan-limit refusal whole, next action included", () => {
    const limit = "Your Pro plan includes 2 cloud computers at once. Delete one to start another.";
    const markup = room(failed(`error: ${limit}`));
    expect(markup).toContain(`>${limit}</span>`);
    expect(markup).not.toContain("truncate");
    expect(markup).not.toContain("error:");
  });

  it("keeps the engine's words once it is signed in again (nothing left to set up)", () => {
    fixture.instances = [{ ...opencode, snapshot: { state: "available", authenticated: true } }];
    try {
      const markup = room(signedOut);
      expect(markup).toContain(">Not logged in · Please run /login</span>");
      expect(markup).not.toContain("opencode auth login");
    } finally {
      fixture.instances = [opencode];
    }
  });
});
