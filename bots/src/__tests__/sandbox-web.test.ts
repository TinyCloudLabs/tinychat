import { describe, expect, test } from "bun:test";
import { gatewayConfig, PINNED_WEB_API } from "../config";
import { configYml, mcpJson } from "../sandbox";

describe("the sandbox's agent config for web access", () => {
  test("one MCP server, the gateway's own route on the egress socket, authorised by the bot's token variable", () => {
    const servers = JSON.parse(mcpJson()).mcpServers as Record<string, { type: string; url: string; headers: Record<string, string> }>;
    expect(Object.keys(servers)).toEqual(["web", "app"]);
    expect(servers.web).toMatchObject({ type: "http", url: "http://127.0.0.1:8080/v1/mcp", headers: { Authorization: "Bearer ${BOT_TOKEN}" } });
  });

  test("the agent's own search and fetch tools are off, since the sandbox has no network", () => {
    expect(configYml()).toContain("web_search:\n  enabled: false");
    expect(configYml()).toContain("fetch:\n  enabled: false");
  });
});

describe("the gateway's provider setting", () => {
  const env = { REDPILL_API_KEY: "m" };

  test("is pinned; a mock may only be on loopback; no key reads as absent", () => {
    expect(gatewayConfig(env).web).toMatchObject({ apiUrl: PINNED_WEB_API, key: undefined, botDailySearches: 100, botDailyPages: 300 });
    expect(gatewayConfig({ ...env, TAVILY_API_KEY: " k " }).web?.key).toBe("k");
    expect(gatewayConfig({ ...env, BOTS_TEST_WEB_URL: "http://127.0.0.1:9/" }).web?.apiUrl).toBe("http://127.0.0.1:9");
    for (const bad of ["https://127.0.0.1:9", "http://example.com", "http://10.0.0.1"]) {
      expect(() => gatewayConfig({ ...env, BOTS_TEST_WEB_URL: bad })).toThrow("loopback");
    }
  });
});
