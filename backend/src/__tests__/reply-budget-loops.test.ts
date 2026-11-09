import { describe, expect, test } from "bun:test";
import { orchestrateToolCalling, type AgentChatConfig } from "../routes/agent-chat.js";
import { createReplyBudget } from "../billing/reply-budget.js";
import type { ModelRates } from "../billing/credits.js";

// 1 credit per output token; a cheap prompt keeps the cap close to the allowance.
const rates: ModelRates = { creditsPerKInput: 1, creditsPerKOutput: 1000, fallback: false };
const dataFrame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const sse = (...frames: unknown[]) => new Response(frames.map(dataFrame).join("") + "data: [DONE]\n\n");
const content = (frames: string[]) => frames.map(frame => { try { return JSON.parse(frame.slice(6)).choices?.[0]?.delta?.content ?? ""; } catch { return ""; } }).join("");

const toolRound = (usage: { prompt_tokens: number; completion_tokens: number }) => sse(
  { id: "round", choices: [{ delta: { tool_calls: [{ index: 0, id: "call", function: { name: "web_search", arguments: '{"query":"capital"}' } }] }, finish_reason: "tool_calls" }] },
  { choices: [], usage });
const answerRound = (text: string, finish: string, usage: { prompt_tokens: number; completion_tokens: number }) => sse(
  { id: "answer", choices: [{ delta: { content: text }, finish_reason: finish }] }, { choices: [], usage });
const planRound = (plan: unknown, usage: { prompt_tokens: number; completion_tokens: number }) => sse(
  { id: "plan", choices: [{ delta: { tool_calls: [{ index: 0, id: "plan", function: { name: "prepare_meeting_turn", arguments: JSON.stringify(plan) } }] }, finish_reason: "tool_calls" }], usage });

function harness(provider: (body: any, index: number) => Response, options: { meeting?: boolean } = {}) {
  const bodies: any[] = []; const tools: string[] = []; const other: string[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/chat/completions")) { const body = JSON.parse(String(init?.body)); bodies.push(body); return provider(body, bodies.length - 1); }
    if (url.includes("/tools/")) { tools.push(url.split("/").pop()!); return Response.json({ result: { text: "Lisbon is the capital.", data: { results: [] } } }); }
    other.push(url);
    if (url.endsWith("/capabilities")) return Response.json({ meetingRetrieval: { contractVersion: 2 }, buildRevision: "fixture-v2" });
    throw new Error(`unexpected request ${url}`);
  }) as typeof fetch;
  const config: AgentChatConfig = {
    agentId: "agent", entityIdFor: () => "entity", elizaServiceUrl: "https://eliza.test", elizaServiceSecret: "test",
    redpillApiKey: "test", redpillBaseUrl: "https://model.test", defaultModel: () => "test-model", isModelOffered: () => true, fetchImpl,
    streamPolicy: { heartbeatMs: 1000, turnTimeoutMs: 10000, drainGraceMs: 100 }, maxRounds: 3,
    ...(options.meeting ? { meetingContentRetrievalEnabled: true, meetingTrace: () => {} } : {}),
  };
  return { config, bodies, tools, other };
}

async function run(h: ReturnType<typeof harness>, allowance: number | undefined, text = "Search for the capital of Portugal", budgetRates = rates) {
  const frames: string[] = [];
  const budget = allowance === undefined ? undefined : createReplyBudget(allowance, budgetRates);
  const result = await orchestrateToolCalling({
    config: h.config, model: "test-model", messages: [{ role: "user", content: text }], entityId: "entity",
    turnContext: { localDate: "2026-09-09", timeZone: "Europe/Lisbon" },
    write: frame => { frames.push(frame); }, ...(budget ? { budget } : {}),
  });
  return { result, frames };
}

describe("existing tool loop under a reply budget", () => {
  test("every provider call carries max_tokens derived from the allowance left, shrinking as rounds spend", async () => {
    const h = harness((_body, i) => i === 0 ? toolRound({ prompt_tokens: 100, completion_tokens: 50 }) : answerRound("Lisbon.", "stop", { prompt_tokens: 120, completion_tokens: 10 }));
    const { result } = await run(h, 500);
    expect(result.errorCode).toBeUndefined();
    expect(h.bodies).toHaveLength(2);
    // Round 1 spent ceil(100/1000*1 + 50/1000*1000) = 51 credits.
    expect(h.bodies[0].max_tokens).toBeLessThanOrEqual(500);
    expect(h.bodies[0].max_tokens).toBeGreaterThan(449);
    expect(h.bodies[1].max_tokens).toBeLessThanOrEqual(449);
    expect(h.bodies[1].max_tokens).toBeGreaterThan(0);
  });

  test("an unaffordable prompt stops before any provider call", async () => {
    const h = harness(() => { throw new Error("provider must not be called"); });
    const { result, frames } = await run(h, 5, "x".repeat(30_000), { ...rates, creditsPerKInput: 1000 });
    expect(result.errorCode).toBe("budget_exhausted");
    expect(h.bodies).toHaveLength(0);
    expect(content(frames)).toBe("");
  });

  test("a round that exhausts the allowance dispatches no tool and makes no further provider call", async () => {
    const h = harness(() => toolRound({ prompt_tokens: 100, completion_tokens: 600 }));
    const { result } = await run(h, 500);
    expect(result.errorCode).toBe("budget_exhausted");
    expect(h.tools).toEqual([]);
    expect(h.bodies).toHaveLength(1);
    expect(result.completionTokens).toBe(600);
  });

  test("finish_reason length under a budget cap stops the reply as budget_exhausted and keeps the streamed text", async () => {
    const h = harness(() => answerRound("Partial answer", "length", { prompt_tokens: 100, completion_tokens: 450 }));
    const { result, frames } = await run(h, 500);
    expect(result.errorCode).toBe("budget_exhausted");
    expect(content(frames)).toBe("Partial answer");
    expect(h.bodies).toHaveLength(1);
  });

  test("finish_reason length without a budget is not a budget stop", async () => {
    const h = harness(() => answerRound("Partial answer", "length", { prompt_tokens: 100, completion_tokens: 450 }));
    const { result } = await run(h, undefined);
    expect(result.errorCode).toBeUndefined();
    expect(h.bodies[0].max_tokens).toBeUndefined();
  });
});

