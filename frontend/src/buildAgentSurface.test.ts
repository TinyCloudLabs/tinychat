import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

describe("TinyCloud agent surface", () => {
  test("installs canonical content without shadowing TinyCloud One routes", () => {
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
    put(site, "chat", "meeting guide");
    put(site, "feed", "feed guide");
    put(site, "skills/feed/SKILL.md", "feed skill");
    put(site, "_headers", "/*\n  X-Agent-Test: yes\n\n/feed\n  Content-Type: text/markdown\n");
    put(site, "_redirects", "/feed.md /feed 301\n/chat.md /chat 301\n");

    put(out, "index.html", "tinycloud one app");
    put(out, "llms.txt", "tinycloud one index");
    put(out, "mcp/server-card", '{"name":"xyz.tinycloud/mcp"}\n');
    put(out, "_headers", "/version.json\n  Cache-Control: no-store\n");
    put(out, "_redirects", "/agents /agents/ 301\n/agents/* /agents/:splat 200\n/* /index.html 200\n");

    installAgentSurface(site, out);

    expect(readFileSync(join(out, "index.html"), "utf8")).toBe("tinycloud one app");
    expect(readFileSync(join(out, "llms.txt"), "utf8")).toBe("tinycloud one index\n\nagent index");
    expect(readFileSync(join(out, "llms-full.txt"), "utf8")).toBe("agent full text");
    expect(readFileSync(join(out, "agents/abilities/feed"), "utf8")).toBe("feed guide");
    expect(readFileSync(join(out, ".well-known/mcp.json"), "utf8")).toBe('{"name":"xyz.tinycloud/mcp"}\n');

    const catalog = JSON.parse(readFileSync(join(out, ".well-known/ai-catalog.json"), "utf8"));
    expect(catalog.entries).toEqual([{
      identifier: "urn:air:tinycloud.one:mcp:tinycloud",
      type: "application/mcp-server-card+json",
      url: "https://tinycloud.one/mcp/server-card",
    }]);

    const redirects = readFileSync(join(out, "_redirects"), "utf8").trim().split("\n");
    expect(redirects).toEqual([
      "/agents /agents/ 301",
      "/agents/* /agents/:splat 200",
      "/agents/abilities/feed.md /agents/abilities/feed 301",
      "/agents/abilities/chat.md /agents/abilities/chat 301",
      "/* /index.html 200",
    ]);
    expect(redirects.some((line) => line.startsWith("/feed") || line.startsWith("/chat"))).toBe(false);

    const headers = readFileSync(join(out, "_headers"), "utf8");
    expect(headers).toContain("/agents/abilities/*\n  X-Agent-Test: yes");
    expect(headers).toContain("/agents/abilities/feed\n  Content-Type: text/markdown");
    expect(headers).toContain("/version.json\n  Cache-Control: no-store");
  });
});
