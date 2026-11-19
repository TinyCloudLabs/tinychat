import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import type { Request, Response } from "express";
import { _resetCache } from "../billing/stripe.js";
import { _resetCatalogCache } from "../billing/catalog.js";
import { _resetUsage } from "../billing/usage.js";
import { createAgentChatHandler, type AgentChatConfig } from "../routes/agent-chat.js";
import type { McpMeetingTools } from "../mcp-meetings/dispatch.js";
import { meetingRolloutFromEnv } from "../transcripts/meeting-rollout.js";

const ADDRESS = "0xabc0000000000000000000000000000000000001";
const ORIGINAL_ENV = { ...process.env };

describe("meeting rollout flags", () => {
  const on = { MEETING_CONTENT_RETRIEVAL_ENABLED: "true" };

  it("a * account entry admits every MCP account, and only MCP accounts", () => {
    const rollout = meetingRolloutFromEnv({ ...on, MEETING_CONTENT_TEST_ACCOUNTS: "*" });
    expect(rollout.mcpAccountAllowed(ADDRESS)).toBe(true);
    expect(rollout.accountAllowed(ADDRESS)).toBe(false);
  });

  it("an empty account list still admits nobody, on either path", () => {
    const rollout = meetingRolloutFromEnv({ ...on, MEETING_CONTENT_TEST_ACCOUNTS: "" });
    expect(rollout.mcpAccountAllowed(ADDRESS)).toBe(false);
    expect(rollout.accountAllowed(ADDRESS)).toBe(false);
  });

  it("named accounts are matched case-insensitively on the MCP path as before", () => {
    const rollout = meetingRolloutFromEnv({ ...on, MEETING_CONTENT_TEST_ACCOUNTS: ` ${ADDRESS.toUpperCase().replace("0X", "0x")} ` });
    expect(rollout.mcpAccountAllowed(ADDRESS)).toBe(true);
    expect(rollout.mcpAccountAllowed("0xdef0000000000000000000000000000000000002")).toBe(false);
  });

  it("an empty model list means every offered model for MCP turns and none for the Eliza path; a named list is exact for both", () => {
    const empty = meetingRolloutFromEnv({ ...on, MEETING_CONTENT_MODELS: "" });
    expect(empty.mcpModelAllowed("any/model")).toBe(true);
    expect(empty.modelAllowed("any/model")).toBe(false);
    const named = meetingRolloutFromEnv({ ...on, MEETING_CONTENT_MODELS: "a/one, b/two" });
    expect(named.mcpModelAllowed("a/one")).toBe(true);
    expect(named.mcpModelAllowed("c/three")).toBe(false);
    expect(named.modelAllowed("b/two")).toBe(true);
  });
});

const sse = (frames: unknown[]): AsyncIterable<Uint8Array> => {
  const enc = new TextEncoder();
  return { async *[Symbol.asyncIterator]() { for (const f of frames) yield enc.encode(`data: ${JSON.stringify(f)}\n\n`); yield enc.encode("data: [DONE]\n\n"); } };
};

function makeReqRes(address: string) {
  let statusCode = 200;
  const written: string[] = [];
  let ended = false;
  let flushed = false;
  const req = Object.assign(new EventEmitter(), { user: { address }, body: { messages: [{ role: "user", content: "What did we decide about the rollout?" }], model: "phala/some-model" } }) as unknown as Request;
  const res = Object.assign(new EventEmitter(), {
    destroyed: false,
    destroy() { this.destroyed = true; this.emit("close"); return this; },
    status(code: number) { statusCode = code; return res; },
    json() { return res; },
    setHeader() { return res; },
    flushHeaders() { flushed = true; },
    write(chunk: string | Uint8Array) { written.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk)); return true; },
    end() { ended = true; this.emit("finish"); },
    chunks: written,
  }) as unknown as Response & { chunks: string[] };
  Object.defineProperties(res, {
    statusCode: { get: () => statusCode, configurable: true },
    writableEnded: { get: () => ended, configurable: true },
    writableFinished: { get: () => ended, configurable: true },
    headersSent: { get: () => flushed, configurable: true },
  });
  return { req, res };
}

const meeting = { meetingRef: "meeting-a", source: "fireflies", title: "Design", startedAt: "2026-09-01T12:00:00Z", participants: ["Ava", "Ben"], organizerEmail: "ava@example.invalid" };
const typedBody = { result: { data: { contractVersion: 2, outcomes: [{
  meetingRef: "meeting-a", source: "fireflies", meeting, state: "read",
  body: { state: "not_requested" }, search: { state: "not_requested", storedFieldsExamined: false, bodyExamined: false, examinedMatches: 0, retainedMatches: 0 },
  evidence: [{ id: "E1", meetingRef: "meeting-a", source: "fireflies", kind: "summary", text: "The team approved the cobalt rollout.", truncated: false }],
  coverage: { purpose: "summary", overviewPresent: true, actionsPresent: false, bodyAttempted: false, bodyRequired: false, evidenceRetained: 1, omittedEvidenceCount: 0, omissionReasons: [], support: "sufficient" },
}] } } };

