import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ComputerPanel } from "../../src/components/ComputerPanel";
import { LocalComputerSection } from "../../src/components/LocalComputerSection";
import { StoreProvider, useStore, type Bot } from "../../src/state/store";
import { applySkin, readSkin } from "../../src/lib/skins";
import "../../src/styles.css";

function frame(label: string, color: string) {
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 400;
  const context = canvas.getContext("2d")!;
  context.fillStyle = color;
  context.fillRect(0, 0, 640, 400);
  context.fillStyle = "white";
  context.font = "28px sans-serif";
  context.fillText(label, 70, 210);
  return canvas.toDataURL("image/png");
}

const screenshot = frame("Isolated VM connected", "#134e4a");
const otherScreenshot = frame("Another VM conversation", "#1e3a8a");
let mode = "connected";
let held = false;
let surfaceScenario = "vm-pin";
let vmRunning = false;
let vmDesktopReady = false;
const transport = {
  screenshot, otherScreenshot, requests: 0, aborted: 0, conflicts: 0, failures: 0, successful: 0, capturing: false,
  joining: false, holdJoin: false, opened: 0, paths: [] as string[],
  vmStarts: 0, vmReadinessReads: 0,
  resetVm: () => { vmRunning = false; vmDesktopReady = false; },
  releaseCapture: () => {}, releaseJoin: () => {},
};
Object.assign(window, { vmPreviewFixture: transport });
Object.defineProperty(window, "open", { configurable: true, value: () => ({
  opener: null,
  location: { replace: () => { transport.opened++; } },
  close: () => {},
}) });

const originalFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const requested = typeof input === "string" ? input : "";
  const url = new URL(requested, window.location.origin);
  const path = url.pathname;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json" },
  });
  if (path.includes("/computer") || path.includes("/local-computer")) transport.paths.push(requested);
  if (/^\/api\/bots\/[\w-]+\/computer$/.test(path)) return json({ surface: "vm", configured: true });
  if (path.endsWith("/computer/control")) {
    if (init?.method === "POST") {
      const action = JSON.parse(String(init.body)).action;
      if (action === "take" && transport.holdJoin) {
        transport.joining = true;
        await new Promise<void>(resolve => { transport.releaseJoin = resolve; });
        transport.joining = false;
      }
      held = action === "take";
    }
    return json({ held, helpReason: null });
  }
  const status = () => ({
    platform: "linux", runtime: "docker", available: ["docker"], mode: "shared", daemonUp: true,
    image: true, create_supported: true, container: vmRunning ? "running" : "stopped", resumable: !vmRunning,
    imageMatches: true, managed: true, network: "loopback", security: "hardened", persistence: "durable",
    desktopReady: vmDesktopReady, ready: vmDesktopReady, stop_reason: vmRunning ? null : "idle",
    problem: vmDesktopReady ? null : vmRunning ? "Desktop is starting" : "The Local VM is stopped",
    viewer_url: "/desktop-viewer#fixture", idle_timeout_ms: 480 * 60_000, max_instances: 2,
    commands: {}, workspace_path: "/fixture/workspace", workspace_guest_path: "/home/cua/workspace",
  });
  if (path.endsWith("/local-computer/start")) {
    transport.vmStarts++;
    vmRunning = true;
    return json(status());
  }
  if (path.endsWith("/local-computer") && surfaceScenario === "vm-stopped") {
    if (vmRunning && !vmDesktopReady) transport.vmReadinessReads++;
    return json(status());
  }
  if (path.endsWith("/local-computer")) return json({
    daemonUp: true, mode: "per-bot", max_instances: 2, image: true, create_supported: true,
    container: "running", imageMatches: true, managed: true, network: "loopback",
    security: "hardened", persistence: "durable", desktopReady: true, ready: true,
    problem: null, viewer_url: "/desktop-viewer#fixture",
  });
  if (path.endsWith("/local-computer/screenshot")) {
    transport.requests++;
    const image = url.searchParams.get("threadId") === "fixture-other-vm" ? otherScreenshot : screenshot;
    if (transport.capturing) {
      transport.conflicts++;
      return json({ error: "VM capture is busy" }, 409);
    }
    if (mode === "failed") {
      transport.failures++;
      return json({ error: "VM capture is temporarily unavailable" }, 503);
    }
    if (mode === "held") {
      transport.capturing = true;
      const aborted = () => { transport.aborted++; };
      init?.signal?.addEventListener("abort", aborted, { once: true });
      await new Promise<void>(resolve => {
        transport.releaseCapture = () => {
          transport.capturing = false;
          init?.signal?.removeEventListener("abort", aborted);
          resolve();
        };
      });
    }
    transport.successful++;
    return json({ image });
  }
  return originalFetch(input, init);
};

function Fixture() {
  const { state } = useStore();
  const bot = state.bots[0];
  const [busy, setBusy] = useState(true);
  const [generation, setGeneration] = useState(0);
  const [scenario, setScenario] = useState("vm-pin");
  const [panel, setPanel] = useState("computer");
  const shown: Bot | undefined = bot && {
    ...bot, busy, browser: true,
    computer: scenario === "off" ? "off" : scenario === "vm-stopped" ? "vm" : scenario === "auto-vm" ? undefined : "browser",
    threadId: `fixture-${scenario}`,
    tasks: [{ threadId: `fixture-${scenario}`, title: scenario, createdAt: 1, busy,
      modelSelection: bot.modelSelection,
      ...(scenario === "auto-vm" || scenario === "off" ? {} : { surface: scenario === "browser-pin" ? "browser" : "vm" }),
    }],
  };
  return <div className="flex h-screen justify-center">
    <div className="fixed left-2 top-2 grid max-w-32 gap-3 text-sm">
      <label>Screenshot response<select aria-label="Screenshot response" defaultValue={mode} onChange={event => { mode = event.target.value; }}>
        {["connected", "held", "failed"].map(value => <option key={value}>{value}</option>)}
      </select></label>
      <label>Conversation<select aria-label="Conversation surface" value={scenario} onChange={event => {
        surfaceScenario = event.target.value;
        transport.resetVm();
        setScenario(surfaceScenario);
      }}>
        {["vm-pin", "other-vm", "auto-vm", "browser-pin", "off", "vm-stopped"].map(value => <option key={value}>{value}</option>)}
      </select></label>
      <label>Panel<select aria-label="Panel" value={panel} onChange={event => setPanel(event.target.value)}>
        <option value="computer">Computer</option><option value="settings">VM settings</option>
      </select></label>
      <button onClick={() => setGeneration(value => value + 1)}>Reconnect panel</button>
      <button onClick={() => setBusy(value => !value)}>Busy: {String(busy)}</button>
      <button onClick={() => transport.releaseCapture()}>Release held capture</button>
      <button onClick={() => transport.releaseJoin()}>Release desktop join</button>
      <button onClick={() => { vmDesktopReady = true; }}>Finish VM startup</button>
    </div>
    {shown && (panel === "settings" ? <div className="w-[720px] overflow-y-auto"><LocalComputerSection /></div> : <ComputerPanel key={generation} bot={shown} />)}
  </div>;
}

applySkin(readSkin());
createRoot(document.getElementById("root")!).render(<StoreProvider><Fixture /></StoreProvider>);
