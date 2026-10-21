import type { LoginBots, LoginSummary } from "../../shared/logins";
import type { ComputerHelpRef } from "../../shared/wire";
import { api } from "@/state/store";

/** What the person typed into a login form. Kept only until it is sent. */
export interface LoginFieldsInput {
  username: string;
  password: string;
  totp: string;
}

export async function listLogins(): Promise<{ logins: LoginSummary[] }> {
  return await api<{ logins: LoginSummary[] }>("/api/logins");
}

export async function addLogin(site: string, fields: LoginFieldsInput, bots: LoginBots, exactHost = false): Promise<LoginSummary> {
  return (await api<{ login: LoginSummary }>("/api/logins", {
    method: "POST",
    body: JSON.stringify({ site, username: fields.username, password: fields.password, ...(fields.totp.trim() ? { totp: fields.totp } : {}), bots, ...(exactHost ? { exactHost } : {}) }),
  })).login;
}

export async function changeLogin(id: string, change: { password?: string; totp?: string; removeTotp?: boolean; bots?: LoginBots; exactHost?: boolean }): Promise<LoginSummary> {
  return (await api<{ login: LoginSummary }>(`/api/logins/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({
      ...(change.password ? { password: change.password } : {}),
      ...(change.removeTotp ? { totp: null } : change.totp?.trim() ? { totp: change.totp } : {}),
      ...(change.bots ? { bots: change.bots } : {}),
      ...(change.exactHost === undefined ? {} : { exactHost: change.exactHost }),
    }),
  })).login;
}

export async function deleteLogin(id: string): Promise<void> {
  await api(`/api/logins/${encodeURIComponent(id)}`, { method: "DELETE" });
}

type CardRef = Pick<ComputerHelpRef, "botId" | "threadId" | "messageId">;

const cardSavePath = (ref: CardRef) => `/api/bots/${encodeURIComponent(ref.botId)}/sign-in-cards/${encodeURIComponent(ref.messageId)}/save-login`;

/** Where a login saved from the card fills: its site, and a sign-in page on another site the browser shows now, which
 * the person may add. */
export async function cardSaveTarget(ref: CardRef): Promise<{ site: string; signInHost?: string }> {
  return await api<{ site: string; signInHost?: string }>(`${cardSavePath(ref)}?threadId=${encodeURIComponent(ref.threadId)}`);
}

export async function saveLoginFromCard(ref: CardRef, fields: LoginFieldsInput, signInHost?: string): Promise<void> {
  await api(cardSavePath(ref), {
    method: "POST",
    body: JSON.stringify({ threadId: ref.threadId, username: fields.username, password: fields.password, ...(fields.totp.trim() ? { totp: fields.totp } : {}), ...(signInHost ? { signInHost } : {}) }),
  });
}
