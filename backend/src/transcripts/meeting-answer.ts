import type { MeetingEvidence, MeetingPurpose, PackedMeeting, PackedMeetingEvidence } from "./meeting-evidence.js";
import { evidenceSupportsPurpose } from "./meeting-evidence.js";

export interface MeetingEvidenceRequest { purpose: MeetingPurpose; evidenceRequirement?: "overview" | "body" }
export interface MeetingClaim { text: string; meetingIds: string[]; evidenceIds: string[] }
export interface MeetingDraft { claims: MeetingClaim[] }
export type MeetingDraftValidation = { valid: true; draft: MeetingDraft } | { valid: false; errors: string[] };
type Request = MeetingPurpose | MeetingEvidenceRequest;
const normalizeRequest = (request: Request): MeetingEvidenceRequest => typeof request === "string" ? { purpose: request } : request;

function appropriate(evidence: MeetingEvidence, request: MeetingEvidenceRequest): boolean {
  return evidenceSupportsPurpose(evidence, request.purpose, request.evidenceRequirement === "body");
}

export function hasUsableMeetingEvidence(packed: PackedMeetingEvidence, request: Request): boolean {
  if (packed.limit) return false;
  const normalized = normalizeRequest(request);
  return packed.meetings.some((meeting) => meeting.evidence.some((evidence) => Boolean(packed.citations[evidence.id]) && appropriate(evidence, normalized)));
}

