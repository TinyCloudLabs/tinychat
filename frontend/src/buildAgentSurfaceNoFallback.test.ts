import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { installAgentSurface } from "../../scripts/build-agent-surface.mjs";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function put(root: string, path: string, content: string) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

// The app's _redirects has no `/* /index.html 200` line (TC-3471 relies on Pages' own SPA handling so missing
// build files return 404). The agent rules must still be added, last, and no fallback line invented.
test("adds the agent redirects when the app has no explicit SPA fallback", () => {
  const root = mkdtempSync(join(tmpdir(), "tinychat-agent-surface-"));
  roots.push(root);
  const site = join(root, "site");
  const out = join(root, "dist");

  put(site, "index.html", "agent landing");
  put(site, "llms.txt", "agent index");
  put(site, "llms-full.txt", "agent full text");
  put(site, "robots.txt", "Sitemap: https://tinycloud.one/agents/abilities/sitemap.xml\n");
  put(site, "sitemap.xml", "<urlset />\n");
  put(site, ".well-known/api-catalog", "{}\n");
  put(site, ".well-known/ai-catalog.json", '{"specVersion":"1.0","entries":[]}\n');
  put(site, "_headers", "/feed\n  Content-Type: text/markdown\n");
  put(site, "_redirects", "/feed.md /feed 301\n");

  put(out, "index.html", "tinycloud one app");
  put(out, "llms.txt", "tinycloud one index");
  put(out, "mcp/server-card", '{"name":"xyz.tinycloud/mcp"}\n');
  put(out, "_headers", "/version.json\n  Cache-Control: no-store\n");
  put(out, "_redirects", "/agents /agents/ 301\n/agents/* /agents/:splat 200\n");

  installAgentSurface(site, out);

  expect(readFileSync(join(out, "_redirects"), "utf8").trim().split("\n")).toEqual([
    "/agents /agents/ 301",
    "/agents/* /agents/:splat 200",
    "/agents/abilities/feed.md /agents/abilities/feed 301",
  ]);
});
