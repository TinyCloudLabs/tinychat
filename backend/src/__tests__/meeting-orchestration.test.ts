import { expect, test } from "bun:test";
import { runMeetingTurn } from "../transcripts/meeting-turn.js";
import { orchestrateToolCalling, type AgentChatConfig } from "../routes/agent-chat.js";

function modelResponse(value: unknown, tool = false) {
  const delta = tool ? { content: "Do not deliver this early prose.", tool_calls: [{ index: 0, id: "plan", function: { name: "prepare_meeting_turn", arguments: JSON.stringify(value) } }] } : { content: typeof value === "string" ? value : JSON.stringify(value) };
  return new Response(`data: ${JSON.stringify({ id: "completion", choices: [{ delta, finish_reason: tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`);
}
function streamedToolResponse(deltas: unknown[]) {
  return new Response(deltas.map(delta => `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [delta] }, finish_reason: null }] })}\n\n`).join("")
    + `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 5, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`);
}
function outcome(ref = "meeting-a", state = "read") {
  return { meetingRef: ref, source: "google-meet", meeting: { meetingRef: ref, source: "google-meet", title: `Design ${ref}`, startedAt: "2026-09-01T12:00:00Z", participants: ["Sam"], organizerEmail: null }, state,
    body: { state: "not_requested" }, search: { state: "not_requested", storedFieldsExamined: true, bodyExamined: false, examinedMatches: 0, retainedMatches: 0 },
    evidence: [{ id: "E1", meetingRef: ref, source: "google-meet", kind: state === "metadata" ? "metadata" : "summary", text: state === "metadata" ? `Design ${ref}` : `The team chose the green design for ${ref}.`, truncated: false }],
    coverage: { purpose: state === "metadata" ? "metadata" : "summary", overviewPresent: state !== "metadata", actionsPresent: false, bodyAttempted: false, bodyRequired: false, evidenceRetained: 1, omittedEvidenceCount: 0, omissionReasons: [], support: "sufficient" } };
}
function config(fetchImpl: typeof fetch): AgentChatConfig {
  return { agentId: "agent", entityIdFor: () => "entity", elizaServiceUrl: "https://eliza.test", elizaServiceSecret: "test", redpillApiKey: "test", redpillBaseUrl: "https://model.test", defaultModel: () => "test-model", isModelOffered: () => true, fetchImpl, meetingTrace: () => {}, meetingContentRetrievalEnabled: true, streamPolicy: { heartbeatMs: 100, turnTimeoutMs: 30000, drainGraceMs: 100 } };
}
function output(frames: string[]) { return frames.flatMap(frame => { try { return JSON.parse(frame.slice(6)).choices?.[0]?.delta?.content ?? ""; } catch { return ""; } }).join(""); }
async function scenario(plan: unknown, service: (name: string, body: any, signal?: AbortSignal | null) => Promise<Response> | Response, options: { capability?: unknown; signal?: AbortSignal; remainingMs?: () => number; noPlan?: boolean } = {}) {
  const frames: string[] = []; const tools: Array<{ name: string; body: any }> = []; let models = 0;
  const fetchImpl = (async (input, init) => {
    const url = String(input); const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (url.endsWith("/capabilities")) return Response.json(options.capability ?? { meetingRetrieval: { contractVersion: 2 }, buildRevision: "fixture-v2" });
    if (url.includes("/tools/")) { const name = url.split("/").pop()!; tools.push({ name, body }); return service(name, body, init?.signal); }
    models++; return models === 1 ? modelResponse(plan, !options.noPlan) : modelResponse("invalid draft");
  }) as typeof fetch;
  const result = await orchestrateToolCalling({ config: config(fetchImpl), model: "test-model", messages: [{ role: "user", content: "A synthetic meeting request" }], entityId: "entity", roomId: "room", turnContext: { localDate: "2026-09-09", timeZone: "Europe/Lisbon" }, signal: options.signal, remainingMs: options.remainingMs, write: frame => { frames.push(frame); } });
  return { result, frames, text: output(frames), tools, models };
}
const wire = (outcomes: ReturnType<typeof outcome>[], discovery?: Record<string, unknown>) => Response.json({ result: { data: { contractVersion: 2, outcomes, ...(discovery ? { discovery } : {}) } } });
const discovery = (count: number, limited = false) => ({ matchedCount: count, countKind: limited ? "lower_bound" : "exact", returnedCount: Math.min(count, 12), scanLimited: limited, orderProven: true, excludedUndatedCount: 0, interval: {}, observedAt: "2026-09-09T12:00:00Z", omittedMeetingRefs: [] });

