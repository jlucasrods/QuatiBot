import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { expect, it } from "vitest";
import { recordScreenClip } from "./screen-recording.ts";
import { CHROME } from "./browser/cdp/testing/real-chrome.ts";
import { startService } from "./browser/testing/real-service.ts";

it.skipIf(!CHROME)("records a replayable video from the agent's own browser after a real page action", async () => {
  const browser = await startService();
  const target = { session: "web-migration", key: "bot:web-migration" };
  try {
    const page = '<button onclick="this.textContent=\'Clicked\'">Click me</button>';
    const opened = await browser.call(target, "agent_browser_open", { url: `data:text/html,${encodeURIComponent(page)}` });
    expect(opened.isError, browser.text(opened)).not.toBe(true);
    const clicked = await browser.call(target, "agent_browser_click", { selector: "button" });
    expect(clicked.isError, browser.text(clicked)).not.toBe(true);
    expect(await browser.peek(target, "document.querySelector('button').textContent")).toBe("Clicked");
    const output = join(browser.dataDir, "agent-screen.webm");
    await recordScreenClip(async () => {
      const result = await browser.call(target, "agent_browser_screenshot");
      const frame = result.content.find(part => part.type === "image");
      expect(frame?.data).toBeTruthy();
      return Buffer.from(frame!.data!, "base64");
    }, output, 2);
    const { stdout } = await promisify(execFile)("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,width,height", "-of", "json", output]);
    expect(JSON.parse(stdout)).toMatchObject({ streams: [{ codec_name: "vp9", width: expect.any(Number), height: expect.any(Number) }] });
    await promisify(execFile)("ffmpeg", ["-v", "error", "-i", output, "-f", "null", "-"]);
  } finally {
    await browser.close();
  }
}, 120_000);
