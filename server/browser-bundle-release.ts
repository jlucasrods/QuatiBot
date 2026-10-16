// Reviewed vendor assets hashed on 2026-09-16: update all pins together and run each platform's packaged offline browser
// smoke test. Chromium's headless shell, not full Chrome (which includes Widevine).
import { join } from "node:path";
import {
  agentBrowserReleaseUrl,
  agentBrowserReleaseVersion,
  resolveAgentBrowserReleaseAsset,
} from "./browser-engine-release.ts";

export const CHROME_VERSION = "153.0.8010.47";
export const SUPPORTED_BROWSER_TARGETS = ["linux-arm64", "linux-x64"] as const;
export type BrowserBundleTarget = typeof SUPPORTED_BROWSER_TARGETS[number];

const CHROME_ASSETS = {
  "linux-arm64": { platform: "linux-arm64", bytes: 120245582, sha256: "af0931a58d6bab688112d5ca1f7abd6d95c0b8a296ef34637f272795787774d7", executableSha256: "b6a9f0483c976fddc72c34ce1c983a1275163cdfb95576874bfed5ff07c53807" },
  "linux-x64": { platform: "linux64", bytes: 119695587, sha256: "7728775cf4a35464cd81c8eea2d44d6d32ccc0bd1edfa75aea7f32d146963d63", executableSha256: "ea90dee9cbd7b17f197eb6c386bd9f1ff636734ee99753cd2408658c45358bf2" },
} as const;

export function browserBundleSpec(target: string) {
  if (!Object.hasOwn(CHROME_ASSETS, target)) throw new Error(`Unsupported Linux browser target: ${target}`);
  const pinned = CHROME_ASSETS[target as BrowserBundleTarget];
  const [platform, arch] = target.split("-");
  const engine = resolveAgentBrowserReleaseAsset(platform as NodeJS.Platform, arch)!;

  const directory = `chrome-headless-shell-${pinned.platform}`;
  return {
    schemaVersion: 1,
    target,
    engine: {
      version: agentBrowserReleaseVersion(engine),
      asset: engine.asset,
      url: agentBrowserReleaseUrl(engine),
      bytes: engine.bytes,
      sha256: engine.sha256,
      executable: `agent-browser`,
    },
    chrome: {
      version: CHROME_VERSION,
      asset: `${directory}.zip`,
      url: `https://storage.googleapis.com/chrome-for-testing-public/${CHROME_VERSION}/${pinned.platform}/${directory}.zip`,
      bytes: pinned.bytes,
      sha256: pinned.sha256,
      executableSha256: pinned.executableSha256,
      executable: `chrome/${directory}/chrome-headless-shell`,
      license: `chrome/${directory}/LICENSE.headless_shell`,
      about: `chrome/${directory}/ABOUT`,
    },
  };
}

export function browserBundlePaths(bundleDirectory: string, target: string) {
  const spec = browserBundleSpec(target);
  return {
    directory: bundleDirectory,
    manifest: join(bundleDirectory, "manifest.json"),
    engine: join(bundleDirectory, spec.engine.executable),
    chrome: join(bundleDirectory, spec.chrome.executable),
    licenses: join(bundleDirectory, "licenses"),
  };
}
