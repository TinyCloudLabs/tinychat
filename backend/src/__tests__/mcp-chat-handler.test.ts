import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import type { Request, Response } from "express";
import { _resetCache } from "../billing/stripe.js";
import { _resetCatalogCache } from "../billing/catalog.js";
import { _resetUsage } from "../billing/usage.js";
import { mcpChatFromEnv } from "../mcp-meetings/config.js";
import { createAgentChatHandler } from "../routes/agent-chat.js";
import type { AgentChatConfig } from "../routes/agent-chat.js";

const ADDRESS = "0xabc0000000000000000000000000000000000001";
const OTHER = "0xdef0000000000000000000000000000000000002";
const OWNER_DID = `did:pkh:eip155:1:${ADDRESS}`;
const ORIGINAL_ENV = { ...process.env };

const sse = (frames: unknown[]): AsyncIterable<Uint8Array> => {
  const enc = new TextEncoder();
  return { async *[Symbol.asyncIterator]() { for (const f of frames) yield enc.encode(`data: ${JSON.stringify(f)}\n\n`); yield enc.encode("data: [DONE]\n\n"); } };
};

function makeReqRes(address: string) {
  let statusCode = 200;
  const jsonResponses: Array<{ status: number; body: unknown }> = [];
  const written: string[] = [];
  let ended = false;
  let flushed = false;
  const req = Object.assign(new EventEmitter(), { user: { address }, body: { messages: [{ role: "user", content: "what is in the news and when was my planning meeting?" }], model: "phala/gpt-oss-120b" } }) as unknown as Request;
  const res = Object.assign(new EventEmitter(), {
    destroyed: false,
    destroy() { this.destroyed = true; this.emit("close"); return this; },
    status(code: number) { statusCode = code; return res; },
    json(body: unknown) { jsonResponses.push({ status: statusCode, body }); return res; },
    setHeader() { return res; },
    flushHeaders() { flushed = true; },
    write(chunk: string | Uint8Array) { written.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk)); return true; },
    end() { ended = true; this.emit("finish"); },
    chunks: written,
  }) as unknown as Response & { chunks: string[]; lastJson: { status: number; body: unknown } | undefined };
  Object.defineProperties(res, {
    statusCode: { get: () => statusCode, configurable: true },
    writableEnded: { get: () => ended, configurable: true },
    writableFinished: { get: () => ended, configurable: true },
    headersSent: { get: () => flushed, configurable: true },
    lastJson: { get: () => jsonResponses[jsonResponses.length - 1], configurable: true },
  });
  return { req, res };
}

interface Calls { eliza: string[]; mcpTools: string[]; mcpOwners: string[]; tavily: unknown[]; modelBodies: Array<{ messages: Array<{ role: string; content: string }>; tools?: Array<{ function: { name: string } }> }> }

function setup(options: { grant: "active" | "none"; mcpAccounts?: string; elizaServiceUrl?: string }) {
  const calls: Calls = { eliza: [], mcpTools: [], mcpOwners: [], tavily: [], modelBodies: [] };
  let round = 0;
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://eliza.test")) { calls.eliza.push(url); return Response.json({ status: "active", transcriptStatus: "active", revision: "r1" }); }
    if (url.startsWith("https://api.tavily.com")) {
      calls.tavily.push(JSON.parse(init!.body as string));
      return Response.json({ answer: "A public answer.", results: [{ title: "T", url: "https://example.com/a", content: "snippet" }] });
    }
    if (url.startsWith("https://mcp.test")) {
      const body = JSON.parse(init!.body as string) as { params: { name: string; arguments: { sql?: string } } };
      calls.mcpTools.push(body.params.name);
      calls.mcpOwners.push(new Headers(init?.headers).get("x-test-owner") ?? "");
      if (options.grant === "none") return Response.json({ error: "native_grant_required" }, { status: 401 });
      const sql = body.params.arguments.sql ?? "";
      const rows = /FROM connector_meeting/.test(sql) ? [] : [[1]];
      return Response.json({ jsonrpc: "2.0", id: 1, result: { structuredContent: { status: "ok", output: { columns: [], rows } } } });
    }
    // RedPill: first round asks for web_search and a meeting tool, second round answers.
    calls.modelBodies.push(JSON.parse(init!.body as string));
    round += 1;
    const delta = round === 1
      ? { tool_calls: [
        { index: 0, id: "c1", function: { name: "web_search", arguments: '{"query":"news"}' } },
        ...(options.grant === "active" ? [{ index: 1, id: "c2", function: { name: "tinycloud_find_meetings", arguments: '{"title":"Planning"}' } }] : []),
      ] }
      : { content: "Answer." };
    return { ok: true, status: 200, body: sse([{ choices: [{ delta, finish_reason: round === 1 ? "tool_calls" : "stop" }] }, { choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } }]) } as unknown as Response;
  }) as unknown as typeof fetch;
  const mcp = mcpChatFromEnv({
    MCP_CHAT_ENABLED: "true", MCP_CHAT_URL: "https://mcp.test/mcp", MCP_CHAT_SERVICE_CREDENTIAL: "credential-with-plenty-of-entropy-for-tests",
    MCP_CHAT_SERVICE_CREDENTIAL_HEADER: "x-test-credential", MCP_CHAT_OWNER_DID_HEADER: "x-test-owner", MCP_CHAT_SERVICE_DID: "did:key:z6MkService",
    MCP_CHAT_TEST_ACCOUNTS: options.mcpAccounts ?? ADDRESS, TAVILY_API_KEY: "tavily-test-key",
  }, fetchImpl);
  const config: AgentChatConfig = {
    agentId: "agent", streamPolicy: { heartbeatMs: 1000, turnTimeoutMs: 10000, drainGraceMs: 100 }, entityIdFor: () => "entity-1",
    elizaServiceUrl: options.elizaServiceUrl ?? "", elizaServiceSecret: "", redpillApiKey: "rp", redpillBaseUrl: "https://redpill.test/v1",
    defaultModel: () => "phala/gpt-oss-120b", isModelOffered: () => true, fetchImpl, maxRounds: 3, ...mcp,
  };
  return { calls, config };
}