test("accepted content plan mandates exact read before any answer and accounts interpretation", async () => {
  const calls: Array<{ url: string; body: any }> = []; const frames: string[] = []; let models = 0;
  const fetchImpl = (async (input, init) => {
    const url = String(input); const body = init?.body ? JSON.parse(String(init.body)) : {}; calls.push({ url, body });
    if (url.endsWith("/capabilities")) return Response.json({ meetingRetrieval: { contractVersion: 2 }, buildRevision: "fixture-v2" });
    if (url.includes("/tools/")) return Response.json({ result: { data: { contractVersion: 2, outcomes: [outcome()] } } });
    models++;
    if (models === 1) return modelResponse({ kind: "meeting_content", scope: "exact", meetingRef: "meeting-a", purpose: "summary", evidenceRequirement: "overview" }, true);
    expect(frames.some(frame => output([frame]).includes("early prose"))).toBe(false);
    return modelResponse({ claims: [{ text: "The team chose the green design.", meetingIds: ["M1"], evidenceIds: ["M1:E1"] }] });
  }) as typeof fetch;
  const result = await orchestrateToolCalling({ config: config(fetchImpl), model: "test-model", messages: [{ role: "user", content: "Summarize this meeting" }], entityId: "entity", roomId: "room", write: frame => { frames.push(frame); } });
  expect(calls.filter(c => c.url.includes("/tools/")).map(c => c.url.split("/").pop())).toEqual(["tinycloud_read_meeting"]);
  expect(calls.find(c => c.url.includes("/tools/"))?.body.context.retrievalMode).toBe("single");
  expect(output(frames)).toContain("green design"); expect(output(frames)).not.toContain("early prose");
  expect(result.promptTokens).toBe(10); expect(models).toBe(2);
});

test("nullable provider continuation fields preserve the interpreted meeting plan", async () => {
  const frames: string[] = []; const reads: string[] = []; let models = 0;
  const plan = JSON.stringify({ kind: "meeting_content", scope: "exact", meetingRef: "meeting-a", purpose: "summary", evidenceRequirement: "overview" });
  const fetchImpl = (async (input, init) => {
    const url = String(input);
    if (url.endsWith("/capabilities")) return Response.json({ meetingRetrieval: { contractVersion: 2 }, buildRevision: "fixture-v2" });
    if (url.includes("/tools/")) { reads.push(JSON.parse(String(init?.body)).args.meetingRef); return wire([outcome()]); }
    models++;
    if (models === 1) return streamedToolResponse([
      { index: 0, id: "plan", function: { name: "prepare_meeting_turn", arguments: null } },
      { index: 0, id: null, function: { name: null, arguments: plan.slice(0, 30) } },
      { index: 0, id: null, function: null },
      { index: 0, function: { arguments: plan.slice(30) } },
    ]);
    return modelResponse({ claims: [{ text: "The team chose the green design.", meetingIds: ["M1"], evidenceIds: ["M1:E1"] }] });
  }) as typeof fetch;
  const result = await orchestrateToolCalling({ config: config(fetchImpl), model: "test-model", messages: [{ role: "user", content: "Summarize it" }], entityId: "entity", write: frame => { frames.push(frame); } });
  expect(reads).toEqual(["meeting-a"]); expect(output(frames)).toContain("green design");
  expect(result.errorCode).toBeUndefined(); expect(result.promptTokens).toBe(10); expect(models).toBe(2);
});

