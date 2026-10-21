// https://github.com/vercel-labs/agent-browser/pull/2003
export const AGENT_BROWSER_VERSION = "0.39.1";
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
        { target: "linux-arm64", asset: "agent-browser-linux-arm64", sha256: "9d8fdc586056df65747927ae166157c83af91b52cea287175e5544afd2591d33", bytes: 15844112 },
    ],
    [
        "linux-musl-arm64",
        { target: "linux-musl-arm64", asset: "agent-browser-linux-musl-arm64", sha256: "c4959f3e193c5bc8f333613363f25f2eaceecafe25a0821843b271906474a20f", bytes: 15642552 },
    ],
    [
        "linux-musl-x64",
        { target: "linux-musl-x64", asset: "agent-browser-linux-musl-x64", sha256: "74507cdab98aa91bdc14346c545aff974640a225e43f8c3d6c23164f8c0f9bb9", bytes: 18102976 },
    ],
    [
        "linux-x64",
        { target: "linux-x64", asset: "agent-browser-linux-x64", sha256: "6906d3a2a67b05809932a93d99e53d1132373f0a52a617b2d6032dbb954df6fc", bytes: 18305528 },
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