function object(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function idList(value: unknown): value is string[] { return Array.isArray(value) && value.length > 0 && value.length <= 24 && value.every((id) => typeof id === "string") && new Set(value).size === value.length; }

/** Structural provenance validation; this cannot prove semantic entailment of generated prose. */
export function validateMeetingDraft(input: unknown, packed: PackedMeetingEvidence, request: Request): MeetingDraftValidation {
  if (typeof input === "string") {
    if (input.length > 16_000) return { valid: false, errors: ["draft_size_limit"] };
    try { input = JSON.parse(input); } catch { return { valid: false, errors: ["invalid_json"] }; }
  }
  if (!object(input) || Object.keys(input).some((key) => key !== "claims") || !Array.isArray(input.claims) || input.claims.length < 1 || input.claims.length > 24) {
    return { valid: false, errors: ["invalid_draft_shape"] };
  }
  if (JSON.stringify(input).length > 16_000) return { valid: false, errors: ["draft_size_limit"] };
  const errors: string[] = [];
  const normalized = normalizeRequest(request);
  const overviewSummary = normalized.purpose === "summary" && normalized.evidenceRequirement !== "body";
  const recapMeetings = new Set<string>();
  const supplementaryActions: Array<{ index: number; meetingId: string }> = [];
  const evidenceById = new Map(packed.meetings.flatMap((meeting) => meeting.evidence.map((evidence) => [evidence.id, evidence] as const)));
  for (const [index, claim] of input.claims.entries()) {
    if (!object(claim) || Object.keys(claim).some((key) => !["text", "meetingIds", "evidenceIds"].includes(key))
      || typeof claim.text !== "string" || !claim.text.trim() || claim.text.length > 2_000 || /[\r\n]/.test(claim.text)
      || !idList(claim.meetingIds) || !idList(claim.evidenceIds)) {
      errors.push(`claim_${index}:invalid_shape`); continue;
    }
    // Availability/completeness belongs to deterministic rendering. These narrow
    // checks also reject common attempts to smuggle those paragraphs into a claim;
    // semantic evaluation remains necessary for paraphrases and ordinary facts.
    if (/(?:\bno\s+(?:transcript|recording|meeting evidence)|\b(?:transcript|recording|body|evidence)\s+(?:is|was|are|were)\s+(?:missing|unavailable|absent|not available)|\b(?:covers?|includes?|reviewed|read|summarized)\s+all\s+(?:of\s+)?(?:your\s+|the\s+)?meetings|\bcomplete\s+(?:coverage|recap|transcript)|\b(?:no|none of the)\s+(?:decisions|actions)\s+(?:were|was)\s+(?:made|taken|assigned))/i.test(claim.text)) {
      errors.push(`claim_${index}:server_owned_coverage`);
    }
    const citedMeetings = new Set<string>();
    for (const id of claim.evidenceIds) {
      const citation = packed.citations[id];
      const evidence = evidenceById.get(id);
      if (!citation || !evidence) { errors.push(`claim_${index}:unknown_evidence`); continue; }
      citedMeetings.add(citation.meetingId);
      if (appropriate(evidence, normalized)) {
        if (overviewSummary) recapMeetings.add(citation.meetingId);
      } else if (overviewSummary && evidence.kind === "action" && evidence.text.trim()) {
        supplementaryActions.push({ index, meetingId: citation.meetingId });
      } else errors.push(`claim_${index}:wrong_evidence_kind`);
    }
    if (claim.meetingIds.length !== citedMeetings.size || claim.meetingIds.some((id) => !citedMeetings.has(id))) errors.push(`claim_${index}:meeting_mismatch`);
  }
  // Actions can supplement an overview only when this draft also cites recap
  // evidence for the same meeting, regardless of claim order.
  for (const { index, meetingId } of supplementaryActions) {
    if (!recapMeetings.has(meetingId)) errors.push(`claim_${index}:wrong_evidence_kind`);
  }
  return errors.length ? { valid: false, errors: [...new Set(errors)] } : { valid: true, draft: structuredClone(input) as unknown as MeetingDraft };
}

function escapeMarkdown(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/[\\`*_{}[\]()#!|]/g, "\\$&");
}
function heading(meeting: PackedMeeting): string {
  const title = meeting.meeting.title?.trim() || "Untitled meeting";
  const date = meeting.meeting.startedAt ? ` — ${meeting.meeting.startedAt.replace(/[\r\n]/g, " ")}` : " — date unknown";
  return `### ${escapeMarkdown(title.replace(/[\r\n]/g, " "))}${escapeMarkdown(date)} [${meeting.id}]`;
}
function citationText(ids: string[]): string { return ids.map((id) => `[${id}]`).join(" "); }

function meetingLimitations(meeting: PackedMeeting, request: MeetingEvidenceRequest): string[] {
  const lines: string[] = [];
  if (meeting.state === "not_read") {
    const reasons = meeting.coverage.omissionReasons;
    lines.push(reasons.includes("contract_mismatch") ? "This meeting was not read because the reader returned an incompatible evidence contract."
      : reasons.includes("unavailable") ? "This meeting was not read because the reader was unavailable."
      : reasons.includes("budget") ? "This meeting was not read within the retrieval budget."
      : reasons.includes("cancelled") ? "This meeting was not read because retrieval was cancelled."
      : "This meeting was not read; no content conclusion is available.");
  }
  else if (meeting.state === "meeting_not_found") lines.push("This meeting could not be resolved when its content was requested.");
  else if (meeting.state === "access_denied") lines.push("Access to this meeting was denied.");
  else if (meeting.state === "unavailable") lines.push("This meeting's storage was unavailable.");
  if (request.purpose !== "metadata" && meeting.state !== "not_read") {
    const descriptions: Partial<Record<PackedMeeting["body"]["state"], string>> = {
      missing: "The stored body is missing; any retained overview or actions are separate evidence.",
      invalid_json: "The stored body contains invalid JSON; any retained overview or actions remain usable.",
      unsupported_shape: "The stored body uses an unsupported format; any retained overview or actions remain usable.",
      empty: "The stored body was read and is empty; any retained overview or actions are separate evidence.",
      size_limit: "The body exceeded the supported input size; body coverage is limited.",
      access_denied: "The body could not be read because access was denied.",
      unavailable: "The body could not be read because storage was unavailable.",
      timeout: "The body read timed out.",
      cancelled: "The body read was cancelled.",
    };
    const description = descriptions[meeting.body.state];
    if (description) lines.push(description);
    if (meeting.body.state === "not_requested" && (request.evidenceRequirement === "body" || !meeting.evidence.some((item) => appropriate(item, request)))) lines.push("The body was not requested; no body-content conclusion is available.");
    if (meeting.body.partialDecoding) lines.push("Only recognized parts of the stored body were decoded.");
    if (meeting.search.state === "no_match") lines.push("No supporting matches were found in the fields and body portions examined under this query; this does not establish that a discussion or decision was absent.");
    if (!meeting.evidence.some((item) => appropriate(item, request))) lines.push("The retained evidence does not support the requested level of detail.");
  }
  if (meeting.coverage.omittedEvidenceCount > 0 || meeting.evidence.some((item) => item.truncated)) {
    lines.push(`Evidence coverage is partial: ${meeting.coverage.omittedEvidenceCount} item(s) omitted or shortened${meeting.coverage.omissionReasons.includes("package_budget") ? " to fit the answer context" : " during retrieval"}.`);
  }
  const bodyItems = meeting.evidence.filter((item) => item.kind === "transcript_excerpt" || item.kind === "body_excerpt" || (item.kind === "notes" && item.offsets));
  let coveredEnd = -1;
  const bodyHasGaps = bodyItems.flatMap(item => item.offsets ? [item.offsets] : []).sort((a, b) => a.start - b.start).some(offsets => {
    // Normalized transcript segments have one newline between source spans.
    const gap = offsets.start > coveredEnd + 1;
    coveredEnd = Math.max(coveredEnd, offsets.end);
    return gap;
  });
  if (bodyItems.length && (meeting.search.bodyExamined || bodyHasGaps || bodyItems.some((item) => item.truncated)
    || meeting.coverage.omissionReasons.some((reason) => ["body_excerpted", "match_limit", "partial_decoding", "sentence_limit"].includes(reason)))) {
    lines.push("Body coverage is excerpted to the retained passages; those passages do not establish complete discussion coverage.");
  }
  return lines;
}

function coverageText(packed: PackedMeetingEvidence, request: MeetingEvidenceRequest): string {
  const { coverage } = packed;
  const lines: string[] = [];
  const discovery = coverage.discovery;
  if (discovery) {
    const { from, to, timeZone } = discovery.interval;
    if (from || to) lines.push(`Requested interval: ${escapeMarkdown(from ?? "unspecified start")} through ${escapeMarkdown(to ?? "unspecified end")}${timeZone ? ` (${escapeMarkdown(timeZone)})` : ""}.`);
    const matchedCount = `${discovery.countKind === "lower_bound" ? "at least " : ""}${discovery.matchedCount}`;
    lines.push(discovery.selectionResolved ? `Selected one meeting from ${matchedCount} matching candidates.` : `${coverage.includedMeetings} meeting(s) included from ${matchedCount} matching meeting(s).`);
    if (discovery.scanLimited && !discovery.selectionResolved) lines.push("Discovery reached its bounded scan limit; completeness is unknown beyond the rows inspected.");
    if (discovery.excludedUndatedCount) lines.push(`${discovery.excludedUndatedCount} undated record(s) were excluded from the requested date interval.`);
  }
  if (request.purpose !== "metadata") {
    const usable = packed.meetings.filter((meeting) => meeting.evidence.some((item) => Boolean(packed.citations[item.id]) && appropriate(item, request))).length;
    lines.push(`${coverage.attemptedMeetings} meeting evidence retrieval(s) attempted; ${coverage.bodyAttemptedMeetings} body read(s) attempted. ${usable} meeting(s) retain evidence for this request; ${coverage.failedMeetings} meeting(s) had a retrieval failure; ${coverage.notReadMeetings} admitted meeting(s) not read.`);
  }
  if (coverage.omittedMeetings) lines.push(`${discovery?.countKind === "lower_bound" ? "At least " : ""}${coverage.omittedMeetings} meeting(s) omitted. Request a narrower date range or more specific meeting filters.`);
  else if (discovery?.scanLimited && !discovery.selectionResolved) lines.push("Request a narrower date range or more specific meeting filters to improve coverage.");
  if (!packed.meetings.length && !packed.limit) lines.push("No meeting evidence was included in this request.");
  return lines.length ? `### Coverage\n\n${lines.join("\n\n")}` : "";
}

function render(draft: MeetingDraft | null, packed: PackedMeetingEvidence, request: MeetingEvidenceRequest): string {
  if (packed.limit) return packed.limit.message;
  const sections: string[] = [];
  if (draft === null && hasUsableMeetingEvidence(packed, request)) sections.push("Available meeting evidence:");
  for (const meeting of packed.meetings) {
    const lines = [heading(meeting)];
    if (draft) {
      for (const claim of draft.claims.filter((claim) => claim.meetingIds.length === 1 && claim.meetingIds[0] === meeting.id)) lines.push(`${escapeMarkdown(claim.text)} ${citationText(claim.evidenceIds)}`);
    } else {
      for (const evidence of meeting.evidence) {
        if (!packed.citations[evidence.id]) continue;
        // An actions-only result is still useful in the safe recap fallback, but
        // it must be explicitly labeled rather than presented as discussion.
        if (!appropriate(evidence, request) && !(request.purpose === "summary" && ["summary", "notes", "action"].includes(evidence.kind))) continue;
        if (evidence.kind === "metadata") {
          const meta = evidence.metadata ?? meeting.meeting;
          const facts = [meta.participants.length ? `Participants: ${meta.participants.join(", ")}` : "", meta.organizerEmail ? `Organizer: ${meta.organizerEmail}` : ""].filter(Boolean);
          lines.push(`${escapeMarkdown(facts.join(". ") || meta.title || "Meeting metadata")} ${citationText([evidence.id])}`);
        } else {
          const labels: Record<Exclude<MeetingEvidence["kind"], "metadata">, string> = { summary: "Stored overview", notes: "Stored notes", action: "Stored action", transcript_excerpt: "Transcript passage", body_excerpt: "Body passage (provenance unspecified)" };
          const attribution = [evidence.speaker, evidence.startSecs === undefined ? undefined : `${evidence.startSecs}s`].filter(Boolean).join(" · ");
          lines.push(`**${labels[evidence.kind]}${attribution ? ` — ${escapeMarkdown(attribution)}` : ""}:** ${escapeMarkdown(evidence.text)}${evidence.truncated ? " [excerpt shortened]" : ""} ${citationText([evidence.id])}`);
        }
      }
    }
    lines.push(...meetingLimitations(meeting, request));
    sections.push(lines.join("\n\n"));
  }
  const crossMeeting = draft?.claims.filter((claim) => claim.meetingIds.length > 1) ?? [];
  if (crossMeeting.length) sections.push(`### Across meetings\n\n${crossMeeting.map((claim) => `${escapeMarkdown(claim.text)} ${citationText(claim.evidenceIds)}`).join("\n\n")}`);
  const coverage = coverageText(packed, request);
  if (coverage) sections.push(coverage);
  return sections.join("\n\n");
}

export function renderMeetingAnswer(draft: MeetingDraft, packed: PackedMeetingEvidence, request: Request): string {
  const validation = validateMeetingDraft(draft, packed, request);
  if (!validation.valid) throw new Error(`Invalid meeting draft: ${validation.errors.join(", ")}`);
  return render(validation.draft, packed, normalizeRequest(request));
}

export function renderMeetingEvidenceFallback(packed: PackedMeetingEvidence, request: Request): string {
  return render(null, packed, normalizeRequest(request));
}