test("nullable provider continuation fields work in public web calls after interpretation", async () => {
  const frames: string[] = []; let models = 0, searches = 0;
  const fetchImpl = (async (input) => {
    if (String(input).endsWith("/tools/web_search")) { searches++; return Response.json({ result: { text: "Lisbon is the capital.", data: { results: [] } } }); }
    models++;
    if (models === 1) return modelResponse({ kind: "general" }, true);
    if (models === 2) return streamedToolResponse([
      { index: 0, id: "search", function: { name: "web_search", arguments: "" } },
      { index: 0, id: null, function: { name: null, arguments: '{"query":"capital of Portugal"}' } },
    ]);
    return modelResponse("Lisbon is the capital.");
  }) as typeof fetch;
  const result = await orchestrateToolCalling({ config: config(fetchImpl), model: "test-model", messages: [{ role: "user", content: "Search for the capital of Portugal" }], entityId: "entity", write: frame => { frames.push(frame); } });
  expect(searches).toBe(1); expect(models).toBe(3); expect(result.errorCode).toBeUndefined(); expect(output(frames)).toContain("Lisbon");
});

test.each([
  ["index", { index: null }], ["negative index", { index: -1 }], ["fractional index", { index: 0.5 }],
  ["id", { id: 42 }], ["function", { function: "invalid" }], ["function array", { function: [] }],
  ["name", { function: { name: 42 } }], ["arguments", { function: { arguments: {} } }],
])("interpretation rejects malformed nonnull tool fields: %s", async (_name, invalid) => {
  let requests = 0;
  const fetchImpl = (async () => {
    requests++;
    return streamedToolResponse([
      { index: 0, id: "plan", function: { name: "prepare_meeting_turn", arguments: '{"kind":"general"}' } },
      { index: 0, ...invalid },
    ]);
  }) as typeof fetch;
  const result = await orchestrateToolCalling({ config: config(fetchImpl), model: "test-model", messages: [{ role: "user", content: "Hello" }], entityId: "entity", write: () => {} });
  expect(result.errorCode).toBe("upstream_incomplete"); expect(requests).toBe(1);
});

test("range recap reads all eight distinct exact references with concurrency at most three", async () => {
  const frames: string[] = []; const reads: string[] = []; let models = 0, active = 0, peak = 0, discoveries = 0;
  const fetchImpl = (async (input, init) => {
    const url = String(input); const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (url.endsWith("/capabilities")) return Response.json({ meetingRetrieval: { contractVersion: 2 }, buildRevision: "fixture-v2" });
    if (url.endsWith("tinycloud_find_meetings")) { discoveries++; expect(body.args.limit).toBe(12); return Response.json({ result: { data: { contractVersion: 2, outcomes: Array.from({ length: 8 }, (_, i) => outcome(`meeting-${i}`, "metadata")), discovery: { matchedCount: 8, countKind: "exact", returnedCount: 8, scanLimited: false, orderProven: true, excludedUndatedCount: 0, interval: {}, observedAt: "2026-09-09T12:00:00Z", omittedMeetingRefs: [] } } } }); }
    if (url.endsWith("tinycloud_read_meeting")) { reads.push(body.args.meetingRef); expect(body.context.retrievalMode).toBe("range"); active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 3)); active--; return Response.json({ result: { data: { contractVersion: 2, outcomes: [outcome(body.args.meetingRef)] } } }); }
    models++; return models === 1 ? modelResponse({ kind: "meeting_content", scope: "range", purpose: "summary", evidenceRequirement: "overview", relativeDate: "last_week" }, true) : modelResponse("invalid draft");
  }) as typeof fetch;
  await orchestrateToolCalling({ config: config(fetchImpl), model: "test-model", messages: [{ role: "user", content: "What happened last week?" }], entityId: "entity", turnContext: { localDate: "2026-09-09", timeZone: "Europe/Lisbon" }, write: frame => { frames.push(frame); } });
  expect(discoveries).toBe(1); expect(reads.length).toBe(8); expect(new Set(reads).size).toBe(8); expect(peak).toBe(3); expect(models).toBe(3);
  for (let i = 0; i < 8; i++) expect(output(frames)).toContain(`green design for meeting-${i}`);
});

