import { AGENT_TRIM_RATIO, estimateTokens } from "../lib/contextGuard.js";

export type MeetingPurpose = "metadata" | "summary" | "actions" | "decisions" | "speaker" | "topic";
export type EvidenceKind = "metadata" | "summary" | "notes" | "action" | "transcript_excerpt" | "body_excerpt";
export type BodyState = "not_requested" | "present" | "missing" | "invalid_json" | "unsupported_shape" | "empty" | "size_limit" | "access_denied" | "unavailable" | "timeout" | "cancelled";
export interface MeetingMetadata {
  meetingRef: string;
  source: string;
  title: string | null;
  startedAt: string | null;
  participants: string[];
  organizerEmail: string | null;
}
export interface MeetingEvidence {
  id: string;
  meetingRef: string;
  source: string;
  kind: EvidenceKind;
  text: string;
  metadata?: MeetingMetadata;
  speaker?: string;
  startSecs?: number;
  offsets?: { start: number; end: number };
  truncated: boolean;
}
export interface MeetingOutcome {
  meetingRef: string;
  source: string;
  meeting: MeetingMetadata;
  state: "read" | "metadata" | "meeting_not_found" | "not_read" | "access_denied" | "unavailable";
  body: { state: BodyState; reasonCode?: string; partialDecoding?: boolean };
  search: { state: "not_requested" | "matched" | "no_match"; storedFieldsExamined: boolean; bodyExamined: boolean; examinedMatches: number; retainedMatches: number };
  evidence: MeetingEvidence[];
  coverage: {
    purpose: MeetingPurpose | "transcript";
    overviewPresent: boolean;
    actionsPresent: boolean;
    bodyAttempted: boolean;
    bodyRequired?: boolean;
    evidenceRetained: number;
    omittedEvidenceCount: number;
    omissionReasons: string[];
    support: "sufficient" | "limited" | "none";
  };
}
export interface MeetingDiscovery {
  matchedCount: number;
  countKind: "exact" | "lower_bound";
  returnedCount: number;
  scanLimited: boolean;
  excludedUndatedCount: number;
  orderProven?: boolean;
  /** Backend-owned: discovery candidates were resolved to the requested single meeting. */
  selectionResolved?: boolean;
  interval: { from?: string; to?: string; timeZone?: string };
  observedAt: string;
  omittedMeetingRefs: string[];
}
export interface MeetingToolData {
  contractVersion: 2;
  outcomes: MeetingOutcome[];
  discovery?: MeetingDiscovery;
}
export interface LedgerMeeting extends MeetingOutcome {
  id: string;
  /** Includes access context; deliberately excluded from the synthesis package. */
  key: string;
  evidenceKeys: string[];
}
export interface MeetingLedger {
  accessContext: string;
  meetings: LedgerMeeting[];
  discovery?: MeetingDiscovery;
}
export interface PackedMeeting extends MeetingOutcome { id: string }
export interface MeetingCitation { meetingId: string; evidenceId: string; kind: EvidenceKind }
export interface PackageCoverage {
  admittedMeetings: number;
  includedMeetings: number;
  readMeetings: number;
  notReadMeetings: number;
  attemptedMeetings: number;
  bodyAttemptedMeetings: number;
  usableMeetings: number;
  failedMeetings: number;
  omittedMeetings: number;
  discovery?: MeetingDiscovery;
}
export interface PackedMeetingEvidence {
  contractVersion: 2;
  meetings: PackedMeeting[];
  citations: Record<string, MeetingCitation>;
  coverage: PackageCoverage;
  limit?: { code: "context_limit"; message: string };
  /** Only this string is the model package; outer fields also serve validation/rendering. */
  serialized: string;
  /** Existing chars/4 estimate, including supplied instructions/question/arguments. */
  estimatedTokens: number;
}

