import { describe, expect, test } from "bun:test";
import {
  createMeetingLedger,
  mergeMeetingOutcomes,
  packMeetingEvidence,
  parseMeetingToolData,
  type MeetingOutcome,
} from "../transcripts/meeting-evidence.js";

export function meetingOutcome(ref: string, text = `Discussion in ${ref}`, kind = "summary"): MeetingOutcome {
  return {
    meetingRef: ref, source: "fireflies",
    meeting: { meetingRef: ref, source: "fireflies", title: `Meeting ${ref}`, startedAt: "2026-09-02T14:00:00Z", participants: ["Alex"], organizerEmail: null },
    state: "read", body: { state: "not_requested" },
    search: { state: "not_requested", storedFieldsExamined: false, bodyExamined: false, examinedMatches: 0, retainedMatches: 0 },
    evidence: [{ id: "E1", meetingRef: ref, source: "fireflies", kind: kind as any, text, truncated: false }],
    coverage: { purpose: "summary", overviewPresent: kind === "summary", actionsPresent: kind === "action", bodyAttempted: false, evidenceRetained: 1, omittedEvidenceCount: 0, omissionReasons: [], support: "sufficient" },
  };
}

const budget = { contextWindowTokens: 128_000, contextText: "Question and instructions" };

describe("meeting evidence ledger", () => {
  test("allocates stable meeting and evidence identities without touching literal citations", () => {
    const first = meetingOutcome("a", "Someone literally said [M1] and [M1:E1].");
    const second = meetingOutcome("b", "Separate meeting");
    const original = createMeetingLedger("entity-a/room-a");
    const discovered = mergeMeetingOutcomes(original, [first, second]);
    const inputSnapshot = JSON.stringify(discovered);
    const next = mergeMeetingOutcomes(discovered, [first, meetingOutcome("a", "Different excerpt", "body_excerpt")]);
    const packed = packMeetingEvidence(next, budget);
    expect(original.meetings).toHaveLength(0);
    expect(JSON.stringify(discovered)).toBe(inputSnapshot);
    expect(packed.meetings.map((meeting) => meeting.id)).toEqual(["M1", "M2"]);
    expect(packed.meetings[0].evidence.map((evidence) => evidence.id)).toEqual(["M1:E1", "M1:E2"]);
    expect(packed.meetings[1].evidence[0].id).toBe("M2:E1");
    expect(packed.meetings[0].evidence[0].text).toBe(first.evidence[0].text);
    expect(packed.serialized).not.toContain("entity-a/room-a");
  });

  test("keeps source identities separate despite duplicate titles or references", () => {
    const a = meetingOutcome("same");
    const b = meetingOutcome("same");
    b.source = "fathom"; b.meeting.source = "fathom"; b.evidence[0].source = "fathom";
    const packed = packMeetingEvidence(mergeMeetingOutcomes(createMeetingLedger("context"), [a, b]), budget);
    expect(packed.meetings).toHaveLength(2);
    expect(Object.keys(packed.citations)).toEqual(["M1:E1", "M2:E1"]);
  });

  test("metadata discovery reserves IDs and cannot overwrite a later content outcome", () => {
    const metadata = meetingOutcome("a", "Meeting a", "metadata"); metadata.state = "metadata";
    const read = meetingOutcome("a", "The project launched"); read.body = { state: "present" };
    const ledger = mergeMeetingOutcomes(createMeetingLedger("context"), [metadata, meetingOutcome("b")]);
    const packed = packMeetingEvidence(mergeMeetingOutcomes(mergeMeetingOutcomes(ledger, [read]), [metadata]), budget);
    expect(packed.meetings[0].id).toBe("M1");
    expect(packed.meetings[0].body.state).toBe("present");
    expect(packed.meetings[0].state).toBe("read");
    expect(packed.meetings[0].evidence).toHaveLength(2);
  });

  test("terminal rereads invalidate previous content while preserving allocated IDs", () => {
    const read = meetingOutcome("a", "OLD PRIVATE CONTENT");
    const failed = meetingOutcome("a"); failed.state = "meeting_not_found"; failed.evidence = []; failed.coverage.evidenceRetained = 0;
    const ledger = mergeMeetingOutcomes(createMeetingLedger("context"), [read]);
    const invalidated = mergeMeetingOutcomes(ledger, [failed]);
    const packed = packMeetingEvidence(invalidated, budget);
    expect(packed.citations["M1:E1"]).toBeUndefined();
    expect(packed.serialized).not.toContain("OLD PRIVATE CONTENT");
    const reread = packMeetingEvidence(mergeMeetingOutcomes(invalidated, [read]), budget);
    expect(reread.meetings[0].evidence[0].id).toBe("M1:E1");
  });

  test("a failed body reread cannot preserve an old body passage", () => {
    const body = meetingOutcome("a", "OLD BODY PASSAGE", "body_excerpt"); body.body.state = "present";
    const missing = meetingOutcome("a", "Current stored summary"); missing.body.state = "missing";
    const packed = packMeetingEvidence(mergeMeetingOutcomes(mergeMeetingOutcomes(createMeetingLedger("context"), [body]), [missing]), budget);
    expect(packed.serialized).not.toContain("OLD BODY PASSAGE");
    expect(packed.citations["M1:E1"]).toBeUndefined();
    expect(packed.meetings[0].evidence[0].id).toBe("M1:E2");
  });

  test("a failed body reread also invalidates body-derived notes", () => {
    const notes = meetingOutcome("a", "OLD NOTES BODY", "notes"); notes.body.state = "present";
    notes.evidence[0].offsets = { start: 0, end: notes.evidence[0].text.length };
    const missing = meetingOutcome("a", "Current overview"); missing.body.state = "missing";
    const packed = packMeetingEvidence(mergeMeetingOutcomes(mergeMeetingOutcomes(createMeetingLedger("context"), [notes]), [missing]), budget);
    expect(packed.serialized).not.toContain("OLD NOTES BODY");
  });
});

