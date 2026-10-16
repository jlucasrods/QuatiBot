import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { OpenCodeExtensions, OpenCodeMcpServer } from "../shared/opencode-mcp.ts";
import { execCli } from "./procs.ts";

const documents = z.array(z.object({
  type: z.string(),
  path: z.string().optional(),
  info: z.object({
    mcp: z.object({ servers: z.record(z.string(), z.object({
      type: z.enum(["local", "remote"]), disabled: z.boolean().optional(),
    }).passthrough()).optional() }).optional(),
    plugins: z.array(z.union([z.string(), z.object({ package: z.string() })])).optional(),
    skills: z.array(z.string()).optional(),
  }).optional(),
}));

function globalDocuments(entries: unknown, configDirectory: string) {
  const parsed = documents.safeParse(entries);
  if (!parsed.success) throw new Error("OpenCode returned an unsupported configuration response.");
  const paths = new Set(["opencode.json", "opencode.jsonc"].map((file) => resolve(configDirectory, file)));
  return parsed.data.filter((entry) => entry.type === "document" && entry.path && paths.has(resolve(entry.path)));
}

export function globalMcpConfigFromEntries(entries: unknown, configDirectory: string) {
  return Object.fromEntries(globalDocuments(entries, configDirectory).flatMap((entry) => Object.entries(entry.info?.mcp?.servers ?? {})));
}

export function globalMcpServersFromEntries(entries: unknown, configDirectory: string): OpenCodeMcpServer[] {
  return Object.entries(globalMcpConfigFromEntries(entries, configDirectory))
    .map(([name, server]) => ({ name, type: server.type, status: server.disabled ? "disabled" as const : "configured" as const }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function openCodeApi(cli: string, cwd: string, path: string, env = process.env): Promise<unknown> {
  const stdout = await new Promise<string>((resolve, reject) => {
    execCli(cli, ["api", "get", path], {
      cwd, env: { ...env, OPENCODE_DISABLE_PROJECT_CONFIG: "1" }, timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
    }, (error, output) => {
      if (error) reject(new Error("Could not read global extensions from OpenCode V2."));
      else resolve(output);
    });
  });
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error("OpenCode returned an unsupported configuration response.");
  }
}

export function openCodeConfigDirectory(env = process.env): string {
  const home = env.HOME || env.USERPROFILE || homedir();
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), "opencode");
}

export async function listOpenCodeGlobalMcpServers(cli: string, cwd: string): Promise<OpenCodeMcpServer[]> {
  return globalMcpServersFromEntries(await openCodeApi(cli, cwd, "/api/config"), openCodeConfigDirectory());
}

export function globalExtensionMetadata(entries: unknown, skills: unknown, plugins: unknown, configDirectory: string, home: string, cwd: string): OpenCodeExtensions {
  const globals = globalDocuments(entries, configDirectory);
  const skillRoots = [join(configDirectory, "skills"), join(home, ".claude", "skills"), join(home, ".agents", "skills")];
  const pluginNames = new Set<string>();
  for (const entry of globals) {
    for (const plugin of entry.info?.plugins ?? []) pluginNames.add(typeof plugin === "string" ? plugin : plugin.package);
    for (const source of entry.info?.skills ?? []) {
      if (!/^https?:\/\//u.test(source)) skillRoots.push(resolve(cwd, source.startsWith("~/") ? join(home, source.slice(2)) : source));
    }
  }

  const availablePlugins = z.object({ data: z.array(z.object({ source: z.object({ type: z.string(), path: z.string().optional() }) })) }).parse(plugins);
  for (const plugin of availablePlugins.data) {
    if (plugin.source.type === "local" && plugin.source.path) {
      const rest = relative(join(configDirectory, "plugins"), plugin.source.path);
      if (rest && !rest.startsWith(`..${sep}`) && rest !== ".." && !isAbsolute(rest)) pluginNames.add(plugin.source.path);
    }
  }

  const availableSkills = z.object({ data: z.array(z.object({ id: z.string(), name: z.string(), path: z.string() })) }).parse(skills);
  return {
    servers: globalMcpServersFromEntries(entries, configDirectory),
    plugins: [...pluginNames].map((target) => {
      const name = /^[a-z]+:\/\//iu.test(target) ? basename(new URL(target).pathname.replace(/\/$/u, ""))
        : target.startsWith("/") || target.startsWith(".")
        ? basename(target.replace(/\/$/u, ""))
        : target.replace(/@[^/@]+$/u, "");
      return { name };
    }).sort((a, b) => a.name.localeCompare(b.name)),
    skills: availableSkills.data.filter((skill) => skillRoots.some((root) => {
      const rest = relative(root, skill.path);
      return rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest);
    })).map(({ id, name }) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export async function listOpenCodeGlobalExtensions(cli: string, cwd: string): Promise<OpenCodeExtensions> {
  const [entries, skills, plugins] = await Promise.all([
    openCodeApi(cli, cwd, "/api/config"), openCodeApi(cli, cwd, "/api/skill"), openCodeApi(cli, cwd, "/api/plugin"),
  ]);
  return globalExtensionMetadata(entries, skills, plugins, openCodeConfigDirectory(), process.env.HOME || homedir(), cwd);
}
