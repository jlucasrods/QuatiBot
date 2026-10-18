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
export function initialDesktopCapabilities(): DesktopCapabilities {
    return browserCapabilities;
}
export function desktopCapabilitiesNow(): DesktopCapabilities {
    return browserCapabilities;
}
