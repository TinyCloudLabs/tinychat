import { describe, expect, test } from "bun:test";
import { createMeetingLedger, mergeMeetingOutcomes, packMeetingEvidence, type MeetingOutcome, type PackedMeetingEvidence } from "../transcripts/meeting-evidence.js";
import { hasUsableMeetingEvidence, renderMeetingAnswer, renderMeetingEvidenceFallback, validateMeetingDraft } from "../transcripts/meeting-answer.js";

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
const claim = (text = "The launch date changed.", meetingIds = ["M1"], evidenceIds = ["M1:E1"]) => ({ text, meetingIds, evidenceIds });
function summaryWithAction(ref: string): MeetingOutcome {
  const meeting = outcome(ref);
  meeting.evidence.push({ ...meeting.evidence[0], id: "E2", kind: "action", text: "Alex will ship the release Friday." });
  meeting.coverage.actionsPresent = true;
  meeting.coverage.evidenceRetained = 2;
  return meeting;
}

describe("meeting draft validation", () => {
  test("accepts only bounded structured factual blocks with retained evidence", () => {
    const packed = pack();
    expect(validateMeetingDraft({ claims: [claim()] }, packed, "summary").valid).toBe(true);
    expect(validateMeetingDraft(JSON.stringify({ claims: [claim()] }), packed, "summary").valid).toBe(true);
    for (const draft of [null, {}, { claims: [] }, { claims: [claim("Uncited", ["M1"], [])] }, { claims: [claim("Invented", ["M1"], ["M1:E99"])] }, { claims: [claim()], availability: "No transcript" }, { claims: [claim("x".repeat(2_001))] }]) {
      expect(validateMeetingDraft(draft, packed, "summary").valid).toBe(false);
    }
  });

  test("rejects cross-meeting mismatches and requires every declared meeting's evidence", () => {
    const packed = pack();
    expect(validateMeetingDraft({ claims: [claim("Both meetings changed dates.", ["M1", "M2"], ["M1:E1", "M2:E1"])] }, packed, "summary").valid).toBe(true);
    expect(validateMeetingDraft({ claims: [claim("B changed dates.", ["M2"], ["M1:E1"])] }, packed, "summary").valid).toBe(false);
    expect(validateMeetingDraft({ claims: [claim("Both changed.", ["M1", "M2"], ["M1:E1"])] }, packed, "summary").valid).toBe(false);
    expect(validateMeetingDraft({ claims: [claim("A changed.", ["M1"], ["M1:E1", "M2:E1"])] }, packed, "summary").valid).toBe(false);
  });

  test("metadata supports metadata only and cannot satisfy content or availability claims", () => {
    const meta = outcome("A", "metadata", "A design on September 2"); meta.coverage.purpose = "metadata";
    const packed = pack([meta]);
    expect(hasUsableMeetingEvidence(packed, "summary")).toBe(false);
    expect(validateMeetingDraft({ claims: [claim("The meeting was on September 2.")] }, packed, "metadata").valid).toBe(true);
    expect(validateMeetingDraft({ claims: [claim()] }, packed, "summary").valid).toBe(false);
    expect(validateMeetingDraft({ claims: [claim("There is no transcript available.")] }, packed, "metadata").valid).toBe(false);
    expect(validateMeetingDraft({ claims: [claim("This covers all your meetings.")] }, pack(), "summary").valid).toBe(false);
  });

  test("detailed body and speaker requests reject overview or unattributed evidence", () => {
    expect(hasUsableMeetingEvidence(pack([outcome("A")]), { purpose: "summary", evidenceRequirement: "body" })).toBe(false);
    expect(validateMeetingDraft({ claims: [claim()] }, pack([outcome("A")]), { purpose: "summary", evidenceRequirement: "body" }).valid).toBe(false);
    const body = outcome("A", "transcript_excerpt", "We agreed to launch Friday.");
    expect(validateMeetingDraft({ claims: [claim()] }, pack([body]), { purpose: "summary", evidenceRequirement: "body" }).valid).toBe(true);
    expect(hasUsableMeetingEvidence(pack([body]), "speaker")).toBe(false);
    body.evidence[0].speaker = "Alex";
    expect(hasUsableMeetingEvidence(pack([body]), "speaker")).toBe(true);
    body.evidence[0].kind = "notes";
    expect(hasUsableMeetingEvidence(pack([body]), "speaker")).toBe(false);
  });

  test("stored actions remain available after body failure but do not establish a discussion recap", () => {
    const action = outcome("A", "action", "Alex: ship the release Friday."); action.body = { state: "missing" };
    const packed = pack([action]);
    expect(hasUsableMeetingEvidence(packed, "summary")).toBe(false);
    expect(hasUsableMeetingEvidence(packed, { purpose: "actions", evidenceRequirement: "body" })).toBe(true);
    expect(renderMeetingEvidenceFallback(packed, "summary")).toContain("Alex: ship the release Friday.");
    expect(renderMeetingEvidenceFallback(packed, "summary")).toContain("Stored action");
    expect(renderMeetingEvidenceFallback(packed, "summary")).toContain("body is missing");
  });

  test("overview recaps accept supplementary actions with recap evidence cited in the same draft", () => {
    const packed = pack([summaryWithAction("A")]);
    const overview = claim();
    const action = claim("Alex will ship the release Friday.", ["M1"], ["M1:E2"]);
    for (const claims of [[overview, action], [action, overview]]) {
      expect(validateMeetingDraft({ claims }, packed, { purpose: "summary", evidenceRequirement: "overview" }).valid).toBe(true);
      expect(validateMeetingDraft({ claims }, packed, "summary").valid).toBe(true);
    }
    const answer = renderMeetingAnswer({ claims: [overview, action] }, packed, "summary");
    expect(answer).toContain("Alex will ship the release Friday. [M1:E2]");
  });

  test("action-only drafts do not become recaps even when an unused overview was retained", () => {
    const packed = pack([summaryWithAction("A")]);
    expect(hasUsableMeetingEvidence(packed, "summary")).toBe(true);
    expect(validateMeetingDraft({ claims: [claim("Alex will ship Friday.", ["M1"], ["M1:E2"])] }, packed, "summary"))
      .toEqual({ valid: false, errors: ["claim_0:wrong_evidence_kind"] });
    const actionsOnly = pack([outcome("A", "action", "Alex will ship Friday.")]);
    expect(hasUsableMeetingEvidence(actionsOnly, "summary")).toBe(false);
    expect(validateMeetingDraft({ claims: [claim("Alex will ship Friday.")] }, actionsOnly, "summary").valid).toBe(false);
  });

  test("supplementary action claims require recap citations for their own meeting", () => {
    const packed = pack([summaryWithAction("A"), summaryWithAction("B")]);
    const overviewA = claim();
    const overviewB = claim("B changed its launch date.", ["M2"], ["M2:E1"]);
    const actionB = claim("Alex will ship Friday.", ["M2"], ["M2:E2"]);
    expect(validateMeetingDraft({ claims: [overviewA, actionB] }, packed, "summary"))
      .toEqual({ valid: false, errors: ["claim_1:wrong_evidence_kind"] });
    expect(validateMeetingDraft({ claims: [overviewA, overviewB, actionB] }, packed, "summary").valid).toBe(true);
    expect(validateMeetingDraft({ claims: [overviewA, overviewB, { ...actionB, meetingIds: ["M1"] }] }, packed, "summary"))
      .toEqual({ valid: false, errors: ["claim_2:meeting_mismatch"] });
  });

  test("supplementary actions do not weaken body-required or metadata-only validation", () => {
    const meeting = summaryWithAction("A");
    meeting.evidence[0].kind = "transcript_excerpt";
    const packed = pack([meeting]);
    const action = claim("Alex will ship Friday.", ["M1"], ["M1:E2"]);
    expect(validateMeetingDraft({ claims: [claim()] }, packed, { purpose: "summary", evidenceRequirement: "body" }).valid).toBe(true);
    expect(validateMeetingDraft({ claims: [claim(), action] }, packed, { purpose: "summary", evidenceRequirement: "body" }).valid).toBe(false);
    meeting.evidence[0].kind = "metadata";
    const metadata = pack([meeting]);
    expect(validateMeetingDraft({ claims: [claim(), action] }, metadata, "summary").valid).toBe(false);
    expect(validateMeetingDraft({ claims: [claim(), action] }, metadata, "metadata").valid).toBe(false);
  });

  test("supplementary actions must remain nonempty and in the retained citation registry", () => {
    for (const invalid of ["empty", "dropped"] as const) {
      const packed = pack([summaryWithAction("A")]);
      if (invalid === "empty") packed.meetings[0].evidence.find(item => item.kind === "action")!.text = " ";
      else delete packed.citations["M1:E2"];
      expect(validateMeetingDraft({ claims: [claim(), claim("Alex will ship Friday.", ["M1"], ["M1:E2"])] }, packed, "summary").valid).toBe(false);
    }
  });

  test("repair and fallback cannot cite an item dropped by packing", () => {
    const a = outcome("A"); a.evidence.push({ ...a.evidence[0], id: "E2", kind: "metadata", text: "DROP-ME".repeat(10_000) });
    a.coverage.evidenceRetained = 2;
    const packed = pack([a], 2_000);
    expect(packed.citations["M1:E2"]).toBeUndefined();
    expect(validateMeetingDraft({ claims: [claim("Dropped item.", ["M1"], ["M1:E2"])] }, packed, "summary").valid).toBe(false);
    expect(renderMeetingEvidenceFallback(packed, "summary")).not.toContain("DROP-ME");
  });
});

