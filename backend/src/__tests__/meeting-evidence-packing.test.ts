import { expect, test } from "bun:test";
import { createMeetingLedger, mergeMeetingOutcomes, packMeetingEvidence, type MeetingOutcome, type PackedMeetingEvidence } from "../transcripts/meeting-evidence.js";

function outcome(ref: string, kind = "summary", text = `${ref} approved a different launch date.`): MeetingOutcome {
  return {
    meetingRef: ref, source: "fireflies", meeting: { meetingRef: ref, source: "fireflies", title: `${ref} design`, startedAt: "2026-09-02T14:00:00Z", participants: ["Alex"], organizerEmail: null },
    state: "read", body: { state: "not_requested" }, search: { state: "not_requested", storedFieldsExamined: false, bodyExamined: false, examinedMatches: 0, retainedMatches: 0 },
    evidence: [{ id: "E1", meetingRef: ref, source: "fireflies", kind: kind as any, text, truncated: false }],
    coverage: { purpose: "summary", overviewPresent: kind === "summary", actionsPresent: kind === "action", bodyAttempted: false, evidenceRetained: 1, omittedEvidenceCount: 0, omissionReasons: [], support: "sufficient" },
  };
}
function pack(outcomes = [outcome("A"), outcome("B")], maxChars?: number): PackedMeetingEvidence {
  return packMeetingEvidence(mergeMeetingOutcomes(createMeetingLedger("entity/room"), outcomes), { contextWindowTokens: 128_000, contextText: "Instructions", maxChars });
}

test("packing drops an oversized item so it cannot be cited", () => {
  const a = outcome("A"); a.evidence.push({ ...a.evidence[0], id: "E2", kind: "metadata", text: "DROP-ME".repeat(10_000) });
  a.coverage.evidenceRetained = 2;
  const packed = pack([a], 2_000);
  expect(packed.citations["M1:E2"]).toBeUndefined();
});

test("a proven single selection does not count its other discovery candidates as omitted meetings", () => {
  const ledger = mergeMeetingOutcomes(createMeetingLedger("entity/room"), [outcome("A")], {
    matchedCount: 15, countKind: "lower_bound", returnedCount: 12, scanLimited: true, excludedUndatedCount: 0,
    orderProven: true, selectionResolved: true, interval: {}, observedAt: "2026-09-09T12:00:00Z", omittedMeetingRefs: ["other"],
  });
  const packed = packMeetingEvidence(ledger, { contextWindowTokens: 128_000, contextText: "Instructions" });
  expect(packed.coverage.omittedMeetings).toBe(0);
});