test("general route rejects native private calls with zero private dispatch after interpretation", async () => {
  let models = 0, dispatches = 0;
  const fetchImpl = (async (input) => {
    if (String(input).includes("/tools/")) { dispatches++; return Response.json({}); }
    models++;
    if (models === 1) return modelResponse({ kind: "general" }, true);
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "Already streamed prose.", tool_calls: [{ index: 0, id: "bad", function: { name: "tinycloud_find_meetings", arguments: "{}" } }] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
  }) as typeof fetch;
  const result = await orchestrateToolCalling({ config: config(fetchImpl), model: "test-model", messages: [{ role: "user", content: "Hello" }], entityId: "entity", write: () => {} });
  expect(dispatches).toBe(0); expect(result.errorCode).toBe("routing_mismatch"); expect(models).toBe(2);
});

test("metadata selected follow-up performs exactly one finder call without body or availability claims", async () => {
  const run = await scenario({ kind: "meeting_metadata", scope: "selected" }, () => wire([outcome("meeting-a", "metadata")]));
  expect(run.tools.map(tool => tool.name)).toEqual(["tinycloud_find_meetings"]);
  expect(run.tools[0].body.args).toEqual({}); expect(run.tools[0].body.context.retrievalMode).toBe("selected");
  expect(run.text).toContain("Sam"); expect(run.text).not.toMatch(/body|transcript|unavailable|missing/i);
});
test("unproven single selection clarifies without reading the lone observed result", async () => {
  const run = await scenario({ kind: "meeting_content", scope: "single", title: "Design", purpose: "summary", evidenceRequirement: "overview" }, () => wire([outcome("meeting-a", "metadata")], discovery(1, true)));
  expect(run.tools.length).toBe(1); expect(run.models).toBe(1); expect(run.text).toContain("Please specify"); expect(run.text).not.toContain("green design");
});
test("selected topic and range action requests have one owner and propagate body requirements", async () => {
  const topic = await scenario({ kind: "meeting_content", scope: "selected", purpose: "topic", query: "green", evidenceRequirement: "overview" }, () => wire([outcome()]));
  expect(topic.tools.map(tool => tool.name)).toEqual(["tinycloud_search_transcripts"]); expect(topic.tools[0].body.args).toEqual({ query: "green" });
  const actions = await scenario({ kind: "meeting_content", scope: "range", purpose: "actions", evidenceRequirement: "body", assignee: "Sam", from: "2026-09-01", to: "2026-09-07" }, () => wire([outcome()], discovery(1)));
  expect(actions.tools.map(tool => tool.name)).toEqual(["tinycloud_list_meeting_actions"]); expect(actions.tools[0].body.args.includeBody).toBe(true); expect(actions.tools[0].body.args.assignee).toBe("Sam");
});
test("capability mismatch and uninterpreted early prose never dispatch private tools", async () => {
  const plan = { kind: "meeting_content", scope: "selected", purpose: "summary", evidenceRequirement: "overview" };
  const mismatch = await scenario(plan, () => wire([outcome()]), { capability: { meetingRetrieval: { contractVersion: 1 }, buildRevision: "old" } });
  expect(mismatch.tools.length).toBe(0); expect(mismatch.result.errorCode).toBe("meeting_feature_unavailable"); expect(mismatch.text).not.toMatch(/no transcript|missing body/i);
  const prose = await scenario("There is no transcript.", () => wire([outcome()]), { noPlan: true });
  expect(prose.tools.length).toBe(0); expect(prose.text).not.toContain("no transcript"); expect(prose.result.errorCode).toBe("interpretation_failed");
});
test("an exact read cannot supply evidence for a different reference", async () => {
  const run = await scenario({ kind: "meeting_content", scope: "exact", meetingRef: "meeting-a", purpose: "summary", evidenceRequirement: "overview" }, () => wire([outcome("meeting-b")]));
  expect(run.text).not.toContain("green design"); expect(run.models).toBe(1); expect(run.result.errorCode).toBe("meeting_feature_unavailable");
});
test.each(["success", "overflow"])("revocation during fan-out suppresses later %s", async late => {
  const run = await scenario({ kind: "meeting_content", scope: "range", purpose: "summary", evidenceRequirement: "overview" }, async (name, body) => {
    if (name === "tinycloud_find_meetings") return wire(Array.from({ length: 8 }, (_, i) => outcome(`meeting-${i}`, "metadata")), discovery(8));
    if (body.args.meetingRef === "meeting-0") return Response.json({ error: "delegation_expired" }, { status: 409 });
    await new Promise(resolve => setTimeout(resolve, 10)); return late === "overflow" ? new Response("x".repeat(16001)) : wire([outcome(body.args.meetingRef)]);
  });
  expect(run.tools.length).toBeLessThanOrEqual(4); expect(run.models).toBe(1); expect(run.text).not.toContain("green design"); expect(run.frames.some(frame => frame.includes('"delegation_error"'))).toBe(true);
});
test("retrieval slice exhaustion retains successes and labels remaining meetings without inventing missing bodies", async () => {
  const run = await scenario({ kind: "meeting_content", scope: "range", purpose: "summary", evidenceRequirement: "overview" }, async (name, body) => {
    if (name === "tinycloud_find_meetings") return wire(Array.from({ length: 8 }, (_, i) => outcome(`meeting-${i}`, "metadata")), discovery(8));
    if (body.args.meetingRef !== "meeting-0") await new Promise(resolve => setTimeout(resolve, 150));
    return wire([outcome(body.args.meetingRef)]);
  }, { remainingMs: () => 100 });
  expect(run.text).toContain("green design for meeting-0"); expect(run.text).toContain("not read"); expect(run.text).not.toContain("missing"); expect(run.tools.length).toBeLessThan(9); expect(run.models).toBe(3);
});

