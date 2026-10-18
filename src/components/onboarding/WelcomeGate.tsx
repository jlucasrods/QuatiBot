import { useEffect, useState } from "react";
import { emailGateDone } from "@/lib/onboarding-status";
import { hostedMember, LOCAL_VIEWER, welcomeDue, welcomeViewer, type WelcomeViewer } from "@/lib/onboarding";
import { api, useStore } from "@/state/store";
import { SharedWorkspaceHint } from "./SharedWorkspaceHint";
import { WelcomeFlow } from "./WelcomeFlow";
/**
 * Security: a remote page the desktop app loads gets a reduced but truthy window.quati without remoteClient, and is no
 * more the owner than a browser.
 */
export function localDesktopPage(): boolean {
    return false;
}
export function useWelcomeViewer(): WelcomeViewer | null {
    const local = localDesktopPage();
    const [viewer, setViewer] = useState<WelcomeViewer | null>(local ? LOCAL_VIEWER : null);
    useEffect(() => {
        if (local)
            return;
        let active = true;
        void api("/api/auth/session", { timeoutMs: 10000 })
            .then((session) => {
            if (active)
                setViewer(welcomeViewer(session));
        })
            .catch(() => {
            if (active)
                setViewer(LOCAL_VIEWER);
        });
        return () => {
            active = false;
        };
    }, [local]);
    return viewer;
}
export function WelcomeGate({ viewer }: {
    viewer: WelcomeViewer | null;
}) {
    const { state, dispatch } = useStore();
    const [dismissed, setDismissed] = useState(false);
    const remoteClient = false;
    if (!viewer)
        return null;
    if (hostedMember(viewer)) {
        return (<SharedWorkspaceHint replay={state.welcomeOpen} onClose={() => {
                if (state.welcomeOpen)
                    dispatch({ type: "toggleWelcome", open: false });
            }}/>);
    }
    const due = !dismissed &&
        welcomeDue(state.config, {
            remoteClient,
            legacyDone: emailGateDone(),
            hosted: viewer.hosted,
            canSave: viewer.canSave,
            cloudHome: viewer.cloudHome,
        });
    if (!state.welcomeOpen && !due)
        return null;
    const bot = state.bots.find((b) => !b.hidden) ?? null;
    const replay = state.welcomeOpen && !due;
    return (<WelcomeFlow bot={bot} replay={replay} hosted={viewer.hosted} onDone={() => {
            setDismissed(true);
            dispatch({ type: "toggleWelcome", open: false });
            if (!replay)
                dispatch({ type: "toggleTour", open: true });
        }}/>);
}
