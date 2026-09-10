import { describe, expect, test } from "bun:test";
import { estimateTokens } from "../lib/contextGuard.js";
import type { AgentChatConfig, ChatMsg } from "../routes/agent-chat.js";
import { parseMeetingToolData, type MeetingOutcome, type PackedMeetingEvidence } from "../transcripts/meeting-evidence.js";
import { runMeetingTurn, type MeetingModelRequest } from "../transcripts/meeting-turn.js";

// These are deterministic controller/request-sizing checks. Scripted replies and
// chars/4 estimates do not qualify any provider's tokenizer, context or grounding.
type EvidencePackage = Omit<PackedMeetingEvidence, "serialized" | "estimatedTokens">;
type CapturedRequest = Omit<MeetingModelRequest, "signal">;

function fact(index: number): string {
  return `Meeting ${index + 1} selected cobalt-${index + 1} for release.`;
}

function meeting(index: number): MeetingOutcome {
  const meetingRef = `synthetic-meeting-${index + 1}`;
  const identity = { meetingRef, source: "fireflies" };
  const overview = `${fact(index)} ${'Snow 雪, emoji 🙂, path C:\\notes\\, and "quoted words". '.repeat(100)}`;
  const body = `BODY-ONLY-${index + 1}: The separate delivery date is October ${index + 1}. ${'Detailed sentence with \\ and "escaping". '.repeat(110)}`;
  return {
    ...identity,
    meeting: { ...identity, title: `Design ${index + 1}`, startedAt: "2026-09-01T12:00:00Z", participants: [`Person ${index + 1}`], organizerEmail: null },
    state: "read",
    body: { state: "present" },
    search: { state: "not_requested", storedFieldsExamined: true, bodyExamined: true, examinedMatches: 0, retainedMatches: 0 },
    evidence: [
      { ...identity, id: "E1", kind: "summary", text: overview, truncated: false },
      { ...identity, id: "E2", kind: "transcript_excerpt", text: body, speaker: `Person ${index + 1}`, offsets: { start: 0, end: body.length }, truncated: false },
    ],
    coverage: { purpose: "summary", overviewPresent: true, actionsPresent: false, bodyAttempted: true, bodyRequired: true, evidenceRetained: 2, omittedEvidenceCount: 0, omissionReasons: [], support: "sufficient" },
  };
}

function evidenceFrom(request: CapturedRequest): EvidencePackage {
  return JSON.parse(request.messages[1].content).evidence;
}

function measure(request: CapturedRequest) {
  const tools = request.tool ? [request.tool] : [];
  const wire = JSON.stringify({ messages: request.messages, ...(tools.length ? { tools } : {}) });
  return {
    // Providers receive the decoded contents; outer HTTP JSON escaping is
    // measured separately instead of being mistaken for model input tokens.
    estimatedInputTokens: request.messages.reduce((sum, message) => sum + estimateTokens(message.content), 0)
      + (tools.length ? estimateTokens(JSON.stringify(tools)) : 0),
    serializedChars: wire.length,
    serializedBytes: Buffer.byteLength(wire),
  };
}

