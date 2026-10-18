import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyStartupPreferences, formatSessions, parseArgs, runOnboardingCommand, serverEntry, type CliOptions } from "./cli.ts";
import { browserSignInLines, pairingBlock, qrToString } from "./cli-pairing.ts";
import { SetupCancelled } from "./cli-prompts.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const setup = vi.hoisted(() => ({ runSetup: vi.fn(), isSetupComplete: vi.fn(), readCliStartup: vi.fn(), saveCliStartup: vi.fn() }));
vi.mock("./cli-setup.ts", () => setup);
describe("quatibot command line", () => {
    it("parses commands and flags, and explains mistakes", () => {
        const serve = parseArgs(["serve", "--port", "9001", "--data-dir", "/tmp/x", "--label", "cab mini", "--tailscale", "--no-pair"], {});
        // --data-dir is resolved against the platform: C:\tmp\x on Windows.
        expect(serve).toMatchObject({ command: "serve", port: 9001, dataDir: resolve("/tmp/x"), label: "cab mini", tailscale: true, pair: false });
        expect(parseArgs(["pair", "--client", "--public-url", "https://h/"], {})).toMatchObject({ command: "pair", client: true, publicUrl: "https://h" });
        expect(parseArgs(["sessions", "revoke", "abc"], {})).toMatchObject({ command: "sessions", revoke: "abc" });
        expect(parseArgs([], { QUATI_PORT: "8123" })).toMatchObject({ command: "start", port: 8123 });
        expect(parseArgs(["--port", "8125", "--no-open", "--local"], {})).toMatchObject({ command: "start", port: 8125, open: false, local: true });
        expect(parseArgs(["--help"], {})).toMatchObject({ command: "help" });
        expect(parseArgs(["-h"], {})).toMatchObject({ command: "help" });
        expect(parseArgs(["dance"], {})).toEqual({ error: 'unknown command "dance"' });
        expect(parseArgs(["serve", "--port"], {})).toEqual({ error: "--port needs a value" });
        expect(parseArgs(["serve", "--port", "70000"], {})).toEqual({ error: "--port must be 1-65535" });
        expect(parseArgs(["pair", "--public-url", "mini.example"], {})).toEqual({ error: "--public-url must start with http:// or https://" });
        expect(parseArgs(["serve", "--bogus"], {})).toEqual({ error: 'unknown argument "--bogus"' });
        expect(parseArgs(["setup", "--data-dir", "/tmp/cli-setup"], {})).toMatchObject({ command: "setup", dataDir: resolve("/tmp/cli-setup") });
        expect(parseArgs(["start", "--port", "8125", "--no-pair"], {})).toMatchObject({ command: "start", port: 8125, pair: false });
        expect(parseArgs(["browser", "install", "--with-deps"], {})).toMatchObject({ command: "browser", browserAction: "install", withDeps: true });
        expect(parseArgs(["browser", "status"], {})).toMatchObject({ command: "browser", browserAction: "status" });
        expect(parseArgs(["browser"], {})).toEqual({ error: "browser needs an action: install or status" });
        expect(parseArgs(["service", "install", "--domain", "quati.example.com", "--port", "8799"], {})).toMatchObject({ command: "service", serviceAction: "install", domain: "quati.example.com", port: 8799 });
        expect(parseArgs(["service", "uninstall"], {})).toMatchObject({ command: "service", serviceAction: "uninstall" });
        expect(parseArgs(["service", "install", "--sentinel"], {})).toMatchObject({ command: "service", serviceAction: "install", sentinel: true });
        expect(parseArgs(["serve", "--sentinel"], {})).toEqual({ error: expect.stringContaining("--sentinel") });
        expect(parseArgs(["service"], {})).toEqual({ error: expect.stringContaining("service needs one of") });
        expect(parseArgs(["serve", "--domain", "Quati.Example.com"], {})).toMatchObject({ command: "serve", domain: "quati.example.com" });
        expect(parseArgs(["serve", "--domain", "localhost"], {})).toEqual({ error: expect.stringContaining("bare hostname") });
    });
    it("prints a scannable block with the link, or says where to type the code", () => {
        const block = pairingBlock({ code: "ABCD-EFGH-JKLM", url: "https://mini.example/pair#code=ABCD-EFGH-JKLM", expiresAt: Date.now() + 60000 });
        expect(block).toContain("pairing code:  ABCD-EFGH-JKLM");
        expect(block).toContain("open or scan:  https://mini.example/pair#code=ABCD-EFGH-JKLM");
        expect(block).toMatch(/[▀▄█]/);
        const noUrl = pairingBlock({ code: "ABCD-EFGH-JKLM", url: null, expiresAt: Date.now(), hint: "set QUATI_PUBLIC_URL" });
        expect(noUrl).toContain("/pair on the address you use");
        expect(noUrl).toContain("set QUATI_PUBLIC_URL");
        expect(qrToString("https://example.com").length).toBeGreaterThan(200);
    });
    it("adds a link that signs in a browser on this computer, which is no longer the owner by being here", () => {
        const local = "http://127.0.0.1:8799/pair#code=ABCD-EFGH-JKLM";
        const block = pairingBlock({ code: "ABCD-EFGH-JKLM", url: null, localUrl: local, expiresAt: Date.now() + 60000, hint: "set QUATI_PUBLIC_URL" });
        expect(block).toContain(`this computer: ${local}`);
        expect(block).toContain("/pair on the address you use");
        expect(block).not.toContain(qrToString(local));
        const guided = browserSignInLines(local, "ABCD-EFGH-JKLM", Date.now() + 60000);
        expect(guided).toContain(local);
        expect(guided).toContain("ABCD-EFGH-JKLM");
        expect(guided).toContain("quatibot pair");
    });
    it("lists sessions as a table with relative last-seen times", () => {
        const now = Date.parse("2026-09-05T12:00:00Z");
        const table = formatSessions([
            { id: "a1", label: "My MacBook", scopes: ["admin", "client"], lastSeenAt: now - 30000, expiresAt: now + 86400000 },
            { id: "b2", label: "", scopes: ["client"], lastSeenAt: now - 3 * 3600000, expiresAt: now + 86400000 },
        ], now);
        expect(table).toContain("My MacBook");
        expect(table).toContain("(unnamed)");
        expect(table).toMatch(/a1\s+My MacBook\s+admin\s+just now/);
        expect(table).toMatch(/b2\s+\(unnamed\)\s+client\s+3 h ago/);
        expect(table).toContain("sessions revoke <id>");
    });
    it("finds the server next to itself: bundled index.js in a package, the TypeScript source in a checkout", () => {
        const checkout = serverEntry(SERVER_DIR);
        expect(checkout.args[0]).toBe("--experimental-strip-types");
        expect(checkout.args[1]).toBe(join(SERVER_DIR, "index.ts"));
        expect(checkout.skillsDir).toBe(join(SERVER_DIR, "..", "skills"));
    });
    it("serve: starts the server, prints the pairing link, and stops on SIGTERM", async () => {
        const home = mkdtempSync(join(tmpdir(), "quati-cli-serve-"));
        const port = 21000 + Math.floor(Math.random() * 9000);
        const child = spawn(process.execPath, ["--experimental-strip-types", join(SERVER_DIR, "quatibot.ts"), "serve", "--port", String(port), "--data-dir", join(home, "data"), "--label", "cli test", "--public-url", "https://mini.example"], {
            cwd: join(SERVER_DIR, ".."),
            env: { PATH: process.env.PATH ?? "", HOME: home, USERPROFILE: home, QUATI_WEBHOOK_PORT: String(port + 1), QUATI_BROWSER_CONNECTION: join(home, "browser-connection.json") },
            stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        child.stdout.on("data", (c) => (out += String(c)));
        child.stderr.on("data", (c) => (out += String(c)));
        try {
            const deadline = Date.now() + 60000;
            while (!out.includes("open or scan:") && Date.now() < deadline && child.exitCode === null)
                await new Promise((r) => setTimeout(r, 200));
            expect(out).toContain(`QuatiBot is running on http://127.0.0.1:${port}, reachable at https://mini.example`);
            expect(out).toMatch(/pairing code:  [A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}/);
            expect(out).toContain("open or scan:  https://mini.example/pair#code=");
            expect(out).toMatch(/[▀▄█]/);
            const descriptor: any = await (await fetch(`http://127.0.0.1:${port}/.well-known/quatibot/environment`)).json();
            expect(descriptor.label).toBe("cli test");
            const pairing: any = await (await fetch(`http://127.0.0.1:${port}/api/auth/pairing`)).json();
            expect(pairing.pairings.length).toBeGreaterThanOrEqual(1);
        }
        finally {
            child.kill("SIGTERM");
            await waitForExit(child, { signal: "SIGTERM" });
            await removeTempDir(home);
        }
        let dead = false;
        try {
            await fetch(`http://127.0.0.1:${port}/api/health`);
        }
        catch {
            dead = true;
        }
        expect(dead).toBe(true);
    }, 90000);
});
describe("terminal onboarding commands", () => {
    const inputTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    const outputTty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    const terminal = (enabled: boolean) => {
        Object.defineProperty(process.stdin, "isTTY", { value: enabled, configurable: true });
        Object.defineProperty(process.stdout, "isTTY", { value: enabled, configurable: true });
    };
    afterEach(() => {
        if (inputTty)
            Object.defineProperty(process.stdin, "isTTY", inputTty);
        else
            Reflect.deleteProperty(process.stdin, "isTTY");
        if (outputTty)
            Object.defineProperty(process.stdout, "isTTY", outputTty);
        else
            Reflect.deleteProperty(process.stdout, "isTTY");
        vi.unstubAllEnvs();
        vi.resetAllMocks();
    });
    const command = (name: "setup" | "start") => parseArgs([name, "--data-dir", join(process.env.HOME!, "onboarding"), "--port", "18451"], {}) as CliOptions;
    const io = () => ({ log: vi.fn(), error: vi.fn(), ask: vi.fn() });
    const preserveEnv = () => vi.stubEnv("QUATI_DATA_DIR", process.env.QUATI_DATA_DIR);
    const running = vi.fn().mockResolvedValue(false);
    const open = vi.fn().mockResolvedValue(true);
    const flow = { running, open };
    beforeEach(() => {
        running.mockResolvedValue(false);
        open.mockResolvedValue(true);
    });
    it("runs explicit setup once and explains how to start without launching a server", async () => {
        terminal(true);
        preserveEnv();
        const options = command("setup");
        const output = io();
        const serve = vi.fn();
        setup.runSetup.mockImplementation(async () => {
            expect(process.env.QUATI_DATA_DIR).toBe(options.dataDir);
            return true;
        });
        expect(await runOnboardingCommand(options, output, serve, flow)).toBe(0);
        expect(setup.runSetup).toHaveBeenCalledWith({ dataDir: options.dataDir, port: options.port });
        expect(setup.isSetupComplete).not.toHaveBeenCalled();
        expect(serve).not.toHaveBeenCalled();
        expect(output.log).toHaveBeenCalledWith(expect.stringContaining("Start with: quatibot"));
    });
    it("starts after first-time setup and passes through the requested serve options", async () => {
        terminal(true);
        preserveEnv();
        const options = command("start");
        setup.isSetupComplete.mockResolvedValue(false);
        setup.runSetup.mockResolvedValue(true);
        const serve = vi.fn().mockResolvedValue(0);
        expect(await runOnboardingCommand(options, io(), serve, flow)).toBe(0);
        expect(setup.runSetup).toHaveBeenCalledOnce();
        expect(serve).toHaveBeenCalledWith({ ...options, guided: true });
    });
    it("uses completed setup without prompting even when start has no terminal", async () => {
        terminal(false);
        preserveEnv();
        setup.isSetupComplete.mockResolvedValue(true);
        const serve = vi.fn().mockResolvedValue(7);
        expect(await runOnboardingCommand(command("start"), io(), serve, flow)).toBe(7);
        expect(setup.runSetup).not.toHaveBeenCalled();
        expect(serve).toHaveBeenCalledOnce();
    });
    it.each(["setup", "start"] as const)("refuses an unconfigured %s without a terminal", async (name) => {
        terminal(false);
        preserveEnv();
        setup.isSetupComplete.mockResolvedValue(false);
        const output = io();
        const serve = vi.fn();
        expect(await runOnboardingCommand(command(name), output, serve, flow)).toBe(1);
        expect(setup.runSetup).not.toHaveBeenCalled();
        expect(serve).not.toHaveBeenCalled();
        expect(output.error).toHaveBeenCalledWith(expect.stringContaining("interactive terminal"));
    });
    it.each([false, new SetupCancelled()])("does not start after setup is cancelled (%s)", async (result) => {
        terminal(true);
        preserveEnv();
        setup.isSetupComplete.mockResolvedValue(false);
        if (result instanceof Error)
            setup.runSetup.mockRejectedValue(result);
        else
            setup.runSetup.mockResolvedValue(result);
        const serve = vi.fn();
        expect(await runOnboardingCommand(command("start"), io(), serve, flow)).toBe(130);
        expect(serve).not.toHaveBeenCalled();
    });
    it("reopens an already-running workspace without setup, pairing, or a second server", async () => {
        terminal(true);
        preserveEnv();
        running.mockResolvedValue(true);
        const serve = vi.fn();
        expect(await runOnboardingCommand(command("start"), io(), serve, flow)).toBe(0);
        expect(open).toHaveBeenCalledWith(18451);
        expect(setup.runSetup).not.toHaveBeenCalled();
        expect(serve).not.toHaveBeenCalled();
    });
    it("honors --no-pair and --no-open without saving an access choice", async () => {
        terminal(true);
        preserveEnv();
        setup.isSetupComplete.mockResolvedValue(true);
        const serve = vi.fn().mockResolvedValue(0);
        await runOnboardingCommand({ ...command("start"), pair: false, open: false }, io(), serve, flow);
        expect(setup.saveCliStartup).not.toHaveBeenCalled();
        expect(serve).toHaveBeenCalledWith(expect.objectContaining({ pair: false, open: false }));
    });
    it("does not claim --local changed an already-running public workspace", async () => {
        terminal(true);
        preserveEnv();
        running.mockResolvedValue(true);
        const output = io();
        const serve = vi.fn();
        expect(await runOnboardingCommand({ ...command("start"), local: true }, output, serve, flow)).toBe(1);
        expect(output.error).toHaveBeenCalledWith(expect.stringContaining("current connection was not changed"));
        expect(open).not.toHaveBeenCalled();
        expect(serve).not.toHaveBeenCalled();
    });
});
describe("saved startup access", () => {
    const options = () => parseArgs([], {}) as CliOptions;
    it("keeps local launches local and supports a one-time local override", () => {
        expect(applyStartupPreferences(options(), { access: "local" })).toMatchObject({ tailscale: false, publicUrl: undefined });
        expect(applyStartupPreferences({ ...options(), local: true }, { access: "tunnel", phone: "ios" })).toMatchObject({});
    });
    it("explicit route flags take priority over saved settings", () => {
        expect(applyStartupPreferences({ ...options(), tailscale: true }, { access: "tunnel" })).toMatchObject({ tailscale: true });
    });
    it("refuses a saved URL that embeds a credential or points to localhost", () => {
        for (const publicUrl of ["https://localhost", "https://user:secret@example.com", "https://example.com/pair#code=secret"])
            expect(() => applyStartupPreferences(options(), { access: "public-url", publicUrl })).toThrow("not a valid HTTPS origin");
    });
});
const exited = (child: ChildProcess) => (child.exitCode !== null ? Promise.resolve(child.exitCode) : new Promise<number | null>((done) => child.once("exit", (code) => done(code))));
describe.skipIf(process.platform === "win32")("serve --domain", () => {
    it("runs a managed Caddy for the domain and serves the pairing link there", async () => {
        const home = mkdtempSync(join(tmpdir(), "quati-cli-domain-"));
        const dataDir = join(home, "data");
        mkdirSync(dataDir, { recursive: true });
        const fake = join(home, "fake-caddy");
        writeFileSync(fake, `#!/bin/sh\necho "$@" > "${join(home, "caddy-args.txt")}"\necho $$ > "${join(home, "caddy.pid")}"\nexec sleep 300\n`, { mode: 0o755 });
        const port = 21000 + Math.floor(Math.random() * 9000);
        const child = spawn(process.execPath, ["--experimental-strip-types", join(SERVER_DIR, "quatibot.ts"), "serve", "--domain", "quati.example.test", "--port", String(port), "--data-dir", dataDir], {
            cwd: join(SERVER_DIR, ".."),
            env: { PATH: process.env.PATH ?? "", HOME: home, USERPROFILE: home, QUATI_WEBHOOK_PORT: String(port + 1), QUATI_BROWSER_CONNECTION: join(home, "browser-connection.json"), QUATI_CADDY_PATH: fake },
            stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        child.stdout?.on("data", (chunk) => (out += String(chunk)));
        child.stderr?.on("data", (chunk) => (out += String(chunk)));
        try {
            const deadline = Date.now() + 60000;
            while (!out.includes("open or scan:") && Date.now() < deadline && child.exitCode === null)
                await new Promise((r) => setTimeout(r, 200));
            expect(out).toContain(`QuatiBot is running on http://127.0.0.1:${port}, reachable at https://quati.example.test`);
            expect(out).toContain("https: Caddy serves https://quati.example.test");
            expect(out).toContain("open or scan:  https://quati.example.test/pair#code=");
            const args = readFileSync(join(home, "caddy-args.txt"), "utf8").trim();
            expect(args).toMatch(/^run --config .*Caddyfile --adapter caddyfile$/);
            const caddyfile = readFileSync(join(dataDir, "caddy", "Caddyfile"), "utf8");
            expect(caddyfile).toContain("quati.example.test {");
            expect(caddyfile).toContain(`reverse_proxy 127.0.0.1:${port}`);
            expect(caddyfile).toContain(`reverse_proxy 127.0.0.1:${port + 1}`);
        }
        finally {
            // Cleanup must not mask the real failure: a server that never reached
            // the Caddy step has no pid file, and the assertions above already
            // named what actually went wrong.
            const caddyPid = existsSync(join(home, "caddy.pid")) ? Number(readFileSync(join(home, "caddy.pid"), "utf8").trim() || "0") : 0;
            child.kill("SIGTERM");
            await exited(child);
            await new Promise((r) => setTimeout(r, 300));
            if (caddyPid)
                expect(() => process.kill(caddyPid, 0)).toThrow();
            await removeTempDir(home);
        }
    }, 120000);
});
