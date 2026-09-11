import { expect, test } from "bun:test";
import { orchestrateToolCalling, type AgentChatConfig, type ChatMsg } from "../routes/agent-chat.js";

const plan = { kind: "meeting_content", scope: "selected", purpose: "summary", evidenceRequirement: "overview" };
const good = { claims: [{ text: "The team approved the cobalt rollout.", meetingIds: ["M1"], evidenceIds: ["M1:E1"] }] };
function response(value: unknown, tool = true) {
  const delta = tool ? { tool_calls: [{ index: 0, id: "plan", function: { name: "prepare_meeting_turn", arguments: JSON.stringify(value) } }] } : { content: JSON.stringify(value) };
  return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`);
}
async function run(replies: Array<Response | (() => Promise<Response>)>, options: { signal?: AbortSignal; remainingMs?: () => number; messages?: ChatMsg[] } = {}) {
  const requests: any[] = [], tools: any[] = [], frames: string[] = [], traces: any[] = [];
  const fetchImpl = (async (input, init) => {
    const url = String(input);
    if (url.endsWith("/capabilities")) return Response.json({ meetingRetrieval: { contractVersion: 2 }, buildRevision: "fixture-v2" });
    if (url.includes("/tools/")) {
      tools.push({ name: url.split("/").pop(), ...JSON.parse(String(init?.body)) });
      if (url.endsWith("web_search")) return Response.json({ result: { text: "Public fact.", data: { results: [] } } });
      return Response.json({ result: { data: { contractVersion: 2, outcomes: [{
        meetingRef: "meeting-a", source: "fireflies", meeting: { meetingRef: "meeting-a", source: "fireflies", title: "Design", startedAt: "2026-09-09T12:00:00Z", participants: ["Ava", "Ben"], organizerEmail: "ava@example.invalid" }, state: "read",
        body: { state: "not_requested" }, search: { state: "not_requested", storedFieldsExamined: false, bodyExamined: false, examinedMatches: 0, retainedMatches: 0 },
        evidence: [{ id: "E1", meetingRef: "meeting-a", source: "fireflies", kind: "summary", text: "The team approved the cobalt rollout.", truncated: false }],
        coverage: { purpose: "summary", overviewPresent: true, actionsPresent: false, bodyAttempted: false, bodyRequired: false, evidenceRetained: 1, omittedEvidenceCount: 0, omissionReasons: [], support: "sufficient" },
      }] } } });
    }
    requests.push(JSON.parse(String(init?.body)));
    const reply = replies[requests.length - 1];
    if (!reply) throw new Error("Unexpected extra model request");
    return typeof reply === "function" ? reply() : reply;
  }) as typeof fetch;
  const config: AgentChatConfig = { agentId: "agent", entityIdFor: () => "entity", elizaServiceUrl: "https://eliza.test", elizaServiceSecret: "test", redpillApiKey: "test", redpillBaseUrl: "https://model.test", defaultModel: () => "test-model", isModelOffered: () => true, fetchImpl, meetingTrace: trace => { traces.push(trace); }, meetingContentRetrievalEnabled: true, streamPolicy: { heartbeatMs: 100, turnTimeoutMs: 30000, drainGraceMs: 100 } };
  const result = await orchestrateToolCalling({ config, model: "test-model", messages: options.messages ?? [{ role: "user", content: "Summarize that meeting's decisions and action items." }], entityId: "entity", roomId: "room", signal: options.signal, remainingMs: options.remainingMs, write: frame => { frames.push(frame); } });
  const answer = frames.flatMap(frame => { try { return JSON.parse(frame.slice(6)).choices?.[0]?.delta?.content ?? ""; } catch { return ""; } }).join("");
  return { result, requests, tools, answer, traces };
}

test.each([
  ["historically observed empty argument object", {}, "kind"],
  ["missing overview requirement", { kind: "meeting_content", scope: "selected", purpose: "summary" }, "evidenceRequirement"],
])("corrects %s using original UI context and exact feedback before retrieval", async (_name, invalid, field) => {
  const messages: ChatMsg[] = [{ role: "system", content: "Synthetic memory block." }, { role: "user", content: "Summarize the latest local demo design meeting." }, { role: "assistant", content: "Prior cited recap [M1]." }, { role: "user", content: "Summarize that meeting's decisions and action items." }];
  const r = await run([response(invalid), response(plan), response(good, false)], { messages });
  expect(r.result.errorCode).toBeUndefined();
  expect(r.requests).toHaveLength(3); expect(r.result.promptTokens).toBe(15); expect(r.result.completionTokens).toBe(6);
  expect(r.requests[1].messages.slice(1, -1)).toEqual(messages);
  expect(r.requests[1].messages.at(-1).content).toContain(field);
  expect(r.requests[1].tool_choice.function.name).toBe("prepare_meeting_turn");
  expect(r.tools.map(t => t.name)).toEqual(["tinycloud_read_meeting"]);
  expect(r.tools[0].args.meetingRef).toBeUndefined(); expect(r.tools[0].context.retrievalMode).toBe("selected");
  expect(r.answer).toContain("[M1:E1]"); expect(r.answer).toContain("cobalt rollout");
});

test("one invalid correction fails as model output without retrieval or raw plan leakage", async () => {
  const r = await run([response({ kind: "meeting_content", privateSentinel: "PRIVATE PLAN VALUE" }), response({})]);
  expect(r.requests).toHaveLength(2); expect(r.tools).toHaveLength(0); expect(r.result.promptTokens).toBe(10);
  expect(r.result.errorCode).toBe("interpretation_failed"); expect(r.answer).toContain("model"); expect(r.answer).not.toMatch(/specify|rephrase/i);
  expect(JSON.stringify([r.traces, r.requests[1].messages, r.answer])).not.toContain("PRIVATE PLAN VALUE");
});

test("a correction consumes the existing answer repair allowance", async () => {
  const r = await run([response({}), response(plan), response({ claims: [{ text: "UNSUPPORTED CLAIM", meetingIds: ["M1"], evidenceIds: [] }] }, false)]);
  expect(r.requests).toHaveLength(3); expect(r.result.errorCode).toBeUndefined();
  expect(r.traces[0].terminal).toBe("validation_fallback"); expect(r.answer).not.toContain("UNSUPPORTED CLAIM"); expect(r.answer).toContain("cobalt rollout");
});

test("a genuine clarification is successful content with no correction", async () => {
  const r = await run([response({ kind: "clarify", question: "Which meeting do you mean?" })]);
  expect(r.requests).toHaveLength(1); expect(r.tools).toHaveLength(0); expect(r.result.errorCode).toBeUndefined(); expect(r.answer).toBe("Which meeting do you mean?");
});

test.each([false, true])("HTTP 429 remains terminal without transport retry (after correction: %s)", async correction => {
  const r = await run([...(correction ? [response({})] : []), new Response("rate limited", { status: 429 })]);
  expect(r.requests).toHaveLength(correction ? 2 : 1); expect(r.tools).toHaveLength(0); expect(r.result.errorCode).toBe("upstream_failed"); expect(r.result.promptTokens).toBe(correction ? 5 : 0);
});

test("correction shares the original interpretation deadline and cancels its response", async () => {
  let cancelled = 0;
  const pending = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(": waiting\n\n")); }, cancel() { cancelled++; } });
  const start = Date.now();
  const r = await run([async () => { await Bun.sleep(90); return response({}); }, new Response(pending)], { remainingMs: () => 1000 });
  expect(r.requests).toHaveLength(2); expect(r.result.errorCode).toBe("interpretation_timeout"); expect(r.result.promptTokens).toBe(5); expect(cancelled).toBe(1);
  expect(Date.now() - start).toBeLessThan(270); expect(r.tools).toHaveLength(0);
});

test("cancellation during correction never retrieves or sends a third request", async () => {
  const parent = new AbortController(); const reason = new Error("cancelled by test");
  const correction = async () => { parent.abort(reason); return response(plan); };
  await expect(run([response({}), correction], { signal: parent.signal })).rejects.toBe(reason);
});

test("corrected general intent keeps the four-request ceiling and only public tools", async () => {
  const search = () => new Response(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "web", function: { name: "web_search", arguments: '{"query":"public fact"}' } }] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
  const r = await run([response({}), response({ kind: "general" }), search(), response("Public fact.", false)]);
  expect(r.requests).toHaveLength(4); expect(r.result.errorCode).toBeUndefined(); expect(r.tools.map(t => t.name)).toEqual(["web_search"]);
  expect(r.requests[2].tools.map((t: any) => t.function.name)).toEqual(["web_search"]);
  expect(r.requests[3].tools).toBeUndefined(); expect(r.requests[3].messages[0].content).toContain("public-web results");
});

test("an exhausted turn budget prevents sending the correction at all", async () => {
  let budgetReads = 0;
  const r = await run([response({}), response(plan)], { remainingMs: () => ++budgetReads <= 2 ? 1000 : 0 });
  expect(r.requests).toHaveLength(1); expect(r.tools).toHaveLength(0);
  expect(r.result.errorCode).toBe("interpretation_timeout"); expect(r.result.promptTokens).toBe(5);
});

test("failed correction records both interpretation requests in the trace", async () => {
  const r = await run([response({}), new Response("unavailable", { status: 503 })]);
  expect(r.traces[0].interpretationCalls).toBe(2);
});
