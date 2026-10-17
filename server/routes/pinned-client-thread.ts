import type { RequestAuth } from "../request-auth.ts";
import type { Store } from "../store.ts";

export function pinnedClientThreadGuard(store: Pick<Store, "tasks">) {
  return (auth: RequestAuth) => {
    const requirePinnedClientThread = (botId: string, threadId: unknown): void => {
      if (threadId === undefined && auth.kind === "session" && store.tasks(botId).length > 1) {
        throw Object.assign(new Error("This bot has more than one thread. Choose a thread and try again."), { status: 409 });
      }
    };
    return requirePinnedClientThread;
  };
}