test("general inline private call after streamed prose never dispatches or leaks tool markup", async () => {
  let models = 0, dispatches = 0; const frames: string[] = [];
  const fetchImpl = (async (input) => {
    if (String(input).includes("/tools/")) { dispatches++; return Response.json({}); }
    models++; if (models === 1) return modelResponse({ kind: "general" }, true);
    const chunks = ["Already streamed prose. ", "<too", "l_call>tinycloud_read_meeting<arg_key>focus</arg_key><arg_value>summary</arg_value></tool_call>"];
    return new Response(chunks.map(content => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`).join("") + `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  }) as typeof fetch;
  const result = await orchestrateToolCalling({ config: config(fetchImpl), model: "test-model", messages: [{ role: "user", content: "Hello" }], entityId: "entity", write: frame => { frames.push(frame); } });
  expect(result.errorCode).toBe("routing_mismatch"); expect(dispatches).toBe(0); expect(output(frames)).toContain("Already streamed prose."); expect(output(frames)).not.toContain("<tool");
});
test("ordinary general deltas stream before the answer model finishes", async () => {
  let models = 0; const frames: string[] = []; let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const fetchImpl = (async (_input, init) => {
    const body = JSON.parse(String(init?.body)); models++;
    if (models === 1) return modelResponse({ kind: "general" }, true);
    expect(body.tools.map((tool: any) => tool.function.name)).toEqual(["web_search"]); expect(JSON.stringify(body)).not.toContain("tinycloud_find_meetings");
    const encoder = new TextEncoder();
    return new Response(new ReadableStream({ async start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "Hello now." } }] })}\n\n`));
      await gate;
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: " Finished." }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`)); controller.close();
    } }));
  }) as typeof fetch;
  const run = orchestrateToolCalling({ config: config(fetchImpl), model: "test-model", messages: [{ role: "user", content: "Hello" }], entityId: "entity", write: frame => { frames.push(frame); } });
  await new Promise(resolve => setTimeout(resolve, 5)); expect(output(frames)).toBe("Hello now."); release(); await run; expect(output(frames)).toBe("Hello now. Finished."); expect(models).toBe(2);
});

