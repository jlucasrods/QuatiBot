import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { HELP } from "../control-quati.ts";

const root = fileURLToPath(new URL("../..", import.meta.url));
const docs = join(root, "docs");
const site = join(root, "apps/docs/content/docs");
const files = [docs, site].flatMap(directory => readdirSync(directory, { recursive: true, encoding: "utf8" })
  .filter(name => /\.mdx?$/.test(name))
  .map(name => join(directory, name)));

it.each(files)("resolves local documentation links in %s", file => {
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(/\]\(([^\s)]+)\)/g)) {
    const href = match[1].split("#")[0];
    if (!href || /^[a-z]+:/i.test(href)) continue;

    const target = href.startsWith("/docs")
      ? join(site, `${href.replace(/^\/docs\/?/, "") || "index"}.mdx`)
      : resolve(dirname(file), href);
    const directoryIndex = href.startsWith("/docs") ? join(target.replace(/\.mdx$/, ""), "index.mdx") : "";
    expect(existsSync(target) || Boolean(directoryIndex && existsSync(directoryIndex)), `${file}: ${href}`).toBe(true);
  }
});

it("keeps the documentation navigation attached to real pages", () => {
  const metadata = readdirSync(site, { recursive: true, encoding: "utf8" }).filter(name => name.endsWith("meta.json"));
  for (const name of metadata) {
    const file = join(site, name);
    const data: { pages: string[] } = JSON.parse(readFileSync(file, "utf8"));
    for (const page of data.pages) {
      expect(existsSync(join(dirname(file), `${page}.mdx`)) || existsSync(join(dirname(file), page, "meta.json")), `${name}: ${page}`).toBe(true);
    }
  }
});

it("uses fixture verbs supported by the control CLI", () => {
  const guide = readFileSync(join(docs, "verification/README.md"), "utf8");
  const verbs = new Set([...HELP.matchAll(/^ {2}([a-z][\w-]*)(?= |$)/gm)].map(match => match[1]));
  const commands = [...guide.matchAll(/pnpm control:quati ([a-z][\w-]*)/g)];
  expect(commands.length).toBeGreaterThan(0);
  for (const command of commands) expect(verbs.has(command[1]), command[1]).toBe(true);
});

it("cites executable verification sources", () => {
  const guide = readFileSync(join(docs, "verification/README.md"), "utf8");
  const references = [...guide.matchAll(/`((?:server|scripts)\/[\w./-]+\.(?:ts|mjs))`/g)];
  expect(references.length).toBeGreaterThan(0);
  for (const reference of references) expect(existsSync(join(root, reference[1])), reference[1]).toBe(true);
});
