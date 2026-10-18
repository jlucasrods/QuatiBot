import { afterEach, describe, expect, it } from "vitest";

import { launchVerificationServer, runControlQuati, type VerificationServer } from "../scripts/control-quati.ts";

interface Message {
  kind: string;
  tool?: { name: string; itemId?: string; fullResult?: boolean; output?: string };
  digest?: { hookCoverage: string };
}

describe("OpenCode tool previews through an isolated HTTP fixture", () => {
  let fixture: VerificationServer | undefined;

  afterEach(async () => {
    await fixture?.close();
  });

  it("keeps bounded previews without claiming full hook results", async () => {
    const output = `${"line xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\n".repeat(200)}PRIVATE_RESULT_TAIL`;
    fixture = await launchVerificationServer({
      FAKE_ACP_MODELS: "fixture/test",
      FAKE_ACP_TOOL_CALLS: JSON.stringify([
        { name: "Bash", kind: "execute", input: { command: "cat big.log" }, ok: true, output },
        { name: "Read", kind: "read", input: { file_path: "a.ts" }, ok: true, output: "const a = 1;" },
      ]),
    });
    const created = await fetch(`${fixture.info.url}/api/bots`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Tool previews", modelSelection: { instanceId: "opencodeGo", model: "fixture/test" } }),
    });
    expect(created.status).toBe(201);
    const { bot } = JSON.parse(await created.text());
    await runControlQuati(["send", "--bot", bot.id, "--task", bot.threadId, "--text", "Read the log.", "--url", fixture.info.url]);
    expect(await runControlQuati(["wait", "--bot", bot.id, "--task", bot.threadId, "--timeout", "15", "--url", fixture.info.url])).toMatchObject({ status: "settled" });

    const response = await fetch(`${fixture.info.url}/api/threads/${bot.threadId}/messages?limit=50`);
    expect(response.status).toBe(200);
    const state: { messages: Message[] } = JSON.parse(await response.text());
    const tools = state.messages.filter((message) => message.kind === "activity" && message.tool);
    expect(tools.map((message) => message.tool!.name)).toEqual(["shell", "Read"]);
    for (const row of tools) {
      expect(row.tool!.itemId).toBeTruthy();
      expect(row.tool!.fullResult).not.toBe(true);
      expect(row.tool).not.toHaveProperty("outputPath");
    }
    expect(tools[0]!.tool!.output).toContain("line xxx");
    expect(tools[0]!.tool!.output!.length).toBeLessThan(7_000);
    expect(tools[0]!.tool!.output).not.toContain("PRIVATE_RESULT_TAIL");
    expect(tools[1]!.tool!.output).toContain("const a = 1;");
    expect(JSON.stringify(tools)).not.toContain(fixture.info.dataDir);
    expect(state.messages.find((message) => message.kind === "digest")?.digest?.hookCoverage).toBe("preview");
  }, 30_000);

  it("refuses hook calls without a live hook capability", async () => {
    fixture = await launchVerificationServer();
    const response = await fetch(`${fixture.info.url}/api/internal/hook`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer not-a-real-token" },
      body: JSON.stringify({ event: "PostToolUse", payload: { tool_use_id: "x" } }),
    });
    expect(response.status).toBe(401);
  });
});