async function scenario(options: {
  contextWindowTokens: number;
  messages?: ChatMsg[];
  requireBody?: boolean;
  failRepair?: boolean;
}) {
  const outcomes = Array.from({ length: 12 }, (_, index) => meeting(index));
  const snapshot = JSON.stringify(outcomes);
  const requests: CapturedRequest[] = [];
  const tools: Array<{ name: string; args: Record<string, unknown> }> = [];
  const serviceSizes: number[] = [];
  const answers: string[] = [];
  const traces: Record<string, unknown>[] = [];
  let capabilityCalls = 0;
  const config: AgentChatConfig = {
    agentId: "synthetic-agent", entityIdFor: () => "synthetic-entity",
    elizaServiceUrl: "https://synthetic.invalid", elizaServiceSecret: "synthetic-unused",
    redpillApiKey: "synthetic-unused", redpillBaseUrl: "https://synthetic.invalid",
    defaultModel: () => "synthetic-context-model", isModelOffered: () => true,
    fetchImpl: (async () => { throw new Error("External requests are forbidden in this fixture"); }) as typeof fetch,
    meetingTrace: trace => { traces.push(trace); }, meetingContentRetrievalEnabled: true,
    streamPolicy: { heartbeatMs: 100, turnTimeoutMs: 30_000, drainGraceMs: 100 },
  };
  const result = await runMeetingTurn({
    config, model: "synthetic-context-model", entityId: "synthetic-entity", roomId: "synthetic-room",
    turnContext: { localDate: "2026-09-09", timeZone: "Europe/Lisbon" },
    contextWindowTokens: options.contextWindowTokens,
    messages: options.messages ?? [{ role: "user", content: "Summarize the meetings from September 1 to September 6." }],
    capability: async () => { capabilityCalls++; return { meetingRetrieval: { contractVersion: 2 }, buildRevision: "synthetic-fixture-v2" }; },
    runGeneral: async () => { throw new Error("A meeting request must not enter general chat"); },
    write: () => {},
    contentFrame: text => { answers.push(text); return text; },
    toolActivityFrame: () => "",
    delegationErrorFrame: () => { throw new Error("No fixture changes access"); },
    dispatch: async (name, args) => {
      tools.push({ name, args: structuredClone(args) });
      const found = name === "tinycloud_find_meetings";
      expect(found || name === "tinycloud_read_meeting").toBe(true);
      const selected = found ? outcomes.map(outcome => ({
        ...outcome, state: "metadata", body: { state: "not_requested" }, evidence: [],
        search: { ...outcome.search, bodyExamined: false },
        coverage: { ...outcome.coverage, purpose: "metadata", bodyAttempted: false, bodyRequired: false, evidenceRetained: 0 },
      })) : outcomes.filter(outcome => outcome.meetingRef === args.meetingRef);
      const wire = JSON.stringify({ result: { text: "LEGACY-ONLY: Never use this prose as meeting evidence.", data: {
        contractVersion: 2, outcomes: selected,
        ...(found ? { discovery: {
          matchedCount: 15, countKind: "exact", returnedCount: 12, scanLimited: false, orderProven: true, excludedUndatedCount: 0,
          interval: { from: "2026-09-01", to: "2026-09-06" }, observedAt: "2026-09-09T12:00:00Z",
          omittedMeetingRefs: ["synthetic-omitted-13", "synthetic-omitted-14", "synthetic-omitted-15"],
        } } : {}),
      } } });
      serviceSizes.push(wire.length);
      const decoded = JSON.parse(wire);
      const data = parseMeetingToolData(decoded.result.data);
      expect(data).not.toBeNull();
      if (!data) throw new Error("Invalid synthetic v2 service envelope");
      return { status: "done", text: decoded.result.text, data };
    },
    modelCall: async request => {
      const { signal: _signal, ...captured } = request;
      requests.push(structuredClone(captured));
      const base = { completionId: `synthetic-${request.phase}`, promptTokens: 7, completionTokens: 3, inline: false, complete: true };
      if (request.phase === "model") return { ...base, content: "", calls: [{ id: "plan", name: "prepare_meeting_turn", args: JSON.stringify({
        kind: "meeting_content", scope: "range", from: "2026-09-01", to: "2026-09-06", purpose: "summary", evidenceRequirement: options.requireBody ? "body" : "overview",
      }) }] };
      const evidence = evidenceFrom(captured);
      const invalid = { claims: [{ text: "INVALID-DRAFT: The dropped delivery date is October 1.", meetingIds: ["M1"], evidenceIds: ["M1:E2"] }] };
      const valid = { claims: evidence.meetings.map((item, index) => ({ text: fact(index), meetingIds: [item.id], evidenceIds: [`${item.id}:E1`] })) };
      return { ...base, calls: [], content: JSON.stringify(request.phase === "synthesis" || options.failRepair ? invalid : valid) };
    },
  });
  expect(JSON.stringify(outcomes)).toBe(snapshot);
  return { requests, tools, serviceSizes, answer: answers.join(""), trace: traces[0], result, capabilityCalls };
}