const failureSentinel = "PRIVATE PROVIDER FAILURE SENTINEL";
test.each([
  ["HTTP 429", () => new Response(failureSentinel, { status: 429 }), "upstream_failed", 0],
  ["HTTP 503", () => new Response(failureSentinel, { status: 503 }), "upstream_failed", 0],
  ["fetch rejection", () => { throw new Error(failureSentinel); }, "upstream_failed", 0],
  ["provider error", () => new Response(`data: ${JSON.stringify({ error: { message: failureSentinel } })}\n\n`), "upstream_failed", 0],
  ["reader rejection", () => new Response(new ReadableStream({ pull(c) { c.error(new Error(failureSentinel)); } })), "upstream_failed", 0],
  ["EOF", () => new Response('data: {"usage":{"prompt_tokens":99}}\n\n'), "upstream_incomplete", 0],
  ["malformed SSE", () => new Response('data: {broken\n\n'), "upstream_incomplete", 0],
  ["malformed tool envelope", () => new Response('data: {"choices":[{"delta":{"tool_calls":{}},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'), "upstream_incomplete", 0],
  ["malformed choices", () => new Response('data: {"choices":{}}\n\ndata: [DONE]\n\n'), "upstream_incomplete", 0],
  ["malformed choice", () => new Response('data: {"choices":["invalid"]}\n\ndata: [DONE]\n\n'), "upstream_incomplete", 0],
  ["null choice", () => new Response('data: {"choices":[null]}\n\ndata: [DONE]\n\n'), "upstream_incomplete", 0],
  ["malformed delta", () => new Response('data: {"choices":[{"delta":"invalid","finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'), "upstream_incomplete", 0],
  ["malformed content", () => new Response('data: {"choices":[{"delta":{"content":42},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'), "upstream_incomplete", 0],
  ["missing valid finish", () => new Response('data: {"choices":[{"delta":{},"finish_reason":"length"}],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\ndata: [DONE]\n\n'), "upstream_incomplete", 5],
  ["provider output overflow", () => modelResponse(failureSentinel.repeat(600)), "result_size_limit", 0],
] as const)("interpretation preserves bounded failure: %s", async (_name, response, code, promptTokens) => {
  let requests = 0; const traces: unknown[] = [], frames: string[] = [];
  const cfg = config((async () => { requests++; return response(); }) as typeof fetch);
  cfg.meetingTrace = trace => { traces.push(trace); };
  const result = await orchestrateToolCalling({ config: cfg, model: "test-model", messages: [{ role: "user", content: "Summarize it" }], entityId: "entity", write: frame => { frames.push(frame); } });
  expect(result).toEqual({ errorCode: code, promptTokens, completionTokens: promptTokens ? 2 : 0, completionId: "" });
  expect(requests).toBe(1); expect(traces).toHaveLength(1);
  expect(traces[0]).toMatchObject({ terminal: code, tools: [] });
  expect(JSON.stringify([traces, frames])).not.toContain(failureSentinel);
  expect(output(frames)).not.toMatch(/specify|rephrase|meeting or dates/i);
});

test.each([
  ["invalid schema", { kind: "meeting_content", scope: "selected", title: "conflicting filter", purpose: "summary", evidenceRequirement: "overview" }, "interpretation_failed"],
  ["valid clarify", { kind: "clarify", question: "Which date range?" }, "clarify"],
] as const)("interpretation traces its semantic outcome: %s", async (_name, plan, terminal) => {
  const traces: unknown[] = []; let requests = 0;
  const cfg = config((async () => { requests++; return modelResponse(plan, true); }) as typeof fetch);
  cfg.meetingTrace = trace => { traces.push(trace); };
  const result = await orchestrateToolCalling({ config: cfg, model: "test-model", messages: [{ role: "user", content: "Summarize it" }], entityId: "entity", write: () => {} });
  expect(result.errorCode).toBe(terminal === "clarify" ? undefined : terminal);
  expect(result.promptTokens).toBe(5); expect(requests).toBe(1); expect(traces[0]).toMatchObject({ terminal });
});

