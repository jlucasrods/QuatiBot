// Against the real server: the room's eligibility and the turn it reads are assembled in server/index.ts.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlQuati } from "../scripts/control-quati.ts";
import type { WireBot } from "../shared/wire.ts";
import { CAPTURE_MARKER } from "./memory-capture.ts";

it("captures a member bot's room turn into its memory, sourced to the room, once Learn from group chats is on", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "quati-room-capture-"));
  const routes = join(scratch, "routes.json");
  writeFileSync(routes, JSON.stringify({
    [CAPTURE_MARKER]: JSON.stringify([{ text: "The garden launch moved to Friday", kind: "decision", confidence: 0.9 }]),
  }));
  const fixture = await launchVerificationServer({ FAKE_ACP_TEXT_ROUTES: routes });
  const env = { QUATIBOT_URL: fixture.info.url };
  const api = async <T = any>(path: string, method = "GET", body?: unknown): Promise<T> => {
    const response = await fetch(fixture.info.url + path, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json() as T;
    expect(response.ok, `${method} ${path}: ${JSON.stringify(result)}`).toBe(true);
    return result;
  };
  const capturePrompt = () => {
    try {
      return readFileSync(`${fixture.fixtureDumpPath}.prompts.jsonl`, "utf8").split("\n").filter(Boolean)
        .map((line) => {
          const turn: { prompt: Array<{ text?: string }> } = JSON.parse(line);
          return turn.prompt.map((block) => block.text ?? "").join("\n");
        })
        .find((prompt) => prompt.includes(CAPTURE_MARKER)) ?? "";
    } catch {
      return "";
    }
  };
  try {
    const { bot: lead } = await api<{ bot: WireBot }>("/api/bots", "POST", { name: "Lead" });
    const { bot: helper } = await api<{ bot: WireBot }>("/api/bots", "POST", { name: "Helper" });
    await api("/api/config", "PUT", { memory: { captureQuietMs: 1_000 } });
    expect((await api<{ features?: { roomMemoryCapture?: boolean } }>("/api/config")).features?.roomMemoryCapture).toBe(false);
    const config = await api<{ features?: { roomMemoryCapture?: boolean } }>("/api/config", "PATCH", { features: { roomMemoryCapture: true } });
    expect(config.features?.roomMemoryCapture).toBe(true);

    const { group } = await api<{ group: { id: string; threadId: string } }>("/api/groups", "POST", {
      name: "Garden room", memberIds: [lead.id, helper.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: lead.id } },
    });
    await api(`/api/groups/${group.id}/messages`, "POST", { text: "Lead, the garden launch moved to Friday." });
    await runControlQuati(["wait", "--bot", lead.id, "--timeout", "30"], { env });

    await expect.poll(async () => (await api<{ text: string }>(`/api/bots/${lead.id}/memory/file?path=MEMORY.md`)).text, { timeout: 30_000 })
      .toMatch(/- \d{4}-\d{2}-\d{2} · from room "Garden room" \(noticed\) · The garden launch moved to Friday/);
    const prompt = capturePrompt();
    expect(prompt).toContain("Person: Lead, the garden launch moved to Friday.");
    expect(prompt).toContain('This is a group chat ("room") Lead is a member of.');
    await expect.poll(async () => (await api<{ entries: Array<{ path: string; actor: string; via: string; threadId?: string }> }>(`/api/bots/${lead.id}/memory/journal`)).entries
      .filter((entry) => entry.path.startsWith("memory/log/")), { timeout: 10_000 })
      .toEqual([expect.objectContaining({ actor: "bot", via: "turn", threadId: group.threadId })]);
  } finally {
    await fixture.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}, 120_000);
