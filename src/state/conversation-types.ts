import type { BotVisibility, CardAnswerer, CloudBackend, ConnectorToolGrant, EffortLevel, InstalledPackageMetadata, GroupThreadUsage, WireGroup, OptionCardData as WireOptionCard } from "../../shared/wire";
import type { TurnDigest } from "../../shared/digest";
import type { ToolScope } from "../../shared/tool-scope";
import type { QuatiColor } from "@/lib/mascot";
import type { BotAvatarCrop } from "../../shared/bot-avatar";
import type { ApprovalMode } from "../../shared/approval-mode";
import type { MascotBodyId } from "../../shared/mascot-bodies";
import type { QuestionRequestCardData } from "../../shared/ask-question";
import type { ProfileRequestCardData } from "../../shared/profile-request";
import type { ModelRequestCardData } from "../../shared/model-request";
import type { RoutineRequestCardData } from "../../shared/routine-request";
import type { RoutineRunCardData } from "../../shared/routine-run";
import type { GroupGoalRunCardData } from "../../shared/group-goal-run";
import type { PlaceRow } from "../../shared/place-view";
import type { SkillRequestCardData } from "../../shared/skill-request";

export type { QuatiColor } from "@/lib/mascot";
export type { RoutineRunCardData } from "../../shared/routine-run";
export interface OptionCardData extends Pick<WireOptionCard, "fixedOptions"> {
    title: string;
    subtitle: string;
    options: string[];
    requestType?: "permission" | "question";
    optionHints?: Record<string, string>;
    multiSelect?: boolean;
    answered?: string;
    answeredText?: string;
    answeredBy?: CardAnswerer;
    dismissed?: boolean;
    requestId?: string;
    tool?: string;
    held?: string;
    expired?: boolean;
    heldCode?: string;
    allowKey?: string;
    allowSession?: boolean;
    commandAllowlist?: {
        command: string;
        cwd: string;
        providerInstanceId: string;
    };
    approvalScope?: "local-computer";
    autoApplied?: boolean;
    undone?: boolean;
    routineRequest?: RoutineRequestCardData;
    skillRequest?: SkillRequestCardData;
    outboundRequest?: {
        tool: string;
        app: string | null;
        calls?: Array<{
            app: string | null;
            label: string;
        }>;
    };
    teamMemoryRequest?: {
        section: string;
        entryId: string;
        kind: string;
    };
    profileRequest?: ProfileRequestCardData;
    modelRequest?: ModelRequestCardData;
    teamSetupRequest?: import("../../shared/team-setup").TeamSetupRequest;
    questionRequest?: QuestionRequestCardData;
}
export interface ConnectorCardData {
    slug: string;
    label: string;
    description: string;
    status: "required" | "authorizing" | "connected" | "failed";
    resumeKey: string;
    alias?: string;
    error?: string;
    dismissed?: boolean;
    resumed?: boolean;
    stopped?: boolean;
}
export interface SecretRequestCardData {
    target: import("../../shared/credential-request").CredentialTargetId;
    label: string;
    description: string;
    placeholder: string;
    helpUrl: string;
    requestKey: string;
    provided?: boolean;
    dismissed?: boolean;
    superseded?: boolean;
    resumed?: boolean;
    error?: string;
    stopped?: boolean;
}
export type ComputerControlState = {
    held: boolean;
    helpReason: string | null;
    help?: import("../../shared/wire").ComputerHelpRef | null;
};
export interface Message extends Pick<import("../../shared/wire").WireMessage, "widget" | "routedBy" | "quickModel"> {
    id: string;
    role: "bot" | "user";
    kind: "text" | "options" | "activity" | "screen" | "connector" | "secret" | "signin" | "routine.run" | "goal.run" | "digest" | "compaction" | "call" | "widget";
    text?: string;
    digest?: TurnDigest;
    compaction?: import("../../shared/wire").WireMessage["compaction"];
    attachments?: import("../../shared/wire").WireMessage["attachments"];
    card?: OptionCardData;
    connector?: ConnectorCardData;
    secret?: SecretRequestCardData;
    signIn?: import("../../shared/wire").SignInRequestCardData;
    routineRun?: RoutineRunCardData;
    goalRun?: GroupGoalRunCardData;
    call?: import("../../shared/wire").LiveCallRecord;
    channelMode?: "chat" | "goal";
    tool?: {
        name: string;
        ok?: boolean;
        spoken?: string;
        setup?: boolean;
        claudeUpdate?: boolean;
        place?: PlaceRow;
        summary?: string;
        input?: string;
        output?: string;
        itemId?: string;
        outputPath?: string;
        fullResult?: boolean;
    };
    steered?: boolean;
    via?: "api" | "call";
    callId?: string;
    requestMessageId?: string;
    turnId?: string;
    turnTerminal?: boolean;
    turnCompletedAt?: number;
    optimisticThreadOrderAt?: number;
    hasImage?: boolean;
    png?: string;
    mime?: string;
    at: number;
    parentId?: string | null;
    replyToId?: string;
    sendId?: string;
    from?: {
        botId: string;
        name: string;
        color: QuatiColor;
    };
    peerAsk?: {
        botId: string;
        name: string;
        unattended?: boolean;
    };
    roomRequest?: {
        id: string;
        phase: "request" | "result";
    };
    reactions?: Array<{
        emoji: string;
        by: string;
    }>;
    comm?: {
        groupId: string;
        threadId?: string;
        withBotId: string;
        withName: string;
        withColor: QuatiColor;
    };
    threadRef?: {
        botId: string;
        threadId: string;
        title: string;
    };
    dataResult?: import("../../shared/wire").WireMessage["dataResult"];
    queued?: boolean;
    queueId?: string;
}
export type GroupDefaultResponder = import("../../shared/wire").GroupDefaultResponder;
export interface Group extends Pick<WireGroup, "memberContext" | "queue"> {
    usage?: GroupThreadUsage | null;
    id: string;
    threadId: string;
    name: string;
    memberIds: string[];
    defaultResponder: GroupDefaultResponder;
    bulletin: string;
    unread: boolean;
    lastReadMessageId?: string;
    createdAt: number;
    dm?: boolean;
    busyBotId?: string | null;
    turnStartedAt?: number | null;
    working?: boolean;
    cwd?: string;
    pinnedCwd?: string | null;
    pinnedMessageId?: string;
    section?: string;
    setupCompletedAt?: number | null;
    setupSkippedAt?: number | null;
    turnTimeoutMinutes?: number | null;
    holds?: Record<string, import("../../shared/wire").RoomHold>;
    heldMessages?: Record<string, import("../../shared/wire").RoomHeldMessage[]>;
    tasks?: GroupTask[];
    messages: Message[];
    hasMore?: boolean;
}
export interface GroupTask {
    threadId: string;
    title: string;
    createdAt: number;
    pinnedCwd?: string | null;
    pinnedMessageId?: string;
    pinned?: boolean;
    updatedAt?: number;
    turnTimeoutMinutes?: number;
    lastThreadOrderAt?: number;
    working?: boolean;
    busyBotId?: string | null;
}
export interface ModelSelection {
    instanceId: string;
    model: string;
    effort?: EffortLevel;
    variant?: string;
}
export interface Task {
    waitingForTeammates?: boolean;
    threadId: string;
    routineRunId?: string;
    projectId?: string;
    title: string;
    createdAt: number;
    pinned?: boolean;
    link?: string;
    updatedAt?: number;
    lastThreadOrderAt?: number;
    usage?: TaskUsage;
    cwd?: string | null;
    modelSelection?: ModelSelection;
    followsBotModel?: boolean;
    approvalMode?: ApprovalMode;
    autoApprove?: boolean;
    alwaysAllow?: string[];
    activity?: Bot["activity"];
    busy?: boolean;
    turnStartedAt?: number;
    unread?: boolean;
    lastReadMessageId?: string;
    pinnedMessageId?: string;
    surface?: "cloud" | "vm" | "local" | "browser";
    surfaceAuto?: true;
    openedBy?: ThreadOpener;
    closedBy?: ThreadCloser;
    archivedAt?: number;
    snoozedUntil?: number;
}
export interface ThreadOpener {
    botId: string;
    name: string;
    delegationId?: string;
    at: number;
}
export interface ThreadCloser {
    botId: string;
    name: string;
    at: number;
}
export interface TaskUsage {
    input: number;
    output: number;
    cachedInput?: number;
    costUsd: number | null;
    turns: number;
    lastTurn?: {
        input: number;
        output: number;
        cachedInput?: number;
        costUsd: number | null;
    };
    context?: {
        tokens: number;
        window?: number;
    };
}
export interface Bot {
    toolScope?: ToolScope;
    waitingForTeammates?: boolean;
    id: string;
    threadId: string;
    mainThreadId?: string;
    tasks?: Task[];
    projects?: BotProject[];
    name: string;
    title: string;
    description: string;
    soul?: string;
    soulDrift?: boolean;
    notifications: boolean;
    color: QuatiColor;
    mascotExpression?: string | null;
    mascotBody?: MascotBodyId | null;
    avatarUrl?: string | null;
    avatarCrop?: BotAvatarCrop;
    avatarZoom?: number;
    avatarFocusX?: number;
    avatarFocusY?: number;
    unread: boolean;
    busy?: boolean;
    activity?: "working" | "waiting-on-you" | "idle" | "no-signal" | "dead" | "parked.computer";
    turnStartedAt?: number | null;
    modelSelection: ModelSelection;
    computer?: "cloud" | "vm" | "local" | "browser" | "off";
    cloudBackend?: CloudBackend;
    autoStartVps?: boolean;
    cwd?: string;
    autoApprove?: boolean;
    approvalMode?: ApprovalMode;
    alwaysAllow?: string[];
    speakReplies?: boolean;
    replyStyle?: import("../../shared/wire").WireBot["replyStyle"];
    voice?: string;
    voiceNotes?: boolean;
    memoryEnabled?: boolean;
    pinned?: boolean;
    hidden?: boolean;
    section?: string;
    pinnedMessageId?: string;
    chiefOfStaff?: boolean;
    managedSections?: string[];
    approvePeerComms?: boolean;
    peers?: string[];
    composio?: boolean;
    connectorTools?: Record<string, ConnectorToolGrant>;
    connectorScopes?: {
        apps: Record<string, "read" | "write">;
    };
    outbound?: {
        policy: "ask" | "allow";
        dailyCap: number;
    };
    fallback?: Array<{
        instanceId: string;
        model: string;
    }>;
    browser?: boolean;
    recordBrowserSteps?: boolean;
    memoryUpkeep?: boolean;
    helperModel?: boolean;
    mcpServers?: string[] | null;
    browserProfile?: string | null;
    visibility?: BotVisibility;
    installedPackage?: InstalledPackageMetadata;
    messages: Message[];
    hasMore?: boolean;
    awaitingThreadSnapshot?: boolean;
    /** The server announces a switch before its snapshot lands; until then this, not threadId, is on screen. */
    switchingTo?: string;
    activeLeafId?: string | null;
}
export interface BotProject {
    id: string;
    name: string;
    emoji?: string;
}
export type ProjectUpdatePatch = {
    name?: string;
    emoji?: string | null;
};
