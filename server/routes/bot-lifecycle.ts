import { PASS, type RouteHandler } from "./table.ts";

export interface BotLifecycleRouteDeps {
  deleteBotWithLifecycle(botId: string): Promise<{ status: number; body: unknown }>;
}

export function createBotLifecycleRoutes({ deleteBotWithLifecycle }: BotLifecycleRouteDeps): RouteHandler {
  return async ({ res, path, method, json }) => {
    const match = path.match(/^\/api\/bots\/([\w-]+)$/);
    if (match && method === "DELETE") {
      const result = await deleteBotWithLifecycle(match[1]);
      return json(res, result.status, result.body);
    }
    return PASS;
  };
}
