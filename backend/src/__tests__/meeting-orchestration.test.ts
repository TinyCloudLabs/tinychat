import { expect, test } from "bun:test";
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
  expect(result.errorCode).toBe("interpretation_failed"); expect(requests).toBe(1);
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
test("revocation during fan-out stops scheduling and suppresses every private result", async () => {
  const run = await scenario({ kind: "meeting_content", scope: "range", purpose: "summary", evidenceRequirement: "overview" }, async (name, body) => {
    if (name === "tinycloud_find_meetings") return wire(Array.from({ length: 8 }, (_, i) => outcome(`meeting-${i}`, "metadata")), discovery(8));
    if (body.args.meetingRef === "meeting-0") return Response.json({ error: "delegation_expired" }, { status: 409 });
    await new Promise(resolve => setTimeout(resolve, 10)); return wire([outcome(body.args.meetingRef)]);
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
