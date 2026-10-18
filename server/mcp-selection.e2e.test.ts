import { existsSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-quati.ts";

it("applies the Quati-only global MCP selection on the next room turn", async () => {
  const fixture = await launchVerificationServer();
  const { url } = fixture.info;
  const request = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(url + path, {
      method, headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    });
    return { status: response.status, body: JSON.parse(await response.text()) };
  };

  try {
    const created = await request("POST", "/api/bots", { name: "MCP room member" });
    expect(created.status).toBe(201);
    const { id: botId } = created.body.bot;
    const room = await request("POST", "/api/groups", {
      name: "MCP selection", memberIds: [botId],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId } },
    });
    expect(room.status).toBe(201);
    const { id: groupId } = room.body.group;
    const promptPath = `${fixture.fixtureDumpPath}.prompts.jsonl`;

    for (const enabled of [true, false]) {
      expect((await request("PATCH", "/api/mcp/servers/global-local", { enabled })).status).toBe(200);
      const previousPrompts = existsSync(promptPath) ? readFileSync(promptPath, "utf8").trim().split("\n").length : 0;
      expect((await request("POST", `/api/groups/${groupId}/messages`, { text: `Check MCP selection: ${enabled}` })).status).toBe(202);
      await expect.poll(() => existsSync(promptPath) && readFileSync(promptPath, "utf8").trim().split("\n").length > previousPrompts, { timeout: 15_000 }).toBe(true);
      await expect.poll(async () => (await request("GET", "/api/bots?messages=0")).body.groups
        .find((group: { id: string }) => group.id === groupId)?.working, { timeout: 15_000 }).toBe(false);

      const dump = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")) as { env: { OPENCODE_CONFIG_CONTENT: string } };
      expect(JSON.parse(dump.env.OPENCODE_CONFIG_CONTENT)).toMatchObject({ mcp: { servers: {
        "global-local": { command: ["fixture-mcp"], environment: { TOKEN: "fixture-secret" }, disabled: !enabled },
      } } });
      const listed = await request("GET", "/api/opencode/extensions");
      expect(listed.status).toBe(200);
      expect(listed.body.servers.find((server: { name: string }) => server.name === "global-local"))
        .toMatchObject({ status: "disabled", enabled });
    }
  } finally {
    await fixture.close();
  }
}, 60_000);
