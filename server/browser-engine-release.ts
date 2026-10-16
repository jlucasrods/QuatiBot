// Digests computed from the official GitHub assets on 2026-09-08, except the versioned Windows vendor build; update pins
// only through a reviewed native end-to-end run. The Dockerfile keeps the official Linux version.
export const AGENT_BROWSER_VERSION = "0.37.0";
export interface AgentBrowserReleaseAsset {
    /** `<platform>-<arch>`; Linux adds `-musl` on Alpine-style systems. */
    target: string;
    asset: string;
    sha256: string;
    bytes: number;
    /** A reviewed platform-specific vendor revision; other assets use the upstream version. */
    version?: string;
    /** Exact release URL for a reviewed vendor build, never a mutable latest URL. */
    url?: string;
}
const RELEASES = new Map<string, AgentBrowserReleaseAsset>([
    [
        "linux-arm64",
        { target: "linux-arm64", asset: "agent-browser-linux-arm64", sha256: "0315a8c4f7bf167cc5fd5eeaea79009b0e6b5d2ae8b3057bf6f96be978483426", bytes: 12507840 },
    ],
    [
        "linux-musl-arm64",
        { target: "linux-musl-arm64", asset: "agent-browser-linux-musl-arm64", sha256: "db67c0e84e0668c052c2cbdca325c57f896e309c3723755dcdd65b700f8a2b52", bytes: 12369352 },
    ],
    [
        "linux-musl-x64",
        { target: "linux-musl-x64", asset: "agent-browser-linux-musl-x64", sha256: "5cff3bc7b2486867aba2901f92c9ce6029bd2a37951630d9feec1c5b3fee402e", bytes: 14092888 },
    ],
    [
        "linux-x64",
        { target: "linux-x64", asset: "agent-browser-linux-x64", sha256: "78e0c5a14a7fa1f3d1ae2acdbdcc94a047b435b998a8c505fcc49d7fa4935a49", bytes: 14253776 },
    ]
]);
export function agentBrowserReleaseUrl(asset: AgentBrowserReleaseAsset): string {
    return asset.url ?? `https://github.com/vercel-labs/agent-browser/releases/download/v${AGENT_BROWSER_VERSION}/${asset.asset}`;
}
export function agentBrowserReleaseVersion(asset: AgentBrowserReleaseAsset | null): string {
    return asset?.version ?? AGENT_BROWSER_VERSION;
}
/** The asset for this machine, or null where Vercel publishes none. */
export function resolveAgentBrowserReleaseAsset(platform: NodeJS.Platform = process.platform, arch: string = process.arch, musl = false): AgentBrowserReleaseAsset | null {
    const key = platform === "linux" && musl ? `linux-musl-${arch}` : `${platform}-${arch}`;
    return RELEASES.get(key) ?? null;
}