describe("server-owned meeting answer rendering", () => {
  test("renders source headings, citation associations and bounded range coverage immutably", () => {
    const ledger = mergeMeetingOutcomes(createMeetingLedger("entity/room"), [outcome("A"), outcome("B")], {
      matchedCount: 15, countKind: "lower_bound", returnedCount: 2, scanLimited: true, excludedUndatedCount: 3,
      interval: { from: "2026-08-31", to: "2026-09-06", timeZone: "Europe/Lisbon" }, observedAt: "2026-09-09T12:00:00Z", omittedMeetingRefs: [],
    });
    const packed = packMeetingEvidence(ledger, { contextWindowTokens: 128_000, contextText: "Instructions" });
    const draft = { claims: [claim(), claim("B chose Tuesday.", ["M2"], ["M2:E1"]), claim("Both chose dates.", ["M1", "M2"], ["M1:E1", "M2:E1"])] };
    const snapshot = JSON.stringify({ packed, draft });
    const answer = renderMeetingAnswer(draft, packed, "summary");
    expect(answer).toContain("A design"); expect(answer).toContain("B design"); expect(answer).toContain("2026-09-02");
    expect(answer).toContain("[M1:E1]"); expect(answer).toContain("[M2:E1]");
    expect(answer).toContain("2026-08-31"); expect(answer).toContain("2026-09-06"); expect(answer).toContain("Europe/Lisbon");
    expect(answer).toContain("at least 15"); expect(answer).toContain("13"); expect(answer).toContain("3 undated"); expect(answer).toContain("narrower");
    expect(JSON.stringify({ packed, draft })).toBe(snapshot);
    expect(renderMeetingAnswer(draft, packed, "summary")).toBe(answer);
  });

  test("a proven single selection does not count its other discovery candidates as omitted meetings", () => {
    const ledger = mergeMeetingOutcomes(createMeetingLedger("entity/room"), [outcome("A")], {
      matchedCount: 15, countKind: "lower_bound", returnedCount: 12, scanLimited: true, excludedUndatedCount: 0,
      orderProven: true, selectionResolved: true, interval: {}, observedAt: "2026-09-09T12:00:00Z", omittedMeetingRefs: ["other"],
    });
    const packed = packMeetingEvidence(ledger, { contextWindowTokens: 128_000, contextText: "Instructions" });
    const answer = renderMeetingEvidenceFallback(packed, "summary");
    expect(packed.coverage.omittedMeetings).toBe(0);
    expect(answer).toContain("Selected one meeting from at least 15 matching candidates");
    expect(answer).not.toMatch(/meeting\(s\) omitted|narrower|completeness is unknown/);
  });

  test("no-match and unread statuses never become absent transcript or absent decision claims", () => {
    const a = outcome("A"); a.evidence = []; a.coverage.evidenceRetained = 0; a.coverage.support = "none";
    a.search.state = "no_match"; a.body.state = "present";
    const b = outcome("B"); b.state = "not_read"; b.evidence = []; b.coverage.evidenceRetained = 0; b.coverage.omissionReasons = ["budget"];
    const answer = renderMeetingEvidenceFallback(pack([a, b]), "decisions");
    expect(answer).toContain("No supporting matches"); expect(answer).toContain("not read");
    expect(answer).not.toMatch(/no transcript|no decisions|body is missing/i);
  });

  test("metadata-only answers make no content-availability assertion", () => {
    const a = outcome("A", "metadata"); a.state = "metadata"; a.coverage.purpose = "metadata";
    const answer = renderMeetingEvidenceFallback(pack([a]), "metadata");
    expect(answer).not.toMatch(/transcript|body|not requested|no content/i);
  });

  test("structured metadata supports attendance even when its service text is empty", () => {
    const a = outcome("A", "metadata", ""); a.state = "metadata"; a.coverage.purpose = "metadata";
    a.evidence[0].metadata = a.meeting;
    const packed = pack([a]);
    expect(hasUsableMeetingEvidence(packed, "metadata")).toBe(true);
    expect(renderMeetingEvidenceFallback(packed, "metadata")).toContain("Participants: Alex");
  });

  test("read failure reports its actual reason rather than a retrieval budget", () => {
    const a = outcome("A"); a.state = "not_read"; a.evidence = []; a.coverage.evidenceRetained = 0; a.coverage.omissionReasons = ["contract_mismatch"];
    const answer = renderMeetingEvidenceFallback(pack([a]), "summary");
    expect(answer).toContain("contract"); expect(answer).not.toContain("retrieval budget");
  });

  test("a full retained body is not labeled excerpted", () => {
    const a = outcome("A", "transcript_excerpt", "Every normalized sentence.");
    a.body.state = "present"; a.evidence[0].offsets = { start: 0, end: a.evidence[0].text.length };
    const answer = renderMeetingEvidenceFallback(pack([a]), "summary");
    expect(answer).not.toMatch(/partial|do not establish complete|excerpted/);
  });

  test("contiguous attributed body segments are complete, while source gaps remain excerpted", () => {
    const meeting = outcome("A", "transcript_excerpt", "Ava's statement.");
    meeting.body.state = "present";
    const first = meeting.evidence[0];
    first.speaker = "Ava";
    first.offsets = { start: 0, end: first.text.length };
    const second = { ...first, id: "E2", text: "Ben's response.", speaker: "Ben",
      offsets: { start: first.text.length + 1, end: first.text.length + 1 + "Ben's response.".length } };
    meeting.evidence.push(second);
    meeting.coverage.evidenceRetained = 2;
    expect(renderMeetingEvidenceFallback(pack([meeting]), { purpose: "summary", evidenceRequirement: "body" })).not.toContain("Body coverage is excerpted");
    second.offsets = { start: second.offsets.start + 10, end: second.offsets.end + 10 };
    expect(renderMeetingEvidenceFallback(pack([meeting]), { purpose: "summary", evidenceRequirement: "body" })).toContain("Body coverage is excerpted");
  });

  test("notes with source offsets support detailed notes, while an overview alone stays a labeled fallback", () => {
    const notes = outcome("A", "notes", "Detailed discussion in notes."); notes.evidence[0].offsets = { start: 0, end: notes.evidence[0].text.length };
    expect(hasUsableMeetingEvidence(pack([notes]), { purpose: "summary", evidenceRequirement: "body" })).toBe(true);
    const a = outcome("A"); a.body.state = "unavailable";
    const answer = renderMeetingEvidenceFallback(pack([a]), { purpose: "summary", evidenceRequirement: "body" });
    expect(answer).toContain("Stored overview");
    expect(answer).toContain("does not support the requested level of detail");
  });

  test("limits-only fallback preserves a concrete narrowing message", () => {
    const packed = packMeetingEvidence(mergeMeetingOutcomes(createMeetingLedger("entity"), [outcome("A")]), { contextWindowTokens: 10, contextText: "instructions" });
    expect(renderMeetingEvidenceFallback(packed, "summary")).toContain("narrower date range");
  });
});
