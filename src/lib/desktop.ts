const browserCapabilities: DesktopCapabilities = {
    host: {
        platform: "other",
        label: "Browser",
        session: "unknown",
        packaged: false,
    },
    windowChrome: "native",
    screenPreview: {
        available: false,
        interaction: "none",
        reasonCode: "desktop-app-required",
    },
    dictation: {
        available: false,
        engine: "none",
        onDevice: false,
        reasonCode: "desktop-app-required",
    },
    localComputer: {
        available: false,
        support: "unsupported",
        enabled: false,
        status: "unavailable",
        reasonCode: "desktop-app-required",
    },
};
let cached: DesktopCapabilities | null = null;
let cacheRevision = 0;
export function initialDesktopCapabilities(): DesktopCapabilities {
    return browserCapabilities;
}
export async function loadDesktopCapabilities(): Promise<DesktopCapabilities> {
    if (cached)
        return cached;
    return browserCapabilities;
}
export function desktopCapabilitiesNow(): DesktopCapabilities {
    return cached ?? initialDesktopCapabilities();
}
export function cacheDesktopCapabilities(capabilities: DesktopCapabilities): DesktopCapabilities {
    cacheRevision += 1;
    cached = capabilities;
    return capabilities;
}