describe("meeting turn under a reply budget", () => {
  test("interpretation and the general round it hands off to share one allowance", async () => {
    const h = harness((_body, i) => i === 0 ? planRound({ kind: "general" }, { prompt_tokens: 5, completion_tokens: 100 }) : answerRound("Lisbon.", "stop", { prompt_tokens: 20, completion_tokens: 10 }), { meeting: true });
    const { result } = await run(h, 1000);
    expect(result.errorCode).toBeUndefined();
    expect(h.bodies).toHaveLength(2);
    // Interpretation spent ceil(5/1000 + 100) = 101 credits; its own cap was below the 1024 default.
    expect(h.bodies[0].max_tokens).toBeLessThanOrEqual(1000);
    expect(h.bodies[0].max_tokens).toBeGreaterThan(899);
    expect(h.bodies[1].max_tokens).toBeLessThanOrEqual(899);
  });

  test("an allowance below the fixed output cap lowers the interpretation call's max_tokens", async () => {
    const h = harness(() => planRound({ kind: "general" }, { prompt_tokens: 5, completion_tokens: 2 }), { meeting: true });
    await run(h, 300).catch(() => {});
    expect(h.bodies[0].max_tokens).toBeLessThanOrEqual(300);
  });

  test("an unaffordable interpretation prompt makes no provider call", async () => {
    const h = harness(() => { throw new Error("provider must not be called"); }, { meeting: true });
    const { result } = await run(h, 1, "Summarize my meeting", { ...rates, creditsPerKInput: 1000 });
    expect(result.errorCode).toBe("budget_exhausted");
    expect(h.bodies).toHaveLength(0);
  });

  test("an interpretation that exhausts the allowance reaches no meeting tool and no synthesis", async () => {
    const plan = { kind: "meeting_content", scope: "exact", meetingRef: "meeting-a", purpose: "summary", evidenceRequirement: "overview" };
    const h = harness(() => planRound(plan, { prompt_tokens: 5, completion_tokens: 600 }), { meeting: true });
    const { result } = await run(h, 500, "Summarize this meeting");
    expect(result.errorCode).toBe("budget_exhausted");
    expect(h.tools).toEqual([]);
    expect(h.bodies).toHaveLength(1);
  });

  test("a synthesis call is capped by what interpretation already spent", async () => {
    const plan = { kind: "meeting_content", scope: "exact", meetingRef: "meeting-a", purpose: "summary", evidenceRequirement: "overview" };
    const meeting = { meetingRef: "meeting-a", source: "google-meet", meeting: { meetingRef: "meeting-a", source: "google-meet", title: "Design", startedAt: "2026-09-01T12:00:00Z", participants: ["Sam"], organizerEmail: null }, state: "read",
      body: { state: "not_requested" }, search: { state: "not_requested", storedFieldsExamined: true, bodyExamined: false, examinedMatches: 0, retainedMatches: 0 },
      evidence: [{ id: "E1", meetingRef: "meeting-a", source: "google-meet", kind: "summary", text: "The team chose the green design.", truncated: false }],
      coverage: { purpose: "summary", overviewPresent: true, actionsPresent: false, bodyAttempted: false, bodyRequired: false, evidenceRetained: 1, omittedEvidenceCount: 0, omissionReasons: [], support: "sufficient" } };
    const h = harness((_body, i) => i === 0 ? planRound(plan, { prompt_tokens: 5, completion_tokens: 100 })
      : answerRound(JSON.stringify({ claims: [{ text: "The team chose the green design.", meetingIds: ["M1"], evidenceIds: ["M1:E1"] }] }), "stop", { prompt_tokens: 50, completion_tokens: 20 }), { meeting: true });
    const base = h.config.fetchImpl!;
    h.config.fetchImpl = (async (input: unknown, init?: RequestInit) => String(input).includes("/tools/")
      ? Response.json({ result: { data: { contractVersion: 2, outcomes: [meeting] } } }) : base(input as RequestInfo, init)) as typeof fetch;
    const { result } = await run(h, 1000, "Summarize this meeting");
    expect(result.errorCode).toBeUndefined();
    expect(h.bodies).toHaveLength(2);
    expect(h.bodies[1].max_tokens).toBeLessThanOrEqual(899);
  });

  test("finish_reason length under a budget cap aborts the call as budget_exhausted", async () => {
    const plan = { kind: "meeting_content", scope: "exact", meetingRef: "meeting-a", purpose: "summary", evidenceRequirement: "overview" };
    const h = harness(() => sse({ id: "plan", choices: [{ delta: { tool_calls: [{ index: 0, id: "plan", function: { name: "prepare_meeting_turn", arguments: JSON.stringify(plan).slice(0, 20) } }] }, finish_reason: "length" }], usage: { prompt_tokens: 5, completion_tokens: 295 } }), { meeting: true });
    const { result } = await run(h, 300, "Summarize this meeting");
    expect(result.errorCode).toBe("budget_exhausted");
    expect(h.tools).toEqual([]);
  });
});