/** The chat config exactly as index.ts builds it from the environment, with the MCP wrapper stubbed in-process. */
function setup(env: Record<string, string>, mcpSelected = true) {
  const rollout = meetingRolloutFromEnv(env);
  const modelBodies: Array<{ tools?: Array<{ function: { name: string } }> }> = [];
  const replies = [
    { tool_calls: [{ index: 0, id: "plan", function: { name: "prepare_meeting_turn", arguments: JSON.stringify({ kind: "meeting_content", scope: "selected", purpose: "summary", evidenceRequirement: "overview" }) } }] },
    { content: JSON.stringify({ claims: [{ text: "The team approved the cobalt rollout.", meetingIds: ["M1"], evidenceIds: ["M1:E1"] }] }) },
  ];
  let round = 0;
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    if (String(input).startsWith("https://eliza.test")) return Response.json({ error: "not_found" }, { status: 404 });
    modelBodies.push(JSON.parse(init!.body as string));
    const delta = replies[Math.min(round++, replies.length - 1)]!;
    return { ok: true, status: 200, body: sse([{ choices: [{ delta, finish_reason: "tool_calls" in delta ? "tool_calls" : "stop" }] }, { choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } }]) } as unknown as Response;
  }) as unknown as typeof fetch;
  const mcpMeetings: McpMeetingTools = {
    handles: name => ["tinycloud_find_meetings", "tinycloud_read_meeting", "tinycloud_search_transcripts", "tinycloud_list_meeting_actions", "web_search"].includes(name),
    run: async () => ({ status: 200, body: typedBody as Record<string, unknown> }),
    status: async () => ({ status: "active", transcriptStatus: "active", revision: "r1" }),
  };
  const config: AgentChatConfig = {
    agentId: "agent", streamPolicy: { heartbeatMs: 1000, turnTimeoutMs: 10000, drainGraceMs: 100 }, entityIdFor: () => "entity-1",
    elizaServiceUrl: mcpSelected ? "" : "https://eliza.test", elizaServiceSecret: mcpSelected ? "" : "s", redpillApiKey: "rp", redpillBaseUrl: "https://redpill.test/v1",
    defaultModel: () => "phala/some-model", isModelOffered: () => true, redpillFetch: fetchImpl, fetchImpl, maxRounds: 3, backendRevision: "rev-1", meetingTrace: () => {},
    mcpMeetings, mcpChatAccountAllowed: () => mcpSelected, mcpOwnerDidFor: address => `did:pkh:eip155:1:${address.toLowerCase()}`,
    meetingContentRetrievalEnabled: rollout.enabled, meetingContentAccountAllowed: rollout.accountAllowed, meetingContentModelAllowed: rollout.modelAllowed,
    meetingContentMcpAccountAllowed: rollout.mcpAccountAllowed, meetingContentMcpModelAllowed: rollout.mcpModelAllowed,
  };
  return { config, modelBodies };
}

async function ask(env: Record<string, string>, mcpSelected = true) {
  const { config, modelBodies } = setup(env, mcpSelected);
  const { req, res } = makeReqRes(ADDRESS);
  await createAgentChatHandler(config, undefined)(req, res);
  const text = res.chunks.join("");
  return { text, modelBodies };
}

beforeEach(() => { process.env.PAYWALL_ENABLED = "false"; _resetCache(); _resetUsage(); _resetCatalogCache(); });
afterEach(() => { process.env = { ...ORIGINAL_ENV }; _resetCache(); _resetUsage(); _resetCatalogCache(); });

describe("MCP chat turn admitted to the validated pipeline by the rollout flags", () => {
  it("runs it for every MCP account when the account list is * and the model list is empty", async () => {
    const { text, modelBodies } = await ask({ MEETING_CONTENT_RETRIEVAL_ENABLED: "true", MEETING_CONTENT_TEST_ACCOUNTS: "*", MEETING_CONTENT_MODELS: "" });
    expect(modelBodies[0]!.tools?.map(tool => tool.function.name)).toEqual(["prepare_meeting_turn"]);
    expect(text).toContain("The team approved the cobalt rollout.");
    expect(text).toContain("Coverage");
  });

  it("leaves an account served by eliza-service on the plain tool loop even with * and an empty model list", async () => {
    const { modelBodies } = await ask({ MEETING_CONTENT_RETRIEVAL_ENABLED: "true", MEETING_CONTENT_TEST_ACCOUNTS: "*", MEETING_CONTENT_MODELS: "" }, false);
    const offered = modelBodies[0]!.tools?.map(tool => tool.function.name) ?? [];
    expect(offered).not.toContain("prepare_meeting_turn");
    expect(offered).toContain("tinycloud_find_meetings");
  });

  it("keeps the plain tool loop for an MCP account the list does not name", async () => {
    const { modelBodies } = await ask({ MEETING_CONTENT_RETRIEVAL_ENABLED: "true", MEETING_CONTENT_TEST_ACCOUNTS: "0xdef0000000000000000000000000000000000002", MEETING_CONTENT_MODELS: "" });
    expect(modelBodies[0]!.tools?.map(tool => tool.function.name) ?? []).not.toContain("prepare_meeting_turn");
  });

  it("keeps the plain tool loop when the master flag is off, even with * and an empty model list", async () => {
    const { modelBodies } = await ask({ MEETING_CONTENT_RETRIEVAL_ENABLED: "false", MEETING_CONTENT_TEST_ACCOUNTS: "*", MEETING_CONTENT_MODELS: "" });
    expect(modelBodies[0]!.tools?.map(tool => tool.function.name) ?? []).not.toContain("prepare_meeting_turn");
  });

  it("refuses private meeting tools for a model outside a non-empty model list", async () => {
    const { modelBodies } = await ask({ MEETING_CONTENT_RETRIEVAL_ENABLED: "true", MEETING_CONTENT_TEST_ACCOUNTS: "*", MEETING_CONTENT_MODELS: "phala/other-model" });
    const offered = modelBodies[0]!.tools?.map(tool => tool.function.name) ?? [];
    expect(offered).not.toContain("prepare_meeting_turn");
    expect(offered.filter(name => name.startsWith("tinycloud_"))).toEqual([]);
  });
});
