import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

import { launchVerificationServer, runControlQuati } from "../scripts/control-quati.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

interface Turn {
  botId: string;
  threadId: string;
  prompt: { message?: { content?: string } };
}

it.each([false, true])("keeps the full OpenCode room window across members with room sessions %s", async (roomSessions) => {
  const fixture = await launchVerificationServer({}, undefined, undefined, undefined, undefined, { scripted: true });
  const { url, dataDir } = fixture.info;
  const planPath = join(dataDir, "room-plan.json");

  async function request(method: string, path: string, body: unknown) {
    const response = await fetch(url + path, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.ok).toBe(true);
    return JSON.parse(await response.text());
  }

  try {
    await request("PATCH", "/api/config", { context: { roomSessions } });
    const editor = await request("POST", "/api/bots", { name: "Editor" });
    const writer = await request("POST", "/api/bots", { name: "Writer" });
    const room = await request("POST", "/api/groups", {
      name: "Edit bay",
      memberIds: [editor.bot.id, writer.bot.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: editor.bot.id } },
    });
    const plan = {
      [editor.bot.id]: { reply: "Intro cut. BRAVO_ROOM" },
      [writer.bot.id]: { reply: "Call it Dawn. DELTA_ROOM" },
    };
    writeFileSync(planPath, JSON.stringify(plan));

    for (const text of [
      "@Editor Cut the intro. ALPHA_ROOM",
      "@Writer Name the film. CHARLIE_ROOM",
      "@Editor Use that title. ECHO_ROOM",
      "@Editor Add the credits. GOLF_ROOM",
    ]) {
      await runControlQuati(["send-channel", "--channel", room.group.id, "--text", text, "--url", url]);
      const settled = await runControlQuati(["wait", "--channel", room.group.id, "--timeout", "30", "--url", url]);
      expect(settled).toMatchObject({ status: "settled" });
    }

    const turns: Turn[] = readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const editorTurns = turns.filter((turn) => turn.botId === editor.bot.id);
    expect(editorTurns).toHaveLength(3);
    expect(turns.filter((turn) => turn.botId === writer.bot.id)).toHaveLength(1);

    for (const turn of editorTurns.slice(1)) {
      expect(turn.threadId).toBe(room.group.threadId);
      expect(turn.prompt.message?.content).not.toContain("[Messages this conversation received since your last turn in this room");
      for (const sentinel of ["ALPHA_ROOM", "BRAVO_ROOM", "CHARLIE_ROOM", "DELTA_ROOM", "ECHO_ROOM"]) {
        expect(turn.prompt.message?.content, sentinel).toContain(sentinel);
      }
    }
    expect(editorTurns.at(-1)?.prompt.message?.content).toContain("GOLF_ROOM");
  } finally {
    await fixture.close();
  }
}, hostTimeout(90_000));
