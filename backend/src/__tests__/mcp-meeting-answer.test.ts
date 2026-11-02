import { describe, expect, test } from "bun:test";
import { orchestrateToolCalling, type AgentChatConfig } from "../routes/agent-chat.js";
import { Database } from "bun:sqlite";
import { CONNECTOR_SCHEMA } from "../../../packages/core/src/connector-meeting.js";
import { createMcpMeetingTools, type McpMeetingTools } from "../mcp-meetings/dispatch.js";

/**
 * Answer validation for chat turns whose meeting tools run over the MCP (no eliza-service anywhere).
 * Every model call is a scripted RedPill reply; the meeting tools are an in-process stub of the MCP wrapper.
 */
const OWNER = "did:pkh:eip155:1:0xabc0000000000000000000000000000000000001";
const meeting = { meetingRef: "meeting-a", source: "fireflies", title: "Design", startedAt: "2026-09-01T12:00:00Z", participants: ["Ava", "Ben"], organizerEmail: "ava@example.invalid" };

function sse(delta: Record<string, unknown>, finish: string) {
  return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }], usage: { prompt_tokens: 5, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`);
}
const text = (content: string) => sse({ content }, "stop");
const toolCall = (name: string, args: unknown) => sse({ tool_calls: [{ index: 0, id: "call-1", function: { name, arguments: JSON.stringify(args) } }] }, "tool_calls");

function typed(evidence: Record<string, unknown>, purpose: string) {
  return { result: { data: { contractVersion: 2, outcomes: [{
    meetingRef: "meeting-a", source: "fireflies", meeting, state: "read",
    body: { state: "not_requested" }, search: { state: "not_requested", storedFieldsExamined: false, bodyExamined: false, examinedMatches: 0, retainedMatches: 0 },
    evidence: [{ id: "E1", meetingRef: "meeting-a", source: "fireflies", text: "The team approved the cobalt rollout.", truncated: false, ...evidence }],
    coverage: { purpose, overviewPresent: true, actionsPresent: false, bodyAttempted: false, bodyRequired: false, evidenceRetained: 1, omittedEvidenceCount: 0, omissionReasons: [], support: "sufficient" },
  }] } } };
}
const typedBody = typed({ kind: "summary" }, "summary");
const citedBody = { result: { text: "1 meeting", data: { meeting: { citation: "[M1]" }, excerpts: [{ citation: "[M1:E1, Avery, 00:00:05]", text: "We approved the cobalt rollout." }] } } };

function mcpTools(body: unknown, calls: string[]): McpMeetingTools {
  return {
    handles: name => ["tinycloud_find_meetings", "tinycloud_read_meeting", "tinycloud_search_transcripts", "tinycloud_list_meeting_actions", "web_search"].includes(name),
    run: async request => { calls.push(request.name); return { status: 200, body: body as Record<string, unknown> }; },
    status: async () => ({ status: "active", transcriptStatus: "active", revision: "r1" }),
  };
}

async function run(options: { elizaUrl?: string; replies: Array<() => Response>; body: unknown; rollout?: boolean; backendRevision?: string; modelAllowed?: boolean; question?: string }) {
  const modelRequests: Array<{ messages: Array<{ role: string; content: string }>; tools?: unknown[] }> = [];
  const otherHosts: string[] = [];
  const toolCalls: string[] = [];
  const frames: string[] = [];
  const traces: Array<Record<string, unknown>> = [];
  let next = 0;
  const fetchImpl = (async (input, init) => {
    const url = String(input);
    if (!url.startsWith("https://model.test")) { otherHosts.push(url); throw new Error(`unexpected request ${url}`); }
    modelRequests.push(JSON.parse(String(init?.body)));
    const reply = options.replies[next++];
    if (!reply) throw new Error("model called more often than scripted");
    return reply();
  }) as typeof fetch;
  const config: AgentChatConfig = {
    agentId: "agent", entityIdFor: () => "entity", elizaServiceUrl: options.elizaUrl ?? "", elizaServiceSecret: options.elizaUrl ? "eliza-secret" : "", redpillApiKey: "test", redpillBaseUrl: "https://model.test",
    defaultModel: () => "test-model", isModelOffered: () => true, fetchImpl, meetingTrace: trace => { traces.push(trace); },
    streamPolicy: { heartbeatMs: 100, turnTimeoutMs: 30000, drainGraceMs: 100 }, maxRounds: 3,
    mcpMeetings: mcpTools(options.body, toolCalls), mcpOwner: OWNER,
    ...(options.rollout ? { meetingContentRetrievalEnabled: true, meetingContentModelAllowed: () => options.modelAllowed ?? true } : {}),
    ...(options.backendRevision ? { backendRevision: options.backendRevision } : {}),
  };
  const result = await orchestrateToolCalling({ config, model: "test-model", messages: [{ role: "user", content: options.question ?? "What did we decide about the rollout?" }], entityId: "entity", roomId: "room", write: frame => { frames.push(frame); } });
  const answer = frames.flatMap(frame => { try { return JSON.parse(frame.slice(6)).choices?.[0]?.delta?.content ?? ""; } catch { return ""; } }).join("");
  return { answer, modelRequests, otherHosts, toolCalls, traces, result };
}

const plan = () => toolCall("prepare_meeting_turn", { kind: "meeting_content", scope: "selected", purpose: "summary", evidenceRequirement: "overview" });
const draft = (evidenceIds: string[]) => () => text(JSON.stringify({ claims: [{ text: "The team approved the cobalt rollout.", meetingIds: ["M1"], evidenceIds }] }));

describe("MCP chat turn with the plain tool loop (meeting rollout flags off)", () => {
  test("delivers an answer that cites only tool-supplied citations and never reaches eliza-service", async () => {
    const r = await run({ body: citedBody, replies: [() => toolCall("tinycloud_read_meeting", { meetingRef: "meeting-a" }), () => text("The team approved it. [M1:E1, Avery, 00:00:05]")] });
    expect(r.toolCalls).toEqual(["tinycloud_read_meeting"]);
    expect(r.answer).toBe("The team approved it. [M1:E1, Avery, 00:00:05]");
    expect(r.otherHosts).toEqual([]);
  });

  test("a tool the model invents is refused on the spot; it is never forwarded to eliza-service, even when eliza-service is configured", async () => {
    const r = await run({ elizaUrl: "https://eliza.test", body: citedBody, replies: [() => toolCall("tinycloud_made_up_tool", { q: "x" }), () => text("I could not look that up.")] });
    expect(r.otherHosts).toEqual([]);
    expect(r.toolCalls).toEqual([]);
    const toolMessage = r.modelRequests[1]!.messages.find(message => message.role === "tool")!.content;
    expect(toolMessage).toContain("tinycloud_made_up_tool");
    expect(toolMessage).toContain("not available");
  });

  test("repairs once, then withholds an answer whose citation was never supplied by a tool", async () => {
    const r = await run({ body: citedBody, replies: [() => toolCall("tinycloud_read_meeting", { meetingRef: "meeting-a" }), () => text("Approved. [M1:E9]"), () => text("Still approved. [M1:E9]")] });
    expect(r.modelRequests).toHaveLength(3);
    expect(r.answer).not.toContain("Approved");
    expect(r.answer).toContain("could not produce a safely cited answer");
  });
});

describe("MCP chat turn through the validated meeting pipeline (meeting rollout flags on)", () => {
  test("interprets, reads over the MCP, validates the draft and renders a cited answer with coverage, without eliza-service", async () => {
    const r = await run({ rollout: true, backendRevision: "rev-1", body: typedBody, replies: [plan, draft(["M1:E1"])] });
    expect(r.otherHosts).toEqual([]);
    expect(r.toolCalls).toEqual(["tinycloud_read_meeting"]);
    expect(r.modelRequests).toHaveLength(2);
    expect(r.answer).toContain("The team approved the cobalt rollout.");
    expect(r.answer).toContain("[M1:E1]");
    expect(r.answer).toContain("### Coverage");
    expect(r.traces.at(-1)).toMatchObject({ terminal: "validated_answer", contractVersion: 2 });
  });

  test("a draft citing evidence that was not retained is repaired once; a second bad draft falls back to the evidence itself", async () => {
    const r = await run({ rollout: true, backendRevision: "rev-1", body: typedBody, replies: [plan, draft(["M1:E7"]), draft(["M1:E8"])] });
    expect(r.modelRequests).toHaveLength(3);
    expect(r.modelRequests[2]!.messages.at(-1)!.content).toContain("claim_0:unknown_evidence");
    expect(r.answer).toContain("Available meeting evidence:");
    expect(r.answer).toContain("The team approved the cobalt rollout. [M1:E1]");
    expect(r.traces.at(-1)).toMatchObject({ terminal: "validation_fallback" });
  });

  test("cites a spoken passage with its speaker and timestamp, as the plain tool loop does", async () => {
    const speakerPlan = () => toolCall("prepare_meeting_turn", { kind: "meeting_content", scope: "selected", purpose: "speaker", speaker: "Avery", evidenceRequirement: "body" });
    const r = await run({ rollout: true, backendRevision: "rev-1", body: typed({ kind: "transcript_excerpt", speaker: "Avery", startSecs: 3725 }, "speaker"), replies: [speakerPlan, draft(["M1:E1"])] });
    expect(r.answer).toContain("The team approved the cobalt rollout. [M1:E1, Avery, 01:02:05]");
  });

  test("a bracketed speaker name cannot forge a second citation", async () => {
    const speakerPlan = () => toolCall("prepare_meeting_turn", { kind: "meeting_content", scope: "selected", purpose: "speaker", speaker: "Avery", evidenceRequirement: "body" });
    const r = await run({ rollout: true, backendRevision: "rev-1", body: typed({ kind: "transcript_excerpt", speaker: "Avery [M9:E9]", startSecs: 5 }, "speaker"), replies: [speakerPlan, draft(["M1:E1"])] });
    expect(r.answer).toContain("The team approved the cobalt rollout. [M1:E1, Avery M9:E9, 00:00:05]");
    expect(r.answer).not.toContain("[M9");
  });

  test("a passage with no recorded speaker or time keeps the bare citation", async () => {
    const r = await run({ rollout: true, backendRevision: "rev-1", body: typedBody, replies: [plan, draft(["M1:E1"])] });
    expect(r.answer).toContain("The team approved the cobalt rollout. [M1:E1]");
  });

  test("admission is the rollout's own: a model that is not allowed for meeting content gets no private tools", async () => {
    const r = await run({ rollout: true, modelAllowed: false, backendRevision: "rev-1", body: typedBody, replies: [() => text("I cannot read your meetings with this model.")] });
    const offered = (r.modelRequests[0]!.tools as Array<{ function: { name: string } }> | undefined)?.map(tool => tool.function.name) ?? [];
    expect(offered).not.toContain("prepare_meeting_turn");
    expect(offered.filter(name => name.startsWith("tinycloud_"))).toEqual([]);
    expect(r.toolCalls).toEqual([]);
    expect(r.otherHosts).toEqual([]);
  });

  test("an unknown backend revision fails closed instead of answering", async () => {
    const r = await run({ rollout: true, body: typedBody, replies: [plan] });
    expect(r.toolCalls).toEqual([]);
    expect(r.otherHosts).toEqual([]);
    expect(r.modelRequests).toHaveLength(1);
    expect(r.answer).toContain("temporarily unavailable");
    expect(r.result.errorCode).toBe("meeting_feature_unavailable");
  });
});

describe("validated pipeline over the real MCP wrapper (SQLite stand-in for the hosted MCP's reads)", () => {
  test("a date-range question is interpreted, discovered, read and answered with citations the validator accepts", async () => {
    const db = new Database(":memory:");
    for (const { sql } of CONNECTOR_SCHEMA) db.run(sql);
    db.run(
      "INSERT INTO connector_meeting (id, source, source_id, title, started_at, participants, summary_overview, summary_action_items, metadata, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      ["m-planning", "fireflies", "ff-1", "Planning sync", "2026-10-20T15:00:00Z", JSON.stringify([{ name: "Ana" }, { name: "Ben" }]), "The team agreed to launch on Friday.", "Ana to draft the plan", "{}", "2026-10-20T15:00:00Z", "2026-10-20T15:00:00Z"],
    );
    const port = {
      sqlQuery: async (sql: string, params: Array<string | number | null>) => db.query(sql).values(...params) as unknown[][],
      kvGetText: async () => { throw new Error("kv_not_found"); },
    };
    const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    const hosts: string[] = [];
    const fetchImpl = (async (input, init) => {
      if (!String(input).startsWith("https://model.test")) { hosts.push(String(input)); throw new Error("unexpected host"); }
      const body = JSON.parse(String(init?.body));
      requests.push(body);
      if (requests.length === 1) return toolCall("prepare_meeting_turn", { kind: "meeting_content", scope: "single", purpose: "summary", evidenceRequirement: "overview", title: "Planning", selectFirst: true });
      const { evidence } = JSON.parse(body.messages.at(-1).content) as { evidence: { citations: Record<string, { kind: string }> } };
      const id = Object.keys(evidence.citations).find(key => evidence.citations[key]!.kind === "summary")!;
      return text(JSON.stringify({ claims: [{ text: "The team agreed to launch on Friday.", meetingIds: ["M1"], evidenceIds: [id] }] }));
    }) as typeof fetch;
    const frames: string[] = [];
    const config: AgentChatConfig = {
      agentId: "agent", entityIdFor: () => "entity", elizaServiceUrl: "", elizaServiceSecret: "", redpillApiKey: "test", redpillBaseUrl: "https://model.test",
      defaultModel: () => "test-model", isModelOffered: () => true, fetchImpl, meetingTrace: () => {}, meetingContentRetrievalEnabled: true, meetingContentModelAllowed: () => true, backendRevision: "rev-1",
      streamPolicy: { heartbeatMs: 100, turnTimeoutMs: 30000, drainGraceMs: 100 }, mcpMeetings: createMcpMeetingTools(() => port), mcpOwner: OWNER,
    };
    await orchestrateToolCalling({ config, model: "test-model", messages: [{ role: "user", content: "Summarize my planning meeting." }], entityId: "entity", roomId: "room", write: frame => { frames.push(frame); } });
    const answer = frames.flatMap(frame => { try { return JSON.parse(frame.slice(6)).choices?.[0]?.delta?.content ?? ""; } catch { return ""; } }).join("");
    expect(hosts).toEqual([]);
    expect(requests).toHaveLength(2);
    expect(answer).toContain("The team agreed to launch on Friday.");
    expect(answer).toMatch(/\[M1:[A-Z0-9]+\]/);
    expect(answer).not.toContain("Available meeting evidence:");
  });
});
