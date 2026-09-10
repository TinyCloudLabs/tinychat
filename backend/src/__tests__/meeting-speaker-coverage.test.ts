import { expect, test } from "bun:test";
import { orchestrateToolCalling, type AgentChatConfig } from "../routes/agent-chat.js";
import type { MeetingOutcome, PackedMeetingEvidence } from "../transcripts/meeting-evidence.js";

const question = "Read its transcript and explain the detailed security discussion. What did Ava and Ben actually say?";
const avaText = "We agreed on the cobalt rollout. The detailed security plan uses saffron verification before launch.";
const benText = "I propose an audit. We have not assigned an owner or decided to proceed with it.";
const plan = { kind: "meeting_content", scope: "selected", purpose: "summary", evidenceRequirement: "body" };
const claims = [
  { text: "Ava described saffron verification before launch.", meetingIds: ["M1"], evidenceIds: ["M1:E2"] },
  { text: "Ben proposed an audit with no owner assigned or decision to proceed.", meetingIds: ["M1"], evidenceIds: ["M1:E3"] },
];

function meeting(bodyState: "present" | "unavailable"): MeetingOutcome {
  const source = "fireflies";
  const meetingRef = "synthetic-meeting";
  const evidence: MeetingOutcome["evidence"] = [
    { id: "E1", meetingRef, source, kind: "summary", text: "The team discussed the cobalt rollout.", truncated: false },
  ];
  if (bodyState === "present") evidence.push(
    { id: "E2", meetingRef, source, kind: "transcript_excerpt", text: avaText, speaker: "Ava", startSecs: 60, truncated: false },
    { id: "E3", meetingRef, source, kind: "transcript_excerpt", text: benText, speaker: "Ben", startSecs: 75, truncated: false },
  );
  return {
    meetingRef, source, meeting: { meetingRef, source, title: "Synthetic design meeting", startedAt: "2026-09-09T12:00:00Z", participants: ["Ava", "Ben"], organizerEmail: null },
    state: "read", body: { state: bodyState },
    search: { state: "not_requested", storedFieldsExamined: true, bodyExamined: false, examinedMatches: 0, retainedMatches: 0 },
    evidence, coverage: { purpose: "summary", overviewPresent: true, actionsPresent: false, bodyAttempted: true, bodyRequired: true,
      evidenceRetained: evidence.length, omittedEvidenceCount: 0, omissionReasons: [], support: bodyState === "present" ? "sufficient" : "limited" },
  };
}

function modelResponse(value: unknown, tool = false): Response {
  const delta = tool
    ? { tool_calls: [{ index: 0, id: "plan", function: { name: "prepare_meeting_turn", arguments: JSON.stringify(value) } }] }
    : { content: JSON.stringify(value) };
  return new Response(`data: ${JSON.stringify({ id: "synthetic-completion", choices: [{ delta, finish_reason: tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`);
}

