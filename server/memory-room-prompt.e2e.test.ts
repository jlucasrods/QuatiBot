// Against the real server: the two prompts are assembled in two places, and only the assembled bytes prove they agree.
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlQuati } from "../scripts/control-quati.ts";

it("gives a room turn the memory_update guidance, not the file-tools one", async () => {
  const fixture = await launchVerificationServer();
  const env = { QUATIBOT_URL: fixture.info.url };
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method, headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json() as { [key: string]: unknown };
    expect(response.ok, JSON.stringify(result)).toBe(true);
    return result;
  };
  const prompt = () => {
    try {
      const turns: Array<{ prompt: Array<{ text?: string }>; mcpServers: Array<{ name: string }> }> = readFileSync(`${fixture.fixtureDumpPath}.prompts.jsonl`, "utf8")
        .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
      return turns.findLast((turn) => turn.mcpServers.some((server) => server.name === "agents"))?.prompt.map((block) => block.text ?? "").join("\n") ?? "";
    } catch {
      return "";
    }
  };
  try {
    // SAFETY: control-quati returns the created bot record under `bot`
    const { bot: lead } = await runControlQuati(["new-bot", "--name", "Lead"], { env }) as { bot: { id: string } };
    // SAFETY: same shape as above
    const { bot: helper } = await runControlQuati(["new-bot", "--name", "Helper"], { env }) as { bot: { id: string } };
    // A 1:1 turn first: it is the reference the room turn must match.
    await runControlQuati(["send", "--bot", lead.id, "--text", "Remember that the fixture garden is watered on Mondays."], { env });
    await runControlQuati(["wait", "--bot", lead.id, "--timeout", "30"], { env });
    const direct = prompt();
    expect(direct).toContain("Change MEMORY.md only with memory_update");
    expect(direct).not.toContain("update it with your file tools");

    // SAFETY: the groups route returns the created room under `group`
    const { group } = await api("POST", "/api/groups", {
      name: "Garden room", memberIds: [lead.id, helper.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: lead.id } },
    }) as { group: { id: string } };
    await api("POST", `/api/groups/${group.id}/messages`, { text: "Lead, what day is the garden watered?" });
    await expect.poll(() => {
      return prompt().includes("Reply to the conversation above as");
    }, { timeout: 30_000 }).toBe(true);
    await runControlQuati(["wait", "--bot", lead.id, "--timeout", "30"], { env });
    const room = prompt();
    expect(room).toContain("Change MEMORY.md only with memory_update");
    expect(room).not.toContain("update it with your file tools");
  } finally {
    await fixture.close();
  }
}, 120_000);
