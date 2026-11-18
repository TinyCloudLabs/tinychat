import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const script = new URL("../build-agent-surface.mjs", import.meta.url);

function put(root, path, content) {
  const target = join(root, path);
  mkdirSync(new URL(".", `file://${target}`).pathname, { recursive: true });
  writeFileSync(target, content);
}

test("installs the canonical agent site without shadowing TinyCloud One routes", () => {
  const root = mkdtempSync(join(tmpdir(), "tinychat-agent-surface-"));
  const site = join(root, "site");
  const out = join(root, "dist");

  try {
    put(site, "index.html", "agent landing");
    put(site, "llms.txt", "agent index");
    put(site, "llms-full.txt", "agent full text");
    put(site, "robots.txt", "Sitemap: https://tinycloud.one/agents/abilities/sitemap.xml\n");
    put(site, "sitemap.xml", "<urlset />\n");
    put(site, ".well-known/api-catalog", "{}\n");
    put(site, ".well-known/ai-catalog.json", "{\"specVersion\":\"1.0\",\"entries\":[]}\n");
    put(site, "chat", "meeting guide");
    put(site, "feed", "feed guide");
    put(site, "skills/feed/SKILL.md", "feed skill");
    put(site, "_headers", "/*\n  X-Agent-Test: yes\n\n/feed\n  Content-Type: text/markdown\n");
    put(site, "_redirects", "/feed.md /feed 301\n/chat.md /chat 301\n");

    put(out, "index.html", "tinycloud one app");
    put(out, "llms.txt", "tinycloud one index");
    put(out, "mcp/server-card", "{\"name\":\"xyz.tinycloud/mcp\"}\n");
    put(out, "_headers", "/version.json\n  Cache-Control: no-store\n");
    put(out, "_redirects", "/agents /agents/ 301\n/agents/* /agents/:splat 200\n/* /index.html 200\n");

    execFileSync(process.execPath, [script.pathname, "--site-dir", site, "--out", out]);

    assert.equal(readFileSync(join(out, "index.html"), "utf8"), "tinycloud one app");
    assert.equal(readFileSync(join(out, "llms.txt"), "utf8"), "tinycloud one index\n\nagent index");
    assert.equal(readFileSync(join(out, "llms-full.txt"), "utf8"), "agent full text");
    assert.equal(readFileSync(join(out, "agents/abilities/index.html"), "utf8"), "agent landing");
    assert.equal(readFileSync(join(out, "agents/abilities/chat"), "utf8"), "meeting guide");
    assert.equal(readFileSync(join(out, "agents/abilities/feed"), "utf8"), "feed guide");
    assert.equal(readFileSync(join(out, ".well-known/mcp.json"), "utf8"), "{\"name\":\"xyz.tinycloud/mcp\"}\n");
    assert.equal(readFileSync(join(out, ".well-known/mcp/server-card.json"), "utf8"), "{\"name\":\"xyz.tinycloud/mcp\"}\n");
    const catalog = JSON.parse(readFileSync(join(out, ".well-known/ai-catalog.json"), "utf8"));
    assert.deepEqual(catalog.entries, [{
      identifier: "urn:air:tinycloud.one:mcp:tinycloud",
      type: "application/mcp-server-card+json",
      url: "https://tinycloud.one/mcp/server-card",
    }]);

    const redirects = readFileSync(join(out, "_redirects"), "utf8").trim().split("\n");
    assert.deepEqual(redirects, [
      "/agents /agents/ 301",
      "/agents/* /agents/:splat 200",
      "/agents/abilities/feed.md /agents/abilities/feed 301",
      "/agents/abilities/chat.md /agents/abilities/chat 301",
      "/* /index.html 200",
    ]);
    assert.equal(redirects.some((line) => line.startsWith("/feed") || line.startsWith("/chat")), false);

    const headers = readFileSync(join(out, "_headers"), "utf8");
    assert.match(headers, /\/agents\/abilities\/\*\n  X-Agent-Test: yes/);
    assert.match(headers, /\/agents\/abilities\/feed\n  Content-Type: text\/markdown/);
    assert.match(headers, /\/version\.json\n  Cache-Control: no-store/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