test("interpretation slice expiry cancels its reader while the parent remains active", async () => {
  const parent = new AbortController(); let cancelled = 0, requests = 0; const traces: unknown[] = [];
  const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(": waiting\n\n")); }, cancel() { cancelled++; } });
  const cfg = config((async () => { requests++; return new Response(body); }) as typeof fetch);
  cfg.meetingTrace = trace => { traces.push(trace); };
  const result = await orchestrateToolCalling({ config: cfg, model: "test-model", messages: [{ role: "user", content: "Summarize it" }], entityId: "entity", signal: parent.signal, remainingMs: () => 0, write: () => {} });
  expect(result).toEqual({ errorCode: "interpretation_timeout", promptTokens: 0, completionTokens: 0, completionId: "" });
  expect(parent.signal.aborted).toBe(false); expect(cancelled).toBe(1); expect(body.locked).toBe(false); expect(requests).toBe(1);
  expect(traces[0]).toMatchObject({ terminal: "interpretation_timeout" });
}, 500);

test.each(["unexpected", "parent abort", "incomplete result", "invalid JSON", "wrong tool", "preflight"])("interpretation direct boundary: %s", async mode => {
  const parent = new AbortController(), reason = new Error(failureSentinel); const traces: unknown[] = []; let calls = 0;
  const cfg = config((async () => { throw new Error("unexpected fetch"); }) as typeof fetch); cfg.meetingTrace = trace => { traces.push(trace); };
  const run = runMeetingTurn({ config: cfg, model: "test-model", entityId: "entity", messages: [{ role: "user", content: "Summarize it" }], contextWindowTokens: mode === "preflight" ? 1 : 32000, signal: parent.signal,
    modelCall: async () => { calls++; if (mode === "parent abort") parent.abort(reason); if (mode === "unexpected" || mode === "parent abort") throw reason;
      return { content: "", calls: [{ id: "plan", name: mode === "wrong tool" ? "wrong" : "prepare_meeting_turn", args: mode === "invalid JSON" ? "{" : '{"kind":"general"}' }], inline: false, complete: mode !== "incomplete result", promptTokens: 5, completionTokens: 2, completionId: "private-id" }; },
    streamErrorCode: () => undefined,
    capability: async () => { throw new Error("unexpected capability"); }, dispatch: async () => { throw new Error("unexpected dispatch"); }, runGeneral: async () => { throw new Error("unexpected general"); },
    contentFrame: text => text, toolActivityFrame: () => "", delegationErrorFrame: () => "", write: () => {},
  });
  if (mode === "parent abort") { await expect(run).rejects.toBe(reason); expect(traces[0]).toMatchObject({ terminal: "aborted" }); }
  else {
    const code = mode === "unexpected" ? "agent_failed" : mode === "incomplete result" ? "upstream_incomplete" : "interpretation_failed";
    expect(await run).toMatchObject({ errorCode: code, completionId: "", promptTokens: mode === "unexpected" || mode === "preflight" ? 0 : 5 });
    expect(traces[0]).toMatchObject({ terminal: code });
  }
  expect(calls).toBe(mode === "preflight" ? 0 : 1); expect(JSON.stringify(traces)).not.toContain(failureSentinel);
});

function sizedMeetingJson(size: number) {
  const value = { result: { text: "OVERSIZED SENTINEL café 🦋", data: { contractVersion: 2, outcomes: [outcome()] } } };
  value.result.text += "x".repeat(size - JSON.stringify(value).length);
  const json = JSON.stringify(value); expect(json.length).toBe(size); return json;
}

test.each([
  [16000, "crossing chunks"], [16001, "crossing chunks"],
  [16000, "split UTF-8"], [16001, "split UTF-8"],
  [16000, "bodyless"], [16001, "bodyless"],
  [16000, "decoder flush"],
] as const)("guarded tool JSON cap: %s characters via %s", async (size, transport) => {
  const json = sizedMeetingJson(size), bytes = new TextEncoder().encode(json);
  const response = () => {
    if (transport === "bodyless") return { ok: true, status: 200, body: null, json: async () => JSON.parse(json) } as Response;
    return new Response(new ReadableStream<Uint8Array>({ start(c) {
      if (transport === "split UTF-8") { for (const byte of bytes) c.enqueue(Uint8Array.of(byte)); }
      else { c.enqueue(bytes.slice(0, bytes.length - 1)); c.enqueue(bytes.slice(-1)); }
      if (transport === "decoder flush") c.enqueue(Uint8Array.of(0xe2));
      c.close();
    } }));
  };
  const run = await scenario({ kind: "meeting_content", scope: "exact", meetingRef: "meeting-a", purpose: "summary", evidenceRequirement: "overview" }, response);
  const overflow = size > 16000 || transport === "decoder flush";
  expect(run.result.errorCode).toBe(overflow ? "result_size_limit" : undefined);
  expect(run.models).toBe(overflow ? 1 : 3); expect(run.tools).toHaveLength(1);
  expect(run.result.promptTokens).toBe(overflow ? 5 : 15); expect(run.result.completionId).toBe("");
  if (overflow) expect(run.text).not.toContain("green design"); else expect(run.text).toContain("green design");
  expect(run.text).not.toContain("OVERSIZED SENTINEL");
});

