import { describe, expect, it } from "vitest";

import {
  checkSentinelInstall, launchdPlist, sentinelCommand, sentinelLaunchdPlist, sentinelServicePlan, sentinelSystemdService, sentinelSystemdTimer,
  sentinelUnitCommand, serviceCommand, servicePlan, shippedSentinelCli, systemdUnit, unstableInstallWarning, type ServiceSpec,
} from "./service-unit.ts";

const spec: ServiceSpec = {
  node: "/usr/bin/node",
  script: "/usr/lib/node_modules/quatibot/cli.js",
  serveArgs: ["--port", "8799", "--data-dir", "/home/quati/.quatibot", "--domain", "quati.example.com", "--no-pair"],
  dataDir: "/home/quati/.quatibot",
  user: "quati",
  home: "/home/quati",
  bindsLowPorts: true,
  label: "agentada",
};

describe("service units", () => {
  it("runs the same serve command, with strip-types only for a checkout", () => {
    expect(serviceCommand(spec)).toEqual(["/usr/bin/node", "/usr/lib/node_modules/quatibot/cli.js", "serve", ...spec.serveArgs]);
    expect(serviceCommand({ ...spec, script: "/srv/QuatiBot/server/quatibot.ts" })[1]).toBe("--experimental-strip-types");
  });

  it("renders a systemd unit that restarts, runs as the user, and grants low ports only for --domain", () => {
    const unit = systemdUnit(spec);
    expect(unit).toContain("Description=QuatiBot (agentada)");
    expect(unit).toContain("User=quati");
    expect(unit).toContain("Environment=QUATI_DATA_DIR=/home/quati/.quatibot");
    expect(unit).toContain("ExecStart=/usr/bin/node /usr/lib/node_modules/quatibot/cli.js serve --port 8799 --data-dir /home/quati/.quatibot --domain quati.example.com --no-pair");
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("AmbientCapabilities=CAP_NET_BIND_SERVICE");
    expect(unit).toContain("WantedBy=multi-user.target");
    const local = systemdUnit({ ...spec, bindsLowPorts: false, serveArgs: ["--port", "8799", "--data-dir", "/home/quati/.quatibot"] });
    expect(local).not.toContain("CAP_NET_BIND_SERVICE");
    expect(systemdUnit({ ...spec, dataDir: "/home/quati/My Data", serveArgs: ["--data-dir", "/home/quati/My Data"] })).toContain('ExecStart=/usr/bin/node /usr/lib/node_modules/quatibot/cli.js serve --data-dir "/home/quati/My Data"');
  });

  it("renders a launchd agent that keeps the server alive and logs under the data dir", () => {
    const plist = launchdPlist({ ...spec, home: "/Users/quati", dataDir: "/Users/quati/.quatibot" });
    expect(plist).toContain("<string>com.quatibot.serve</string>");
    expect(plist).toContain("<string>/usr/bin/node</string>");
    expect(plist).toContain("<string>serve</string>");
    expect(plist).toContain("<string>quati.example.com</string>");
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("/Users/quati/.quatibot/logs/service.log");
    expect(launchdPlist({ ...spec, serveArgs: ["--label", "a & b <c>"] })).toContain("<string>a &amp; b &lt;c&gt;</string>");
  });

  it("refuses to point a service at an npx cache, and knows where each platform's file goes", () => {
    expect(unstableInstallWarning("/home/quati/.npm/_npx/abc123/node_modules/quatibot/cli.js")).toMatch(/persistent checkout or local build/);
    expect(unstableInstallWarning("/usr/lib/node_modules/quatibot/cli.js")).toBeNull();
    const linux = servicePlan("linux", "/home/quati/.quatibot");
    expect(linux?.installed).toBe("/etc/systemd/system/quatibot.service");
    expect(linux?.activate.join("\n")).toContain("systemctl enable --now quatibot");
    const mac = servicePlan("darwin", "/Users/quati/.quatibot", "/Users/quati");
    expect(mac?.installed).toBe("/Users/quati/Library/LaunchAgents/com.quatibot.serve.plist");
    expect(mac?.activate.join("\n")).toContain("launchctl bootstrap gui/$(id -u)");
    expect(servicePlan("win32", "C:\\x")).toBeNull();
  });

  it("renders Sentinel as a launchd agent on an interval, under its own label, logging outside the data dir", () => {
    const out = "/Users/quati/Library/Application Support/quatibot-sentinel";
    const sentinel = { node: "/usr/bin/node", script: "/usr/lib/node_modules/quatibot/cli.js", dataDir: "/Users/quati/.quatibot", home: "/Users/quati", out };
    expect(sentinelCommand(sentinel)).toEqual(["/usr/bin/node", "/usr/lib/node_modules/quatibot/cli.js", "sentinel", "--once", "--data-dir", "/Users/quati/.quatibot", "--out", out]);
    expect(sentinelCommand({ ...sentinel, script: "/srv/QuatiBot/server/quatibot.ts" })[1]).toBe("--experimental-strip-types");
    const plist = sentinelLaunchdPlist(sentinel);
    expect(plist).toContain("<string>com.quatibot.sentinel</string>");
    expect(plist).toContain("<key>StartInterval</key>\n\t<integer>120</integer>");
    expect(plist).toContain("<string>sentinel</string>");
    expect(plist).not.toContain("KeepAlive");
    expect(plist).toContain(`<string>${out}/sentinel.log</string>`);
    expect(plist).not.toContain(".quatibot/logs");
    const mac = sentinelServicePlan("darwin", out, "/Users/quati");
    expect(mac?.files).toEqual([{ name: "com.quatibot.sentinel.plist", installed: "/Users/quati/Library/LaunchAgents/com.quatibot.sentinel.plist" }]);
    // a path with a space is one argument in the printed commands
    expect(mac?.activate[0]).toBe("mkdir -p /Users/quati/Library/LaunchAgents && cp '/Users/quati/Library/Application Support/quatibot-sentinel/com.quatibot.sentinel.plist' /Users/quati/Library/LaunchAgents/com.quatibot.sentinel.plist");
    expect(mac?.deactivate[0]).toBe("launchctl bootout gui/$(id -u)/com.quatibot.sentinel");
  });

  it("renders Sentinel as a systemd user timer, with no root", () => {
    const sentinel = { node: "/usr/bin/node", script: "/usr/lib/node_modules/quatibot/cli.js", dataDir: "/home/quati/My Data", home: "/home/quati", out: "/home/quati/.local/state/quatibot-sentinel" };
    const unit = sentinelSystemdService(sentinel);
    expect(unit).toContain("Type=oneshot");
    expect(unit).toContain('ExecStart=/usr/bin/node /usr/lib/node_modules/quatibot/cli.js sentinel --once --data-dir "/home/quati/My Data" --out /home/quati/.local/state/quatibot-sentinel');
    expect(unit).not.toContain("User=");
    expect(sentinelSystemdTimer()).toContain("OnUnitActiveSec=120s");
    expect(sentinelSystemdTimer()).toContain("WantedBy=timers.target");
    const linux = sentinelServicePlan("linux", sentinel.out, "/home/quati");
    expect(linux?.files.map((file) => file.installed)).toEqual(["/home/quati/.config/systemd/user/quatibot-sentinel.service", "/home/quati/.config/systemd/user/quatibot-sentinel.timer"]);
    expect(linux?.activate[0]).toContain("cp /home/quati/.local/state/quatibot-sentinel/quatibot-sentinel.service");
    expect(linux?.activate.join("\n")).toContain("systemctl --user enable --now quatibot-sentinel.timer");
    expect(linux?.activate.join("\n")).not.toContain("sudo");
    expect(sentinelServicePlan("win32", "C:\\x")).toBeNull();
  });

  it("finds the CLI the installed desktop app ships, and runs it as Node", () => {
    const app = "/Applications/QuatiBot.app/Contents";
    const present = new Set([`${app}/MacOS/QuatiBot`, `${app}/Resources/server/quatibot.js`]);
    expect(shippedSentinelCli("darwin", "/Users/quati", (path) => present.has(path))).toEqual({ node: `${app}/MacOS/QuatiBot`, script: `${app}/Resources/server/quatibot.js` });
    const user = "/Users/quati/Applications/QuatiBot.app/Contents";
    expect(shippedSentinelCli("darwin", "/Users/quati", (path) => path.startsWith(user))?.script).toBe(`${user}/Resources/server/quatibot.js`);
    expect(shippedSentinelCli("linux", "/home/quati", (path) => path.startsWith("/opt/QuatiBot/"))).toEqual({ node: "/opt/QuatiBot/quatibot", script: "/opt/QuatiBot/resources/server/quatibot.js" });
    // an app with its script missing, or one released before Sentinel, is no CLI for it
    expect(shippedSentinelCli("darwin", "/Users/quati", (path) => path.endsWith("MacOS/QuatiBot"))).toBeNull();
    expect(shippedSentinelCli("darwin", "/Users/quati", (path) => present.has(path), () => false)).toBeNull();
    expect(shippedSentinelCli("win32", "C:\\Users\\quati", () => true)).toBeNull();

    const spec = { node: `${app}/MacOS/QuatiBot`, script: `${app}/Resources/server/quatibot.js`, dataDir: "/Users/quati/.quatibot", home: "/Users/quati", out: "/tmp/s", electronRunAsNode: true };
    expect(sentinelLaunchdPlist(spec)).toContain("<key>ELECTRON_RUN_AS_NODE</key>\n\t\t<string>1</string>");
    expect(sentinelSystemdService(spec)).toContain("Environment=ELECTRON_RUN_AS_NODE=1");
    expect(sentinelLaunchdPlist({ ...spec, electronRunAsNode: false })).not.toContain("ELECTRON_RUN_AS_NODE");
  });

  it("keeps every path one quoted value in the systemd unit, and refuses one no unit can hold", () => {
    const spec = { node: "/usr/bin/node", script: "/srv/quati/cli.js", dataDir: "/home/quati/100% $HOME\\", home: "/home/my quati", out: "/home/my quati/.local/state/quatibot-sentinel" };
    const unit = sentinelSystemdService(spec);
    expect(unit).toContain('Environment="HOME=/home/my quati"');
    // % is no specifier, $ no variable, and the trailing backslash no continuation
    expect(unit).toContain('"/home/quati/100%% $$HOME\\\\"');
    expect(sentinelUnitCommand(unit)).toEqual({ node: "/usr/bin/node", script: "/srv/quati/cli.js" });
    expect(sentinelUnitCommand(sentinelSystemdService({ ...spec, script: "/srv/100% $x/cli.js" }))?.script).toBe("/srv/100% $x/cli.js");
    for (const bad of ["/home/quati\n[Service]\nExecStartPre=/bin/true", "/home/quati\r", "/home/\0quati"]) {
      expect(() => sentinelSystemdService({ ...spec, home: bad })).toThrow(/line break or NUL/);
      expect(() => sentinelLaunchdPlist({ ...spec, dataDir: bad })).toThrow(/line break or NUL/);
    }
  });

  it("reads back what an installed unit runs, and calls it stale when either path is gone", () => {
    const spec = { node: "/opt/node & co/bin/node", script: "/srv/quati/cli.js", dataDir: "/home/quati/My Data", home: "/home/quati", out: "/home/quati/.local/state/quatibot-sentinel" };
    expect(sentinelUnitCommand(sentinelLaunchdPlist(spec))).toEqual({ node: "/opt/node & co/bin/node", script: "/srv/quati/cli.js" });
    expect(sentinelUnitCommand(sentinelSystemdService(spec))).toEqual({ node: "/opt/node & co/bin/node", script: "/srv/quati/cli.js" });
    expect(sentinelUnitCommand("[Service]\nType=oneshot\n")).toBeNull();

    const unit = "/home/quati/.config/systemd/user/quatibot-sentinel.service";
    const timer = "/home/quati/.config/systemd/user/quatibot-sentinel.timer";
    const files = new Map([[unit, sentinelSystemdService(spec)]]);
    const fs = (present: string[]) => ({ exists: (path: string) => files.has(path) || present.includes(path), read: (path: string) => files.get(path)! });
    expect(checkSentinelInstall("linux", "/home/quati", fs([spec.node, spec.script, timer]))).toMatchObject({ status: "ok", unit });
    expect(checkSentinelInstall("linux", "/home/quati", fs([spec.node, timer]))).toMatchObject({ status: "stale", missing: ["/srv/quati/cli.js"] });
    // the service without its timer never runs
    expect(checkSentinelInstall("linux", "/home/quati", fs([spec.node, spec.script]))).toMatchObject({ status: "stale", missing: [timer] });
    expect(checkSentinelInstall("darwin", "/Users/quati", fs([]))).toEqual({ status: "not_installed", unit: "/Users/quati/Library/LaunchAgents/com.quatibot.sentinel.plist" });
    files.set(unit, "garbage");
    expect(checkSentinelInstall("linux", "/home/quati", fs([]))).toEqual({ status: "unreadable", unit });
    expect(checkSentinelInstall("win32", "C:\\Users\\quati", fs([]))).toEqual({ status: "unsupported" });
  });
});