describe("structured evidence packing", () => {
  test("reserves every meeting outcome, fairly keeps overviews before bodies, and removes dropped citation eligibility", () => {
    const outcomes = Array.from({ length: 8 }, (_, i) => {
      const outcome = meetingOutcome(String(i), `Overview ${i}: ${"useful ".repeat(100)}`);
      outcome.evidence.push({ ...outcome.evidence[0], id: "E2", kind: "body_excerpt", text: `Late body ${i}: ${"body detail ".repeat(2000)}` });
      outcome.coverage.evidenceRetained = 2;
      return outcome;
    });
    const ledger = mergeMeetingOutcomes(createMeetingLedger("context"), outcomes);
    const snapshot = JSON.stringify(ledger);
    const packed = packMeetingEvidence(ledger, { ...budget, maxChars: 18_000 });
    expect(packed.serialized.length).toBeLessThanOrEqual(18_000);
    expect(() => JSON.parse(packed.serialized)).not.toThrow();
    expect(packed.meetings).toHaveLength(8);
    expect(packed.meetings.every((meeting) => meeting.evidence.some((item) => item.kind === "summary"))).toBe(true);
    expect(packed.meetings.every((meeting) => meeting.coverage.omissionReasons.includes("package_budget"))).toBe(true);
    for (const meeting of packed.meetings) {
      for (const evidence of meeting.evidence) expect(packed.citations[evidence.id].meetingId).toBe(meeting.id);
      for (const id of Object.keys(packed.citations).filter((id) => id.startsWith(`${meeting.id}:`))) {
        expect(meeting.evidence.some((item) => item.id === id)).toBe(true);
      }
    }
    expect(JSON.stringify(ledger)).toBe(snapshot);
    expect(packMeetingEvidence(ledger, { ...budget, maxChars: 18_000 })).toEqual(packed);
  });

  test("uses equal body shares and reports shortened windows with corrected offsets", () => {
    const outcomes = [meetingOutcome("a", "a".repeat(20_000), "body_excerpt"), meetingOutcome("b", "b".repeat(20_000), "body_excerpt")];
    for (const outcome of outcomes) outcome.evidence[0].offsets = { start: 100, end: 20_100 };
    const packed = packMeetingEvidence(mergeMeetingOutcomes(createMeetingLedger("context"), outcomes), { ...budget, maxChars: 8_000 });
    const [a, b] = packed.meetings.map((meeting) => meeting.evidence[0]);
    expect(a.truncated).toBe(true);
    expect(b.truncated).toBe(true);
    expect(Math.abs(a.text.length - b.text.length)).toBeLessThan(100);
    expect(a.offsets).toEqual({ start: 100, end: 100 + a.text.length });
  });

  test("keeps a package above 4000 chars intact and obeys the 48000 absolute ceiling", () => {
    const ledger = mergeMeetingOutcomes(createMeetingLedger("context"), [meetingOutcome("a", "x".repeat(80_000))]);
    const packed = packMeetingEvidence(ledger, { ...budget, maxChars: 100_000 });
    expect(packed.serialized.length).toBeGreaterThan(4_000);
    expect(packed.serialized.length).toBeLessThanOrEqual(48_000);
    expect(packed.meetings[0].evidence[0].truncated).toBe(true);
  });

  test("counts external instructions and arguments with the existing estimator and reserves 30 percent", () => {
    const ledger = mergeMeetingOutcomes(createMeetingLedger("context"), [meetingOutcome("a", "x".repeat(20_000))]);
    const packed = packMeetingEvidence(ledger, { contextWindowTokens: 4_000, contextText: "i".repeat(4_000) });
    expect(packed.estimatedTokens).toBeLessThanOrEqual(2_800);
    expect(packed.serialized.length).toBeLessThanOrEqual(7_200);
  });

  test("packing updates retained search matches and purpose support", () => {
    const a = meetingOutcome("a", "x".repeat(20_000), "metadata");
    a.evidence.push({ ...a.evidence[0], id: "E2", kind: "action", text: "Alex will send the email." });
    a.coverage.evidenceRetained = 2; a.search = { state: "matched", storedFieldsExamined: true, bodyExamined: false, examinedMatches: 2, retainedMatches: 2 };
    const packed = packMeetingEvidence(mergeMeetingOutcomes(createMeetingLedger("context"), [a]), { ...budget, maxChars: 2_000 });
    expect(packed.meetings[0].search.retainedMatches).toBe(0);
    expect(packed.meetings[0].coverage.support).toBe("none");
  });

  test("coverage counts attempted bodies, failures and purpose-supported meetings independently", () => {
    const a = meetingOutcome("a"); a.body.state = "unavailable"; a.coverage.bodyAttempted = true;
    const b = meetingOutcome("b"); b.state = "not_read"; b.evidence = []; b.coverage.evidenceRetained = 0;
    const packed = packMeetingEvidence(mergeMeetingOutcomes(createMeetingLedger("context"), [a, b]), budget);
    expect(packed.coverage.bodyAttemptedMeetings).toBe(1);
    expect(packed.coverage.failedMeetings).toBe(1);
    expect(packed.coverage.usableMeetings).toBe(1);
  });

  test("returns an explicit narrow-scope limit when required statuses cannot fit", () => {
    const outcomes = Array.from({ length: 12 }, (_, i) => meetingOutcome(String(i)));
    const packed = packMeetingEvidence(mergeMeetingOutcomes(createMeetingLedger("context"), outcomes), { contextWindowTokens: 200, contextText: "x".repeat(200) });
    expect(packed.limit?.code).toBe("context_limit");
    expect(packed.coverage.admittedMeetings).toBe(12);
    expect(packed.coverage.includedMeetings).toBe(0);
    expect(Object.keys(packed.citations)).toHaveLength(0);
    expect(packed.serialized.length).toBeLessThanOrEqual(360);
  });
});