beforeEach(() => { process.env.PAYWALL_ENABLED = "false"; _resetCache(); _resetUsage(); _resetCatalogCache(); });
afterEach(() => { process.env = { ...ORIGINAL_ENV }; _resetCache(); _resetUsage(); _resetCatalogCache(); });

describe("chat for an MCP account without eliza-service", () => {
  it("serves web_search and the meeting tool in-process and never calls eliza-service", async () => {
    const { calls, config } = setup({ grant: "active" });
    const { req, res } = makeReqRes(ADDRESS);
    await createAgentChatHandler(config, undefined)(req, res);
    expect(calls.eliza).toEqual([]);
    expect(calls.tavily).toHaveLength(1);
    expect(calls.tavily[0]).toMatchObject({ query: "news", include_answer: true, search_depth: "basic", max_results: 5 });
    expect(calls.mcpTools).toContain("tinycloud_sql_query");
    expect(new Set(calls.mcpOwners)).toEqual(new Set([OWNER_DID]));
    const toolMessages = calls.modelBodies[1]!.messages.filter(message => message.role === "tool").map(message => message.content).join("\n");
    expect(toolMessages).toContain("A public answer.");
    expect(res.chunks.join("")).toContain("Answer.");
  });

  it("tells the browser to reconnect before any content when the MCP has no grant, and leaves meeting tools out of the turn", async () => {
    const { calls, config } = setup({ grant: "none" });
    const { req, res } = makeReqRes(ADDRESS);
    await createAgentChatHandler(config, undefined)(req, res);
    const text = res.chunks.join("");
    expect(text).toContain('"delegation_error":{"code":"delegation_required"}');
    expect(text.indexOf("delegation_error")).toBeLessThan(text.indexOf("Answer."));
    expect(calls.eliza).toEqual([]);
    const offered = calls.modelBodies[0]!.tools?.map(tool => tool.function.name) ?? [];
    expect(offered).toEqual(["web_search"]);
  });

  it("says eliza-service is unavailable, instead of falling back, for an account that is not on the MCP when eliza is not configured", async () => {
    const { calls, config } = setup({ grant: "active", mcpAccounts: OTHER });
    const { req, res } = makeReqRes(ADDRESS);
    await createAgentChatHandler(config, undefined)(req, res);
    expect(res.lastJson).toEqual({ status: 503, body: { error: "eliza_unavailable" } });
    expect(calls.mcpTools).toEqual([]);
  });

  it("keeps the eliza path for accounts the operator did not list (rollback)", async () => {
    const { calls, config } = setup({ grant: "active", mcpAccounts: OTHER, elizaServiceUrl: "https://eliza.test" });
    const { req, res } = makeReqRes(ADDRESS);
    await createAgentChatHandler(config, { capture: () => ({ isCurrent: () => true, onInvalidate: () => () => {} }), status: async () => ({ status: "active", transcriptStatus: "active", revision: "r1" }) })(req, res);
    expect(calls.mcpTools).toEqual([]);
    expect(calls.eliza.length).toBeGreaterThan(0);
  });
});
