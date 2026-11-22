import { describe, expect, test } from "bun:test";
import { utcDay } from "../asks";
import { type GatewayConfig, PINNED_FETCH_URL, PINNED_UPSTREAM, PINNED_WEB_API } from "../config";
import { Gateway } from "../gateway";
import { ALLOWED_TOOLS, type McpServer, NEVER, neverRoute, neverTool, servedTools } from "../tool-policy";

const BOT = "a".repeat(64);
const TOKEN = "1".repeat(64);
const NOW = Date.parse("2026-11-22T12:00:00Z");

const cfg = (): GatewayConfig => ({
  egressRoot: "/egress", modelKey: "model-key", upstream: PINNED_UPSTREAM, models: ["m"], maxTokens: 100, botDailyTokens: 1000,
  globalDailyTokens: 1500, maxBodyBytes: 4096, maxResponseBytes: 1024 * 1024, connectTimeoutMs: 1000, totalTimeoutMs: 5000,
  bodyTimeoutMs: 30_000, budgetFile: "/unused",
  web: { key: "web-key", apiUrl: PINNED_WEB_API, botDailySearches: 3, botDailyPages: 2, globalDailySearches: 100, globalDailyPages: 100, timeoutMs: 1000, fetchUrl: PINNED_FETCH_URL, fetchTimeoutMs: 1000 },
});

function setup() {
  const upstreamCalls: string[] = [];
  const gateway = new Gateway(cfg(), { fetch: async url => (upstreamCalls.push(url), Response.json({ results: [] })), now: () => NOW });
  gateway.setToken(BOT, TOKEN);
  gateway.setAsks(BOT, { enabled: true, pending: 0, day: utcDay(NOW), today: 0, declined: [] });
  return { gateway, upstreamCalls };
}

let rpcId = 0;
const rpc = (path: string, method: string, params?: unknown) =>
  new Request(`http://localhost${path}`, {
    method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
type Reply = { result?: { tools?: Array<{ name: string }> }; error?: { code: number; message: string } };
const PATHS: Record<McpServer, string> = { web: "/v1/mcp", app: "/v1/mcp/app" };
const SERVERS = Object.keys(PATHS) as McpServer[];

describe("the gateway's tool allow-list", () => {
  test("tools/list offers only allow-listed tools, in their order", async () => {
    const { gateway } = setup();
    for (const server of SERVERS) {
      const listed = ((await (await gateway.handle(BOT, rpc(PATHS[server], "tools/list"))).json()) as Reply).result!.tools!.map(tool => tool.name);
      expect(listed.length).toBeGreaterThan(0);
      for (const name of listed) expect(ALLOWED_TOOLS[server]).toContain(name);
    }
    const offered = [{ name: "ask_owner" }, { name: "billing_checkout" }, { name: "search" }, { name: "request_secret" }];
    expect(servedTools("app", offered).map(tool => tool.name)).toEqual(["ask_owner", "request_secret"]);
    expect(servedTools("web", offered).map(tool => tool.name)).toEqual(["search"]);
  });

  test("tools/call refuses a name off the server's list before dispatch, and nothing leaves the gateway", async () => {
    const { gateway, upstreamCalls } = setup();
    const refused: Array<[McpServer, unknown]> = [
      ["app", "billing_checkout"], ["app", "set_web_access"], ["app", "search"], ["app", "ASK_OWNER"], ["app", undefined],
      ["web", "ask_owner"], ["web", "fetch_secret"], ["web", "call_with_secret"], ["web", ["search"]],
    ];
    for (const [server, name] of refused) {
      const body = (await (await gateway.handle(BOT, rpc(PATHS[server], "tools/call", { name, arguments: { query: "x", question: "x" } }))).json()) as Reply;
      expect(body.error).toEqual({ code: -32602, message: "Unknown tool" });
    }
    expect(gateway.drainAsks(BOT)).toEqual([]);
    expect(upstreamCalls).toEqual([]);
  });
});

describe("the never-list", () => {
  test("no allow-listed tool is on it", () => {
    for (const server of SERVERS) for (const name of ALLOWED_TOOLS[server]) expect({ server, name, never: neverTool(name) }).toEqual({ server, name, never: undefined });
  });

  test("catches a tool for each category", () => {
    const named = [
      "billing_checkout", "open_billing_portal", "create_delegation", "grant_agent_access", "disconnect_connector", "connect_google",
      "store_credential", "delete_account", "set_app_lock", "unlock", "set_web_access", "get_secret_value", "reveal_secret", "read_api_key",
    ];
    for (const name of named) expect({ name, caught: neverTool(name) !== undefined }).toEqual({ name, caught: true });
    expect(new Set(named.map(neverTool)).size).toBe(NEVER.length);
  });

  test("leaves the read and request tools later steps add", () => {
    const planned = [
      "find_meetings", "read_meeting", "search_transcripts", "list_meeting_actions", "propose_action", "list_feed_cards", "read_card",
      "list_chats", "read_chat", "list_bots", "calendar_status", "connector_status", "billing_status",
    ];
    for (const name of planned) expect({ name, never: neverTool(name) }).toEqual({ name, never: undefined });
  });

  test("matches routes by method and path prefix, in any case", () => {
    expect(neverRoute("POST", "/api/billing/checkout")).toBe("billing checkout and portal");
    expect(neverRoute("post", "/API/Billing/Portal?x=1")).toBe("billing checkout and portal");
    expect(neverRoute("GET", "/api/billing/status")).toBeUndefined();
    expect(neverRoute("DELETE", "/api/exo/v1/grant")).toBe("delegations and agent access");
    expect(neverRoute("POST", "/api/connectors/credentials/fireflies/oauth/start")).toBe("connector sign-in and credentials");
    expect(neverRoute("GET", "/api/connectors/credentials/fireflies")).toBeUndefined();
    expect(neverRoute("PUT", "/api/bots/main/web")).toBe("the bot's Web access setting");
    expect(neverRoute("GET", "/api/bots/main/webhooks")).toBeUndefined();
  });
});