const BODY_STATES: BodyState[] = ["not_requested", "present", "missing", "invalid_json", "unsupported_shape", "empty", "size_limit", "access_denied", "unavailable", "timeout", "cancelled"];
const PURPOSES = ["metadata", "summary", "actions", "decisions", "speaker", "topic", "transcript"];
const KINDS: EvidenceKind[] = ["metadata", "summary", "notes", "action", "transcript_excerpt", "body_excerpt"];
function record(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function count(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0; }
function strings(value: unknown): value is string[] { return Array.isArray(value) && value.every((item) => typeof item === "string"); }
function metadata(value: unknown): value is MeetingMetadata {
  return record(value) && typeof value.meetingRef === "string" && typeof value.source === "string"
    && (value.title === null || typeof value.title === "string") && (value.startedAt === null || typeof value.startedAt === "string")
    && strings(value.participants) && (value.organizerEmail === null || typeof value.organizerEmail === "string");
}

/** Reject malformed typed data instead of inferring evidence from legacy prose. */
export function parseMeetingToolData(value: unknown): MeetingToolData | null {
  if (!record(value) || value.contractVersion !== 2 || !Array.isArray(value.outcomes) || value.outcomes.length > 12) return null;
  for (const outcome of value.outcomes) {
    if (!record(outcome) || typeof outcome.meetingRef !== "string" || !outcome.meetingRef || typeof outcome.source !== "string" || !outcome.source
      || !metadata(outcome.meeting) || outcome.meeting.meetingRef !== outcome.meetingRef || outcome.meeting.source !== outcome.source
      || !["read", "metadata", "meeting_not_found", "not_read", "access_denied", "unavailable"].includes(outcome.state)
      || !record(outcome.body) || !BODY_STATES.includes(outcome.body.state)
      || (outcome.body.reasonCode !== undefined && typeof outcome.body.reasonCode !== "string")
      || (outcome.body.partialDecoding !== undefined && typeof outcome.body.partialDecoding !== "boolean")
      || !record(outcome.search) || !["not_requested", "matched", "no_match"].includes(outcome.search.state)
      || typeof outcome.search.storedFieldsExamined !== "boolean" || typeof outcome.search.bodyExamined !== "boolean"
      || !count(outcome.search.examinedMatches) || !count(outcome.search.retainedMatches)
      || !record(outcome.coverage) || !PURPOSES.includes(outcome.coverage.purpose)
      || !["overviewPresent", "actionsPresent", "bodyAttempted"].every((key) => typeof outcome.coverage[key] === "boolean")
      || (outcome.coverage.bodyRequired !== undefined && typeof outcome.coverage.bodyRequired !== "boolean")
      || !count(outcome.coverage.evidenceRetained) || !count(outcome.coverage.omittedEvidenceCount)
      || !strings(outcome.coverage.omissionReasons) || !["sufficient", "limited", "none"].includes(outcome.coverage.support)
      || !Array.isArray(outcome.evidence)) return null;
    for (const evidence of outcome.evidence) {
      if (!record(evidence) || typeof evidence.id !== "string" || !evidence.id || !KINDS.includes(evidence.kind)
        || evidence.meetingRef !== outcome.meetingRef || evidence.source !== outcome.source
        || typeof evidence.text !== "string" || typeof evidence.truncated !== "boolean"
        || (evidence.metadata !== undefined && (!metadata(evidence.metadata) || evidence.metadata.meetingRef !== outcome.meetingRef || evidence.metadata.source !== outcome.source))
        || (evidence.speaker !== undefined && typeof evidence.speaker !== "string")
        || (evidence.startSecs !== undefined && (typeof evidence.startSecs !== "number" || !Number.isFinite(evidence.startSecs) || evidence.startSecs < 0))
        || (evidence.offsets !== undefined && (!record(evidence.offsets) || !count(evidence.offsets.start) || !count(evidence.offsets.end) || evidence.offsets.end < evidence.offsets.start))) return null;
    }
    if (outcome.coverage.evidenceRetained !== outcome.evidence.length) return null;
  }
  if (value.discovery !== undefined) {
    const d = value.discovery;
    if (!record(d) || !count(d.matchedCount) || !["exact", "lower_bound"].includes(d.countKind) || !count(d.returnedCount)
      || typeof d.scanLimited !== "boolean" || !count(d.excludedUndatedCount) || !record(d.interval)
      || (d.orderProven !== undefined && typeof d.orderProven !== "boolean")
      || !["from", "to", "timeZone"].every((key) => d.interval[key] === undefined || typeof d.interval[key] === "string")
      || typeof d.observedAt !== "string" || !strings(d.omittedMeetingRefs)) return null;
  }
  const result: MeetingToolData = structuredClone({ contractVersion: 2, outcomes: value.outcomes, ...(value.discovery === undefined ? {} : { discovery: value.discovery }) });
  if (result.discovery) delete result.discovery.selectionResolved;
  return result;
}

export function createMeetingLedger(accessContext: string): MeetingLedger {
  if (!accessContext) throw new Error("Meeting ledger requires an authenticated access context");
  return { accessContext, meetings: [] };
}

function evidenceIdentity(e: MeetingEvidence): string {
  // Service-local IDs (including repeated E1) alone are never identity.
  return JSON.stringify([e.id, e.kind, e.text, e.offsets?.start, e.offsets?.end, e.speaker, e.startSecs,
    e.metadata ? [e.metadata.title, e.metadata.startedAt, e.metadata.participants, e.metadata.organizerEmail] : null, e.truncated]);
}

/** The same kind/provenance rules serve packing, validation and rendering. */
export function evidenceSupportsPurpose(evidence: MeetingEvidence, purpose: MeetingPurpose | "transcript", requireBody = false): boolean {
  if (purpose === "metadata") return evidence.kind === "metadata" && (Boolean(evidence.metadata) || Boolean(evidence.text.trim()));
  if (!evidence.text.trim() || evidence.kind === "metadata") return false;
  const body = evidence.kind === "transcript_excerpt" || evidence.kind === "body_excerpt" || (evidence.kind === "notes" && Boolean(evidence.offsets));
  if (purpose === "speaker") return evidence.kind === "transcript_excerpt" && Boolean(evidence.speaker?.trim());
  if (purpose === "actions") return evidence.kind === "action" || body;
  if (requireBody || purpose === "transcript" || purpose === "decisions") return body;
  if (purpose === "summary") return evidence.kind !== "action";
  return true;
}

/** Stable first-seen ordering; callers supply discovery-ordered outcomes after parallel I/O. */
export function mergeMeetingOutcomes(ledger: MeetingLedger, outcomes: MeetingOutcome[], discovery?: MeetingDiscovery): MeetingLedger {
  const next = structuredClone(ledger);
  if (discovery) next.discovery = structuredClone(discovery);
  for (const outcome of outcomes) {
    const key = JSON.stringify([ledger.accessContext, outcome.source, outcome.meetingRef]);
    const index = next.meetings.findIndex((meeting) => meeting.key === key);
    const prior = index < 0 ? undefined : next.meetings[index];
    const id = prior?.id ?? `M${next.meetings.length + 1}`;
    let evidence = prior?.evidence ?? [];
    if (!["read", "metadata"].includes(outcome.state)) evidence = evidence.filter((item) => item.kind === "metadata");
    else if (!["not_requested", "present"].includes(outcome.body.state)) evidence = evidence.filter((item) => item.kind !== "body_excerpt" && item.kind !== "transcript_excerpt" && !(item.kind === "notes" && item.offsets));
    const evidenceKeys = prior?.evidenceKeys ?? [];
    for (const item of outcome.evidence) {
      const identity = evidenceIdentity(item);
      let evidenceIndex = evidenceKeys.indexOf(identity);
      if (evidenceIndex < 0) { evidenceIndex = evidenceKeys.length; evidenceKeys.push(identity); }
      const evidenceId = `${id}:E${evidenceIndex + 1}`;
      if (!evidence.some((entry) => entry.id === evidenceId)) evidence.push({ ...structuredClone(item), id: evidenceId });
    }
    const selected = prior && outcome.state === "metadata" && prior.state !== "metadata" ? prior : outcome;
    const updated: LedgerMeeting = { ...structuredClone(selected), id, key, evidenceKeys, evidence,
      coverage: { ...structuredClone(selected.coverage), evidenceRetained: evidence.length } };
    if (index < 0) next.meetings.push(updated); else next.meetings[index] = updated;
  }
  return next;
}

interface PackOptions { contextWindowTokens: number; contextText: string; maxChars?: number }

/** Reserve identities/statuses, then allocate equally within metadata, overview/action and body tiers. */
export function packMeetingEvidence(ledger: MeetingLedger, options: PackOptions): PackedMeetingEvidence {
  const tokenBudget = Math.max(0, Math.floor(options.contextWindowTokens * AGENT_TRIM_RATIO));
  const contextTokens = estimateTokens(options.contextText);
  const maxChars = Math.max(0, Math.min(48_000, options.maxChars ?? 48_000, (tokenBudget - contextTokens) * 4));
  const originals: PackedMeeting[] = ledger.meetings.map(({ key: _key, evidenceKeys: _keys, ...meeting }) => structuredClone(meeting));
  const retained = originals.map(() => [] as MeetingEvidence[]);
  const makePackage = (include = true): Omit<PackedMeetingEvidence, "serialized" | "estimatedTokens"> => {
    const meetings: PackedMeeting[] = include ? originals.map((meeting, index) => {
      const items = retained[index];
      const shortened = items.filter((item) => item.text.length < (meeting.evidence.find((original) => original.id === item.id)?.text.length ?? 0)).length;
      const removed = meeting.evidence.length - items.length;
      const limited = removed > 0 || shortened > 0;
      const usableItems = items.filter((item) => evidenceSupportsPurpose(item, meeting.coverage.purpose));
      const usable = usableItems.length > 0;
      return { ...meeting, evidence: items,
        search: { ...meeting.search, retainedMatches: meeting.search.state === "not_requested" ? 0 : Math.min(meeting.search.retainedMatches, usableItems.length) },
        coverage: { ...meeting.coverage, evidenceRetained: items.length,
        omittedEvidenceCount: meeting.coverage.omittedEvidenceCount + removed + shortened,
        omissionReasons: [...new Set([...meeting.coverage.omissionReasons, ...(limited ? ["package_budget"] : [])])],
        support: !usable ? "none" : limited && meeting.coverage.support === "sufficient" ? "limited" : meeting.coverage.support,
      } };
    }) : [];
    const citations: Record<string, MeetingCitation> = {};
    for (const meeting of meetings) for (const evidence of meeting.evidence) citations[evidence.id] = { meetingId: meeting.id, evidenceId: evidence.id, kind: evidence.kind };
    const omittedByDiscovery = ledger.discovery && !ledger.discovery.selectionResolved ? Math.max(ledger.discovery.omittedMeetingRefs.length, ledger.discovery.matchedCount - originals.length, 0) : 0;
    return { contractVersion: 2, meetings, citations, coverage: {
      admittedMeetings: originals.length, includedMeetings: meetings.length,
      readMeetings: meetings.filter((meeting) => meeting.state === "read").length,
      notReadMeetings: meetings.filter((meeting) => meeting.state === "not_read").length,
      attemptedMeetings: meetings.filter((meeting) => meeting.state !== "metadata" && (meeting.state !== "not_read" || meeting.coverage.omissionReasons.some((reason) => ["unavailable", "contract_mismatch"].includes(reason)))).length,
      bodyAttemptedMeetings: meetings.filter((meeting) => meeting.coverage.bodyAttempted).length,
      usableMeetings: meetings.filter((meeting) => meeting.coverage.support !== "none").length,
      failedMeetings: meetings.filter((meeting) => ["meeting_not_found", "access_denied", "unavailable"].includes(meeting.state)
        || (meeting.state === "not_read" && meeting.coverage.omissionReasons.some((reason) => ["unavailable", "contract_mismatch"].includes(reason)))
        || ["missing", "invalid_json", "unsupported_shape", "size_limit", "access_denied", "unavailable", "timeout", "cancelled"].includes(meeting.body.state)).length,
      omittedMeetings: omittedByDiscovery + (include ? 0 : originals.length),
      ...(ledger.discovery ? { discovery: structuredClone(ledger.discovery) } : {}),
    } };
  };
  if (JSON.stringify(makePackage()).length > maxChars) {
    const limited = { ...makePackage(false), limit: { code: "context_limit" as const, message: "The meeting identities and retrieval statuses exceed this model's available context. Please request fewer meetings or a narrower date range." } };
    const text = JSON.stringify(limited);
    const serialized = text.length <= maxChars ? text : "";
    return { ...limited, serialized, estimatedTokens: contextTokens + estimateTokens(serialized) };
  }
  const priority = (kind: EvidenceKind) => kind === "metadata" ? 0 : kind === "transcript_excerpt" || kind === "body_excerpt" ? 2 : 1;
  for (let tier = 0; tier < 3; tier++) {
    const indices = originals.map((meeting, index) => ({ index, items: meeting.evidence.filter((item) => priority(item.kind) === tier) })).filter(({ items }) => items.length > 0);
    const share = Math.max(0, Math.floor((maxChars - JSON.stringify(makePackage()).length) / Math.max(1, indices.length)));
    for (const { index, items } of indices) {
      const meetingLimit = Math.min(maxChars, JSON.stringify(makePackage()).length + share);
      for (const item of items) {
        retained[index].push(structuredClone(item));
        if (JSON.stringify(makePackage()).length <= meetingLimit) continue;
        retained[index].pop();
        if (item.kind === "metadata") continue;
        let low = 0;
        let high = item.text.length - 1;
        let best: MeetingEvidence | undefined;
        while (low <= high) {
          const length = Math.floor((low + high) / 2);
          const candidate: MeetingEvidence = { ...structuredClone(item), text: item.text.slice(0, length), truncated: true,
            ...(item.offsets ? { offsets: { start: item.offsets.start, end: Math.min(item.offsets.end, item.offsets.start + length) } } : {}) };
          retained[index].push(candidate);
          const fits = JSON.stringify(makePackage()).length <= meetingLimit;
          retained[index].pop();
          if (fits) { best = candidate; low = length + 1; } else high = length - 1;
        }
        if (best && best.text.trim().length >= 80) retained[index].push(best);
      }
    }
  }
  // Restore allocated evidence order even when allocation priority differed.
  for (const items of retained) items.sort((a, b) => Number(a.id.split(":E")[1]) - Number(b.id.split(":E")[1]));
  const packed = makePackage();
  const serialized = JSON.stringify(packed);
  return { ...packed, serialized, estimatedTokens: contextTokens + estimateTokens(serialized) };
}
