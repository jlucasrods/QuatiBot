// Half-duplex like CallView: the native recognizer has no echo cancellation. Replies are queued so a fast second member
// never cuts off the first.
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, PhoneOff, X } from "lucide-react";
import { currentCall, deferCallCleanup, endCall, useOnCall } from "@/lib/call";
import { normalizeState } from "@/lib/mascot";
import { speaker } from "@/lib/tts";
import { useSpeech } from "@/lib/tts/useSpeech";
import { usePushToTalk } from "@/lib/push-to-talk";
import { useStore, type Bot, type Group, type Message } from "@/state/store";
import { cn } from "@/lib/cn";
import { BotAvatar } from "./Avatar";
import { CallTargetButton } from "./CallView";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { isRoutineApproval, isSkillApproval, pendingApprovals, spokenApprovalPrompt } from "./PendingApproval";
type Phase = "listening" | "sending" | "working" | "speaking";
export function GroupCallButton({ group, members }: {
    group: Group;
    members: Bot[];
}) {
    const { capabilities, ready } = useDesktopCapabilities();
    if (group.dm)
        return null;
    if (ready && !capabilities.dictation.available)
        return null;
    return (<CallTargetButton targetId={group.id} targetName={group.name} voices={members.map((member) => member.voice)} setupBotId={members.find((member) => !member.voice)?.id ?? members[0]?.id} requireExplicitVoices/>);
}
export function GroupCallOverlay({ group, members }: {
    group: Group;
    members: Bot[];
}) {
    const active = useOnCall() === group.id;
    if (!active)
        return null;
    return <GroupCall group={group} members={members}/>;
}
function questionIn(messages: Message[]): Message | undefined {
    return messages.find((message) => message.kind === "options" &&
        message.card?.requestId &&
        !message.card.tool &&
        !message.card.answered &&
        !message.card.dismissed);
}
function GroupCall({ group, members }: {
    group: Group;
    members: Bot[];
}) {
    const { dispatch } = useStore();
    const speech = useSpeech();
    const initialPhase: Phase = group.working || group.busyBotId ? "working" : "listening";
    const [phase, setPhase] = useState<Phase>(initialPhase);
    const [heard, setHeard] = useState("");
    const [note, setNote] = useState<string | null>(null);
    const [speakingMemberId, setSpeakingMemberId] = useState<string | null>(null);
    const pushToTalk = usePushToTalk(group.id, phase === "listening", () => {
        setNote("Push to talk couldn't start. Check Microphone and Speech Recognition access.");
    });
    const messages = group.messages;
    const approval = pendingApprovals(messages)[0];
    const question = questionIn(messages);
    const membersRef = useRef(members);
    const busyRef = useRef(Boolean(group.working || group.busyBotId));
    const defaultResponderRef = useRef(group.defaultResponder);
    membersRef.current = members;
    busyRef.current = Boolean(group.working || group.busyBotId);
    defaultResponderRef.current = group.defaultResponder;
    const spokenIds = useRef<Set<string>>(new Set());
    const started = useRef(false);
    if (!started.current) {
        started.current = true;
        for (const message of messages)
            spokenIds.current.add(message.id);
    }
    const askedApproval = useRef<{
        requestId: string;
        member?: Bot;
        routine: boolean;
        skill: boolean;
        submitted: boolean;
    } | null>(null);
    const askedQuestion = useRef<{
        requestId: string;
        member?: Bot;
    } | null>(null);
    const phaseRef = useRef<Phase>(initialPhase);
    const alive = useRef(true);
    const sayGeneration = useRef(0);
    const queueGeneration = useRef(0);
    const queue = useRef<Promise<void>>(Promise.resolve());
    const queuedJobs = useRef(new Set<number>());
    const nextJobId = useRef(0);
    const listenWhenDrained = useRef(false);
    const listenTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const allowBargeIn = useRef(false);
    const move = useCallback((next: Phase) => {
        phaseRef.current = next;
        if (alive.current)
            setPhase(next);
    }, []);
    const hush = useCallback(() => {
        void undefined;
    }, []);
    const listen = useCallback(() => {
        if (!alive.current || currentCall() !== group.id)
            return;
        move("listening");
        setSpeakingMemberId(null);
        setHeard("");
        setNote(null);
        void undefined;
    }, [group.id, move]);
    const scheduleListen = useCallback((force = false, delay = 140) => {
        if (listenTimer.current)
            clearTimeout(listenTimer.current);
        listenTimer.current = setTimeout(() => {
            listenTimer.current = null;
            if (!alive.current || currentCall() !== group.id || queuedJobs.current.size)
                return;
            if (force || allowBargeIn.current || !busyRef.current)
                listen();
        }, delay);
    }, [group.id, listen]);
    const say = useCallback(async (text: string, member?: Bot) => {
        if (!alive.current || currentCall() !== group.id)
            return false;
        const mine = ++sayGeneration.current;
        move("speaking");
        setSpeakingMemberId(member?.id ?? null);
        hush();
        await speaker.speak(text, { botId: member?.id, voiceId: member?.voice });
        return alive.current && currentCall() === group.id && sayGeneration.current === mine;
    }, [group.id, hush, move]);
    const enqueueSpeech = useCallback((text: string, member?: Bot, answerAfter = false) => {
        const generation = queueGeneration.current;
        const jobId = ++nextJobId.current;
        queuedJobs.current.add(jobId);
        if (answerAfter)
            listenWhenDrained.current = true;
        queue.current = queue.current
            .catch(() => { })
            .then(async () => {
            if (generation !== queueGeneration.current)
                return;
            await say(text, member);
        })
            .finally(() => {
            if (generation !== queueGeneration.current)
                return;
            queuedJobs.current.delete(jobId);
            if (queuedJobs.current.size)
                return;
            setSpeakingMemberId(null);
            const force = listenWhenDrained.current;
            listenWhenDrained.current = false;
            scheduleListen(force);
        });
    }, [say, scheduleListen]);
    const interruptSpeech = useCallback(() => {
        const wasBusy = busyRef.current;
        queueGeneration.current += 1;
        queue.current = Promise.resolve();
        queuedJobs.current.clear();
        listenWhenDrained.current = false;
        sayGeneration.current += 1;
        speaker.stop();
        setSpeakingMemberId(null);
        allowBargeIn.current = true;
        if (wasBusy)
            dispatch({ type: "interruptGroup", groupId: group.id });
        listen();
    }, [dispatch, group.id, listen]);
    useEffect(() => {
        alive.current = true;
        return () => {
            alive.current = false;
            queueGeneration.current += 1;
            sayGeneration.current += 1;
            if (listenTimer.current)
                clearTimeout(listenTimer.current);
            deferCallCleanup(group.id, () => alive.current);
        };
    }, [group.id]);
    useEffect(() => {
        return;
    }, [dispatch, enqueueSpeech, group.id, group.threadId, hush, listen, move, scheduleListen]);
    useEffect(() => {
        let resumeAfterRoutine = false;
        if (askedApproval.current && approval?.requestId !== askedApproval.current.requestId) {
            resumeAfterRoutine = askedApproval.current.routine && askedApproval.current.submitted;
            askedApproval.current = null;
        }
        if (askedQuestion.current && question?.card?.requestId !== askedQuestion.current.requestId) {
            askedQuestion.current = null;
        }
        if (resumeAfterRoutine && !approval && !question && !group.working && !group.busyBotId) {
            scheduleListen(true);
            return;
        }
        // Voice queue and microphone stay closed until this exact decision settles or its request errors.
        if (askedApproval.current?.submitted)
            return;
        if (approval && askedApproval.current?.requestId !== approval.requestId) {
            const member = members.find((candidate) => candidate.id === approval.message.from?.botId);
            askedApproval.current = {
                requestId: approval.requestId,
                member,
                routine: isRoutineApproval(approval),
                skill: isSkillApproval(approval),
                submitted: false,
            };
            spokenIds.current.add(approval.message.id);
            const name = member?.name ?? approval.message.from?.name ?? "A group member";
            const skillPrompt = approval.message.card?.skillRequest?.action === "update"
                ? `${name} wants to update a learned skill. Open the group thread to review the complete skill before replacing the current version. You can say no to deny it.`
                : `${name} wants to enable a new learned skill. Open the group thread to review the complete skill before enabling it. You can say no to deny it.`;
            enqueueSpeech(isSkillApproval(approval) ? skillPrompt : spokenApprovalPrompt(approval, name), member, true);
        }
        if (question?.card?.requestId && askedQuestion.current?.requestId !== question.card.requestId) {
            const member = members.find((candidate) => candidate.id === question.from?.botId);
            askedQuestion.current = { requestId: question.card.requestId, member };
            spokenIds.current.add(question.id);
            const name = member?.name ?? question.from?.name ?? "A group member";
            const detail = question.card.subtitle.trim();
            const choices = question.card.options.length
                ? " The options are " + question.card.options.join(", ") + "."
                : "";
            enqueueSpeech(name + " asks: " + detail + (/[.!?]$/.test(detail) ? "" : ".") + choices, member, true);
        }
        const fresh = messages.filter((message) => !spokenIds.current.has(message.id));
        if (!fresh.length)
            return;
        for (const message of fresh)
            spokenIds.current.add(message.id);
        const replies = fresh.filter((message) => message.role === "bot" && message.kind === "text" && message.text?.trim());
        for (const reply of replies) {
            const member = members.find((candidate) => candidate.id === reply.from?.botId);
            enqueueSpeech(reply.text!, member);
        }
        if (!replies.length) {
            const chip = [...fresh].reverse().find((message) => message.kind === "activity" && message.tool?.spoken);
            if (chip?.tool?.spoken) {
                const member = members.find((candidate) => candidate.id === chip.from?.botId);
                enqueueSpeech(chip.tool.spoken, member);
            }
        }
    }, [approval, enqueueSpeech, group.busyBotId, group.working, members, messages, question, scheduleListen]);
    useEffect(() => {
        const busy = Boolean(group.working || group.busyBotId);
        busyRef.current = busy;
        if (busy) {
            if ((phaseRef.current === "listening" || phaseRef.current === "sending") &&
                !askedApproval.current &&
                !askedQuestion.current &&
                !allowBargeIn.current) {
                move("working");
                hush();
            }
            return;
        }
        allowBargeIn.current = false;
        if ((phaseRef.current === "working" || phaseRef.current === "sending") &&
            !askedApproval.current &&
            !askedQuestion.current) {
            scheduleListen();
        }
    }, [group.busyBotId, group.working, hush, move, scheduleListen]);
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                event.preventDefault();
                endCall(group.id);
            }
            else if (event.code === "Space" && speaker.isSpeaking()) {
                event.preventDefault();
                interruptSpeech();
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [group.id, interruptSpeech]);
    const speakingMember = members.find((member) => member.id === speakingMemberId);
    const workingMember = members.find((member) => member.id === group.busyBotId);
    const focusId = speakingMember?.id ?? workingMember?.id;
    const status = phase === "listening"
        ? pushToTalk
            ? "Push to talk"
            : "Listening"
        : phase === "sending"
            ? "Bringing the group in"
            : phase === "speaking"
                ? (speakingMember?.name ?? "Group member") + " is speaking"
                : workingMember
                    ? workingMember.name + " is working"
                    : "Working";
    return (<div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-6 bg-app/95 px-8 backdrop-blur-sm">
      <button onClick={() => endCall(group.id)} aria-label="Hang up" className="absolute right-5 top-5 rounded-md p-2 text-ink-secondary hover:bg-raised hover:text-ink">
        <X size={18}/>
      </button>

      <div className="max-w-full overflow-x-auto px-4 py-3">
        <div className="flex min-w-max items-end justify-center gap-3">
          {members.map((member) => {
            const focused = member.id === focusId;
            const state = speakingMember?.id === member.id
                ? "sending"
                : workingMember?.id === member.id
                    ? "working"
                    : phase === "listening"
                        ? "listening"
                        : normalizeState(member.mascotExpression) ?? "happy";
            return (<div key={member.id} className={cn("flex w-[124px] flex-col items-center gap-2 rounded-3xl px-2 py-3 transition-all duration-200", focused ? "scale-105 bg-raised/70 shadow-lg" : "opacity-75")}>
                <BotAvatar bot={member} state={state} size={94} animated motion={workingMember?.id === member.id ? "working" : "none"} motionKey={workingMember?.id === member.id ? 1 : 0}/>
                <span className={cn("text-[13px] font-medium", focused ? "text-ink" : "text-ink-secondary")}>
                  {member.name}
                </span>
              </div>);
        })}
        </div>
      </div>

      <div className="flex flex-col items-center gap-1.5 text-center">
        <div className="text-[20px] font-medium text-ink">{group.name}</div>
        <div className="flex items-center gap-2 text-[13.5px] text-ink-secondary">
          {(phase === "working" || phase === "sending") && <Loader2 size={13} className="animate-spin"/>}
          {status}
        </div>
      </div>

      <div className="min-h-[3.5rem] max-w-[620px] text-center text-[15px] leading-relaxed text-ink">
        {phase === "listening" ? (heard || (<span className="text-ink-secondary">
              {pushToTalk
                ? "Release Control + Option to send…"
                : "Say a name, say “everyone,” or just talk to the group…"}
            </span>)) : phase === "speaking" ? (speech.caption) : (<span className="text-ink-secondary">{workingMember ? "You’ll hear each response in turn." : ""}</span>)}
      </div>

      {note && (<div className="flex max-w-[520px] flex-col items-center gap-2 text-center text-[12.5px] text-warning">
          <span>{note}</span>
          <button onClick={listen} className="rounded-full border border-warning/40 px-3 py-1.5 text-[12px] hover:bg-warning/10">
            Try microphone again
          </button>
        </div>)}
      {speech.error && <div className="max-w-[460px] text-center text-[12.5px] text-danger">{speech.error}</div>}

      <div className="flex items-center gap-3">
        {speaker.isSpeaking() && (<button onClick={interruptSpeech} className="rounded-full border border-hairline/50 px-4 py-2 text-[13.5px] text-ink hover:bg-raised">
            Interrupt
          </button>)}
        <button onClick={() => endCall(group.id)} className="flex items-center gap-2 rounded-full bg-danger px-5 py-2.5 text-[14px] font-medium text-white hover:brightness-110">
          <PhoneOff size={16}/> Hang up
        </button>
      </div>

      <div className="text-[11.5px] text-ink-tertiary">
        Hold Control + Option to talk · Say a member’s name to direct the turn · Space interrupts · Esc hangs up
      </div>
    </div>);
}