describe("meeting controller near estimated context limits", () => {
  test.each([16_000, 128_000])("twelve meetings preserve distinct overview citations and repair within a %i-token context", async contextWindowTokens => {
    const messages: ChatMsg[] = [
      { role: "user", content: "Earlier context. ".repeat(1_200) },
      { role: "assistant", content: "Prior discussion. ".repeat(500) },
      { role: "user", content: `Summarize the meetings from September 1 to September 6. ${"Additional scope context. ".repeat(200)}` },
    ];
    const run = await scenario({ contextWindowTokens, messages });
    expect(run.requests.map(request => request.phase)).toEqual(["model", "synthesis", "repair"]);
    expect(run.requests.map(request => request.maxOutputTokens)).toEqual([1024, 2048, 2048]);
    expect(run.tools.map(tool => tool.name)).toEqual(["tinycloud_find_meetings", ...Array(12).fill("tinycloud_read_meeting")]);
    expect(new Set(run.tools.slice(1).map(tool => tool.args.meetingRef)).size).toBe(12);
    expect(Math.max(...run.serviceSizes)).toBeLessThanOrEqual(16_000);
    const packed = evidenceFrom(run.requests[1]);
    expect(packed.meetings).toHaveLength(12);
    expect(packed.coverage).toMatchObject({ admittedMeetings: 12, includedMeetings: 12, omittedMeetings: 3 });
    const packageChars = JSON.stringify(packed).length;
    expect(packageChars).toBeGreaterThan(25_000);
    expect(packageChars).toBeLessThanOrEqual(48_000);
    expect(run.trace.packageChars).toBe(packageChars);
    if (contextWindowTokens === 128_000) expect(packageChars).toBeGreaterThan(47_900);
    else {
      expect(measure(run.requests[0]).estimatedInputTokens).toBeGreaterThan(contextWindowTokens * 0.55);
      expect(measure(run.requests[1]).estimatedInputTokens).toBeGreaterThan(contextWindowTokens * 0.65);
    }
    for (const request of run.requests) {
      const sizing = measure(request);
      expect(sizing.estimatedInputTokens).toBeLessThanOrEqual(Math.floor(contextWindowTokens * 0.7));
      expect(sizing.estimatedInputTokens + request.maxOutputTokens).toBeLessThan(contextWindowTokens);
      expect(sizing.serializedBytes).toBeGreaterThanOrEqual(sizing.serializedChars);
    }
    expect(measure(run.requests[1]).serializedBytes).toBeGreaterThan(measure(run.requests[1]).serializedChars);
    expect(run.requests[1].tool).toBeUndefined();
    expect(run.requests[2].tool).toBeUndefined();
    expect(evidenceFrom(run.requests[2])).toEqual(packed);
    expect(run.requests[2].messages.slice(0, 2)).toEqual(run.requests[1].messages);
    const feedback = run.requests[2].messages.at(-1)!.content;
    expect(feedback).toContain("unknown_evidence");
    expect(feedback.length).toBeLessThanOrEqual(2048);
    expect(feedback).not.toContain("INVALID-DRAFT");
    for (const [index, item] of packed.meetings.entries()) {
      expect(item.evidence).toHaveLength(1);
      expect(item.evidence[0].text).toStartWith(fact(index));
      expect(item.evidence[0].text).toContain('C:\\notes\\, and "quoted words"');
      expect(item.evidence[0].truncated).toBe(true);
      expect(item.coverage).toMatchObject({ support: "limited", omittedEvidenceCount: 2 });
      expect(item.coverage.omissionReasons).toContain("package_budget");
      expect(packed.citations[`${item.id}:E1`]).toMatchObject({ meetingId: item.id, kind: "summary" });
      expect(packed.citations[`${item.id}:E2`]).toBeUndefined();
      expect(run.answer).toContain(`${fact(index)} [${item.id}:E1]`);
      expect(run.answer).not.toContain(`[${item.id}:E2]`);
    }
    expect(Object.keys(packed.citations)).toHaveLength(12);
    expect(JSON.stringify(packed)).not.toContain("BODY-ONLY");
    expect(JSON.stringify(run.requests)).not.toContain("LEGACY-ONLY");
    expect(run.answer).not.toMatch(/INVALID-DRAFT|BODY-ONLY|delivery date/);
    expect(run.answer).toContain("3 meeting(s) omitted");
    expect(run.answer.match(/to fit the answer context/g)).toHaveLength(12);
    expect(run.trace.terminal).toBe("validated_answer");
    expect(run.result).toMatchObject({ promptTokens: 21, completionTokens: 9 });
  });

  test("failed repair falls back only to retained evidence with explicit omissions", async () => {
    const run = await scenario({ contextWindowTokens: 16_000, failRepair: true });
    expect(run.requests.map(request => request.phase)).toEqual(["model", "synthesis", "repair"]);
    expect(run.trace.terminal).toBe("validation_fallback");
    expect(run.answer).toContain("Stored overview");
    expect(run.answer).toContain("to fit the answer context");
    expect(run.answer).not.toMatch(/BODY-ONLY|INVALID-DRAFT|LEGACY-ONLY|\[M\d+:E2\]/);
    expect(evidenceFrom(run.requests[2])).toEqual(evidenceFrom(run.requests[1]));
  });

  test("a body request with only overviews retained stops before synthesis and explains the lost detail", async () => {
    const run = await scenario({ contextWindowTokens: 16_000, requireBody: true });
    expect(run.requests.map(request => request.phase)).toEqual(["model"]);
    expect(run.tools.slice(1).every(tool => tool.args.includeBody === true)).toBe(true);
    expect(run.trace.terminal).toBe("no_usable_evidence");
    expect(run.answer).toContain("Stored overview");
    expect(run.answer).toContain("does not support the requested level of detail");
    expect(run.answer).toContain("to fit the answer context");
    expect(run.answer).not.toMatch(/BODY-ONLY|INVALID-DRAFT|\[M\d+:E2\]/);
  });

  test("insufficient room for all twelve identities produces a narrowing response without synthesis", async () => {
    const run = await scenario({ contextWindowTokens: 4_000 });
    expect(run.requests.map(request => request.phase)).toEqual(["model"]);
    expect(run.tools).toHaveLength(13);
    expect(run.trace).toMatchObject({ planned: 12, retained: 0, terminal: "context_limit" });
    expect(run.answer).toContain("fewer meetings or a narrower date range");
    expect(run.answer).not.toMatch(/cobalt-|BODY-ONLY|\[M\d/);
  });

  test("an oversized protected question stops before interpretation or private retrieval", async () => {
    const run = await scenario({ contextWindowTokens: 4_000, messages: [{ role: "user", content: "Scope context. ".repeat(1_000) }] });
    expect(run.requests).toHaveLength(0);
    expect(run.tools).toHaveLength(0);
    expect(run.capabilityCalls).toBe(0);
    expect(run.result.errorCode).toBe("interpretation_failed");
    expect(run.answer).toContain("shorten the conversation");
  });
});
