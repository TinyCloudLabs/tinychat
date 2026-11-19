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


const ARD_MANIFEST = {
  specVersion: "1.0",
  host: {
    displayName: "TinyCloud",
    identifier: "https://tinycloud.one/",
  },
  entries: [
    {
      identifier: "urn:air:tinycloud.one:mcp:hosted",
      displayName: "TinyCloud hosted MCP",
      type: "application/mcp-server-card+json",
      url: "https://tinycloud.one/mcp/server-card",
      representativeQueries: [
        "What tools are available from the hosted TinyCloud MCP?",
        "How can a client connect to the hosted TinyCloud MCP?",
      ],
    },
    {
      identifier: "urn:air:tinycloud.one:a2a:discovery",
      displayName: "TinyCloud Discovery Agent",
      type: "application/a2a-agent-card+json",
      url: "https://tinycloud.one/.well-known/agent-card.json",
      representativeQueries: [
        "Where are TinyCloud's public documentation and protocol links?",
        "Which public TinyCloud discovery resources are available?",
      ],
    },
    {
      identifier: "urn:air:tinycloud.one:api:catalog",
      displayName: "TinyCloud API catalog",
      type: "application/linkset+json",
      url: "https://tinycloud.one/.well-known/api-catalog",
      representativeQueries: [
        "Which public TinyCloud service descriptions are available?",
        "Where is the TinyCloud MCP server card?",
      ],
    },
    {
      identifier: "urn:air:tinycloud.one:skills:index",
      displayName: "TinyCloud Agent Skills Index",
      type: "application/agent-skills+json",
      url: "https://tinycloud.one/.well-known/agent-skills/index.json",
      representativeQueries: [
        "Which public TinyCloud agent skills are available?",
        "Where are the TinyCloud agent skill definitions?",
      ],
    },
  ],
};
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
    put(site, ".well-known/api-catalog", '{"linkset":[{"anchor":"https://tinycloud.one/agents/abilities/","service-doc":[{"href":"https://docs.tinycloud.xyz/cli/mcp"}]}]}\n');
    put(site, ".well-known/ai-catalog.json", '{"specVersion":"1.0","entries":[]}\n');
    put(site, ".well-known/agent-skills/index.json", '{"skills":[{"name":"feed","url":"/skills/feed/SKILL.md"}]}\n');
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
    put(out, ".well-known/ard.json", `${JSON.stringify(ARD_MANIFEST, null, 2)}\n`);

    installAgentSurface(site, out);

    expect(readFileSync(join(out, "index.html"), "utf8")).toBe("tinycloud one app");
    expect(readFileSync(join(out, "llms.txt"), "utf8")).toBe("tinycloud one index\n\nagent index");
    expect(readFileSync(join(out, "llms-full.txt"), "utf8")).toBe("agent full text");
    expect(readFileSync(join(out, "agents/abilities/feed"), "utf8")).toBe("feed guide");
    expect(readFileSync(join(out, ".well-known/mcp.json"), "utf8")).toBe('{"name":"xyz.tinycloud/mcp"}\n');

    const catalog = JSON.parse(readFileSync(join(out, ".well-known", "ai-catalog.json"), "utf8"));
    expect(catalog).toEqual(ARD_MANIFEST);
    const ard = JSON.parse(readFileSync(join(out, ".well-known", "ard.json"), "utf8"));
    expect(ard).toEqual(ARD_MANIFEST);
    const apiCatalog = JSON.parse(readFileSync(join(out, ".well-known/api-catalog"), "utf8"));
    expect(apiCatalog.linkset[0]["service-desc"]).toEqual([{
      href: "https://tinycloud.one/mcp/server-card",
      type: "application/mcp-server-card+json",
      title: "TinyCloud MCP server card",
    }]);

    const skills = JSON.parse(readFileSync(join(out, ".well-known/agent-skills/index.json"), "utf8"));
    expect(skills.skills[0].url).toBe("/agents/abilities/skills/feed/SKILL.md");

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
