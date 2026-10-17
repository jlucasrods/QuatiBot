import type { ComputerHelpRef } from "../../shared/wire";
import { api } from "@/state/store";
export async function answerSignIn(ref: Pick<ComputerHelpRef, "botId" | "threadId" | "messageId" | "place">, answer: "done" | "cancel"): Promise<void> {
    await api(`/api/bots/${encodeURIComponent(ref.botId)}/sign-in-cards/${encodeURIComponent(ref.messageId)}/${answer}`, {
        method: "POST",
        body: JSON.stringify({ threadId: ref.threadId }),
    });
}
export function signInHostIsHere(): boolean {
    return false;
}
