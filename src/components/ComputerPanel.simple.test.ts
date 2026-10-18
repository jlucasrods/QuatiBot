import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, InstanceInfo, Message, Task } from "@/state/store";
import type { FeatureFlagConfig } from "@/lib/feature-flags";
// Hook-by-call-order harness: state survives between renders, effects never run, handlers are read off the element
// tree. `seed` presets what the resolve effect would have reached.
const fixture = vi.hoisted(() => {
    const view = { current: "computer" as string };
    const quati: Record<string, unknown> = {};
    vi.stubGlobal("window", { quati });
    vi.stubGlobal("document", { visibilityState: "visible" });
    vi.stubGlobal("localStorage", { getItem: (key: string) => key.startsWith("quati-computer-panel-view") ? view.current : null, setItem: () => { } });
    return {
        advanced: false,
        view,
        quati,
        platform: "darwin" as "darwin" | "win32" | "linux",
        values: [] as unknown[],
        index: 0,
        own: 0,
        seed: {} as Record<string, unknown>,
        config: {} as FeatureFlagConfig & {
            box?: {
                configured: boolean;
            };
        },
        instances: [] as InstanceInfo[],
        android: false,
        dispatch: (() => { }) as (...args: unknown[]) => void,
        api: (() => Promise.resolve({})) as (...args: unknown[]) => Promise<unknown>,
        setAdvancedMode: (() => { }) as (enabled: boolean) => void,
        ownerOrAdmin: null as boolean | null,
    };
});
// The panel's useState calls in source order, counted from `phase`; keep in step with ComputerPanel.tsx.
const PHASE_OFFSETS = { phase: 0, resolved: 2, vmViewerUrl: 5, vmStatus: 6, error: 10 } as const;
let phaseIndex = -1;
vi.mock("react", async (original) => ({
    ...await original<typeof import("react")>(),
    useState: (initial: unknown) => {
        const index = fixture.index++;
        if (!(index in fixture.values)) {
            let value = typeof initial === "function" ? initial() : initial;
            if (value === "checking" && phaseIndex < 0)
                phaseIndex = index;
            for (const [name, offset] of Object.entries(PHASE_OFFSETS)) {
                if (phaseIndex >= 0 && index === phaseIndex + offset && name in fixture.seed)
                    value = fixture.seed[name];
            }
            fixture.values[index] = value;
        }
        return [fixture.values[index], (next: unknown) => {
                fixture.values[index] = typeof next === "function" ? next(fixture.values[index]) : next;
            }];
    },
    useEffect: () => { },
}));
vi.mock("@/lib/interface-mode", () => ({
    useAdvancedMode: () => fixture.advanced,
    setAdvancedMode: (enabled: boolean) => fixture.setAdvancedMode(enabled),
}));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => fixture.ownerOrAdmin }));
vi.mock("./DesktopCapabilities", () => ({
    useCaptionChrome: () => ({ padClass: undefined }),
    useDesktopCapabilities: () => ({
        ready: true,
        capabilities: {
            host: { platform: fixture.platform, label: "Host", session: "unknown", packaged: true, homeDir: "/Users/me" },
            windowChrome: "native",
            screenPreview: { available: false, interaction: "none" },
            dictation: { available: false, engine: "none", onDevice: false },
            localComputer: { available: true, support: "supported", enabled: true, status: "ready" },
        },
    }),
}));
vi.mock("./AndroidDevicePanel", () => ({
    AndroidDevicePanel: () => null,
    useAndroidUsbDevices: () => ({ devices: fixture.android ? [{ serial: "p1" }] : [] }),
}));
vi.mock("./BrowserPanel", () => ({ BrowserPanel: () => createElement("div", null, "BROWSER-PANEL") }));
vi.mock("./CloudScreenPreview", () => ({ CloudScreenPreview: () => null }));
vi.mock("./LocalScreenPreview", () => ({ LocalScreenPreview: () => null }));
vi.mock("./LinuxLocalControl", () => ({ LinuxLocalControl: () => null }));
vi.mock("./MacLocalControl", () => ({ MacLocalControl: () => null }));
vi.mock("./bot-settings/RoutinesSection", () => ({ RoutinesSection: () => null }));
vi.mock("@/state/store", async (importOriginal) => ({
    ...await importOriginal<typeof import("@/state/store")>(),
    api: (...args: unknown[]) => fixture.api(...args),
    useStore: () => ({
        state: {
            config: { box: { configured: true }, ...fixture.config },
            instances: fixture.instances,
            computerControl: {},
            routines: [],
            routineRuns: [],
        },
        dispatch: fixture.dispatch,
        flushBotPatches: () => Promise.resolve(null),
    }),
}));
const { ComputerPanel } = await import("./ComputerPanel");
const { ComputerFilesPane } = await import("./ComputerFilesPane");
afterAll(() => vi.unstubAllGlobals());
type Node = ReactElement<Record<string, unknown> & {
    children?: ReactNode;
}>;
function nodes(value: ReactNode): Node[] {
    return Children.toArray(value).flatMap((child) => {
        if (!isValidElement(child))
            return [];
        const node = child as Node;
        return [node, ...nodes(node.props.children)];
    });
}
function text(value: ReactNode): string {
    return Children.toArray(value).map((child) => {
        if (typeof child === "string" || typeof child === "number")
            return String(child);
        return isValidElement(child) ? text((child as Node).props.children) : "";
    }).join("").trim();
}
const engine = (): InstanceInfo => ({
    instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude", access: "subscription",
    snapshot: { state: "available", version: "1", authenticated: true },
    models: { default: "m", options: [{ id: "m", label: "M" }] },
    capabilities: { computerMcp: true, browserMcp: true },
} as InstanceInfo);
function makeBot(patch: Partial<Bot> = {}): Bot {
    return {
        id: "scout", threadId: "thread-scout", name: "Scout", title: "", description: "", notifications: true,
        color: "green", unread: false, messages: [],
        modelSelection: { instanceId: "claude", model: "m" },
        ...patch,
    } as Bot;
}
function render(forBot: Bot, props: {
    onOpenVmWorkspace?: (botId: string) => void;
} = {}) {
    fixture.values.length = Math.min(fixture.values.length, fixture.own);
    let tree: ReactNode = null;
    function Capture() {
        fixture.index = 0;
        tree = ComputerPanel({ bot: forBot, ...props });
        fixture.own = fixture.index;
        return tree;
    }
    const html = renderToStaticMarkup(createElement(Capture));
    const all = nodes(tree);
    const buttons = all.filter((node) => node.type === "button");
    const button = (label: string) => buttons.find((node) => text(node.props.children) === label);
    return { html, nodes: all, buttons, button };
}
const tabs = (rendered: ReturnType<typeof render>) => {
    const bar = rendered.nodes.find((node) => node.props["data-testid"] === "computer-tabs")!;
    return nodes(bar.props.children).filter((node) => node.type === "button").map((node) => text(node.props.children));
};
const placeLine = (rendered: ReturnType<typeof render>) => text(rendered.nodes.find((node) => node.props["data-testid"] === "place-line")!.props.children).replace(/&#x27;/g, "'");
const grid = (rendered: ReturnType<typeof render>) => {
    const card = rendered.nodes.find((node) => node.props["data-testid"] === "where-works");
    if (!card)
        return [];
    return nodes(card.props.children).filter((node) => node.type === "button");
};
beforeEach(() => {
    fixture.advanced = false;
    fixture.view.current = "computer";
    fixture.platform = "darwin";
    fixture.values = [];
    fixture.index = 0;
    fixture.own = 0;
    fixture.seed = {};
    phaseIndex = -1;
    fixture.config = { features: { browser: true }, browserEngine: { kind: "engine" } };
    fixture.instances = [engine()];
    fixture.android = false;
    fixture.dispatch = vi.fn();
    fixture.api = vi.fn(() => Promise.resolve({ features: { browser: true } }));
    fixture.setAdvancedMode = vi.fn();
    fixture.ownerOrAdmin = null;
    for (const key of Object.keys(fixture.quati))
        delete fixture.quati[key];
});
describe("Computer panel tabs", () => {
    it("centres the tabs as a pill with close pinned right, in both modes", () => {
        for (const advanced of [false, true]) {
            fixture.advanced = advanced;
            fixture.values = [];
            const rendered = render(makeBot());
            const bar = rendered.nodes.find((node) => node.props["data-testid"] === "computer-tabs")!;
            expect(String(bar.props.className).split(" ")).toEqual(expect.arrayContaining(["rounded-full", "mx-9"]));
            expect(String(bar.props.className).split(" ")).not.toContain("flex-wrap");
            const firstTab = Children.toArray(bar.props.children).find(isValidElement) as Node;
            expect(String(firstTab.props.className).split(" ")).toEqual(expect.arrayContaining(["shrink-0", "@max-[28rem]/paneltabs:[&>svg]:hidden"]));
            expect(rendered.nodes.some((node) => String(node.props.className ?? "").split(" ").includes("@container/paneltabs"))).toBe(true);
            const row = rendered.nodes.find((node) => Children.toArray(node.props.children)
                .some((child) => isValidElement(child) && (child as Node).props["data-testid"] === "computer-tabs"))!;
            expect(String(row.props.className).split(" ")).toEqual(expect.arrayContaining(["relative", "flex", "justify-center"]));
            const close = rendered.nodes.find((node) => node.props["aria-label"] === "Close computer panel")!;
            expect(String(close.props.className).split(" ")).toEqual(expect.arrayContaining(["absolute", "right-0"]));
        }
    });
    it("shows Computer, Browser, Data and Files in Simple mode", () => {
        fixture.android = true;
        expect(tabs(render(makeBot()))).toEqual(["Computer", "Browser", "Data", "Files"]);
    });
    it("keeps the Advanced tabs unchanged", () => {
        fixture.advanced = true;
        fixture.android = true;
        expect(tabs(render(makeBot()))).toEqual(["Computer", "Routines", "Browser", "Data"]);
        fixture.config = {};
        fixture.android = false;
        expect(tabs(render(makeBot()))).toEqual(["Computer", "Routines", "Browser", "Data"]);
    });
    it("reads a Routines view stored by Advanced as the Computer tab in Simple", () => {
        fixture.view.current = "routines";
        const rendered = render(makeBot());
        expect(rendered.nodes.find((node) => node.props["data-testid"] === "where-works")).toBeDefined();
    });
    it("lists the files this chat changed in the Files tab", () => {
        fixture.view.current = "files";
        const digest = (files: {
            added?: string[];
            changed?: string[];
            deleted?: string[];
        }) => ({
            id: Math.random().toString(36), role: "assistant", kind: "digest", text: "",
            digest: { files: { added: [], changed: [], deleted: [], ...files } },
        }) as unknown as Message;
        const rendered = render(makeBot({ messages: [
                digest({ added: ["/Users/me/work/report.md", "/Users/me/work/old.txt"] }),
                digest({ changed: ["/Users/me/work/notes.md"], deleted: ["/Users/me/work/old.txt"] }),
            ] }));
        expect(rendered.nodes.some((node) => node.type === ComputerFilesPane)).toBe(true);
        expect(rendered.html).toContain("notes.md");
        expect(rendered.html).toContain("report.md");
        expect(rendered.html).not.toContain("old.txt");
        expect(rendered.html).toContain("~/work");
        expect(rendered.html).toContain("Scout&#x27;s private folder");
    });
    it("explains an empty Files tab", () => {
        fixture.view.current = "files";
        expect(render(makeBot()).html).toContain("Files Scout makes or changes in this chat will show up here.");
    });
    it("shows the selected chat's pinned folder after the bot default changes", () => {
        fixture.view.current = "files";
        const rendered = render(makeBot({
            cwd: "/workspace/new-project",
            tasks: [
                { threadId: "other-thread", title: "Other chat", createdAt: 1, cwd: "/workspace/other-project" },
                { threadId: "thread-scout", title: "Existing chat", createdAt: 2, cwd: "/Users/me/original-project" },
            ],
        }));
        expect(rendered.html).toContain('title="/Users/me/original-project"');
        expect(rendered.html).toContain("~/original-project");
        expect(rendered.html).not.toContain("/workspace/new-project");
        expect(rendered.html).not.toContain("/workspace/other-project");
        expect(rendered.html).toContain("Change default");
        expect(rendered.html).toContain("This chat keeps its current folder.");
    });
    it("keeps showing the pinned private folder after the bot default is cleared", () => {
        fixture.view.current = "files";
        const rendered = render(makeBot({ tasks: [
                { threadId: "thread-scout", title: "Existing chat", createdAt: 1, cwd: "/Users/me/.quatibot/task-workspaces/scout/thread-scout" },
            ] }));
        expect(rendered.html).toContain('title="/Users/me/.quatibot/task-workspaces/scout/thread-scout"');
        expect(rendered.html).toContain("~/.quatibot/task-workspaces/scout/thread-scout");
        expect(rendered.html).not.toContain("Scout&#x27;s private folder");
    });
    it("shows a legacy home-folder pin instead of the new bot default", () => {
        fixture.view.current = "files";
        const rendered = render(makeBot({
            cwd: "/workspace/new-project",
            tasks: [{ threadId: "thread-scout", title: "Legacy chat", createdAt: 1, cwd: null }],
        }));
        expect(rendered.html).toContain("Home folder");
        expect(rendered.html).not.toContain("/workspace/new-project");
        expect(rendered.html).not.toContain("Scout&#x27;s private folder");
        expect(rendered.html).toContain("Change default");
    });
    it("uses the bot default until the selected chat has a folder pin", () => {
        fixture.view.current = "files";
        for (const tasks of [undefined, [{ threadId: "thread-scout", title: "New chat", createdAt: 1 }]]) {
            const rendered = render(makeBot({ cwd: "/Users/me/new-project", tasks }));
            expect(rendered.html).toContain('title="/Users/me/new-project"');
            expect(rendered.html).toContain("~/new-project");
            expect(rendered.html).not.toContain("This chat keeps its current folder.");
            expect(rendered.html).not.toContain("Change default");
        }
    });
});
describe("Simple Browser tab with the browser off", () => {
    it("explains and turns on the same installation setting as Settings", async () => {
        fixture.view.current = "browser";
        fixture.config = { features: { browser: false }, browserEngine: { kind: "engine" } };
        const rendered = render(makeBot());
        expect(rendered.html).toContain("The browser is off");
        expect(rendered.html).not.toContain("BROWSER-PANEL");
        (browserSwitch(rendered).props.onClick as () => void)();
        await vi.waitFor(() => expect(fixture.dispatch).toHaveBeenCalledWith({ type: "configStatus", config: { features: { browser: true } } }));
        expect(fixture.api).toHaveBeenCalledWith("/api/config", {
            method: "PATCH",
            body: JSON.stringify({ features: { browser: true } }),
        });
    });
    it("turns on this bot's own browser switch when only that is off", async () => {
        fixture.view.current = "browser";
        const rendered = render(makeBot({ browser: false }));
        expect(browserSwitch(rendered).props.checked).toBe(false);
        (browserSwitch(rendered).props.onClick as () => void)();
        await vi.waitFor(() => expect(fixture.dispatch).toHaveBeenCalledWith({ type: "updateBot", botId: "scout", patch: { browser: true } }));
        expect(fixture.api).not.toHaveBeenCalled();
    });
    it("says why when this server cannot have a browser", () => {
        fixture.view.current = "browser";
        fixture.config = { features: { browser: false }, browserEngine: { kind: "unavailable", reason: "No engine here." } };
        const rendered = render(makeBot());
        expect(rendered.html).toContain("No engine here.");
        expect(browserSwitch(rendered).props.disabled).toBe(true);
    });
    it("shows the real browser once it is on, under a switch that turns it off for this bot only", () => {
        fixture.view.current = "browser";
        const rendered = render(makeBot());
        expect(rendered.html).toContain("BROWSER-PANEL");
        expect(browserSwitch(rendered).props.checked).toBe(true);
        (browserSwitch(rendered).props.onClick as () => void)();
        expect(fixture.dispatch).toHaveBeenCalledWith({ type: "updateBot", botId: "scout", patch: { browser: false } });
        expect(fixture.api).not.toHaveBeenCalled();
    });
    it("keeps the Browser tab and its switch in Advanced mode when the browser is off", () => {
        fixture.advanced = true;
        fixture.view.current = "browser";
        fixture.config = { features: { browser: false }, browserEngine: { kind: "engine" } };
        const rendered = render(makeBot());
        expect(rendered.html).toContain("The browser is off");
        expect(browserSwitch(rendered).props.checked).toBe(false);
    });
});
function browserSwitch(rendered: ReturnType<typeof render>) {
    return rendered.nodes.find((node) => node.props["aria-label"] === "Let Scout use a browser")!;
}
describe("Where the bot works", () => {
    it("offers browser and isolated VM destinations with plain names", () => {
        const rendered = render(makeBot());
        const card = rendered.nodes.find((node) => node.props["data-testid"] === "where-works")!;
        expect(rendered.html).toContain("Where Scout works");
        expect(nodes(card.props.children).find((node) => node.props.role === "group")!.props.className).toContain("grid-cols-3");
        expect(grid(rendered).map((node) => text(node.props.children))).toEqual(["Auto", "Local VM", "Browser", "Off"]);
        expect(placeLine(rendered)).toBe("Uses the agent's browser or an isolated VM, whichever the task needs.");
    });
    it("dispatches exactly what the Advanced picker dispatches for each place", () => {
        const expected = [
            { computer: null },
            { computer: "vm" },
            { computer: "browser", browser: true },
            { computer: "off" },
        ];
        for (const [index, patch] of expected.entries()) {
            const calls: unknown[][] = [];
            for (const advanced of [true, false]) {
                fixture.advanced = advanced;
                fixture.values = [];
                fixture.dispatch = vi.fn();
                const start = makeBot({ computer: patch.computer === "off" ? "browser" : "off" });
                const rendered = render(start);
                const group = rendered.nodes.find((node) => node.props.role === "group" && node.props["aria-label"] === "Computer destination")!;
                const option = nodes(group.props.children).filter((node) => node.type === "button")[index]!;
                (option.props.onClick as () => void)();
                calls.push((fixture.dispatch as ReturnType<typeof vi.fn>).mock.calls);
            }
            expect(calls[0]).toEqual([[{ type: "updateBot", botId: "scout", patch }]]);
            expect(calls[1]).toEqual(calls[0]);
        }
    });
});
describe("A chat pinned to a place", () => {
    const pinned = () => makeBot({ tasks: [{ threadId: "thread-scout", title: "", createdAt: 1, surface: "browser" }] } as Partial<Bot>);
    const note = (rendered: ReturnType<typeof render>) => text(rendered.nodes.find((node) => node.props["data-testid"] === "place-pinned-note")!.props.children);
    it("names the place in the grid's words, without pointing Simple at a composer chip it no longer has", () => {
        expect(note(render(pinned()))).toBe("This chat is pinned to “Browser”.");
        fixture.advanced = true;
        fixture.values = [];
        phaseIndex = -1;
        expect(note(render(pinned()))).toBe("This conversation is pinned to Browser. Change it from the composer.");
    });
    const pinnedOn = (computer: Bot["computer"], task: Partial<Task> = {}) => makeBot({ computer, tasks: [{ threadId: "thread-scout", title: "", createdAt: 1, surface: "browser", ...task }] } as Partial<Bot>);
    const unpin = (rendered: ReturnType<typeof render>) => rendered.nodes.find((node) => node.props["data-testid"] === "place-unpin");
    const fresh = () => { fixture.values = []; phaseIndex = -1; };
    it("leads a person's pin back to the grid's choice, which Simple has no composer chip for", () => {
        const button = unpin(render(pinned()))!;
        expect(text(button.props.children)).toBe("Use Auto");
        expect(button.props.disabled).toBe(false);
        (button.props.onClick as () => void)();
        expect(fixture.dispatch).toHaveBeenCalledWith({ type: "updateTask", botId: "scout", threadId: "thread-scout", patch: { surface: null } });
        fresh();
        expect(text(unpin(render(pinnedOn("vm")))!.props.children)).toBe("Use Local VM");
        fixture.advanced = true;
        fresh();
        expect(unpin(render(pinned()))).toBeUndefined();
    });
    it("waits out a running turn, as the server refuses a busy chat's place change", () => {
        const button = unpin(render(pinnedOn(undefined, { busy: true })))!;
        expect(button.props.disabled).toBe(true);
        expect(button.props.title).toBe("Wait for the current turn to finish");
    });
    it("says nothing of a pin Auto recorded, one matching Works on, or one Off overrides", () => {
        for (const bot of [pinnedOn(undefined, { surface: "browser", surfaceAuto: true }), pinnedOn("browser"), pinnedOn("off")]) {
            fresh();
            const rendered = render(bot);
            expect(rendered.nodes.some((node) => node.props["data-testid"] === "place-pinned-note"), JSON.stringify([bot.computer, bot.tasks])).toBe(false);
            expect(unpin(rendered)).toBeUndefined();
        }
    });
});
describe("Technical controls", () => {
    const local = () => makeBot({ computer: "browser" });
    it("hides the gear and Routines card in Simple and keeps them in Advanced", () => {
        const simple = render(local());
        expect(simple.nodes.some((node) => node.props.title === "Bot settings")).toBe(false);
        expect(simple.html).not.toContain("Works on");
        expect(simple.buttons.some((node) => text(node.props.children).startsWith("Routines"))).toBe(false);
        fixture.advanced = true;
        fixture.values = [];
        const advanced = render(local());
        expect(advanced.nodes.some((node) => node.props.title === "Bot settings")).toBe(true);
        expect(advanced.html).toContain("Works on");
        expect(advanced.buttons.some((node) => text(node.props.children).startsWith("Routines"))).toBe(true);
    });
    it("hides the VM settings link in Simple", () => {
        expect(render(makeBot({ computer: "vm" })).html).not.toContain("VM settings");
        fixture.advanced = true;
        fixture.values = [];
        expect(render(makeBot({ computer: "vm" })).html).toContain("VM settings");
    });
    it("keeps VM viewing and control available, with deletion in Advanced", () => {
        fixture.seed = {
            phase: "vm",
            resolved: { botId: "scout", threadId: "thread-scout", computer: "vm", cloudBackend: "box" },
            vmViewerUrl: "http://127.0.0.1/viewer",
            vmStatus: { mode: "per-bot", container: "running", ready: true },
        };
        const vm = () => makeBot({ computer: "vm" });
        const onOpenVmWorkspace = () => { };
        const simple = render(vm(), { onOpenVmWorkspace });
        expect(simple.html).not.toContain("Open two desktops");
        expect(simple.html).not.toContain("Delete this bot");
        const row = simple.nodes.find((node) => node.props["data-testid"] === "computer-actions")!;
        expect(nodes(row.props.children).filter((node) => node.type === "button").map((node) => text(node.props.children)))
            .toEqual(["Take control", "Full screen"]);
        fixture.advanced = true;
        fixture.values = [];
        phaseIndex = -1;
        const advanced = render(vm(), { onOpenVmWorkspace });
        expect(advanced.buttons.some((node) => node.props.title === "Delete Scout's VM" || /Delete/.test(text(node.props.children)))).toBe(true);
    });
});
