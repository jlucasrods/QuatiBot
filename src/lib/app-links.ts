export const APP_NAME = "OpenMausBot";
export const APP_REPOSITORY = "https://github.com/milind-soni/OpenMausBot";
export const DOCS_URL = `${APP_REPOSITORY}/tree/main/docs`;
export const APPROVAL_LEVELS_URL = `${APP_REPOSITORY}/blob/main/docs/approval-levels.md`;
export const RELEASES_URL = `${APP_REPOSITORY}/releases`;
export const PRICING_URL = "https://www.openmausbot.com/pricing";
export function withSource(url: string, source: string): string {
    const target = new URL(url);
    target.searchParams.set("src", source);
    return target.href;
}
export const LICENSE_URL = `${APP_REPOSITORY}/blob/main/LICENSE`;
export function appVersion(): string {
    return typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";
}
const PLATFORM_NAMES: Record<string, string> = {
    darwin: "macOS",
    win32: "Windows",
    linux: "Linux",
};
export function platformLabel(platform?: string): string | null {
    return (platform && PLATFORM_NAMES[platform]) ?? null;
}
export async function openExternalLink(url: string): Promise<void> {
    window.open(url, "_blank", "noopener,noreferrer");
}
