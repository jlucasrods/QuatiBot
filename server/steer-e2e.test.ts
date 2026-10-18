import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verificationServerEnvironment } from "../scripts/control-quati.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_ACP = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
const linuxOnly = describe.skipIf(process.platform !== "linux");

linuxOnly("queued messages with OpenCode ACP", () => {
  let child: ChildProcess;
  let home: string;
  let stderr = "";
  let steerFinishGate: string;

  type NativeTurn = {
    prompt: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    mcpServers: Array<{ env?: Array<{ name: string; value: string }> }>;
  };
  const nativeTurn = (threadId: string): NativeTurn | undefined => {
    const path = join(home, "gated-dump.json.prompts.jsonl");
    if (!existsSync(path)) return;
    const turns: NativeTurn[] = readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    return turns.findLast((turn) => turn.mcpServers.some((server) => server.env?.some((entry) => entry.name === "QUATI_THREAD_ID" && entry.value === threadId)));
  };

  const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  const getBot = async (id: string) => (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === id);
  const PAIRED = { name: "Safari on Mac", id: expect.stringMatching(/^p_[\w-]{22}$/) };
  const asPairedPerson = async () => {
    const opened = await api("POST", "/api/auth/pairing", {});
    expect(opened.status).toBe(200);
    const paired = await fetch(`${BASE}/api/auth/pair`, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Safari/605.1" },
      body: JSON.stringify({ code: opened.body.code }),
    });
    const session = await paired.json() as any;
    expect(paired.status).toBe(200);
    expect(session.session.label).toBe(PAIRED.name);
    return async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
      const res = await fetch(`${BASE}${path}`, {
        method,
        headers: { authorization: `Bearer ${session.token}`, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, body: await res.json() };
    };
  };
  const waitFor = async (predicate: () => Promise<boolean>, what: string, ms = 30_000) => {
    const deadline = Date.now() + ms;
    while (!(await predicate())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}. stderr: ${stderr.slice(-2000)}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "quati-steer-"));
    const dataDir = join(home, ".quatibot");
    mkdirSync(dataDir, { recursive: true });
    const discovery = join(dataDir, "providers", "opencode", "discovery");
    mkdirSync(discovery, { recursive: true });
    writeFileSync(join(discovery, ".quati-project"), "fixture");
    steerFinishGate = join(home, "finish-steered-turn.gate");
    const instances: Record<string, { driver: string; config: { cli: string } }> = {};
    for (const [id, mode] of Object.entries({ gated: "echo-gated", acp: "hang", questions: "question" })) {
      const cli = join(home, `${id}-opencode.mjs`);
      writeFileSync(cli, [
        "#!/usr/bin/env node",
        `process.env.FAKE_ACP_MODE = ${JSON.stringify(mode)};`,
        `process.env.FAKE_ACP_GATE_FILE = ${JSON.stringify(steerFinishGate)};`,
        `process.env.FAKE_ACP_DUMP = ${JSON.stringify(join(home, `${id}-dump.json`))};`,
        `await import(${JSON.stringify(pathToFileURL(FAKE_ACP).href)});`,
      ].join("\n"), { mode: 0o700 });
      instances[id] = { driver: "opencodeGo", config: { cli } };
    }
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({
      instances, defaultModelSelection: { instanceId: "gated", model: "fixture/test" },
    }));
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: {
        ...verificationServerEnvironment({}, dataDir, PORT), HOME: home,
        FAKE_ACP_VERSION: "2.0.31", FAKE_ACP_AGENT_VERSION: "2.0.31", FAKE_ACP_AGENT_NAME: "OpenCode",
        FAKE_ACP_MODELS: "fixture/test", FAKE_ACP_IMAGE_CAPABILITY: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (c) => (stderr += c));
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        if ((await fetch(`${BASE}/api/health`)).ok) break;
      } catch {
      }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
      await new Promise((r) => setTimeout(r, 150));
    }
    await waitFor(async () => {
      const snapshots = (await api("GET", "/api/instances")).body.instances;
      return Object.keys(instances).every((id) => snapshots.find((instance: { instanceId: string }) => instance.instanceId === id)?.models.options.some((option: { id: string }) => option.id === "fixture/test"));
    }, "the OpenCode fixture models");
  }, 30_000);

  afterAll(async () => {
    child?.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (!child || child.exitCode !== null) return resolve();
      child.on("close", () => resolve());
      setTimeout(() => (child.kill("SIGKILL"), resolve()), 5_000).unref?.();
    });
    rmSync(home, { recursive: true, force: true });
  });

  it("keeps two queued attachment messages as two native images in one follow-up turn", async () => {
    // The opener holds the bot's one slot on the gated slow instance, so both sends queue; a timed opener could settle between them.
    rmSync(steerFinishGate, { force: true });
    const previousLimit = (await api("GET", "/api/config")).body.threads.maxConcurrentPerBot as number;
    await api("PATCH", "/api/config", { threads: { maxConcurrentPerBot: 1 } });
    try {
      const created = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${created.id}`, {
        modelSelection: { instanceId: "gated", model: "fixture/test" },
      });
      const waiting = (await api("POST", `/api/bots/${created.id}/tasks`, { title: "Images" })).body.task.threadId as string;
      const waitingMessages = async () =>
        (await api("GET", `/api/threads/${waiting}/messages?limit=20`)).body.messages as any[];
      expect((await api("POST", `/api/bots/${created.id}/messages`, { threadId: created.threadId, text: "first image task" })).status)
        .toBe(202);
      await waitFor(
        async () => Boolean(nativeTurn(created.threadId)),
        "the opener's actual ACP prompt",
      );

      const attachments = join(home, ".quatibot", "attachments");
      mkdirSync(attachments, { recursive: true });
      const firstImagePath = join(attachments, "123e4567-e89b-42d3-a456-426614174000.png");
      const secondImagePath = join(attachments, "123e4567-e89b-42d3-a456-426614174001.png");
      writeFileSync(firstImagePath, "first png");
      writeFileSync(secondImagePath, "second png");
      const firstAttachedText = `look at this\n\n<attached-image path="${firstImagePath}" name="first.png" />`;
      const secondAttachedText = `and this\n\n<attached-image path="${secondImagePath}" name="second.png" />`;
      try {
        const firstReceipt = await api("POST", `/api/bots/${created.id}/messages`, { threadId: waiting, text: firstAttachedText });
        const secondReceipt = await api("POST", `/api/bots/${created.id}/messages`, { threadId: waiting, text: secondAttachedText });

        expect(firstReceipt.status).toBe(202);
        expect(firstReceipt.body).toMatchObject({ ok: true, queued: true, reason: "capacity" });
        expect(firstReceipt.body.steered).toBeUndefined();
        expect(secondReceipt.status).toBe(202);
        expect(secondReceipt.body).toMatchObject({ ok: true, queued: true, reason: "capacity" });
        expect(secondReceipt.body.steered).toBeUndefined();
        expect(
          (await waitingMessages()).some(
            (message: any) => message.text === firstAttachedText || message.text === secondAttachedText,
          ),
        ).toBe(false);
      } finally {
        writeFileSync(steerFinishGate, "finish");
      }

      await waitFor(
        async () => {
          const messages = await waitingMessages();
          return [firstAttachedText, secondAttachedText].every((text) =>
            messages.some((message: any) => message.text === text),
          );
        },
        "both attached messages to drain",
      );
      await waitFor(
        async () => (await getBot(created.id)).tasks.every((task: any) => !task.busy),
        "the attached follow-up to settle",
      );

      const followUp = nativeTurn(waiting);
      expect(followUp).toBeDefined();
      expect(followUp!.prompt.filter((block) => block.type === "image")).toEqual([
        { type: "image", mimeType: "image/png", data: Buffer.from("first png").toString("base64") },
        { type: "image", mimeType: "image/png", data: Buffer.from("second png").toString("base64") },
      ]);
      const text = followUp!.prompt.filter((block) => block.type === "text").map((block) => block.text).join("\n");
      expect(text).toContain("look at this");
      expect(text).toContain("and this");
      expect(text).not.toContain("<attached-image path=");
    } finally {
      await api("PATCH", "/api/config", { threads: { maxConcurrentPerBot: previousLimit } });
    }
  }, 40_000);

  it("delivers a queued room burst's non-last image natively in the coalesced turn", async () => {
    rmSync(steerFinishGate, { force: true });
    const created = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${created.id}`, {
      modelSelection: { instanceId: "gated", model: "fixture/test" },
    });
    const room = (await api("POST", "/api/groups", {
      name: "Burst image room",
      memberIds: [created.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: created.id } },
    })).body.group;
    const getGroup = async () =>
      (await api("GET", "/api/bots?messages=30")).body.groups.find((g: any) => g.id === room.id);

    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "start the room" })).status).toBe(202);
    await waitFor(async () => (await getGroup())?.busyBotId === created.id, "the room turn to start");

    // Loopback API sends never merge (each is its own identity), so the burst comes from one paired person; the gated opener cannot settle early.
    const person = await asPairedPerson();
    const attachments = join(home, ".quatibot", "attachments");
    mkdirSync(attachments, { recursive: true });
    const imagePath = join(attachments, "123e4567-e89b-42d3-a456-426614174004.png");
    writeFileSync(imagePath, "room png");
    const imageText = `look at the room screenshot\n\n<attached-image path="${imagePath}" name="shot.png" />`;
    const firstReceipt = await person("POST", `/api/groups/${room.id}/messages`, { text: imageText });
    expect((await getGroup())?.working).toBe(true);
    const secondReceipt = await person("POST", `/api/groups/${room.id}/messages`, { text: "and summarize it" });
    writeFileSync(steerFinishGate, "finish");
    expect(firstReceipt.status).toBe(202);
    expect(firstReceipt.body).toMatchObject({ ok: true, queued: true });
    expect(secondReceipt.status).toBe(202);
    expect(secondReceipt.body).toMatchObject({ ok: true, queued: true });

    await waitFor(
      async () => (await getGroup())?.messages.some((m: any) => m.text === "and summarize it"),
      "the coalesced burst to drain",
    );
    await waitFor(async () => (await getGroup())?.working === false, "the burst turn to settle");
    expect(
      (await getGroup())?.messages.filter((m: any) => m.role === "bot" && m.kind === "text" && m.text?.startsWith("echo:")),
    ).toHaveLength(2);

    const followUp = nativeTurn(room.threadId);
    expect(followUp).toBeDefined();
    expect(followUp!.prompt.filter((block) => block.type === "image")).toEqual([
      { type: "image", mimeType: "image/png", data: Buffer.from("room png").toString("base64") },
    ]);
    const textBlock = followUp!.prompt.filter((block) => block.type === "text").map((block) => block.text).join("\n");
    expect(textBlock).toContain("look at the room screenshot");
    expect(textBlock).toContain("and summarize it");
    expect(textBlock).not.toContain("<attached-image");
  }, 40_000);

  it("an engine without a live session preserves the message in the server-side queue", async () => {
    const created = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${created.id}`, { modelSelection: { instanceId: "acp", model: "fixture/test" } });
    expect((await api("POST", `/api/bots/${created.id}/messages`, { text: "first" })).status).toBe(202);
    await waitFor(async () => (await getBot(created.id)).busy === true, "the hung turn to start");
    const person = await asPairedPerson();
    const queued = await person("POST", `/api/bots/${created.id}/messages`, { text: "second" });
    expect(queued.status).toBe(202);
    expect(queued.body.queued).toBe(true);
    expect(typeof queued.body.queueId).toBe("string");
    expect(queued.body.threadId).toBe(created.threadId);
    expect((await getBot(created.id)).messages.some((m: any) => m.text === "second")).toBe(false);
    await api("POST", `/api/bots/${created.id}/interrupt`);
    await waitFor(
      async () => (await getBot(created.id)).messages.some((m: any) => m.text === "second"),
      "the queued message to begin its turn",
    );
    const drained = (await getBot(created.id)).messages.find((m: any) => m.text === "second");
    expect(drained.queueId).toBe(queued.body.queueId);
    expect(drained.sender).toEqual(PAIRED);
    await api("POST", `/api/bots/${created.id}/interrupt`);
    await waitFor(async () => (await getBot(created.id)).busy === false, "the queued turn to settle");
  }, 30_000);

  it("a message waiting for a free slot still names the paired person once it runs", async () => {
    const created = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${created.id}`, { modelSelection: { instanceId: "acp", model: "fixture/test" } });
    const limit = (await api("GET", "/api/config")).body.threads.maxConcurrentPerBot as number;
    const threads: string[] = [created.threadId];
    for (let i = 0; i < limit; i++) {
      threads.push((await api("POST", `/api/bots/${created.id}/tasks`, { title: `Slot ${i + 2}` })).body.task.threadId);
    }
    const waiting = threads.at(-1)!;
    const busy = async () =>
      (await getBot(created.id)).tasks.filter((task: any) => task.busy).map((task: any) => task.threadId) as string[];
    try {
      for (const threadId of threads.slice(0, limit)) {
        expect((await api("POST", `/api/bots/${created.id}/messages`, { threadId, text: "hold a slot" })).status).toBe(202);
      }
      await waitFor(async () => (await busy()).length === limit, "every slot to be taken");

      const person = await asPairedPerson();
      const queued = await person("POST", `/api/bots/${created.id}/messages`, { threadId: waiting, text: "when a slot frees up" });
      expect(queued.status).toBe(202);
      expect(queued.body).toMatchObject({ queued: true, reason: "capacity", threadId: waiting });

      await api("POST", `/api/bots/${created.id}/interrupt`, { threadId: threads[0] });
      const line = async () =>
        (await api("GET", `/api/threads/${waiting}/messages?limit=20`)).body.messages.find((m: any) => m.text === "when a slot frees up");
      await waitFor(async () => Boolean(await line()), "the waiting message to start its turn");
      expect((await line()).sender).toEqual(PAIRED);
    } finally {
      for (const threadId of threads) await api("POST", `/api/bots/${created.id}/interrupt`, { threadId });
      await waitFor(async () => (await busy()).length === 0, "every slot to settle");
    }
  }, 40_000);

  it("an engine without live steering keeps its queue through the steer endpoint, then drains after Stop", async () => {
    const created = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${created.id}`, { modelSelection: { instanceId: "acp", model: "fixture/test" } });
    expect((await api("POST", `/api/bots/${created.id}/messages`, { text: "first" })).status).toBe(202);
    await waitFor(async () => (await getBot(created.id)).busy === true, "the hung turn to start");
    const queued = await api("POST", `/api/bots/${created.id}/messages`, { text: "second" });
    expect(queued.body.queued).toBe(true);

    const still = await api("POST", `/api/bots/${created.id}/queue/${queued.body.queueId}/steer`, {
      threadId: created.threadId,
    });
    expect(still.status).toBe(200);
    expect(still.body).toMatchObject({ ok: true, queued: true });
    expect((await getBot(created.id)).busy).toBe(true);
    expect((await getBot(created.id)).messages.some((m: any) => m.text === "second")).toBe(false);

    await api("POST", `/api/bots/${created.id}/interrupt`);
    await waitFor(
      async () => (await getBot(created.id)).messages.some((m: any) => m.text === "second"),
      "the preserved queue to drain",
    );
    await api("POST", `/api/bots/${created.id}/interrupt`);
    await waitFor(async () => (await getBot(created.id)).busy === false, "the drained turn to settle");
  }, 40_000);

  it("a room whose engine cannot steer keeps its queue, then drains after Stop", async () => {
    const created = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${created.id}`, { modelSelection: { instanceId: "acp", model: "fixture/test" } });
    const room = (await api("POST", "/api/groups", {
      name: "Queue room",
      memberIds: [created.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: created.id } },
    })).body.group;
    const getGroup = async () =>
      (await api("GET", "/api/bots?messages=30")).body.groups.find((g: any) => g.id === room.id);

    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "first" })).status).toBe(202);
    await waitFor(async () => (await getGroup())?.busyBotId === created.id, "the hung room turn to start");
    const person = await asPairedPerson();
    const queued = await person("POST", `/api/groups/${room.id}/messages`, { text: "second" });
    expect(queued.status).toBe(202);
    expect(queued.body).toMatchObject({ ok: true, queued: true });

    const still = await api("POST", `/api/groups/${room.id}/queue/${queued.body.queueId}/steer`, {
      threadId: room.threadId,
    });
    expect(still.status).toBe(200);
    expect(still.body).toMatchObject({ ok: true, queued: true });
    expect((await getGroup())?.working).toBe(true);
    expect((await getGroup())?.messages.some((m: any) => m.text === "second")).toBe(false);

    await api("POST", `/api/groups/${room.id}/interrupt`, {});
    await waitFor(
      async () => (await getGroup())?.messages.some((m: any) => m.text === "second"),
      "the preserved room queue to drain",
    );
    expect((await getGroup())?.messages.find((m: any) => m.text === "second")?.sender).toEqual(PAIRED);
    await api("POST", `/api/groups/${room.id}/interrupt`, {});
    await waitFor(async () => (await getGroup())?.working === false, "the drained room turn to settle");
  }, 40_000);

  it("a queued room attachment refuses the fold and waits for a real turn", async () => {
    const created = (await api("POST", "/api/bots")).body.bot;
    const instances = (await api("GET", "/api/instances")).body.instances;
    const model = instances.find((i: any) => i.instanceId === "questions").models.default;
    await api("PATCH", `/api/bots/${created.id}`, { modelSelection: { instanceId: "questions", model } });
    const room = (await api("POST", "/api/groups", {
      name: "Attachment steer room",
      memberIds: [created.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: created.id } },
    })).body.group;
    const getGroup = async () =>
      (await api("GET", "/api/bots?messages=30")).body.groups.find((g: any) => g.id === room.id);

    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "first room turn" })).status).toBe(202);
    await waitFor(async () => (await getGroup())?.busyBotId === created.id, "the room turn to start");
    await waitFor(async () => (await getGroup())?.messages.some((m: any) => m.card), "the room question card");

    const attachments = join(home, ".quatibot", "attachments");
    mkdirSync(attachments, { recursive: true });
    const imagePath = join(attachments, "123e4567-e89b-42d3-a456-426614174005.png");
    writeFileSync(imagePath, "clip png");
    const imageText = `look at the clip\n\n<attached-image path="${imagePath}" name="clip.png" />`;

    const person = await asPairedPerson();
    const queued = await person("POST", `/api/groups/${room.id}/messages`, { text: imageText });
    expect(queued.body).toMatchObject({ ok: true, queued: true });

    const steered = await api("POST", `/api/groups/${room.id}/queue/${queued.body.queueId}/steer`, {
      threadId: room.threadId,
    });
    expect(steered.status).toBe(200);
    expect(steered.body).toMatchObject({ ok: true, queued: true });
    expect(steered.body.steered).toBeUndefined();
    expect((await getGroup())?.working).toBe(true);
    expect((await getGroup())?.messages.some((m: any) => m.text === imageText)).toBe(false);

    await api("POST", `/api/groups/${room.id}/interrupt`, {});
    await waitFor(
      async () => (await getGroup())?.messages.some((m: any) => m.text === imageText),
      "the attachment line to drain",
    );
    const nativePrompts = () => {
      const rows: Array<{ dir: string; msg?: { method?: string } }> = readFileSync(join(home, ".quatibot", "native", `${room.threadId}.ndjson`), "utf8")
        .trim().split("\n").map((line) => JSON.parse(line));
      return rows.filter((row) => row.dir === "out" && row.msg?.method === "session/prompt");
    };
    await waitFor(async () => nativePrompts().length === 2, "the queued attachment's actual ACP prompt");
    await api("POST", `/api/groups/${room.id}/interrupt`, {});
    await waitFor(async () => (await getGroup())?.working === false, "the drained attachment turn to settle");
    expect(nativePrompts()).toHaveLength(2);
  }, 40_000);

  it("the queue steer endpoint keeps an attachment queued without native steering", async () => {
    const created = (await api("POST", "/api/bots")).body.bot;
    const instances = (await api("GET", "/api/instances")).body.instances;
    const instance = instances.find((i: any) => i.instanceId === "questions");
    expect(instance.capabilities.queueing).toBe(false);
    await api("PATCH", `/api/bots/${created.id}`, { modelSelection: { instanceId: "questions", model: instance.models.default } });

    expect((await api("POST", `/api/bots/${created.id}/messages`, { text: "first codex turn" })).status).toBe(202);
    await waitFor(async () => (await getBot(created.id)).busy === true, "the codex turn to start");
    await waitFor(async () => (await getBot(created.id)).messages.some((m: any) => m.card), "the codex question card");

    const attachments = join(home, ".quatibot", "attachments");
    mkdirSync(attachments, { recursive: true });
    const imagePath = join(attachments, "123e4567-e89b-42d3-a456-426614174008.png");
    writeFileSync(imagePath, "codex png");
    const imageText = `see this\n\n<attached-image path="${imagePath}" name="codex.png" />`;
    const queued = await api("POST", `/api/bots/${created.id}/messages`, { text: imageText });
    expect(queued.status).toBe(202);
    expect(queued.body).toMatchObject({ ok: true, queued: true });

    const still = await api("POST", `/api/bots/${created.id}/queue/${queued.body.queueId}/steer`, {
      threadId: created.threadId,
    });
    expect(still.status).toBe(200);
    expect(still.body).toMatchObject({ ok: true, queued: true });
    expect(still.body.steered).toBeUndefined();
    expect((await getBot(created.id)).busy).toBe(true);
    expect((await getBot(created.id)).messages.some((m: any) => m.text === imageText)).toBe(false);
    const nativeRows = readFileSync(join(home, ".quatibot", "native", `${created.threadId}.ndjson`), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line));
    expect(nativeRows.filter((row) => row.dir === "out" && row.msg?.method === "session/prompt")).toHaveLength(1);

    expect((await api("DELETE", `/api/bots/${created.id}/queue/${queued.body.queueId}`, { threadId: created.threadId })).status).toBe(200);
    await api("POST", `/api/bots/${created.id}/interrupt`);
    await waitFor(async () => (await getBot(created.id)).busy === false, "the codex turn to settle");
  }, 40_000);
});
