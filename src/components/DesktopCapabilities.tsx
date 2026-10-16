import { createContext, useContext, type ReactNode } from "react";
const capabilities: DesktopCapabilities = {
    host: { platform: "other", label: "Browser", session: "unknown", packaged: false },
    windowChrome: "native",
    screenPreview: { available: true, interaction: "none" },
    dictation: { available: false, engine: "none", onDevice: false },
    localComputer: { available: false, support: "unsupported", enabled: false, status: "unavailable" },
};
const CapabilitiesContext = createContext({ capabilities, ready: true });
export function DesktopCapabilitiesProvider({ children }: {
    children: ReactNode;
}) {
    return <CapabilitiesContext.Provider value={{ capabilities, ready: true }}>{children}</CapabilitiesContext.Provider>;
}
export function useDesktopCapabilities() {
    return useContext(CapabilitiesContext);
}
