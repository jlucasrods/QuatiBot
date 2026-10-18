import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
const compose = parse(readFileSync(new URL("../deploy/docker-compose.yml", import.meta.url), "utf8"));
const caddy = readFileSync(new URL("../deploy/Caddyfile", import.meta.url), "utf8");

describe("Linux container deployment", () => {
  it("installs the pinned OpenCode V2 CLI and checks its major version", () => {
    expect(dockerfile).toContain("ARG OPENCODE_VERSION=2.0.31");
    expect(dockerfile).toContain("@opencode/cli@${OPENCODE_VERSION}");
    expect(dockerfile).toContain("opencode --version | grep -E '^opencode v?2\\.'");
    expect(dockerfile).toContain('CMD ["node", "dist-server/server-launcher.js"]');
  });

  it("ships the compiled web app, native data modules, browser and video encoder", () => {
    for (const path of ["/src/dist-native/duckdb/linux-x64 ./duckdb", "/src/dist-server ./dist-server", "/src/dist ./dist"]) {
      expect(dockerfile).toContain(`COPY --from=build ${path}`);
    }
    expect(dockerfile).toContain("AGENT_BROWSER_EXECUTABLE_PATH=/opt/quatibot-browser/chrome");
    expect(dockerfile).toContain("ffmpeg");
    expect(dockerfile).toContain("USER quati");
    expect(dockerfile).toContain("COPY LICENSE NOTICE LICENSING.md ./");
    expect(dockerfile).toContain("COPY third_party/ ./third_party/");
  });

  it("persists the user's home and publishes only the loopback edge by default", () => {
    expect(compose.services.quati.volumes).toEqual(["data:/data"]);
    expect(compose.services.quati.ports).toEqual([
      "${QUATI_BIND_ADDRESS:-127.0.0.1}:${QUATI_HTTP_PORT:-8080}:80",
      "${QUATI_BIND_ADDRESS:-127.0.0.1}:${QUATI_HTTPS_PORT:-8443}:443",
    ]);
    expect(compose.services.caddy.network_mode).toBe("service:quati");
    expect(compose.services.caddy.depends_on.quati.condition).toBe("service_healthy");
    expect(compose.services.caddy.depends_on.quati.restart).toBe(true);
    expect(compose.services.caddy.environment.QUATI_SITE).toBe("${QUATI_SITE:-:80}");
    expect(compose.services.caddy.volumes).toContain("caddy_data:/data");
  });

  it("routes hooks and unbuffered app traffic to their private listeners", () => {
    expect(caddy).toContain("{$QUATI_SITE}");
    expect(caddy).toContain("handle /hooks/*");
    expect(caddy).toContain("reverse_proxy 127.0.0.1:8800");
    expect(caddy).toContain("reverse_proxy 127.0.0.1:8799");
    expect(caddy).toContain("flush_interval -1");
  });

  it("builds the application locally instead of pulling a published image", () => {
    expect(compose.services.quati.build.context).toBe("..");
    expect(compose.services.quati.image).toBe("quatibot:local");
    expect(compose.services.quati.pull_policy).toBe("build");
  });
});
