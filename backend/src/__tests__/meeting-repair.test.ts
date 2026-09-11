import { expect, test } from "bun:test";
import { orchestrateToolCalling, type AgentChatConfig } from "../routes/agent-chat.js";

function response(value: unknown, tool = false) {
  const delta = tool ? { tool_calls: [{ index: 0, id: "plan", function: { name: "prepare_meeting_turn", arguments: JSON.stringify(value) } }] } : { content: JSON.stringify(value) };
  return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`);
}

async function run(draft: unknown, metadata = false) {
  const requests: Array<{ messages: Array<{ role: string; content: string }>; max_tokens: number; reasoning?: { enabled: boolean }; reasoning_effort?: string }> = [];
  const frames: string[] = [];
  const traces: Array<Record<string, unknown>> = [];
  const meeting = { meetingRef: "meeting-a", source: "fireflies", title: "Design", startedAt: "2026-09-01T12:00:00Z", participants: ["Ava", "Ben"], organizerEmail: "ava@example.invalid" };
  const good = { claims: [{ text: metadata ? "Ava and Ben attended." : "The team approved the cobalt rollout.", meetingIds: ["M1"], evidenceIds: ["M1:E1"] }] };
  const fetchImpl = (async (input, init) => {
    const url = String(input);
    if (url.endsWith("/capabilities")) return Response.json({ meetingRetrieval: { contractVersion: 2 }, buildRevision: "fixture-v2" });
    if (url.includes("/tools/")) return Response.json({ result: { data: { contractVersion: 2, outcomes: [{
      meetingRef: "meeting-a", source: "fireflies", meeting, state: metadata ? "metadata" : "read",
      body: { state: "not_requested" }, search: { state: "not_requested", storedFieldsExamined: false, bodyExamined: false, examinedMatches: 0, retainedMatches: 0 },
      evidence: [{ id: "E1", meetingRef: "meeting-a", source: "fireflies", kind: metadata ? "metadata" : "summary", text: metadata ? "" : "The team approved the cobalt rollout.", truncated: false, ...(metadata ? { metadata: meeting } : {}) }],
      coverage: { purpose: metadata ? "metadata" : "summary", overviewPresent: !metadata, actionsPresent: false, bodyAttempted: false, bodyRequired: false, evidenceRetained: 1, omittedEvidenceCount: 0, omissionReasons: [], support: "sufficient" },
    }] } } });
    requests.push(JSON.parse(String(init?.body)));
    if (requests.length === 1) return response(metadata ? { kind: "meeting_metadata", scope: "selected" } : { kind: "meeting_content", scope: "selected", purpose: "summary", evidenceRequirement: "overview" }, true);
    return response(requests.length === 2 ? draft : good);
  }) as typeof fetch;
  const config: AgentChatConfig = { agentId: "agent", entityIdFor: () => "entity", elizaServiceUrl: "https://eliza.test", elizaServiceSecret: "test", redpillApiKey: "test", redpillBaseUrl: "https://model.test", defaultModel: () => "test-model", isModelOffered: () => true, fetchImpl, meetingTrace: trace => { traces.push(trace); }, meetingContentRetrievalEnabled: true, streamPolicy: { heartbeatMs: 100, turnTimeoutMs: 30000, drainGraceMs: 100 } };
  await orchestrateToolCalling({ config, model: "test-model", messages: [{ role: "user", content: metadata ? "Who attended it?" : "Summarize it." }], entityId: "entity", roomId: "room", write: frame => { frames.push(frame); } });
  const answer = frames.flatMap(frame => { try { return JSON.parse(frame.slice(6)).choices?.[0]?.delta?.content ?? ""; } catch { return ""; } }).join("");
  return { requests, answer, traces };
}

test("repair identifies the observed empty evidence IDs without delivering the invalid metadata introduction", async () => {
  const result = await run({ claims: [
    { text: "Design occurred on September 1 with Ava and Ben.", meetingIds: ["M1"], evidenceIds: [] },
    { text: "The team approved the cobalt rollout.", meetingIds: ["M1"], evidenceIds: ["M1:E1"] },
  ] });
  expect(result.requests).toHaveLength(3);
  const instructions = result.requests[1].messages[0].content;
  const feedback = result.requests[2].messages.at(-1)!.content;
  expect(instructions).toContain("nonempty evidenceIds");
  expect(instructions).toContain("For content requests, omit metadata introductions");
  expect(feedback).toContain("claim_0:invalid_shape");
  expect(feedback).toContain("nonempty evidenceIds");
  expect(feedback).not.toContain("Design occurred on September 1");
  expect(result.requests.map(request => request.max_tokens)).toEqual([1024, 2048, 2048]);
  expect(result.answer).toContain("cobalt rollout");
  expect(result.answer).not.toContain("Design occurred on September 1");
});

test("repair error feedback stays within the reserved context and never includes raw failed claims", async () => {
  const result = await run({ claims: Array.from({ length: 24 }, (_, i) => ({ text: `Untrusted failed draft marker ${i}`, meetingIds: ["M1"], evidenceIds: [`unknown-${i}`] })) });
  const feedback = result.requests[2].messages.at(-1)!.content;
  expect(feedback).toContain("claim_0:unknown_evidence");
  expect(feedback).toContain("claim_0:meeting_mismatch");
  expect(feedback.length).toBeLessThanOrEqual(2048);
  expect(feedback).not.toContain("Untrusted failed draft marker");
  expect(result.requests).toHaveLength(3);
});

test("metadata requests can still produce attributed attendance claims", async () => {
  const result = await run({ claims: [{ text: "Ava and Ben attended.", meetingIds: ["M1"], evidenceIds: ["M1:E1"] }] }, true);
  expect(result.requests).toHaveLength(2);
  expect(result.answer).toContain("Ava and Ben attended.");
  expect(result.answer).toContain("[M1:E1]");
});

test("only interpretation disables reasoning while synthesis and repair retain their existing setting and budgets", async () => {
  const result = await run({ claims: [] });
  expect(result.requests).toHaveLength(3);
  expect(result.requests[0].reasoning).toEqual({ enabled: false });
  expect(result.requests[0].reasoning_effort).toBeUndefined();
  for (const request of result.requests.slice(1)) {
    expect(request.reasoning).toBeUndefined();
    expect(request.reasoning_effort).toBe("low");
  }
  expect(result.requests.map(request => request.max_tokens)).toEqual([1024, 2048, 2048]);
});


test("rejected draft traces retain only bounded validator codes, never generated prose or identifiers", async () => {
  const result = await run({ claims: Array.from({ length: 24 }, (_, i) => ({
    text: `Untrusted private-like marker ${i}`,
    meetingIds: [`private-meeting-${i}`], evidenceIds: [`private-evidence-${i}`],
  })) });
  expect(result.traces).toHaveLength(1);
  const trace = result.traces[0];
  expect(trace.draftErrorCodes).toEqual(Array.from({ length: 6 }, (_, i) => [
    `claim_${i}:unknown_evidence`, `claim_${i}:meeting_mismatch`,
  ]).flat());
  expect(trace.repairErrorCodes).toEqual([]);
  const retained = JSON.stringify(trace);
  for (const marker of ["Untrusted private-like", "private-meeting-", "private-evidence-", "meeting-a", "cobalt rollout"]) {
    expect(retained).not.toContain(marker);
  }
});
