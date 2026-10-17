import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlQuati } from "../scripts/control-quati.ts";

it("discovers native models, persists conversation choices and completes an ACP chat", async () => {
  const fixture = await launchVerificationServer();
  const { url, dataDir } = fixture.info;
  const request = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${url}${path}`, {
      method, headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    });
    return { status: response.status, body: await response.json() };
  };

  try {
    const catalog = await request("GET", "/api/instances");
    expect(catalog.status).toBe(200);
    expect(catalog.body).toMatchObject({ instances: [{
      instanceId: "opencodeGo", driverKind: "opencodeGo",
      models: { options: [{ id: "fixture/default" }, { id: "fixture/alternate" }] },
    }] });

    const before = readFileSync(join(dataDir, "config.json"), "utf8");
    expect(await request("GET", "/api/mcp/servers")).toEqual({ status: 200, body: {
      scope: "global", activationScope: "quati", servers: [
        { name: "global-local", type: "local", status: "disabled", enabled: false },
        { name: "global-remote", type: "remote", status: "configured", enabled: true },
      ],
    } });
    expect(await request("GET", "/api/opencode/extensions")).toMatchObject({ status: 200, body: {
      plugins: [{ name: "fixture-plugin" }], skills: [{ id: "global-skill", name: "Global skill" }],
    } });
    for (const [method, path] of [["POST", "/api/mcp/servers"], ["DELETE", "/api/mcp/servers/global-remote"], ["POST", "/api/mcp/servers/global-remote/auth/start"]]) {
      expect((await request(method!, path!, {})).status).toBe(405);
    }
    for (const body of [
      { opencodeGo: { apiKey: "not-a-real-key" } },
      { box: { token: "not-a-real-key" } },
      { composio: { apiKey: "not-a-real-key" } },
      { vps: { sshAlias: "fixture" } },
      { mcpServers: { injected: { command: "fixture" } } },
      { features: { claudeUserMcp: true } },
      { features: { claudeUserSkills: true } },
    ]) {
      const credentials = await request("PATCH", "/api/config", body);
      expect(credentials.status).toBe(400);
    }
    expect(readFileSync(join(dataDir, "config.json"), "utf8")).toBe(before);
    expect((await request("PATCH", "/api/mcp/servers/missing", { enabled: false })).status).toBe(404);
    expect((await request("PATCH", "/api/mcp/servers/global-remote", { enabled: "yes" })).status).toBe(400);
    expect((await request("PATCH", "/api/mcp/servers/global-remote", { enabled: false })).status).toBe(200);
    expect((await request("PATCH", "/api/mcp/servers/global-local", { enabled: true })).status).toBe(200);

    const created = await runControlQuati(["new-bot", "--name", "OpenCode fixture", "--url", url]) as { bot: { id: string; activeTaskId: string } };
    const { id, activeTaskId } = created.bot;
    const browser = await request("PATCH", `/api/bots/${id}`, { computer: "browser", browser: true });
    expect(browser.status).toBe(200);
    expect(await request("GET", `/api/bots/${id}/computer`)).toMatchObject({ status: 200, body: { surface: "browser" } });
    const modelSelection = { instanceId: "opencodeGo", model: "fixture/alternate", variant: "high" };
    const selected = await request("PATCH", `/api/bots/${id}/tasks/${activeTaskId}`, { modelSelection });
    expect(selected.status).toBe(200);

    await runControlQuati(["send", "--bot", id, "--text", "Hello OpenCode V2", "--url", url]);
    const settled = await runControlQuati(["wait", "--bot", id, "--timeout", "30", "--url", url]);
    expect(settled, JSON.stringify(settled)).toMatchObject({ status: "settled" });
    const state = await request("GET", "/api/bots");
    expect(state.body).toMatchObject({ bots: expect.arrayContaining([
      expect.objectContaining({ id, tasks: expect.arrayContaining([expect.objectContaining({ threadId: activeTaskId, modelSelection })]) }),
    ]) });
    const transcript = await runControlQuati(["messages", "--bot", id, "--limit", "20", "--url", url]);
    expect(transcript).toMatchObject({ messages: expect.arrayContaining([expect.objectContaining({ role: "bot", text: "hello from fake acp" })]) });
    const dump = JSON.parse(readFileSync(join(dataDir, "fake-acp-dump.json"), "utf8")) as { env: { OPENCODE_CONFIG_CONTENT: string } };
    expect(JSON.parse(dump.env.OPENCODE_CONFIG_CONTENT)).toMatchObject({ mcp: { servers: {
      "global-local": { type: "local", command: ["fixture-mcp"], environment: { TOKEN: "fixture-secret" }, disabled: false },
      "global-remote": { type: "remote", headers: { Authorization: "fixture-secret" }, disabled: true },
    } } });
    expect(await request("GET", "/api/mcp/servers")).toMatchObject({ body: { servers: [
      { name: "global-local", status: "disabled", enabled: true },
      { name: "global-remote", status: "configured", enabled: false },
    ] } });

    expect((await request("PATCH", "/api/mcp/servers/global-remote", { enabled: true })).status).toBe(200);
    await runControlQuati(["send", "--bot", id, "--text", "Continue with the updated MCP selection", "--url", url]);
    expect(await runControlQuati(["wait", "--bot", id, "--timeout", "30", "--url", url])).toMatchObject({ status: "settled" });
    const resumedDump = JSON.parse(readFileSync(join(dataDir, "fake-acp-dump.json"), "utf8")) as { env: { OPENCODE_CONFIG_CONTENT: string } };
    expect(JSON.parse(resumedDump.env.OPENCODE_CONFIG_CONTENT)).toMatchObject({ mcp: { servers: {
      "global-local": { command: ["fixture-mcp"], disabled: false },
      "global-remote": { headers: { Authorization: "fixture-secret" }, disabled: false },
    } } });
    expect(JSON.parse(readFileSync(join(dataDir, "fake-acp-dump.json.session.json"), "utf8"))).toHaveProperty("sessionId");
  } finally {
    await fixture.close();
  }
}, 60_000);
