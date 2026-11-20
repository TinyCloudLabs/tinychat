#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Bump this one SHA to import a reviewed prompts build.
export const PROMPTS_COMMIT = "208c9b0cfa081bea2b667be0d930ca35f5a874f4";
const SITE_URL = "https://tinycloud.one/agents/abilities";
const PREFIX = "/agents/abilities";
const ROOT_DISCOVERY = ["llms-full.txt", "robots.txt", "sitemap.xml", ".well-known"];

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function prefixed(path) {
  if (/^https?:\/\//.test(path)) return path;
  return `${PREFIX}${path.startsWith("/") ? path : `/${path}`}`;
}

function prefixHeaders(text) {
  return text
    .split("\n")
    .map((line) => (line.startsWith("/") ? prefixed(line) : line))
    .join("\n")
    .trim();
}

function prefixRedirects(text) {
  return text
    .split("\n")
    .map((line) => {
      if (!line.trim() || line.trimStart().startsWith("#")) return line;
      const [source, destination, ...rest] = line.trim().split(/\s+/);
      return [prefixed(source), prefixed(destination), ...rest].join(" ");
    })
    .join("\n")
    .trim();
}

function mergeRedirects(current, generated) {
  const lines = current.trim().split("\n");
  // Generated rules go before an explicit SPA fallback; without one (Pages' implicit SPA mode), they go last.
  const fallback = lines.findIndex((line) => /^\/\*\s+\/index\.html\s+200\s*$/.test(line));
  lines.splice(fallback === -1 ? lines.length : fallback, 0, ...generated.split("\n"));
  return `${lines.join("\n")}\n`;
}

export function installAgentSurface(siteDir, outDir) {
  if (!existsSync(join(siteDir, "llms.txt")) || !existsSync(join(siteDir, "_redirects"))) {
    throw new Error(`${siteDir} is not a built TinyCloud prompts site`);
  }
  if (!existsSync(join(outDir, "index.html"))) throw new Error(`${outDir} is not a built TinyChat frontend`);

  const namespace = join(outDir, "agents", "abilities");
  rmSync(namespace, { recursive: true, force: true });
  mkdirSync(namespace, { recursive: true });
  cpSync(siteDir, namespace, { recursive: true });
  for (const control of ["_headers", "_redirects", "404.html"]) {
    rmSync(join(namespace, control), { force: true });
  }

  for (const path of ROOT_DISCOVERY) {
    cpSync(join(siteDir, path), join(outDir, path), { recursive: true, force: true });
  }

  const skillsIndexPath = join(outDir, ".well-known", "agent-skills", "index.json");
  if (existsSync(skillsIndexPath)) {
    const skillsIndex = JSON.parse(readFileSync(skillsIndexPath, "utf8"));
    for (const skill of skillsIndex.skills ?? []) skill.url = prefixed(skill.url);
    writeFileSync(skillsIndexPath, `${JSON.stringify(skillsIndex, null, 2)}\n`);
  }

  const apiCatalogPath = join(outDir, ".well-known", "api-catalog");
  if (existsSync(apiCatalogPath)) {
    const apiCatalog = JSON.parse(readFileSync(apiCatalogPath, "utf8"));
    const links = apiCatalog.linkset?.[0];
    if (links) {
      links["service-desc"] = [{
        href: "https://tinycloud.one/mcp/server-card",
        type: "application/mcp-server-card+json",
        title: "TinyCloud MCP server card",
      }];
      writeFileSync(apiCatalogPath, `${JSON.stringify(apiCatalog, null, 2)}\n`);
    }
  }

  const rootIndexPath = join(outDir, "llms.txt");
  writeFileSync(
    rootIndexPath,
    `${readFileSync(rootIndexPath, "utf8").trimEnd()}\n\n${readFileSync(join(siteDir, "llms.txt"), "utf8").trimStart()}`,
  );

  const cardPath = join(outDir, "mcp", "server-card");
  for (const alias of [".well-known/mcp.json", ".well-known/mcp/server-card.json"]) {
    const target = join(outDir, alias);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(cardPath, target);
  }

  const catalogPath = join(outDir, ".well-known", "ai-catalog.json");
  const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
  catalog.entries.push({
    identifier: "urn:air:tinycloud.one:mcp:tinycloud",
    type: "application/mcp-server-card+json",
    url: "https://tinycloud.one/mcp/server-card",
  });
  writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);

  const redirectsPath = join(outDir, "_redirects");
  writeFileSync(
    redirectsPath,
    mergeRedirects(readFileSync(redirectsPath, "utf8"), prefixRedirects(readFileSync(join(siteDir, "_redirects"), "utf8"))),
  );

  const headersPath = join(outDir, "_headers");
  const headers = readFileSync(headersPath, "utf8").trimEnd();
  writeFileSync(headersPath, `${headers}\n\n${prefixHeaders(readFileSync(join(siteDir, "_headers"), "utf8"))}\n`);
}

async function buildPrompts() {
  const temp = mkdtempSync(join(tmpdir(), "tinycloud-prompts-"));
  try {
    const archive = join(temp, "prompts.tar.gz");
    const response = await fetch(`https://codeload.github.com/TinyCloudLabs/prompts/tar.gz/${PROMPTS_COMMIT}`);
    if (!response.ok) throw new Error(`prompts download failed: ${response.status} ${response.statusText}`);
    writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
    execFileSync("tar", ["-xzf", archive, "-C", temp]);
    const checkout = join(temp, readdirSync(temp).find((entry) => entry !== basename(archive)) ?? "");
    const env = {
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      SITE_URL,
    };
    execFileSync("npm", ["ci", "--ignore-scripts", "--silent"], { cwd: checkout, env, stdio: "inherit" });
    execFileSync("npm", ["run", "build", "--silent"], { cwd: checkout, env, stdio: "inherit" });
    return { siteDir: join(checkout, "_site"), temp };
  } catch (error) {
    rmSync(temp, { recursive: true, force: true });
    throw error;
  }
}

async function main() {
  const outDir = resolve(argument("--out") ?? fileURLToPath(new URL("../frontend/dist", import.meta.url)));
  const suppliedSite = argument("--site-dir");
  let temp;
  try {
    let siteDir;
    if (suppliedSite) {
      siteDir = resolve(suppliedSite);
    } else {
      const built = await buildPrompts();
      siteDir = built.siteDir;
      temp = built.temp;
    }
    installAgentSurface(siteDir, outDir);
  } finally {
    if (temp) rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
