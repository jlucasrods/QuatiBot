import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { resolveAgentBrowserBinary } from "../../server/browser-engine.ts";
import { waitForExit } from "../../server/testing/cleanup.ts";
import { runControlQuati } from "../control-quati.ts";
import { UI_TOOLS_DIR } from "./control-quati-ui.ts";
import { waitForUiLaunch } from "./ui-launch.ts";
import { mountPreview, type MountedPreview } from "./preview-fixture.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const enabled = process.env.QUATI_UI_E2E === "1" || Boolean(resolveAgentBrowserBinary({ dataDir: UI_TOOLS_DIR, env: process.env }));

describe("isolated VM preview recovery in the real renderer", () => {
  let child: ChildProcess | undefined;
  let preview: MountedPreview | undefined;
  afterAll(async () => {
    await waitForExit(child, { signal: "SIGINT", graceMs: 30_000 });
    await preview?.close();
  });

  (enabled ? it : it.skip)("retains frames without cancelling busy captures and rejects stale conversations and viewers", async () => {
    child = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "scripts/control-quati.ts"), "ui", "launch"], {
      cwd: ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe"],
    });
    const info = await waitForUiLaunch(child, 600_000);
    const ui = (verb: string, ...args: string[]) => runControlQuati(["ui", verb, "--ui", info.ui, ...args]) as Promise<Record<string, unknown>>;
    const evaluate = async (js: string) => (await ui("eval", "--js", js)).result;
    const click = (name: string) => ui("click", "--name", name);
    const select = (name: string, value: string) => evaluate(`(() => {
      const select = document.querySelector('select[aria-label=${JSON.stringify(name)}]');
      select.value = ${JSON.stringify(value)};
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    const currentFrame = () => evaluate("document.querySelector('img[alt$=\"screen\"]')?.getAttribute('src') ?? null");
    const frameVisible = () => evaluate("Array.from(document.querySelectorAll('img[alt$=\"screen\"]')).some(img => img.complete && img.naturalWidth > 1 && getComputedStyle(img).visibility === 'visible')");
    const stat = (key: string) => evaluate(`window.vmPreviewFixture.${key}`);
    const pause = (ms: number) => evaluate(`new Promise(resolve => setTimeout(() => resolve(true), ${ms}))`);
    const clickTab = async (name: string) => {
      const state = await ui("snapshot", "--interactive");
      const target = Object.entries(state.refs as Record<string, { role: string; name: string }>)
        .find(([, entry]) => entry.role === "tab" && entry.name.startsWith(name));
      expect(target, JSON.stringify(state.refs)).toBeDefined();
      await ui("click", "--ref", `@${target![0]}`);
    };

    preview = await mountPreview({ info: { url: info!.url } }, {
      entry: "/scripts/testing/vm-preview.tsx", route: "/__vm-preview.html", title: "Isolated VM preview regression", logLevel: "silent",
    });
    await evaluate(`location.href = ${JSON.stringify(preview.previewUrl)}; true`);
    await expect.poll(frameVisible, { timeout: 20_000 }).toBe(true);
    for (const scenario of ["vm-pin", "auto-vm"]) {
      await select("Conversation surface", scenario);
      await expect.poll(currentFrame, { timeout: 6000 }).toBe(await stat("screenshot"));
      expect((await stat("paths") as string[]).some(path => path.endsWith(`/local-computer/screenshot?threadId=fixture-${scenario}`))).toBe(true);
    }
    await select("Conversation surface", "off");
    await expect.poll(currentFrame).toBe(null);
    await select("Conversation surface", "vm-pin");
    await expect.poll(frameVisible).toBe(true);

    await select("Screenshot response", "held");
    await expect.poll(() => stat("capturing"), { timeout: 6000 }).toBe(true);
    const requests = await stat("requests");
    const aborted = await stat("aborted");
    await click("Busy: true");
    await pause(500);
    expect(await stat("aborted")).toBe(aborted);
    expect(await stat("requests")).toBe(requests);
    expect(await frameVisible()).toBe(true);

    await select("Screenshot response", "connected");
    await select("Conversation surface", "other-vm");
    await expect.poll(() => stat("aborted")).toBe(aborted + 1);
    await expect.poll(() => stat("conflicts")).toBeGreaterThan(0);
    await click("Release held capture");
    await expect.poll(currentFrame, { timeout: 8000 }).toBe(await stat("otherScreenshot"));
    expect(await frameVisible()).toBe(true);

    await click("Busy: false");
    await select("Screenshot response", "failed");
    await expect.poll(() => stat("failures"), { timeout: 6000 }).toBeGreaterThan(0);
    expect(await currentFrame()).toBe(await stat("otherScreenshot"));
    expect(await frameVisible()).toBe(true);
    const successful = await stat("successful");
    await select("Screenshot response", "connected");
    await expect.poll(() => stat("successful"), { timeout: 8000 }).toBeGreaterThan(Number(successful));

    await select("Conversation surface", "browser-pin");
    await expect.poll(() => evaluate('document.querySelector("[data-tour=computer-browser]")?.getAttribute("aria-selected")')).toBe("true");
    await clickTab("Browser");
    await select("Conversation surface", "vm-pin");
    await expect.poll(currentFrame).toBe(await stat("screenshot"));
    await select("Conversation surface", "browser-pin");
    await clickTab("Routines");
    await pause(200);
    expect(await evaluate('document.querySelector("[data-tour=computer-browser]")?.getAttribute("aria-selected")')).toBe("false");
    await select("Conversation surface", "vm-pin");
    await expect.poll(frameVisible).toBe(true);

    await evaluate("window.vmPreviewFixture.holdJoin = true");
    await evaluate("Array.from(document.querySelectorAll('button')).find(button => button.getAttribute('aria-label')?.endsWith('live desktop'))?.click(); true");
    await expect.poll(() => stat("joining")).toBe(true);
    await select("Conversation surface", "other-vm");
    await click("Release desktop join");
    await expect.poll(() => stat("joining")).toBe(false);
    expect(await stat("opened")).toBe(0);
    await expect.poll(currentFrame).toBe(await stat("otherScreenshot"));

    await waitForExit(child, { signal: "SIGINT", graceMs: 30_000 });
    expect(child.exitCode).toBe(0);
    expect(existsSync(info!.dataDir)).toBe(false);
    expect(existsSync(info!.logPath)).toBe(true);
  }, 720_000);
});