// The provider supplies a canonical plan and draft. These tests exercise actual
// routing, packing, validation and rendering, not the model's interpretation skill.
async function run(bodyState: "present" | "unavailable") {
  const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  const tools: Array<{ name: string; args: Record<string, unknown>; context: Record<string, unknown> }> = [];
  const frames: string[] = [];
  const fetchImpl = (async (input, init) => {
    const url = String(input);
    if (url === "https://eliza.test/capabilities") return Response.json({ meetingRetrieval: { contractVersion: 2 }, buildRevision: "fixture-v2" });
    if (url.startsWith("https://eliza.test/tools/")) {
      const body = JSON.parse(String(init?.body));
      const name = url.split("/").at(-1)!;
      tools.push({ name, args: body.args, context: body.context });
      if (name !== "tinycloud_read_meeting") throw new Error(`Unexpected tool: ${name}`);
      return Response.json({ result: { data: { contractVersion: 2, outcomes: [meeting(bodyState)] } } });
    }
    if (url !== "https://model.test/chat/completions") throw new Error(`Unexpected URL: ${url}`);
    requests.push(JSON.parse(String(init?.body)));
    if (requests.length === 1) return modelResponse(plan, true);
    if (bodyState === "unavailable" || requests.length > 2) throw new Error("Unexpected synthesis or repair");
    return modelResponse({ claims });
  }) as typeof fetch;
  const config: AgentChatConfig = {
    agentId: "agent", entityIdFor: () => "entity", elizaServiceUrl: "https://eliza.test", elizaServiceSecret: "test",
    redpillApiKey: "test", redpillBaseUrl: "https://model.test", defaultModel: () => "test-model", isModelOffered: () => true,
    fetchImpl, meetingTrace: () => {}, meetingContentRetrievalEnabled: true,
    streamPolicy: { heartbeatMs: 100, turnTimeoutMs: 30_000, drainGraceMs: 100 },
  };
  const result = await orchestrateToolCalling({ config, model: "test-model", messages: [{ role: "user", content: question }], entityId: "entity", roomId: "room",
    write: frame => { frames.push(frame); } });
  const answer = frames.flatMap(frame => {
    try { return JSON.parse(frame.slice(6)).choices?.[0]?.delta?.content ?? ""; } catch { return ""; }
  }).join("");
  return { result, requests, tools, answer };
}

test("selected summary/body routing preserves both attributed speakers through synthesis and cited rendering", async () => {
  const result = await run("present");
  expect(result.tools).toHaveLength(1);
  expect(result.tools[0]).toMatchObject({ name: "tinycloud_read_meeting", context: { retrievalMode: "selected" } });
  expect(result.tools[0].args).toEqual({ focus: "summary", includeBody: true });
  expect(result.requests).toHaveLength(2);
  const synthesis = JSON.parse(result.requests[1].messages.at(-1)!.content) as { question: string; request: unknown; evidence: PackedMeetingEvidence };
  expect(synthesis.question).toBe(question);
  expect(synthesis.request).toEqual({ purpose: "summary", evidenceRequirement: "body" });
  const excerpts = synthesis.evidence.meetings[0].evidence.filter(item => item.kind === "transcript_excerpt");
  expect(excerpts.map(({ id, speaker, text, startSecs }) => ({ id, speaker, text, startSecs }))).toEqual([
    { id: "M1:E2", speaker: "Ava", text: avaText, startSecs: 60 },
    { id: "M1:E3", speaker: "Ben", text: benText, startSecs: 75 },
  ]);
  expect(synthesis.evidence.citations["M1:E2"]).toMatchObject({ meetingId: "M1", kind: "transcript_excerpt" });
  expect(synthesis.evidence.citations["M1:E3"]).toMatchObject({ meetingId: "M1", kind: "transcript_excerpt" });
  for (const claim of claims) expect(result.answer).toContain(`${claim.text} [${claim.evidenceIds[0]}]`);
  expect(result.result.errorCode).toBeUndefined();
});

test("unavailable body reports actual coverage without synthesis or invented speaker statements", async () => {
  const result = await run("unavailable");
  expect(result.tools).toHaveLength(1);
  expect(result.tools[0]).toMatchObject({ name: "tinycloud_read_meeting", args: { focus: "summary", includeBody: true }, context: { retrievalMode: "selected" } });
  expect(result.requests).toHaveLength(1);
  expect(result.answer).toContain("The body could not be read because storage was unavailable.");
  expect(result.answer).toContain("The retained evidence does not support the requested level of detail.");
  expect(result.answer).toContain("1 body read(s) attempted");
  expect(result.answer).not.toContain("Ben");
  expect(result.answer).not.toContain("saffron");
  expect(result.answer).not.toContain("audit");
  expect(result.answer).not.toContain("[M1:E2]");
  expect(result.answer).not.toContain("[M1:E3]");
  expect(result.result.errorCode).toBeUndefined();
});
