import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { installAgentSurface } from "../../scripts/build-agent-surface.mjs";

function put(root: string, path: string, content: string) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

test("installs current prompts discovery documents at the origin root", () => {
  const root = mkdtempSync(join(tmpdir(), "tinychat-agent-discovery-"));
  try {
    const site = join(root, "site");
    const out = join(root, "dist");

    put(site, "llms.txt", "agent index");
    put(site, "llms-full.txt", "agent full text");
    put(site, "robots.txt", "User-agent: *\nAllow: /\n");
    put(site, "sitemap.xml", "<urlset />\n");
    put(site, ".well-known/api-catalog", '{"linkset":[{"anchor":"https://tinycloud.one/agents/abilities/","service-doc":[{"href":"https://docs.tinycloud.xyz/cli/mcp"}]}]}\n');
    put(site, ".well-known/ai-catalog.json", '{"specVersion":"1.0","entries":[]}\n');
    put(site, ".well-known/agent-skills/index.json", '{"skills":[{"name":"feed","url":"/skills/feed/SKILL.md"}]}\n');
    put(site, "_headers", "/*\n  X-Agent-Test: yes\n");
    put(site, "_redirects", "");

    put(out, "index.html", "tinycloud one app");
    put(out, "llms.txt", "tinycloud one index");
    put(out, "mcp/server-card", '{"name":"xyz.tinycloud/mcp"}\n');
    put(out, "_headers", "");
    put(out, "_redirects", "/* /index.html 200\n");

    installAgentSurface(site, out);

    const apiCatalog = JSON.parse(readFileSync(join(out, ".well-known/api-catalog"), "utf8"));
    expect(apiCatalog.linkset[0]["service-desc"]).toEqual([{
      href: "https://tinycloud.one/mcp/server-card",
      type: "application/mcp-server-card+json",
      title: "TinyCloud MCP server card",
    }]);

    const skills = JSON.parse(readFileSync(join(out, ".well-known/agent-skills/index.json"), "utf8"));
    expect(skills.skills[0].url).toBe("/agents/abilities/skills/feed/SKILL.md");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
