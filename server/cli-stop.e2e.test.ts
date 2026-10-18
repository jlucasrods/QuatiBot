import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { launchVerificationServer, runControlQuati } from "../scripts/control-quati.ts";

function alive(pid: number): boolean {
  try {
    return !/^State:\s+Z/m.test(readFileSync(`/proc/${pid}/status`, "utf8"));
  } catch {
    return false;
  }
}

describe.skipIf(process.platform !== "linux")("Stop through the isolated server", () => {
  it.each([false, true])("keeps the task busy until its stubborn helper stops (root ignores TERM: %s)", async (stubbornRoot) => {
    const fixture = await launchVerificationServer();
    const evidence: unknown[] = [{ fixture: fixture.info, stubbornRoot }];
    const pids: number[] = [];
    const control = async (args: string[]) => {
      const command = [...args, "--url", fixture.info.url];
      const result = await runControlQuati(command) as any;
      evidence.push({ command, result });
      return result;
    };
    try {
      const wrapper = join(fixture.info.dataDir, "stubborn-opencode.mjs");
      const pidFile = join(fixture.info.dataDir, "owned-pids.json");
      const gate = join(fixture.info.dataDir, "finish.gate");
      const fake = pathToFileURL(join(process.cwd(), "server/testing/fake-acp-cli.ts")).href;
      const helper = "process.on('SIGTERM', () => {}); console.log(process.pid); setInterval(() => {}, 1000);";
      writeFileSync(wrapper, [
        "#!/usr/bin/env node",
        "import { spawn } from 'node:child_process';",
        "import { once } from 'node:events';",
        "import { writeFileSync } from 'node:fs';",
        "import { createInterface } from 'node:readline';",
        "if (process.argv.includes('acp')) {",
        stubbornRoot ? "process.on('SIGTERM', () => {});" : "",
        `const child = spawn(process.execPath, ['-e', ${JSON.stringify(helper)}], { stdio: ['ignore', 'pipe', 'ignore'] });`,
        "await once(child.stdout, 'data');",
        "createInterface({ input: process.stdin }).on('line', line => {",
        `if (JSON.parse(line).method === 'session/prompt') writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify([process.pid, child.pid]));`,
        "});",
        "}",
        "process.env.FAKE_ACP_MODE = 'echo-gated';",
        "process.env.FAKE_ACP_IGNORE_CANCEL = '1';",
        `process.env.FAKE_ACP_GATE_FILE = ${JSON.stringify(gate)};`,
        `await import(${JSON.stringify(fake)});`,
      ].join("\n"), { mode: 0o700 });
      const configured = await fetch(`${fixture.info.url}/api/instances/opencodeGo`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ cli: wrapper }),
      });
      evidence.push({ method: "PATCH", path: "/api/instances/opencodeGo", body: { cli: wrapper }, status: configured.status });
      expect(configured.status).toBe(200);
      const created = await control(["new-bot", "--name", "Stop fixture"]);
      const botId = created.bot.id;
      const taskId = created.bot.activeTaskId;
      const target = ["--bot", botId, "--task", taskId];
      await control(["send", ...target, "--text", "Keep working until Stop"]);
      await expect.poll(() => existsSync(pidFile), { timeout: 10_000 }).toBe(true);
      pids.push(...JSON.parse(readFileSync(pidFile, "utf8")) as number[]);
      expect(pids.every(alive)).toBe(true);
      expect((await control(["wait", ...target, "--timeout", "1"])).status).toBe("timed-out");

      const started = Date.now();
      await control(["interrupt", ...target]);
      // The root can already have closed, but the helper still owns work.
      expect((await control(["wait", ...target, "--timeout", "1"])).status).toBe("timed-out");
      expect(alive(pids[1]!)).toBe(true);
      const repeated: Promise<number>[] = [];
      const interval = setInterval(() => {
        repeated.push(fetch(`${fixture.info.url}/api/bots/${botId}/interrupt`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ threadId: taskId }), signal: AbortSignal.timeout(2_000),
        }).then((response) => response.status));
      }, 500);
      try {
        expect((await control(["wait", ...target, "--timeout", "10"])).status).toBe("settled");
      } finally {
        clearInterval(interval);
      }
      expect(await Promise.all(repeated)).toEqual(repeated.map(() => 200));
      expect(Date.now() - started).toBeLessThan(12_000);
      await expect.poll(() => pids.some(alive), { timeout: 1_000 }).toBe(false);
      evidence.push({ stoppedPids: [...pids], alive: pids.map(alive), elapsedMs: Date.now() - started });
      await control(["messages", ...target, "--limit", "10"]);

      writeFileSync(gate, "finish");
      await control(["send", ...target, "--text", "Reply after Stop"]);
      expect((await control(["wait", ...target, "--timeout", "10"])).status).toBe("settled");
      pids.push(...JSON.parse(readFileSync(pidFile, "utf8")) as number[]);
      const messages = await control(["messages", ...target, "--limit", "10"]);
      expect(messages.messages.some((message: any) => message.role === "bot" && message.text?.includes("Reply after Stop"))).toBe(true);
    } finally {
      // These are only the exact PIDs recorded by this fixture's wrapper.
      for (const pid of pids) if (alive(pid)) process.kill(pid, "SIGKILL");
      const evidencePath = `${fixture.info.logPath}.json`;
      writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
      console.info(JSON.stringify({ ...fixture.info, evidencePath }));
      await fixture.close();
    }
  }, 35_000);
});