describe("version 2 service envelope validation", () => {
  test("accepts the additive service wire fields and metadata with structured facts", () => {
    const outcome = meetingOutcome("a", "", "metadata");
    const wire = { ...outcome, search: { ...outcome.search, storedFieldsExamined: false },
      evidence: [{ ...outcome.evidence[0], metadata: outcome.meeting }],
      coverage: { ...outcome.coverage, purpose: "metadata", bodyRequired: false } };
    expect(parseMeetingToolData({ contractVersion: 2, outcomes: [wire] })?.outcomes).toEqual([wire]);
    expect(parseMeetingToolData({ contractVersion: 2, outcomes: [{ ...wire, coverage: { ...wire.coverage, purpose: "transcript" } }] })).not.toBeNull();
  });

  test("the service cannot assert the backend-only selected-scope override", () => {
    const parsed = parseMeetingToolData({ contractVersion: 2, outcomes: [], discovery: {
      matchedCount: 10, countKind: "exact", returnedCount: 0, scanLimited: false, excludedUndatedCount: 0,
      interval: {}, observedAt: "2026-09-09T12:00:00Z", omittedMeetingRefs: [], selectionResolved: true,
    } });
    expect(parsed).not.toBeNull(); expect(parsed?.discovery?.selectionResolved).toBeUndefined();
  });
  test("accepts v2 structured outcomes and rejects cross-record evidence and malformed states", () => {
    const outcome = meetingOutcome("a");
    expect(parseMeetingToolData({ contractVersion: 2, outcomes: [outcome] })?.outcomes).toEqual([outcome]);
    expect(parseMeetingToolData({ contractVersion: 1, outcomes: [outcome] })).toBeNull();
    expect(parseMeetingToolData({ contractVersion: 2, outcomes: [{ ...outcome, body: { state: "gone" } }] })).toBeNull();
    expect(parseMeetingToolData({ contractVersion: 2, outcomes: [{ ...outcome, evidence: [{ ...outcome.evidence[0], meetingRef: "other" }] }] })).toBeNull();
    expect(parseMeetingToolData({ contractVersion: 2, outcomes: [{ ...outcome, coverage: { ...outcome.coverage, evidenceRetained: -1 } }] })).toBeNull();
  });
});
