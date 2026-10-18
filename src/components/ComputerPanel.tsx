import { Switch } from "./SettingsPrimitives";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { waitForLocalVmReady } from "@/lib/local-vm-readiness";
import { CalendarClock, Box, Check, Sparkles, Globe, Hand, Loader2, Maximize2, Monitor, Power, Settings, X } from "lucide-react";
import { api, currentTaskBot, useStore, type Bot, type ConfigStatus } from "@/state/store";
import { useAdvancedMode } from "@/lib/interface-mode";
import { ComputerFilesPane } from "./ComputerFilesPane";
import { effectivePlace, isComputerPlace, placeLabelKey } from "@/lib/place";
import { cn } from "@/lib/cn";
import { usePageVisible } from "@/lib/page-visible";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { RoutinesSection } from "./bot-settings/RoutinesSection";
import { routineRunLabel, routineRunTone } from "@/lib/routine-display";
import { BrowserPanel } from "./BrowserPanel";
import { browserAvailable, browserUnavailableReason, builtInBrowserEnabled } from "@/lib/feature-flags";
import { parseComputerHelp, transitionComputerControlLease, type ComputerControlAction } from "@/lib/computer-control";
import { SignInBanner } from "./SignInRequestCard";
import { instanceSupportsLocalComputer, localComputerDisabledReason, localComputerSelectable } from "@/lib/local-computer";
import { moveBetweenTabs, PANEL_TABS, panelTabProps, TAB_PANEL_FOCUS, tabPanelProps } from "./computer-panel-tabs";
import { computerPanelTabs, readComputerPanelView, resolveComputerPanelView, writeComputerPanelView, type ComputerPanelView, } from "@/lib/computer-panel-view";
import { openPlaceAction, placeBlocked, placeFacts, placeHasIssue, placeViewFor, usePlaceSeat, worksOnSimpleLabel } from "@/lib/place-view";
import { type PlaceActionId, type PlaceFacts, type PlaceView } from "../../shared/place-view";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
const DataPanel = lazy(() => import("./data/DataPanel").then((module) => ({ default: module.DataPanel })));
class LocalizedPanelError extends Error {
    constructor(readonly key: LocaleKey, readonly problem?: string | null, readonly fallbackKey?: LocaleKey) {
        super(key);
    }
}
function panelErrorText(error: Error | string | null): string | null {
    if (error instanceof LocalizedPanelError) {
        return t(error.key, error.fallbackKey ? { problem: error.problem ?? t(error.fallbackKey) } : undefined);
    }
    return error instanceof Error ? error.message : error;
}
type Phase = "checking" | "vm" | "vm-unavailable" | "auto-unavailable" | "browser" | "off" | "error";
interface LocalVmStatus {
    resumable?: boolean;
    stop_reason?: "idle" | null;
    mode: "shared" | "per-bot" | "pool";
    max_instances: number;
    image: boolean;
    create_supported: boolean;
    container: "running" | "stopped" | "missing";
    imageMatches: boolean;
    managed: boolean;
    network: "loopback" | "unsafe" | "unknown";
    security: "hardened" | "unsafe" | "unknown";
    persistence: "durable" | "unsafe" | "unknown";
    desktopReady: boolean;
    ready: boolean;
    problem: string | null;
    viewer_url: string;
}
const computerControlSnapshotSchema = z.object({
    held: z.boolean().optional().default(false),
    helpReason: z.string().nullable().optional().default(null),
    help: z.unknown().optional().transform(parseComputerHelp),
}).passthrough();
const PANEL_WIDTH_KEY = "quati-computer-panel-width";
const PANEL_MIN_WIDTH = 360;
const PANEL_MAX_WIDTH = 960;
const PANEL_DEFAULT_WIDTH = 400;
const PANEL_RESIZE_STEP = 40;
function readPanelWidth(): number {
    try {
        const stored = Number(localStorage.getItem(PANEL_WIDTH_KEY));
        if (Number.isFinite(stored) && stored >= PANEL_MIN_WIDTH && stored <= PANEL_MAX_WIDTH)
            return stored;
    }
    catch {
    }
    return PANEL_DEFAULT_WIDTH;
}
export function ComputerPanel({ bot: profileBot }: {
    bot: Bot;
    onOpenVmWorkspace?: (botId: string) => void;
}) {
    const [panelWidth, setPanelWidth] = useState(readPanelWidth);
    const resizeFrom = useRef<{
        x: number;
        width: number;
    } | null>(null);
    const persistPanelWidth = (width: number) => {
        try {
            localStorage.setItem(PANEL_WIDTH_KEY, String(width));
        }
        catch {
        }
    };
    const onResizeStart = (event: React.PointerEvent<HTMLDivElement>) => {
        resizeFrom.current = { x: event.clientX, width: panelWidth };
        event.currentTarget.setPointerCapture(event.pointerId);
    };
    const onResizeMove = (event: React.PointerEvent<HTMLDivElement>) => {
        if (!resizeFrom.current)
            return;
        const next = Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, resizeFrom.current.width + (resizeFrom.current.x - event.clientX)));
        setPanelWidth(next);
    };
    const onResizeEnd = (event: React.PointerEvent<HTMLDivElement>) => {
        if (!resizeFrom.current)
            return;
        resizeFrom.current = null;
        event.currentTarget.releasePointerCapture(event.pointerId);
        persistPanelWidth(panelWidth);
    };
    const onResizeBy = (delta: number) => {
        setPanelWidth((current) => {
            const next = Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, current + delta));
            persistPanelWidth(next);
            return next;
        });
    };
    const separatorRef = useRef<HTMLDivElement>(null);
    const [separatorWidth, setSeparatorWidth] = useState<number | null>(null);
    useEffect(() => {
        const panel = separatorRef.current?.closest("aside");
        if (!panel)
            return;
        const read = () => setSeparatorWidth(panel.offsetWidth);
        read();
        const observer = new ResizeObserver(read);
        observer.observe(panel);
        return () => observer.disconnect();
    }, []);
    const onSeparatorKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
        if (event.ctrlKey || event.metaKey || event.altKey)
            return;
        const widen = event.key === "ArrowLeft" ? PANEL_RESIZE_STEP : event.key === "ArrowRight" ? -PANEL_RESIZE_STEP : null;
        if (widen === null || separatorWidth === null)
            return;
        event.preventDefault();
        onResizeBy(widen);
    };
    const { state, dispatch, flushBotPatches } = useStore();
    const liveTask = profileBot.tasks?.find((task) => task.threadId === profileBot.threadId);
    const livePlace = effectivePlace(profileBot, liveTask);
    const threadBot = currentTaskBot(profileBot);
    const connectionKey = `${profileBot.id}:${profileBot.threadId}:${livePlace}:${threadBot.modelSelection.instanceId}`;
    const [autoSurface, setAutoSurface] = useState<{
        key: string;
        surface: Bot["computer"];
    } | null>(null);
    const autoSurfaceCurrent = autoSurface?.key === connectionKey;
    const surfaceReady = livePlace !== "auto" || autoSurfaceCurrent;
    const bot = { ...threadBot, computer: livePlace === "auto"
            ? autoSurfaceCurrent ? autoSurface.surface : undefined : livePlace };
    const viewerConnectionKey = `${bot.id}:${bot.threadId}:${bot.computer}`;
    const viewerConnection = useRef(viewerConnectionKey);
    viewerConnection.current = viewerConnectionKey;
    const desktopJoin = useRef<AbortController | null>(null);
    useEffect(() => () => desktopJoin.current?.abort(), [viewerConnectionKey]);
    const placeLive = Boolean(bot.busy);
    const threadPath = useCallback((suffix: string) => `/api/bots/${profileBot.id}/${suffix}?threadId=${encodeURIComponent(profileBot.threadId)}`, [profileBot.id, profileBot.threadId]);
    const canManageVm = profileBot.computer === "vm" && livePlace === "vm";
    const { capabilities, ready: capabilitiesReady } = useDesktopCapabilities();
    const isLinux = capabilities.host.platform === "linux";
    const providerSupportsLocal = instanceSupportsLocalComputer(state.instances, bot);
    const localSelectable = localComputerSelectable({ capabilities, providerSupportsLocal });
    const localDisabledReason = localComputerDisabledReason({ capabilities, providerSupportsLocal });
    const placeSeat = usePlaceSeat(capabilities.host.platform);
    const [phase, setPhase] = useState<Phase>("checking");
    const [persistedComputerSelection, setPersistedComputerSelection] = useState<{
        botId: string;
        computer: Bot["computer"];
        section: string;
    } | null>(null);
    const [resolvedComputerSelection, setResolvedComputerSelection] = useState<{
        botId: string;
        threadId: string;
        computer: Bot["computer"];
    } | null>(null);
    const computerSelectionPersisted = Boolean(persistedComputerSelection
        && persistedComputerSelection.botId === bot.id
        && persistedComputerSelection.computer === profileBot.computer
        && persistedComputerSelection.section === (bot.section?.trim() ?? ""));
    const computerStatusCurrent = Boolean(resolvedComputerSelection
        && resolvedComputerSelection.botId === bot.id
        && resolvedComputerSelection.threadId === bot.threadId
        && resolvedComputerSelection.computer === bot.computer);
    const updateComputerSelection = useCallback((patch: {
        computer?: Bot["computer"] | null;
        browser?: boolean;
        acknowledgeLocalAuto?: boolean;
    }) => {
        // Clear in the same render as the optimistic profile change; the resolving effect waits for its PATCH.
        setResolvedComputerSelection(null);
        setPhase("checking");
        dispatch({ type: "updateBot", botId: bot.id, patch });
    }, [bot.id, dispatch]);
    useEffect(() => {
        let alive = true;
        setPersistedComputerSelection(null);
        void flushBotPatches(bot.id).then((persistedBot) => {
            if (!alive)
                return;
            if (persistedBot && persistedBot.computer !== profileBot.computer)
                return;
            if (persistedBot && (persistedBot.section?.trim() ?? "") !== (bot.section?.trim() ?? ""))
                return;
            setPersistedComputerSelection({
                botId: bot.id,
                computer: profileBot.computer,
                section: bot.section?.trim() ?? "",
            });
        });
        return () => {
            alive = false;
        };
    }, [bot.id, profileBot.computer, bot.section, flushBotPatches]);
    const [, setPreviewError] = useState<Error | string | null>(null);
    const [vmFrame, setVmFrame] = useState<string | null>(null);
    const [vmViewerUrl, setVmViewerUrl] = useState<string | null>(null);
    const [vmStatus, setVmStatus] = useState<LocalVmStatus | null>(null);
    const [pending, setPending] = useState<"join" | "vm-start" | "vm-create" | "vm-recreate" | "vm-delete" | null>(null);
    const [controlPending, setControlPending] = useState(false);
    const [viewerOpen] = useState(false);
    const [error, setError] = useState<Error | string | null>(null);
    const errorText = panelErrorText(error);
    const advanced = useAdvancedMode();
    const [storedPanelView, setPanelView] = useState<ComputerPanelView>(() => readComputerPanelView(bot.id));
    const requestedDataResult = state.dataResultFocus?.botId === bot.id ? state.dataResultFocus : undefined;
    const [dataRequest, setDataRequest] = useState<{
        id: string;
        requestId: number;
    }>();
    const androidConnected = false;
    const panelTabs = computerPanelTabs({ advanced, androidConnected });
    const panelView = resolveComputerPanelView(storedPanelView, { advanced, androidConnected });
    const browserAvailableHere = browserAvailable(state.config);
    const browserEnabled = builtInBrowserEnabled(state.config) && bot.browser !== false
        && (browserAvailableHere || state.config?.browserEngine?.installable === true);
    const [retry, setRetry] = useState(0);
    // Auto is the server's decision: never guess host-vs-cloud from desktop capabilities.
    useEffect(() => {
        if (livePlace !== "auto" || !computerSelectionPersisted)
            return;
        const controller = new AbortController();
        setAutoSurface(null);
        void api(threadPath("computer"), { signal: controller.signal }).then((status) => {
            if (controller.signal.aborted)
                return;
            const surface = status.surface;
            setAutoSurface({ key: connectionKey, surface: surface === "cloud" || surface === "vm" || surface === "local" || surface === "browser" || surface === "off"
                    ? surface : undefined });
        }).catch((cause) => {
            if (controller.signal.aborted)
                return;
            setError(cause instanceof Error ? cause : String(cause));
            setPhase("error");
        });
        return () => controller.abort();
    }, [connectionKey, livePlace, computerSelectionPersisted, threadPath, retry]);
    const vmResumable = phase === "vm-unavailable" && vmStatus?.resumable === true;
    const vmReadinessAttempts = useRef(0);
    const vmActionController = useRef<AbortController | null>(null);
    useEffect(() => {
        if (vmActionController.current?.signal.aborted) {
            vmActionController.current = null;
            setPending(null);
        }
        return () => { vmActionController.current?.abort(); };
    }, [bot.id, bot.threadId, bot.computer, panelView]);
    const selectedInstance = state.instances.find((instance) => instance.instanceId === bot.modelSelection.instanceId);
    const explicitPanelView = useRef(false);
    const selectPanelView = (view: ComputerPanelView) => {
        explicitPanelView.current = true;
        setPanelView(view);
        writeComputerPanelView(bot.id, view);
    };
    const previousPanelTarget = useRef<string | null>(null);
    // Excludes the model and Auto's resolved surface: neither may move the tab.
    const panelTargetKey = `${profileBot.id}:${profileBot.threadId}:${livePlace}`;
    useEffect(() => {
        const previous = previousPanelTarget.current;
        if (previous === panelTargetKey && (explicitPanelView.current || !(bot.computer === "browser" && browserEnabled)))
            return;
        if (previous !== panelTargetKey)
            explicitPanelView.current = false;
        previousPanelTarget.current = panelTargetKey;
        setPanelView(bot.computer === "browser" && browserEnabled ? "browser"
            : previous === null ? readComputerPanelView(bot.id) : "computer");
    }, [panelTargetKey, bot.id, bot.computer, browserEnabled]);
    useEffect(() => {
        if (!requestedDataResult || requestedDataResult.consumed)
            return;
        explicitPanelView.current = true;
        setDataRequest(requestedDataResult);
        setPanelView("data");
        writeComputerPanelView(bot.id, "data");
        dispatch({ type: "dataResultFocusConsumed", requestId: requestedDataResult.requestId });
    }, [bot.id, dispatch, requestedDataResult]);
    const requestedSignIn = state.signInFocus?.botId === bot.id ? state.signInFocus : undefined;
    const [signInRequest, setSignInRequest] = useState<{
        url: string;
        site: string;
        nonce: number;
    }>();
    useEffect(() => {
        if (!requestedSignIn || requestedSignIn.consumed)
            return;
        const view = requestedSignIn.place === "browser" ? "browser" : "computer";
        explicitPanelView.current = true;
        setPanelView(view);
        writeComputerPanelView(bot.id, view);
        if (view === "browser")
            setSignInRequest({ url: requestedSignIn.url, site: requestedSignIn.site, nonce: requestedSignIn.requestId });
        dispatch({ type: "signInFocusConsumed", requestId: requestedSignIn.requestId });
    }, [bot.id, dispatch, requestedSignIn]);
    useEffect(() => {
        vmReadinessAttempts.current = 0;
    }, [bot.id, bot.computer]);
    const vmSupported = Boolean(selectedInstance?.snapshot.state === "available" &&
        selectedInstance.capabilities?.computerMcp);
    const botRoutines = state.routines
        .filter((routine) => routine.botId === bot.id)
        .sort((a, b) => Number(b.enabled) - Number(a.enabled) || (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity));
    const activeRoutineRun = state.routineRuns.find((run) => run.botId === bot.id && ["queued", "running", "waiting"].includes(run.status));
    useEffect(() => {
        if (panelView !== "computer")
            return;
        let alive = true;
        setResolvedComputerSelection(null);
        setPhase("checking");
        setPreviewError(null);
        setVmFrame(null);
        setVmViewerUrl(null);
        setVmStatus(null);
        setError(null);
        // The selection may be optimistic: never let it choose a provider until the PATCH confirms server state.
        if (!computerSelectionPersisted || !surfaceReady)
            return;
        if (bot.computer === undefined) {
            setPhase("auto-unavailable");
            return;
        }
        if (bot.computer === "off") {
            setPhase("off");
            return;
        }
        if (bot.computer === "browser") {
            setPhase("browser");
            return;
        }
        if (bot.computer === "local") {
            setError(new Error("Host desktop control is not supported. Select Browser or Local VM."));
            setPhase("error");
            return;
        }
        if (bot.computer === "vm") {
            if (!vmSupported) {
                setError(new LocalizedPanelError("computer.err.vmEngine"));
                setPhase("vm-unavailable");
                return;
            }
            let retryTimer: number | undefined;
            api(threadPath("local-computer"))
                .then((rawStatus) => {
                if (!alive)
                    return;
                const status: LocalVmStatus = rawStatus;
                setResolvedComputerSelection({ botId: bot.id, threadId: bot.threadId, computer: bot.computer, });
                setVmStatus(status);
                const viewerUrl = String(status.viewer_url ?? "");
                if (viewerUrl.startsWith("http") || viewerUrl.startsWith("/desktop-viewer#")) {
                    setVmViewerUrl(new URL(viewerUrl, window.location.href).href);
                }
                if (status.ready) {
                    vmReadinessAttempts.current = 0;
                    setPhase("vm");
                }
                else if (status.container === "running" &&
                    status.imageMatches &&
                    status.managed &&
                    status.network === "loopback" &&
                    status.security === "hardened" &&
                    status.persistence === "durable" &&
                    !status.desktopReady &&
                    vmReadinessAttempts.current < 15) {
                    vmReadinessAttempts.current += 1;
                    setError(null);
                    setPhase("checking");
                    retryTimer = window.setTimeout(() => setRetry((n) => n + 1), 2000);
                }
                else {
                    const canCreateHere = status.mode === "per-bot" &&
                        status.container === "missing" &&
                        status.image &&
                        status.create_supported;
                    setError(canCreateHere || status.resumable ? null : new LocalizedPanelError("computer.err.vmOpenSettings", status.problem, "computer.err.vmNotReady"));
                    setPhase("vm-unavailable");
                }
            })
                .catch((e) => {
                if (!alive)
                    return;
                setError(e.message);
                setPhase("vm-unavailable");
            });
            return () => {
                alive = false;
                if (retryTimer !== undefined)
                    window.clearTimeout(retryTimer);
            };
        }
        setError("Remote computers are not supported");
        setPhase("error");
        return () => { alive = false; };
    }, [
        bot.id,
        bot.threadId,
        bot.computer,
        bot.section,
        retry,
        capabilitiesReady,
        localSelectable,
        isLinux,
        providerSupportsLocal,
        selectedInstance?.driverKind,
        vmSupported,
        panelView,
        computerSelectionPersisted,
        surfaceReady, false,
        livePlace,
        threadPath,
    ]);
    const pageVisible = usePageVisible();
    const captureBusy = useRef(bot.busy);
    captureBusy.current = bot.busy;
    useEffect(() => {
        if (panelView !== "computer" || phase !== "vm" || !computerStatusCurrent || viewerOpen || !pageVisible)
            return;
        const controller = new AbortController();
        let inFlight = false;
        let lastAttemptAt = -Infinity;
        let retryDelay: number | null = null;
        let initialAttempt = true;
        const shoot = async () => {
            if (inFlight || controller.signal.aborted)
                return;
            if (Date.now() - lastAttemptAt < (retryDelay ?? (captureBusy.current ? 3000 : 30000)))
                return;
            inFlight = true;
            retryDelay = null;
            try {
                const { image } = await api(threadPath("local-computer/screenshot"), { method: "POST", signal: controller.signal });
                if (!controller.signal.aborted && typeof image === "string") {
                    setVmFrame(image);
                    setPreviewError(null);
                }
            }
            catch (e) {
                if (!controller.signal.aborted) {
                    retryDelay = 5000;
                    if (initialAttempt)
                        setError(e instanceof Error ? e.message : String(e));
                    else
                        setPreviewError(e instanceof Error ? e : new LocalizedPanelError("computer.err.screenUnavailable"));
                }
            }
            finally {
                inFlight = false;
                initialAttempt = false;
                lastAttemptAt = Date.now();
            }
        };
        void shoot();
        const timer = window.setInterval(() => void shoot(), 1000);
        return () => {
            controller.abort();
            window.clearInterval(timer);
        };
    }, [panelView, phase, computerStatusCurrent, threadPath, viewerOpen, pageVisible, setError, setPreviewError, setVmFrame]);
    // The first capture attempt is what makes macOS show the Screen Recording prompt (no reliable pre-grant on macOS
    // 15+), so repeated empty frames mean denied.
    useEffect(() => {
        return;
    }, [panelView, phase, computerStatusCurrent, isLinux, pageVisible, bot.busy, bot.id, bot.threadId]);
    const frameSrc = !computerStatusCurrent ? null :
        phase === "vm"
            ? vmFrame
            :
                null;
    const previewOpensDesktop = Boolean(frameSrc &&
        ((phase === "vm" && vmViewerUrl)));
    const control = state.computerControl[bot.id] ?? { held: false, helpReason: null };
    const signInHelp = control.help ?? null;
    const signInAsker = signInHelp ? state.bots.find((candidate) => candidate.id === signInHelp.botId)?.name ?? bot.name : bot.name;
    useEffect(() => {
        let alive = true;
        api(`/api/bots/${bot.id}/computer/control`)
            .then((raw) => {
            if (!alive)
                return;
            const snap = computerControlSnapshotSchema.parse(raw);
            dispatch({
                type: "computerControl",
                botId: bot.id,
                held: snap.held === true,
                helpReason: snap.helpReason,
                help: snap.help,
            });
        })
            .catch(() => { });
        return () => {
            alive = false;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [bot.id]);
    const requestControl = useCallback(async (action: ComputerControlAction) => {
        const snap = computerControlSnapshotSchema.parse(await api(`/api/bots/${bot.id}/computer/control`, {
            method: "POST",
            body: JSON.stringify({ action }),
        }));
        dispatch({
            type: "computerControl",
            botId: bot.id,
            held: snap.held === true,
            helpReason: snap.helpReason,
            help: snap.help,
        });
        return snap;
    }, [bot.id, dispatch]);
    const setNativeBrowserControl = useCallback(async (): Promise<boolean> => true, []);
    const transitionControl = useCallback(async (action: ComputerControlAction) => {
        // Security: every computer surface must gate Electron's direct browser host; the server hold is bot-wide, and a
        // shell-capable agent could otherwise bypass the server proxy while the person drives.
        return transitionComputerControlLease({
            action,
            syncNativeBrowser: panelView !== "browser",
            requestControl,
            setNativeBrowserControl,
        });
    }, [panelView, requestControl, setNativeBrowserControl]);
    const controlAction = useCallback(async (action: ComputerControlAction): Promise<boolean> => {
        setControlPending(true);
        setError(null);
        try {
            await transitionControl(action);
            return true;
        }
        catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
            return false;
        }
        finally {
            setControlPending(false);
        }
    }, [transitionControl]);
    const bannerTakesControl = Boolean(signInHelp && signInHelp.place !== "browser" && signInHelp.place !== "local" &&
        (phase === "vm"));
    const signInBanner = (takeControl?: () => void) => signInHelp && (<SignInBanner help={signInHelp} askerName={signInAsker} takeControl={takeControl && { onClick: takeControl, disabled: controlPending || pending === "join", pending: pending === "join" }} onError={setError}/>);
    const openDesktop = async () => {
        const controller = new AbortController();
        desktopJoin.current = controller;
        const ownsConnection = () => !controller.signal.aborted && viewerConnection.current === viewerConnectionKey;
        setPending("join");
        setControlPending(true);
        setError(null);
        let tookControl = false;
        // Plain web opens its blank tab synchronously, inside the user gesture; the packaged app uses the Electron viewer
        // window.
        let fallbackTab: Window | null = null;
        {
            fallbackTab = window.open("", "_blank");
            if (fallbackTab)
                fallbackTab.opener = null;
        }
        try {
            if (!control.held) {
                await transitionControl("take");
                tookControl = true;
            }
            if (!ownsConnection())
                throw new DOMException("The selected conversation changed", "AbortError");
            let viewerUrl = vmViewerUrl;
            if (!ownsConnection())
                throw new DOMException("The selected conversation changed", "AbortError");
            if (!viewerUrl)
                throw new LocalizedPanelError("computer.err.noDesktopLink");
            if (fallbackTab) {
                fallbackTab.location.replace(viewerUrl);
            }
            else if (!window.open(viewerUrl, "_blank", "noopener")) {
                throw new LocalizedPanelError("computer.err.popupBlocked");
            }
        }
        catch (e) {
            fallbackTab?.close();
            // Release the bot before awaiting tunnel cleanup: a sick SSH process must never leave the agent paused.
            if (tookControl)
                await transitionControl("release").catch(() => { });
            if (ownsConnection())
                setError(e instanceof Error ? e : String(e));
        }
        finally {
            if (desktopJoin.current === controller) {
                desktopJoin.current = null;
                setPending(null);
                setControlPending(false);
            }
        }
    };
    const runVmAction = async (action: "vm-start" | "vm-create" | "vm-recreate" | "vm-delete") => {
        if ((action === "vm-recreate" || action === "vm-delete") &&
            !window.confirm(action === "vm-delete"
                ? t("computer.confirm.deleteVm", { name: bot.name })
                : t("computer.confirm.replaceVm", { name: bot.name })))
            return;
        if (vmActionController.current)
            return;
        const controller = new AbortController();
        vmActionController.current = controller;
        setPending(action);
        setError(null);
        vmReadinessAttempts.current = 0;
        try {
            if (action === "vm-recreate" || action === "vm-delete") {
                await api(`/api/bots/${bot.id}/local-computer/remove`, {
                    method: "POST",
                    body: "{}",
                    signal: controller.signal,
                });
            }
            if (action !== "vm-delete") {
                const lifecyclePath = action === "vm-start" && vmStatus?.mode !== "per-bot"
                    ? "/api/local-computer/start"
                    : `/api/bots/${bot.id}/local-computer/${action === "vm-start" ? "start" : "run"}`;
                const started: LocalVmStatus = await api(lifecyclePath, {
                    method: "POST",
                    body: "{}",
                    signal: controller.signal,
                });
                const status = await waitForLocalVmReady(started, () => api(threadPath("local-computer"), { signal: controller.signal }), controller.signal);
                if (!status.ready)
                    throw new Error(status.problem ?? t("computer.err.vmNotReady"));
                setVmStatus(status);
                setPhase("vm");
            }
            else {
                setVmStatus((current) => current ? { ...current, container: "missing", } : current);
                setPhase("vm-unavailable");
            }
        }
        catch (e) {
            if (controller.signal.aborted)
                return;
            setError(e instanceof Error ? e.message : String(e));
            setPhase("vm-unavailable");
        }
        finally {
            if (vmActionController.current === controller && !controller.signal.aborted) {
                vmActionController.current = null;
                setPending(null);
                setRetry((n) => n + 1);
            }
        }
    };
    const openVmSettings = () => {
        window.sessionStorage.setItem("quatibot.settings.section", "computer");
        dispatch({ type: "toggleAppSettings", open: true });
    };
    const browserCanTurnOn = browserAvailableHere || state.config?.browserEngine?.installable === true;
    const [browserTurningOn, setBrowserTurningOn] = useState(false);
    const turnOnBrowser = async () => {
        if (browserTurningOn)
            return;
        setBrowserTurningOn(true);
        setError(null);
        try {
            if (!builtInBrowserEnabled(state.config)) {
                const config: ConfigStatus = await api("/api/config", {
                    method: "PATCH",
                    body: JSON.stringify({ features: { browser: true } }),
                });
                dispatch({ type: "configStatus", config });
            }
            if (profileBot.browser === false)
                dispatch({ type: "updateBot", botId: profileBot.id, patch: { browser: true } });
        }
        catch (cause) {
            setError(cause instanceof Error ? cause.message : t("settings.experimental.error"));
        }
        finally {
            setBrowserTurningOn(false);
        }
    };
    const turnOffBrowser = () => {
        setError(null);
        dispatch({ type: "updateBot", botId: profileBot.id, patch: { browser: false } });
    };
    const browserSwitchRow = (<div data-testid="browser-switch-row" className="mb-3 flex items-center gap-3 rounded-xl bg-card px-3 py-2.5">
      <Globe size={15} className="shrink-0 text-ink-secondary" aria-hidden="true"/>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-ink">{t("computer.browserSwitch.title", { name: bot.name })}</div>
        {!browserCanTurnOn && <div className="text-[11.5px] text-ink-secondary">{browserUnavailableReason(state.config)}</div>}
      </div>
      <Switch checked={browserEnabled} disabled={browserTurningOn || (!browserEnabled && !browserCanTurnOn)} aria-label={t("computer.browserSwitch.title", { name: bot.name })} onClick={() => (browserEnabled ? turnOffBrowser() : void turnOnBrowser())}/>
    </div>);
    const managedPolicy = state.config?.managedPolicy;
    const viewOf = (place: PlaceFacts["place"], refusal?: PlaceFacts["refusal"]): PlaceView => placeViewFor({
        ...placeFacts({
            bot, place, seat: placeSeat, config: state.config, instances: state.instances,
            local: { ready: localSelectable, reason: localDisabledReason ?? t("computer.unavailableLocal") },
        }),
        ...(refusal ? { refusal } : {}),
    });
    const autoView = viewOf("auto");
    const placeOptions = ([
        [null, "vm.dest.auto", "computer.dest.autoDesc", Sparkles],
        ["vm", "vm.dest.vm", "computer.dest.vmDesc", Box],
        ["browser", "vm.dest.browser", "computer.dest.browserDesc", Globe],
        ["off", "vm.dest.off", "computer.dest.offDesc", Power],
    ] as const).filter(([mode]) => mode === null || mode === "off" || true).map(([mode, labelKey, descriptionKey, Icon]) => {
        const selected = mode === null ? !profileBot.computer : profileBot.computer === mode;
        const managedKind = mode === "vm" ? "localVm" : null;
        const managedBy = managedPolicy && managedKind && !managedPolicy.computers[managedKind] ? t("policy.managedBy", { organization: managedPolicy.organizationName }) : undefined;
        const view = mode === null ? autoView : viewOf(mode);
        const disabled = Boolean(managedBy) || placeBlocked(view);
        const issue = !managedBy && placeHasIssue(view);
        const unavailableTitle = managedBy ?? (issue ? view.line : mode === "browser" ? t("computer.browserOnlyTitle") : undefined);
        return { mode, labelKey, descriptionKey, Icon, simpleLabel: worksOnSimpleLabel(mode ?? undefined, capabilities.host.platform), selected, managedBy, disabled, unavailableTitle, view, issue };
    });
    const worksOnView = placeOptions.find(({ selected }) => selected)?.view ?? autoView;
    const runPlaceAction = (id: PlaceActionId) => {
        if (id === "try-again")
            return setRetry((n) => n + 1);
        if (id === "turn-on-browser")
            return void turnOnBrowser();
        if (id === "open-vm-settings")
            return openVmSettings();
        openPlaceAction(id, { botId: profileBot.id, threadId: profileBot.threadId }, dispatch);
    };
    const panelOffers = (id: PlaceActionId | undefined): id is PlaceActionId => Boolean(id) && id !== "watch" && id !== "open-computer-panel"
        && ((id !== "start" && id !== "wake"));
    const placeActionButton = (view: PlaceView, className = "mt-1 rounded-lg bg-control px-3 py-1.5 text-[12px] text-ink hover:bg-raised-hover") => view.action && panelOffers(view.action.id) ? (<button type="button" data-testid="place-action" onClick={() => runPlaceAction(view.action!.id)} className={className}>
        {view.action.label}
      </button>) : null;
    const selectPlace = (mode: (typeof placeOptions)[number]["mode"]) => {
        if ((mode === null && profileBot.computer === undefined) || mode === profileBot.computer)
            return;
        if (mode === "browser")
            updateComputerSelection({ computer: mode, browser: true });
        else
            updateComputerSelection({ computer: mode });
    };
    const heldPin = liveTask?.surface && !liveTask.surfaceAuto && profileBot.computer !== "off"
        && liveTask.surface !== profileBot.computer ? liveTask.surface : undefined;
    const tabClass = (active: boolean) => cn("flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1 text-[12.5px] transition-colors @max-[28rem]/paneltabs:[&>svg]:hidden @max-[22rem]/paneltabs:px-2", active ? "bg-raised text-ink shadow-sm" : "text-ink-secondary hover:text-ink");
    const chooseTab = (view: ComputerPanelView) => {
        if (view === "browser")
            setError(null);
        selectPanelView(view);
    };
    const emptyState = {
        checking: t("computer.phase.checking"),
        "auto-unavailable": autoView.line,
        "vm-unavailable": t("computer.phase.vmUnavailable"),
        browser: viewOf("browser").line,
        off: viewOf("off").line,
        error: t("computer.phase.error"),
    } satisfies Record<Exclude<Phase, "vm">, string>;
    return (<>
    <aside className={cn("animate-panel-in relative flex h-full shrink-0 flex-col border-l border-hairline/40 bg-panel", "max-md:absolute max-md:inset-0 max-md:z-40 max-md:w-full!")} style={{ width: panelWidth }}>
      <div ref={separatorRef} role="separator" aria-orientation="vertical" aria-label={t("computer.resizeAria")} aria-valuemin={PANEL_MIN_WIDTH} aria-valuemax={PANEL_MAX_WIDTH} aria-valuenow={separatorWidth ?? undefined} tabIndex={0} onKeyDown={onSeparatorKeyDown} onPointerDown={onResizeStart} onPointerMove={onResizeMove} onPointerUp={onResizeEnd} onPointerCancel={onResizeEnd} className="absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize hover:bg-accent/40 focus-visible:bg-accent/60 max-md:hidden"/>
      {/* ml-1.5 keeps the drag region clear of the resize handle: a later drag region in the DOM wins. */}
      <div className={cn("@container/paneltabs ml-1.5 py-3 pl-2.5 pr-4", undefined)}>
        <div className="relative flex min-h-7 items-center justify-center">
          {advanced && (<button onClick={() => {
                dispatch({ type: "toggleComputer", open: false });
                dispatch({ type: "toggleSettings", open: true, section: "access" });
            }} className="absolute left-0 top-1/2 -translate-y-1/2 rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink" title={t("computer.botSettings")}>
              <Settings size={18}/>
            </button>)}
          <div className="mx-9 flex min-w-0 gap-0.5 overflow-x-auto rounded-full bg-inset p-1 [scrollbar-width:none]" data-tour="computer-tabs" data-testid="computer-tabs" role="tablist" aria-label={t("computer.tabsAria")} onKeyDown={(event) => moveBetweenTabs(event, panelTabs, chooseTab)}>
            {panelTabs.map((view) => {
            const { Icon, label, tour } = PANEL_TABS[view];
            const live = !placeLive ? undefined
                : view === "computer" && isComputerPlace(livePlace) ? "computer-tab-live"
                    : view === "browser" && livePlace === "browser" ? "browser-tab-live" : undefined;
            return (<button key={view} type="button" data-tour={tour} {...panelTabProps(view, view === panelView)} title={t(label)} onClick={() => chooseTab(view)} className={tabClass(view === panelView)}>
                  <Icon size={13}/> {t(label)}
                  {live && <span className="size-1.5 animate-pulse rounded-full bg-success" role="img" aria-label={t("place.live")} data-testid={live}/>}
                </button>);
        })}
          </div>
          <button onClick={() => dispatch({ type: "toggleComputer", open: false })} className="absolute right-0 top-1/2 -translate-y-1/2 rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink" aria-label={t("computer.close")} title={t("computer.close")}>
            <X size={18}/>
          </button>
        </div>
      </div>

      {panelView === "routines" ? (<div {...tabPanelProps("routines")} className={cn("min-h-0 flex-1 overflow-y-auto px-4 pb-4", TAB_PANEL_FOCUS)}>
          <RoutinesSection key={bot.id} bot={bot} routines={botRoutines} runs={state.routineRuns}/>
        </div>) : panelView === "browser" && browserEnabled ? (<div {...tabPanelProps("browser")} className={cn("flex min-h-0 flex-1 flex-col px-4 pb-4", TAB_PANEL_FOCUS)}>
          {browserSwitchRow}
          {signInHelp?.place === "browser" && <div className="-mt-1 mb-3">{signInBanner()}</div>}
          <BrowserPanel bot={bot} signIn={signInRequest}/>
          {errorText && (<div role="alert" className="mt-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">
              {errorText}
            </div>)}
        </div>) : panelView === "browser" ? (<div {...tabPanelProps("browser")} className={cn("flex-1 overflow-y-auto px-5 pb-5", TAB_PANEL_FOCUS)} data-testid="browser-off">
          {browserSwitchRow}
          <div className="mt-2 flex flex-col items-center gap-3 rounded-xl bg-card px-6 py-8 text-center">
            <Globe size={22} className="text-ink-secondary" aria-hidden="true"/>
            <div className="text-[14px] font-medium text-ink">{t("computer.browserOff.title")}</div>
            <p className="text-[12px] leading-5 text-ink-secondary">
              {browserCanTurnOn ? t("computer.browserOff.body", { name: bot.name }) : browserUnavailableReason(state.config)}
            </p>
            {errorText && (<div role="alert" className="w-full rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">
                {errorText}
              </div>)}
          </div>
        </div>) : panelView === "data" ? (<div {...tabPanelProps("data")} className={cn("flex min-h-0 flex-1 flex-col overflow-hidden", TAB_PANEL_FOCUS)}>
          <Suspense fallback={<div className="flex flex-1 items-center justify-center text-[13px] text-ink-secondary" role="status">{t("data.loading")}</div>}>
            <DataPanel key={bot.id} bot={bot} requestedCard={dataRequest}/>
          </Suspense>
        </div>) : panelView === "files" ? (<div {...tabPanelProps("files")} className={cn("flex min-h-0 flex-1 flex-col", TAB_PANEL_FOCUS)}>
          <ComputerFilesPane bot={bot}/>
        </div>) : panelView === "android" && androidConnected ? (<div {...tabPanelProps("android")} className={cn("flex-1 overflow-y-auto px-4 pt-2", TAB_PANEL_FOCUS)}>

        </div>) : (<div {...tabPanelProps("computer")} className={cn("flex-1 overflow-y-auto px-5 pb-5", TAB_PANEL_FOCUS)}>
          <div className="mb-1.5 mt-2 flex items-center justify-between text-[13px] text-ink-secondary">
            <span>{t("computer.screenOf", { name: bot.name })}</span>

            {phase === "vm" && <span className="text-[11px]">{t("vm.dest.vm")}</span>}

        </div>
        <div className="relative flex aspect-[16/10] w-full items-center justify-center overflow-hidden rounded-xl bg-card">
          {frameSrc && previewOpensDesktop ? (<button type="button" onClick={() => void openDesktop()} disabled={controlPending || pending === "join"} className="group relative flex h-full w-full cursor-pointer items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-wait" aria-label={t("computer.openLiveDesktopAria", { name: bot.name })} title={t("computer.openLiveDesktop")}>
              <img src={frameSrc} alt={t("computer.screenOf", { name: bot.name })} className="h-full w-full object-contain transition group-hover:brightness-75 group-focus-visible:brightness-75"/>
              <span className="pointer-events-none absolute right-2 top-2 flex items-center gap-1 rounded-md bg-black/70 px-2 py-1 text-[11px] font-medium text-white opacity-80 shadow-sm transition group-hover:opacity-100 group-focus-visible:opacity-100">
                {pending === "join" ? <Loader2 size={12} className="animate-spin"/> : <Maximize2 size={12}/>}
                {t("computer.open")}
              </span>
            </button>) : frameSrc ? (<img src={frameSrc} alt={t("computer.screenOf", { name: bot.name })} className="h-full w-full object-contain" title={phase === "vm" ? t("computer.watchOnly") : undefined}/>) : (<div className="flex flex-col items-center gap-2 px-6 text-center text-ink-secondary">
              {phase === "checking" || phase === "vm" || false ? (<Loader2 size={18} className="animate-spin"/>) : phase === "off" ? (<Power size={22}/>) : (<Monitor size={22}/>)}
              <span className="text-[12px]">{vmResumable ? t(pending === "vm-start" ? "vm.setup.starting" : "computer.phase.vmStopped") : phase === "vm" ? t("computer.phase.checking") : emptyState[phase]}</span>

              {phase === "browser" && browserEnabled && (<button onClick={() => selectPanelView("browser")} className="mt-1 rounded-lg bg-control px-3 py-1.5 text-[12px] text-ink hover:bg-raised-hover">
                  {t("computer.openBrowserTab")}
                </button>)}

              {vmResumable && pending !== "vm-start" && (<p className="text-[12px]">{t(vmStatus?.stop_reason === "idle" ? "vm.stopped.idle" : "vm.stopped.detail")}</p>)}
              {phase === "vm-unavailable" && (canManageVm && vmResumable && vmStatus.mode !== "pool" ? (<button onClick={() => void runVmAction("vm-start")} disabled={pending !== null} aria-busy={pending === "vm-start"} className="mt-1 flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[12px] font-medium text-white hover:brightness-110 disabled:opacity-50">
                    {pending === "vm-start" && <Loader2 size={13} className="animate-spin"/>}
                    {t(pending === "vm-start" ? "vm.setup.starting" : "vm.setup.start")}
                  </button>) : canManageVm && vmStatus?.mode === "per-bot" && vmStatus.image && vmStatus.create_supported ? (<button onClick={() => void runVmAction(vmStatus.container === "missing" ? "vm-create" : "vm-recreate")} disabled={pending !== null} className="mt-1 rounded-lg bg-accent px-3 py-1.5 text-[12px] font-medium text-white hover:brightness-110 disabled:opacity-50">
                    {(pending === "vm-create" || pending === "vm-recreate") && (<Loader2 size={13} className="mr-1.5 inline animate-spin"/>)}
                    {vmStatus.container === "missing"
                        ? t("computer.createVm", { name: bot.name })
                        : t("computer.replaceVm", { name: bot.name })}
                  </button>) : (<button onClick={openVmSettings} className="mt-1 rounded-lg bg-control px-3 py-1.5 text-[12px] text-ink hover:bg-raised-hover">
                    {t("computer.openVmSetup")}
                  </button>))}

            </div>)}
        </div>

        {errorText && (<div className="mt-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">
            {errorText}
          </div>)}

        {undefined}

        {signInHelp && signInHelp.place !== "browser" && signInBanner(bannerTakesControl && !control.held
                ? () => phase === "vm" ? void openDesktop() : void controlAction("take")
                : undefined)}
        {(phase === "vm") && control.held && (<div className="mt-3 rounded-xl border border-accent/25 bg-accent/10 p-4">
            <div className="text-[13px] leading-relaxed text-ink">
              {t("computer.youHaveWheel")}

              {phase === "vm" && ` ${t(advanced ? "computer.useOpenDesktopVm" : "computer.simple.useFullScreenVm")}`}
            </div>
            <button onClick={() => {
                    controlAction("release");
                    void undefined;
                }} disabled={controlPending} className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg bg-accent py-2 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-50">
              <Hand size={14}/>
              {t("computer.handBack")}
            </button>
          </div>)}
        {advanced && phase === "vm" && vmViewerUrl && control.held && (<button onClick={() => void openDesktop()} disabled={pending === "join"} className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-control py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50" title={t("computer.openVmDesktopTitle")}>
            {pending === "join" ? <Loader2 size={14} className="animate-spin"/> : <Monitor size={14}/>}
            {t("computer.openLiveDesktop")}
          </button>)}
        {advanced && phase === "vm" && !control.held && !bannerTakesControl && (<button onClick={() => void openDesktop()} disabled={controlPending || pending === "join" || !vmViewerUrl} className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-control py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50" title={t("computer.takeControlVmTitle")}>
            {pending === "join" ? <Loader2 size={14} className="animate-spin"/> : <Hand size={14}/>}
            {t("computer.takeControl")}
          </button>)}
        {advanced && canManageVm && phase === "vm" && vmStatus?.mode === "per-bot" && (<button onClick={() => void runVmAction("vm-delete")} disabled={pending !== null || profileBot.busy} className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg border border-danger/30 py-2 text-[13px] text-danger hover:bg-danger/10 disabled:opacity-50" title={profileBot.busy ? t("computer.deleteVmBlocked") : t("computer.deleteVmTitle", { name: bot.name })}>
            {pending === "vm-delete" ? <Loader2 size={14} className="animate-spin"/> : <Power size={14}/>}
            {t("computer.deleteVm")}
          </button>)}
        {!advanced && (phase === "vm") && (<div className="mt-3 flex gap-2" data-testid="computer-actions">
            {!control.held && !bannerTakesControl && (<button type="button" onClick={() => void openDesktop()} disabled={controlPending || pending === "join" || (phase === "vm" && !vmViewerUrl)} className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-accent py-2 text-[13px] font-medium text-accent-ink hover:brightness-110 disabled:opacity-50" title={phase === "vm" ? t("computer.takeControlVmTitle") : t("computer.takeControlTitle")}>
                {pending === "join" ? <Loader2 size={14} className="animate-spin"/> : <Hand size={14}/>}
                {t("computer.takeControl")}
              </button>)}
            <button type="button" onClick={() => void openDesktop()} disabled={pending === "join" || (!control.held && controlPending) || (phase === "vm" && !vmViewerUrl)} className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-control py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50" title={t("computer.openLiveDesktop")}>
              <Maximize2 size={14}/>
              {t("computer.fullScreen")}
            </button>

          </div>)}

        {(bot.computer !== undefined || computerStatusCurrent) && <>

          </>}

        {advanced ? <>
          <div className="mt-4 rounded-xl bg-card p-4">
            <div className="text-[15px] font-medium text-ink">{t("computer.worksOn")}</div>
            <p className="mt-1 text-[12px] leading-5 text-ink-secondary">
              {t("computer.worksOnHint")}
            </p>
          <div role="group" aria-label={t("computer.destinationAria")} className="mt-3 grid auto-rows-fr grid-cols-2 gap-2">
            {placeOptions.map(({ mode, labelKey, descriptionKey, Icon, selected, managedBy, disabled, unavailableTitle, issue, view }) => (<button key={mode ?? "auto"} disabled={disabled} title={unavailableTitle} onClick={() => selectPlace(mode)} type="button" aria-pressed={selected} className={cn("min-w-0 rounded-lg border px-2.5 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-card", selected
                        ? "border-accent/60 bg-accent/10 text-ink"
                        : "border-hairline/50 bg-panel/30 text-ink-secondary", disabled
                        ? "cursor-not-allowed"
                        : "hover:border-accent/40 hover:bg-control/60")}>
                <span className="flex items-center gap-2 text-[12px] font-medium leading-4">
                  {selected ? <Check size={14} className="shrink-0 text-accent"/> : <Icon size={14} className="shrink-0 text-ink-secondary"/>}
                  <span>{t(labelKey)}</span>
                </span>
                <span className="mt-1.5 block text-[11px] leading-4 text-ink-secondary">
                  {managedBy ?? (issue ? view.short : t(descriptionKey))}
                </span>
              </button>))}
          </div>
          {liveTask?.surface && (<p className="mt-2 text-[11.5px] leading-5 text-ink-secondary" data-testid="place-pinned-note">
              {t("place.pinnedNote", { place: t(placeLabelKey(liveTask.surface)) })}
            </p>)}
          <div className="mt-3 border-t border-hairline/40 pt-3 text-[11.5px] leading-5 text-ink-secondary" aria-live="polite" data-testid="place-line">
            {worksOnView.line}
            {placeActionButton(worksOnView, "mt-1 block font-medium text-accent hover:underline")}
          </div>

        </div>

        <button type="button" onClick={() => selectPanelView("routines")} className="mt-4 flex w-full items-start gap-3 rounded-xl bg-card p-4 text-left hover:bg-raised">
          <CalendarClock size={17} className="mt-0.5 shrink-0 text-accent"/>
          <span className="min-w-0 flex-1">
            <span className="block text-[14px] font-medium text-ink">{t("computer.tab.routines")} <span className="ml-1 text-[11px] text-ink-secondary">{botRoutines.length}</span></span>
            <span className={cn("mt-1 block truncate text-[11.5px]", activeRoutineRun ? routineRunTone(activeRoutineRun) : "text-ink-secondary")}>{activeRoutineRun ? `${activeRoutineRun.routineName} · ${routineRunLabel(activeRoutineRun)}` : t("computer.routines.openTitle")}</span>
          </span>
          <span className="text-ink-secondary" aria-hidden="true">→</span>
        </button>
        </> : (<div className="mt-4 rounded-xl bg-card p-4" data-testid="where-works">
            <div className="text-[15px] font-medium text-ink">{t("computer.simple.whereWorks", { name: bot.name })}</div>
            <div role="group" aria-label={t("computer.destinationAria")} className="mt-3 grid grid-cols-3 gap-2">
              {placeOptions.map(({ mode, Icon, selected, disabled, unavailableTitle, simpleLabel, issue, view }) => (<button key={mode ?? "auto"} type="button" disabled={disabled} title={unavailableTitle} aria-pressed={selected} onClick={() => selectPlace(mode)} className={cn("flex min-w-0 flex-col items-center gap-1.5 rounded-lg border px-1.5 py-2.5 text-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-card", selected
                        ? "border-accent/60 bg-accent/10 text-ink"
                        : "border-hairline/50 bg-panel/30 text-ink-secondary", disabled ? "cursor-not-allowed opacity-50" : "hover:border-accent/40 hover:bg-control/60")}>
                  <Icon size={16} className={cn("shrink-0", selected ? "text-accent" : "text-ink-secondary")} aria-hidden="true"/>
                  <span className="w-full truncate text-[12px] font-medium leading-4">{simpleLabel}</span>
                  {issue && <span className="w-full truncate text-[10.5px] leading-3 text-ink-secondary">{view.short}</span>}
                </button>))}
            </div>
            <div className="mt-3 text-[11.5px] leading-5 text-ink-secondary" data-testid="place-line">
              {worksOnView.line}
              {placeActionButton(worksOnView, "mt-1 block font-medium text-accent hover:underline")}
            </div>
            {heldPin && (<div className="mt-2 flex items-center gap-2">
                <p className="min-w-0 flex-1 text-[11.5px] leading-5 text-ink-secondary" data-testid="place-pinned-note">
                  {t("place.pinnedNoteSimple", {
                        place: placeOptions.find(({ mode }) => mode === heldPin)?.simpleLabel ?? t(placeLabelKey(heldPin)),
                    })}
                </p>
                <button type="button" disabled={Boolean(bot.busy)} title={bot.busy ? t("place.busy") : undefined} onClick={() => dispatch({ type: "updateTask", botId: profileBot.id, threadId: profileBot.threadId, patch: { surface: null } })} className="shrink-0 rounded-md px-2 py-0.5 text-[11.5px] font-medium leading-5 text-accent-text transition-colors hover:bg-control focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent" data-testid="place-unpin">
                  {t("place.unpinSimple", {
                        place: placeOptions.find(({ selected }) => selected)?.simpleLabel ?? t(placeLabelKey(profileBot.computer ?? "auto")),
                    })}
                </button>
              </div>)}
          </div>)}
      </div>)}

    </aside>

    </>);
}
