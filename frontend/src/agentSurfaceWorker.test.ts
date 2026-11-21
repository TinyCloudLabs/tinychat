import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import worker from "../public/_worker.js";

const publicDir = join(dirname(fileURLToPath(import.meta.url)), "../public");

describe("TinyCloud agent routes", () => {
  test("limits the Worker to discovery routes", () => {
    const routesPath = join(publicDir, "_routes.json");
    expect(existsSync(routesPath)).toBe(true);
    expect(JSON.parse(readFileSync(routesPath, "utf8"))).toEqual({
      version: 1,
      include: [
        "/",
        "/robots.txt",
        "/sitemap.xml",
        "/llms.txt",
        "/llms-full.txt",
        "/auth.md",
        "/mcp/server-card",
        "/.well-known/*",
      ],
      exclude: [],
    });
  });

  test("publishes the hosted MCP authentication metadata", () => {
    const metadataPath = join(publicDir, ".well-known/oauth-protected-resource");
    expect(existsSync(metadataPath)).toBe(true);
    expect(JSON.parse(readFileSync(metadataPath, "utf8"))).toEqual({
      resource: "https://mcp.tinycloud.xyz/mcp",
      authorization_servers: ["https://api.openkey.so/api/auth"],
      scopes_supported: ["tinycloud:mcp"],
      resource_name: "TinyCloud hosted MCP",
      resource_documentation: "https://docs.tinycloud.xyz/cli/mcp",
      bearer_methods_supported: ["header"],
    });
    const auth = readFileSync(join(publicDir, "auth.md"), "utf8");
    expect(auth).toContain(
      "The protected resource is the hosted MCP at https://mcp.tinycloud.xyz/mcp.",
    );
    expect(auth).toContain("https://api.openkey.so/.well-known/oauth-authorization-server/api/auth");
  });

  test("negotiates Markdown and advertises discovery links", async () => {
    const assets = {
      fetch(request: Request) {
        const path = new URL(request.url).pathname;
        if (path === "/llms.txt") return new Response("# TinyCloud One\n", { headers: { "Content-Type": "text/plain" } });
        return new Response("<!doctype html><title>TinyCloud</title>", { headers: { "Content-Type": "text/html" } });
      },
    };

    const markdown = await worker.fetch(
      new Request("https://tinycloud.one/", { headers: { Accept: "text/markdown" } }),
      { ASSETS: assets },
    );
    expect(markdown.status).toBe(200);
    expect(markdown.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
    expect(await markdown.text()).toBe("# TinyCloud One\n");

    const html = await worker.fetch(new Request("https://tinycloud.one/"), { ASSETS: assets });
    expect(html.status).toBe(200);
    expect(html.headers.get("Link")).toContain('rel="llms-txt"');
    expect(html.headers.get("Link")).toContain('rel="api-catalog"');
    expect(html.headers.get("Link")).toContain('rel="service-desc"');
  });

  test("serves discovery assets but never turns missing discovery paths into the SPA", async () => {
    const assets = {
      fetch(request: Request) {
        const path = new URL(request.url).pathname;
        if (path === "/robots.txt") {
          return new Response("User-agent: *\nAllow: /\n", { headers: { "Content-Type": "text/plain" } });
        }
        return new Response("<!doctype html><title>TinyCloud</title>", { headers: { "Content-Type": "text/html" } });
      },
    };

    const robots = await worker.fetch(new Request("https://tinycloud.one/robots.txt"), { ASSETS: assets });
    expect(robots.status).toBe(200);
    expect(robots.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");

    const missing = await worker.fetch(new Request("https://tinycloud.one/.well-known/missing"), { ASSETS: assets });
    expect(missing.status).toBe(404);
    expect(missing.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(await missing.text()).toBe("Not found\n");
  });

  test("redirects OAuth authorization-server discovery to the issuer metadata", async () => {
    const response = await worker.fetch(
      new Request("https://tinycloud.one/.well-known/oauth-authorization-server"),
      { ASSETS: { fetch: () => new Response(null, { status: 404 }) } },
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      "https://api.openkey.so/.well-known/oauth-authorization-server/api/auth",
    );
  });

  test("redirects A2A discovery to the TinyCloud discovery agent", async () => {
    const response = await worker.fetch(
      new Request("https://tinycloud.one/.well-known/agent-card.json"),
      { ASSETS: { fetch: () => new Response("<!doctype html>", { headers: { "Content-Type": "text/html" } }) } },
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      "https://tinycloud.xyz/.well-known/agent-card.json",
    );
  });
});
