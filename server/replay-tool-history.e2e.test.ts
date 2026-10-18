import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

import { launchVerificationServer, runControlQuati } from "../scripts/control-quati.ts";
import { request } from "../scripts/mcp-server.ts";
import type { WireMessage } from "../shared/wire.ts";
import { withoutTurnClock } from "./testing/turn-clock-text.ts";

it("names earlier tool calls in a rebuilt session only when switched on", async () => {
  const fixture = await launchVerificationServer({
    FAKE_ACP_MODELS: "fixture/default,fixture/alternate",
    FAKE_ACP_TOOL_CALLS: JSON.stringify([
      { name: "Bash", kind: "execute", input: { command: "pnpm test", description: "INPUT_PREVIEW_ONLY" }, output: "RESULT_BODY 3 failed", ok: false },
      { name: "Read", kind: "read", input: { file_path: "/fixture/notes.md", limit: 40 }, output: "RESULT_BODY notes", ok: true },
    ]),
  });
  const evidence: unknown[] = [{ fixture: fixture.info }];
  const control = async (...args: string[]) => {
    const result = await runControlQuati([...args, "--url", fixture.info.url]) as any;
    evidence.push({ command: args, result });
    return result;
  };
  try {
    const bot = (await control("new-bot", "--name", "Replay probe")).bot;
    const thread: string = bot.activeTaskId;
    const messages = async () =>
      (await request(`/api/threads/${thread}/messages?limit=100`, {}, fixture.info.url) as { messages: WireMessage[] }).messages;
    const settled = async () =>
      expect((await control("wait", "--bot", bot.id, "--task", thread, "--timeout", "30")).status).toBe("settled");
    const nativeTurn = () => {
      const turns = readFileSync(`${fixture.fixtureDumpPath}.prompts.jsonl`, "utf8").trim().split("\n")
        .map((line) => JSON.parse(line) as { model: string; prompt: Array<{ text?: string }>; mcpServers: Array<{ env?: Array<{ name: string; value: string }> }> });
      const turn = turns.findLast((entry) => entry.mcpServers.some((server) => server.env?.some((env) => env.name === "QUATI_THREAD_ID" && env.value === thread)));
      expect(turn).toBeDefined();
      return turn!;
    };
    const prompt = () => {
      const text = withoutTurnClock(nativeTurn().prompt.map((part) => part.text ?? "").join("\n"));
      evidence.push({ prompt: text });
      return text;
    };
    const send = async (text: string) => {
      await control("send", "--bot", bot.id, "--task", thread, "--text", text);
      await settled();
      return prompt();
    };
    /** Rewind: edit the latest user message, which replays the surviving branch. */
    const rewind = async (text: string) => {
      const latest = (await messages()).findLast(message => message.role === "user")!;
      await control("edit", "--bot", bot.id, "--task", thread, "--message", latest.id, "--text", text);
      await settled();
      return prompt();
    };
    const toolLines = (text: string) => text.split("\n").filter(line => line.startsWith("Assistant: [ran: "));

    await send("FIRST_REQUEST run the tests");
    const calls = (await messages()).filter(message => message.tool?.itemId);
    expect(calls.map(message => [message.tool?.name, message.tool?.ok])).toEqual([["shell", false], ["Read", true]]);
    // the Read's chip shows no file: the path is only in the stored input preview
    expect(calls[1]!.tool).toMatchObject({ name: "Read", input: expect.stringContaining('"file_path": "/fixture/notes.md"') });
    expect(calls[1]!.tool?.summary).toBeUndefined();

    // A turn that resumes its session is sent the message, and no replay.
    expect(await send("SECOND_REQUEST anything else?")).toBe("SECOND_REQUEST anything else?");

    // Off (the default): the rewind replays what was said, as it always has.
    const off = await rewind("SECOND_REQUEST, edited");
    expect(off).toContain("rewound this conversation");
    expect(off).toContain("User: FIRST_REQUEST run the tests");
    expect(off).not.toContain("[ran: ");

    await request("/api/config", { method: "PATCH", body: JSON.stringify({ context: { replayToolHistory: true } }) }, fixture.info.url);

    // On: the same replay, plus one line per earlier call, between the
    // request it followed and the reply it led to: the command that ran,
    // and the file that was read.
    const on = await rewind("SECOND_REQUEST, edited again");
    expect(toolLines(on)).toEqual(["Assistant: [ran: shell: pnpm test — failed]", "Assistant: [ran: Read: /fixture/notes.md — ok]"]);
    expect(on).toMatch(/User: FIRST_REQUEST run the tests\nAssistant: hello from fake acp\nAssistant: \[ran: shell: pnpm test — failed\]\nAssistant: \[ran: Read: \/fixture\/notes\.md — ok\]/);
    // no tool result, and of the input preview behind the chip only its target
    expect(on).not.toContain("RESULT_BODY");
    expect(on).not.toContain("INPUT_PREVIEW_ONLY");
    // and nothing else moved: without those lines it is the replay sent while off
    expect(on.split("\n").filter(line => !line.startsWith("Assistant: [ran: ")).join("\n"))
      .toBe(off.replace("SECOND_REQUEST, edited", "SECOND_REQUEST, edited again"));

    // Still on, a turn that resumes its session is sent no replay.
    expect(await send("THIRD_REQUEST thanks")).toBe("THIRD_REQUEST thanks");

    await request(`/api/bots/${bot.id}/tasks/${thread}`, { method: "PATCH", body: JSON.stringify({
      modelSelection: { instanceId: "opencodeGo", model: "fixture/alternate" }, requireAvailableModel: true,
    }) }, fixture.info.url);
    await control("send", "--bot", bot.id, "--task", thread, "--text", "FOURTH_REQUEST carry on");
    await settled();
    // the harness's own record of what it sent that engine
    const sent = readFileSync(join(fixture.info.dataDir, "native", `${thread}.ndjson`), "utf8").trim().split("\n")
      .map(line => JSON.parse(line)).findLast(entry => entry.dir === "out" && entry.msg?.method === "session/prompt");
    const joined = withoutTurnClock((sent.msg.params.prompt as Array<{ text?: string }>).map(part => part.text ?? "").join("\n"));
    evidence.push({ joined });
    expect(nativeTurn().model).toBe("fixture/alternate");
    expect(joined).toBe("FOURTH_REQUEST carry on");
    expect(toolLines(joined)).toEqual([]);
    expect(joined).not.toContain("RESULT_BODY");
    expect(joined.endsWith("FOURTH_REQUEST carry on")).toBe(true);

    // The lines are built for the replay; the stored conversation has none.
    expect(JSON.stringify(await messages())).not.toContain("[ran: ");
  } finally {
    try {
      writeFileSync(`${fixture.info.logPath}.replay-tools.json`, JSON.stringify(evidence, null, 2), { mode: 0o600 });
      console.info(`Replay tool-history evidence: ${fixture.info.logPath}.replay-tools.json`);
    } finally { await fixture.close(); }
    expect(existsSync(fixture.info.dataDir)).toBe(false);
  }
}, 120_000);
