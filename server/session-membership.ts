import type { Scope } from "./sessions.ts";

export interface SignInAllowList {
  admins: string[];
  members: string[];
}

export function parseAllowList(value: string | undefined | null): string[] {
  return (value ?? "")
    .split(/[,\s]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

export function allowedScopes(rawEmail: string, list: SignInAllowList): Scope[] | null {
  const email = rawEmail.trim().toLowerCase();
  if (!email.includes("@")) return null;

  const matches = (entry: string) => entry.startsWith("@")
    ? email.endsWith(entry) && email.length > entry.length
    : entry === email;

  if (list.admins.some(matches)) return ["admin", "client"];
  if (list.members.some(matches)) return ["client"];
  return null;
}