test("guarded overflow cancels active siblings, stops queued reads and discards earlier evidence", async () => {
  const frames: string[] = [], traces: any[] = [], requests: any[] = [], reads: string[] = [];
  let models = 0, overflowCancelled = 0, siblingCancelled = 0, releaseOverflow!: () => void;
  const overflowReady = new Promise<void>(resolve => { releaseOverflow = resolve; });
  const overflowBody = new ReadableStream<Uint8Array>({ async start(c) {
    await overflowReady; c.enqueue(new TextEncoder().encode(sizedMeetingJson(16001)));
  }, cancel() { overflowCancelled++; return new Promise(() => {}); } });
  const siblings: ReadableStream<Uint8Array>[] = [];
  const cfg = config((async (input, init) => {
    const url = String(input), body = init?.body ? JSON.parse(String(init.body)) : {}; requests.push(body);
    if (url.endsWith("/capabilities")) return Response.json({ meetingRetrieval: { contractVersion: 2 }, buildRevision: "fixture-v2" });
    if (url.endsWith("/tinycloud_find_meetings")) return wire(Array.from({ length: 8 }, (_, i) => outcome(`meeting-${i}`, "metadata")), discovery(8));
    if (url.includes("/tools/")) {
      const ref = body.args.meetingRef; reads.push(ref);
      if (ref === "meeting-0") return wire([outcome(ref)]);
      if (ref === "meeting-1") return new Response(overflowBody);
      const sibling = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode('{"result":')); }, cancel() { siblingCancelled++; } }); siblings.push(sibling);
      if (ref === "meeting-3") releaseOverflow();
      return new Response(sibling);
    }
    models++; return modelResponse({ kind: "meeting_content", scope: "range", purpose: "summary", evidenceRequirement: "overview" }, true);
  }) as typeof fetch); cfg.meetingTrace = trace => { traces.push(trace); };
  const result = await orchestrateToolCalling({ config: cfg, model: "test-model", messages: [{ role: "user", content: "Summarize meetings" }], entityId: "entity", write: frame => { frames.push(frame); } });
  expect(result).toEqual({ errorCode: "result_size_limit", promptTokens: 5, completionTokens: 2, completionId: "" });
  expect(reads).toEqual(["meeting-0", "meeting-1", "meeting-2", "meeting-3"]); expect(models).toBe(1);
  expect(overflowCancelled).toBe(1); expect(siblingCancelled).toBe(2); expect(overflowBody.locked).toBe(false); expect(siblings.every(body => !body.locked)).toBe(true);
  const activities = frames.flatMap(frame => { try { return JSON.parse(frame.slice(6)).tool_activity ?? []; } catch { return []; } });
  expect(activities.filter(a => a.status === "error")).toHaveLength(3);
  for (const activity of activities.filter(a => a.status === "running")) expect(activities.filter(a => a.id === activity.id && a.status !== "running")).toHaveLength(1);
  expect(traces[0]).toMatchObject({ terminal: "result_size_limit" });
  expect(traces[0].tools.filter((tool: any) => tool.status === "error").every((tool: any) => tool.code === "result_size_limit")).toBe(true);
  expect(JSON.stringify([requests, traces, frames])).not.toContain("OVERSIZED SENTINEL");
  expect(output(frames)).not.toContain("green design"); expect(traces[0]).not.toHaveProperty("packageChars");
}, 500);
