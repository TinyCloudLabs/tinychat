// Ported from tinycloud-agents eliza-service (ed320bd) so chat reads meetings through the hosted MCP.
import type { FindMeetingsArgs, MeetingFilters, TranscriptMetadata, TranscriptReader, TranscriptSource } from "./tools.js";

export type RetrievalMode = "selected" | "single" | "range";
export interface RetrievalContext { retrievalMode?: RetrievalMode; timeZone?: string; localDate?: string; deadlineAt?: number; signal?: AbortSignal }
export type MeetingSelection = { state: "none" | "range" | "ambiguous" } | { state: "single"; meetingRef: string };
export type BodyState = "not_requested" | "present" | "missing" | "invalid_json" | "unsupported_shape" | "empty" | "size_limit" | "access_denied" | "unavailable" | "timeout" | "cancelled";
export interface BodyResult { state: BodyState; reasonCode?: string; partialDecoding?: boolean; value?: unknown }
export type EvidencePurpose = "metadata" | "summary" | "actions" | "decisions" | "speaker" | "topic" | "transcript";
export interface EvidenceRequest { focus: EvidencePurpose; query?: string; speaker?: string; assignee?: string; includeBody?: boolean }
export interface MeetingMetadata { meetingRef: string; source: TranscriptSource; title: string | null; startedAt: string | null; participants: string[]; organizerEmail: string | null }
export interface MeetingEvidence {
  id: string; meetingRef: string; source: TranscriptSource;
  kind: "metadata" | "summary" | "notes" | "action" | "transcript_excerpt" | "body_excerpt";
  text: string; metadata?: MeetingMetadata; speaker?: string; startSecs?: number;
  offsets?: { start: number; end: number }; truncated: boolean;
}
export interface MeetingOutcome {
  meetingRef: string; source: TranscriptSource; meeting: MeetingMetadata;
  state: "read" | "metadata" | "meeting_not_found" | "not_read" | "access_denied" | "unavailable";
  body: Omit<BodyResult, "value">;
  search: { state: "not_requested" | "matched" | "no_match"; storedFieldsExamined: boolean; bodyExamined: boolean; examinedMatches: number; retainedMatches: number };
  evidence: MeetingEvidence[];
  coverage: { purpose: EvidencePurpose; overviewPresent: boolean; actionsPresent: boolean; bodyAttempted: boolean; bodyRequired: boolean; evidenceRetained: number; omittedEvidenceCount: number; omissionReasons: string[]; support: "sufficient" | "limited" | "none" };
}
export interface Discovery {
  matchedCount: number; countKind: "exact" | "lower_bound"; returnedCount: number; scanLimited: boolean;
  excludedUndatedCount: number; orderProven: boolean; interval: { from?: string; to?: string; timeZone?: string };
  observedAt: string; omittedMeetingRefs: string[];
  /** Offset for a continuation page; find answers intentionally return this page without following it. */
  nextCursor?: number;
}
export interface DiscoveryResult { rows: TranscriptMetadata[]; discovery: Discovery }
export class MeetingRetrievalError extends Error {
  constructor(readonly code: string, readonly status = 503) { super(code); this.name = "MeetingRetrievalError"; }
}
export function checkContext(context: RetrievalContext = {}): void {
  if (context.signal?.aborted) throw new MeetingRetrievalError("retrieval_cancelled", 499);
  if (context.deadlineAt !== undefined && Date.now() >= context.deadlineAt) throw new MeetingRetrievalError("retrieval_timeout", 504);
}
/** Supplement SDK signals with deadline checks, late-reply discard, and listener cleanup. */
export async function withinContext<T>(operation: (signal?: AbortSignal) => Promise<T>, context: RetrievalContext = {}): Promise<T> {
  checkContext(context);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const stop = new Promise<never>((_, reject) => {
    onAbort = () => { controller.abort(); reject(new MeetingRetrievalError("retrieval_cancelled", 499)); };
    context.signal?.addEventListener("abort", onAbort, { once: true });
    if (context.deadlineAt !== undefined) timer = setTimeout(() => { controller.abort(); reject(new MeetingRetrievalError("retrieval_timeout", 504)); }, Math.max(0, context.deadlineAt - Date.now()));
  });
  try { const result = await Promise.race([operation(controller.signal), stop]); checkContext(context); return result; }
  finally { if (timer) clearTimeout(timer); if (onAbort) context.signal?.removeEventListener("abort", onAbort); }
}
export function isAccessError(error: unknown): boolean {
  const e = error as { name?: string; code?: string } | null;
  return e?.name === "NoDelegationError" || e?.name === "DelegationExpiredError" || ["delegation_required", "delegation_expired", "delegation_revoked", "access_denied"].includes(e?.code ?? "");
}
export function validDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
export function safeMeetingRef(value: string): boolean { return value.length > 0 && value.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(value) && !value.includes("..") && !/^M\d+$/i.test(value); }
export function calendarDay(iso: string, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat("en", { timeZone: timeZone ?? "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(iso));
  return ["year", "month", "day"].map(type => parts.find(p => p.type === type)?.value).join("-");
}
export function scopedRows(rows: TranscriptMetadata[], filters: MeetingFilters, timeZone?: string, order: "newest" | "oldest" = "newest"): TranscriptMetadata[] {
  return rows.filter(row => (!filters.source || row.source === filters.source)
    && (!filters.title || row.title?.toLowerCase().includes(filters.title.toLowerCase()))
    && (!filters.participant || [...row.participantNames, ...row.participantEmails, row.organizerEmail ?? ""].join(" ").toLowerCase().includes(filters.participant.toLowerCase()))
    && (!filters.from || (row.startedAt !== null && Number.isFinite(Date.parse(row.startedAt)) && calendarDay(row.startedAt, timeZone) >= filters.from))
    && (!filters.to || (row.startedAt !== null && Number.isFinite(Date.parse(row.startedAt)) && calendarDay(row.startedAt, timeZone) <= filters.to)))
    .sort((a, b) => a.startedAt === null ? (b.startedAt === null ? a.meetingRef.localeCompare(b.meetingRef) : 1)
      : b.startedAt === null ? -1 : (Date.parse(a.startedAt) - Date.parse(b.startedAt)) * (order === "newest" ? -1 : 1) || a.meetingRef.localeCompare(b.meetingRef));
}
export function discoveryResult(rawRows: TranscriptMetadata[], rawCount: number, args: FindMeetingsArgs, context: RetrievalContext): DiscoveryResult {
  const scanned = rawRows.slice(0, 500);
  const candidates = scopedRows(scanned, args, context.timeZone, args.sort);
  const rows = candidates.slice(0, args.limit ?? 5);
  return { rows, discovery: {
    matchedCount: candidates.length, countKind: rawCount > 500 ? "lower_bound" : "exact", returnedCount: rows.length,
    scanLimited: rawCount > 500, excludedUndatedCount: (args.from || args.to) ? scanned.filter(row => !row.startedAt || !Number.isFinite(Date.parse(row.startedAt))).length : 0,
    orderProven: true, interval: { ...(args.from ? { from: args.from } : {}), ...(args.to ? { to: args.to } : {}), ...(context.timeZone ? { timeZone: context.timeZone } : {}) },
    observedAt: new Date().toISOString(), omittedMeetingRefs: candidates.slice(rows.length, rows.length + 12).map(row => row.meetingRef),
  } };
}
export async function discoverMeetings(reader: TranscriptReader, args: FindMeetingsArgs, context: RetrievalContext = {}): Promise<DiscoveryResult> {
  if (reader.discoverMetadata) return reader.discoverMetadata(args, context);
  try { const rows = await withinContext(() => reader.listMetadata(), context); return discoveryResult(rows, rows.length, args, context); }
  catch (error) { if (isAccessError(error) || error instanceof MeetingRetrievalError) throw error; throw new MeetingRetrievalError("transcript_unavailable"); }
}
export async function exactMeeting(reader: TranscriptReader, reference: string, context: RetrievalContext = {}): Promise<TranscriptMetadata | null> {
  if (!safeMeetingRef(reference)) throw new MeetingRetrievalError("invalid_args", 400);
  if (reader.getMetadata) return reader.getMetadata(reference, context);
  // Compatibility for older in-process readers only. The concrete delegated reader has exact SQL.
  return (await withinContext(() => reader.listMetadata(), context)).find(row => row.meetingRef === reference) ?? null;
}
function bounded(value: string, max: number): string { return value.replace(/<\/?(?:system|tool|assistant|user|instructions?)\b/gi, token => token.replace("<", "&lt;")).slice(0, max); }
export function meetingMetadata(row: TranscriptMetadata): MeetingMetadata {
  return { meetingRef: row.meetingRef, source: row.source, title: row.title === null ? null : bounded(row.title, 160), startedAt: row.startedAt,
    participants: row.participantNames.slice(0, 20).map(name => bounded(name, 120)), organizerEmail: row.organizerEmail === null ? null : bounded(row.organizerEmail, 254) };
}
/** Provider notices that a recap was not produced. Anchored or paired so a real recap that mentions these words still counts. */
const PLACEHOLDER_RECAPS = [
  /^(?:n\/?a|none|null|nil|tb[ad]|pending|empty|unavailable|not\s+available|no\s+(?:summary|notes|recap|overview)(?:\s+(?:yet|available|provided))?)[.!]?$/i,
  /^(?:(?:a|the|this)\s+)?(?:meeting\s+)?(?:summary|notes|recap|overview)\s+(?:(?:(?:was|were|is|are|could|can|has|have)(?:\s+not|n['’]t)|cannot)(?:\s+be(?:en)?)?|not)\s+(?:produced|generated|created|available|taken)\b/i,
  /^(?:(?:a|the|this)\s+)?(?:meeting\s+)?(?:summary|notes|recap|overview)\s+(?:is\s+)?unavailable\b/i,
  /^no\s+(?:meeting\s+)?(?:summary|notes|recap|overview)\s+(?:(?:was|were|is|has\s+been)\s+)?(?:produced|generated|created|available)\b/i,
  /(?:\bnot|n['’]t)\s+enough\s+(?:conversation|speech|discussion|dialog(?:ue)?|audio|talking)\b[^.!?]{0,80}?\b(?:supported\s+language|to\s+(?:produce|generate|create|take|write|make)\s+(?:a\s+|the\s+|any\s+)?(?:summary|notes|recap))/i,
];
/**
 * Stored overview text, or null when it is missing or carries no meeting content. Conservative:
 * fewer than four letters/digits, a bare null token, or a short "summary not produced" or
 * "not enough conversation" notice (e.g. Gemini notes for a meeting with too little speech).
 */
export function storedRecap(value: string | null | undefined): string | null {
  const text = value?.trim();
  if (!text || (text.match(/[\p{L}\p{N}]/gu)?.length ?? 0) < 4) return null;
  const lead = text.replace(/^[^\p{L}\p{N}]+/u, "");
  return text.length <= 600 && PLACEHOLDER_RECAPS.some(pattern => pattern.test(lead)) ? null : text;
}
function baseOutcome(row: TranscriptMetadata, request: EvidenceRequest): MeetingOutcome {
  const metadataLimited = row.participantNames.length > 20 || row.participantNames.some(name => name.length > 120) || (row.title?.length ?? 0) > 160 || (row.organizerEmail?.length ?? 0) > 254 || row.metadataLimited || row.listingTruncated;
  return { meetingRef: row.meetingRef, source: row.source, meeting: meetingMetadata(row), state: request.focus === "metadata" ? "metadata" : "read", body: { state: "not_requested" },
    search: { state: "not_requested", storedFieldsExamined: false, bodyExamined: false, examinedMatches: 0, retainedMatches: 0 }, evidence: [],
    coverage: { purpose: request.focus, overviewPresent: storedRecap(row.summaryOverview) !== null, actionsPresent: Boolean(row.summaryActionItems?.trim()), bodyAttempted: false, bodyRequired: Boolean(request.includeBody) || ["topic", "speaker", "decisions", "transcript"].includes(request.focus), evidenceRetained: 0, omittedEvidenceCount: metadataLimited ? 1 : 0, omissionReasons: metadataLimited ? ["metadata_limit"] : [], support: "none" } };
}
export function metadataOutcome(row: TranscriptMetadata): MeetingOutcome {
  const outcome = baseOutcome(row, { focus: "metadata" });
  outcome.evidence = [{ id: "metadata", meetingRef: row.meetingRef, source: row.source, kind: "metadata", text: "", metadata: outcome.meeting, truncated: outcome.coverage.omissionReasons.length > 0 }];
  updateCoverage(outcome); return outcome;
}
export function unattemptedOutcome(row: TranscriptMetadata, request: EvidenceRequest, reason: string): MeetingOutcome {
  const result = baseOutcome(row, request); result.state = "not_read"; result.coverage.omissionReasons.push(reason); return result;
}
export function actionItemsOf(value: string | null): string[] {
  if (!value) return [];
  let heading: string | null = null;
  const items: string[] = [];
  for (const rawLine of value.slice(0, 64_000).split(/\r?\n|(?<=\.)\s+(?=[A-Z])/)) {
    const raw = rawLine.trim();
    const match = raw.match(/^(?:#{1,6}\s*)?\*{1,2}([^*]+)\*{1,2}:?$/);
    if (match) { heading = match[1]!.trim(); continue; }
    const bullet = raw.match(/^\s*(?:[-*•]|\d+[.)])\s*(?:\[[ xX]\]\s*)?(.*)$/);
    const text = (bullet?.[1] ?? raw).replace(/\*\*([^*]+)\*\*/g, "$1").trim();
    if (text.length >= 4 && /[\p{L}\p{N}]/u.test(text)) items.push(bullet && heading ? `${heading}: ${text}` : text);
    if (items.length >= 101) break;
  }
  return items;
}
interface Sentence { text: string; speaker?: string; startSecs?: number; start: number; end: number }
export function decodeBody(value: unknown): BodyResult {
  let encoded: string;
  try { encoded = typeof value === "string" ? value : JSON.stringify(value) ?? ""; } catch { return { state: "unsupported_shape" }; }
  if (Buffer.byteLength(encoded) > 1_048_576) return { state: "size_limit", reasonCode: "encoded_body_limit" };
  if (typeof value === "string") { try { value = JSON.parse(value); } catch { return { state: "invalid_json" }; } }
  return normalizedBody(value);
}
export function normalizedBody(value: unknown): BodyResult {
  if (typeof value === "string") return value.trim() ? { state: "present", value } : { state: "empty" };
  if (!Array.isArray(value)) return { state: "unsupported_shape" };
  if (value.length === 0) return { state: "empty" };
  const inspected = value.slice(0, 20_000);
  const recognized = inspected.filter(item => item && typeof item === "object" && typeof item.text === "string");
  const usable = recognized.filter(item => item.text.trim());
  if (!usable.length) return { state: recognized.length === inspected.length ? "empty" : "unsupported_shape" };
  return { state: "present", value: usable, ...(recognized.length < value.length ? { partialDecoding: true } : {}), ...(value.length > 20_000 ? { reasonCode: "sentence_limit", partialDecoding: true } : {}) };
}
function bodySentences(value: unknown): Sentence[] {
  let offset = 0;
  const list = typeof value === "string" ? [{ text: value }] : Array.isArray(value) ? value : [];
  return list.slice(0, 20_000).map((item): Sentence => {
    const text = item.text as string; const start = offset; offset += text.length + 1;
    const speaker = [item.speaker_name, item.speaker, item.speakerName].find(v => typeof v === "string" && v.trim());
    const startSecs = [item.start_time, item.startTime].find(v => typeof v === "number" && Number.isFinite(v) && v >= 0);
    return { text, start, end: start + text.length, ...(speaker ? { speaker: bounded(speaker, 120) } : {}), ...(startSecs !== undefined ? { startSecs } : {}) };
  });
}
function broadBodyPassages(sentences: Sentence[], available: number): { passages: Array<Sentence & { truncated: boolean }>; omitted: number; excerpted: boolean } {
  const text = sentences.map(item => item.text).join("\n");
  const segments: Array<Omit<Sentence, "text">> = [];
  for (const { text: _text, ...sentence } of sentences) {
    const previous = segments.at(-1);
    // Plain adjacent text can remain one span; never merge away supplied attribution.
    if (previous && !previous.speaker && previous.startSecs === undefined && !sentence.speaker && sentence.startSecs === undefined) previous.end = sentence.end;
    else segments.push(sentence);
  }
  const excerpted = text.length > available;
  const width = excerpted ? Math.floor(available / 3) : text.length;
  const starts = width > 0 ? excerpted ? [...new Set([0, Math.floor((text.length - width) / 2), text.length - width])] : [0] : [];
  const passages: Array<Sentence & { truncated: boolean }> = [];
  let omitted = 0;
  // At most 12 body items, shared evenly across beginning/middle/end windows.
  const perWindow = Math.floor(12 / Math.max(1, starts.length));
  for (const windowStart of starts) {
    const windowEnd = windowStart + width;
    const candidates = segments.filter(item => item.end > windowStart && item.start < windowEnd);
    const indices = candidates.length <= perWindow ? candidates.map((_, index) => index)
      : Array.from({ length: perWindow }, (_, index) => Math.round(index * (candidates.length - 1) / (perWindow - 1)));
    omitted += candidates.length - indices.length;
    for (const index of indices) {
      const segment = candidates[index]!;
      const start = Math.max(segment.start, windowStart), end = Math.min(segment.end, windowEnd);
      passages.push({ ...segment, text: text.slice(start, end), start, end, truncated: start > segment.start || end < segment.end });
    }
  }
  return { passages, omitted, excerpted };
}
function matches(text: string, query?: string): boolean {
  if (!query) return true;
  const terms = [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(term => term.length > 1))];
  return terms.some(term => text.toLowerCase().includes(term));
}
function notesProvenance(row: TranscriptMetadata): boolean {
  const metadata = row.metadata;
  if (!metadata) return false;
  if (metadata.notes_kind === "gemini") return true;
  return [metadata.artifactType, metadata.artifact_type, metadata.type, metadata.kind, metadata.documentType, metadata.document_type].some(value => typeof value === "string" && /^(?:notes|meeting_notes|generated_notes|meeting-notes)$/i.test(value));
}
export function updateCoverage(outcome: MeetingOutcome): void {
  const { purpose, bodyRequired } = outcome.coverage;
  const bodyEvidence = (item: MeetingEvidence) => ["transcript_excerpt", "body_excerpt"].includes(item.kind) || (item.kind === "notes" && item.offsets !== undefined);
  const usable = outcome.evidence.filter(item => purpose === "metadata" ? item.kind === "metadata"
    : purpose === "summary" ? ["summary", "notes", "transcript_excerpt", "body_excerpt"].includes(item.kind)
    : purpose === "speaker" ? item.kind === "transcript_excerpt" && Boolean(item.speaker)
    : purpose === "actions" ? item.kind === "action" || bodyEvidence(item)
    : purpose === "decisions" || purpose === "transcript" ? bodyEvidence(item)
    : item.kind !== "metadata");
  outcome.coverage.evidenceRetained = outcome.evidence.length;
  outcome.search.retainedMatches = outcome.search.state === "not_requested" ? 0 : usable.length;
  const limited = outcome.coverage.omissionReasons.length > 0 || outcome.evidence.some(item => item.truncated)
    || (bodyRequired && outcome.body.state !== "present") || (purpose === "actions" && !usable.some(item => item.kind === "action"));
  outcome.coverage.support = usable.length === 0 ? "none" : limited ? "limited" : "sufficient";
}
export async function readMeetingEvidence(reader: TranscriptReader, reference: string, request: EvidenceRequest, context: RetrievalContext = {}, admitted?: TranscriptMetadata): Promise<MeetingOutcome> {
  const row = await exactMeeting(reader, reference, context);
  if (!row) {
    if (!admitted) throw new MeetingRetrievalError("meeting_not_found", 404);
    const absent = baseOutcome(admitted, request); absent.state = "meeting_not_found"; absent.coverage.omissionReasons.push("meeting_not_found"); return absent;
  }
  const outcome = baseOutcome(row, request);
  const add = (kind: MeetingEvidence["kind"], text: string, id: string, extra: Partial<MeetingEvidence> = {}, max = 4_000) => {
    const retained = bounded(text, max);
    outcome.evidence.push({ id, meetingRef: row.meetingRef, source: row.source, kind, text: retained, truncated: retained.length < text.length, ...extra });
    if (retained.length < text.length && !outcome.coverage.omissionReasons.includes("evidence_excerpted")) outcome.coverage.omissionReasons.push("evidence_excerpted");
  };
  const topic = request.focus === "topic";
  const focused = ["topic", "decisions", "speaker", "actions"].includes(request.focus);
  const storedAllowed = !request.speaker;
  // A placeholder recap counts as missing: it is neither evidence nor a reason to skip the body.
  const overview = storedRecap(row.summaryOverview);
  if (overview && storedAllowed && (!topic || matches(overview, request.query))) add(notesProvenance(row) ? "notes" : "summary", overview, "summary");
  const allActions = actionItemsOf(row.summaryActionItems).filter(item => !request.assignee || item.toLowerCase().includes(request.assignee.toLowerCase()));
  if ((row.summaryActionItems?.length ?? 0) > 64_000 || allActions.length > 100) outcome.coverage.omissionReasons.push("action_input_limit");
  const retainedActions = allActions.filter(item => storedAllowed && (!topic || matches(item, request.query)));
  for (const [index, text] of retainedActions.slice(0, 8).entries()) add("action", text, `action-${index + 1}`, {}, 800);
  if (retainedActions.length > 8) { outcome.coverage.omittedEvidenceCount += retainedActions.length - 8; outcome.coverage.omissionReasons.push("action_limit"); }
  const needsBody = Boolean(request.includeBody) || ["topic", "speaker", "transcript", "decisions"].includes(request.focus)
    || (request.focus === "summary" && !overview) || (request.focus === "actions" && !allActions.length);
  if (focused) { outcome.search.state = "no_match"; outcome.search.storedFieldsExamined = storedAllowed && (topic || request.focus === "actions"); }
  if (needsBody) {
    outcome.coverage.bodyAttempted = true;
    let body: BodyResult;
    try {
      body = reader.readBody ? await reader.readBody(row.source, row.sourceId, context)
        : await withinContext(async () => { const value = await reader.getTranscript(row.source, row.sourceId); return value === null ? { state: "missing" as const } : normalizedBody(value); }, context);
    } catch (error) {
      if (isAccessError(error)) throw error;
      const code = (error as { code?: string }).code;
      body = { state: code === "retrieval_timeout" ? "timeout" : code === "retrieval_cancelled" ? "cancelled" : "unavailable" };
    }
    const { value, ...status } = body; outcome.body = status;
    if (body.state === "access_denied") throw new MeetingRetrievalError("access_denied", 409);
    if (body.state === "cancelled") throw new MeetingRetrievalError("retrieval_cancelled", 499);
    if (body.state === "present") {
      let sentences = bodySentences(value);
      outcome.search.bodyExamined = focused;
      // Exo Local bodies are local You/Others channel transcripts, written in the Fireflies sentence shape.
      const knownTranscript = row.source === "fireflies" || row.source === "tinycloud-transcriber" || row.source === "exo-local" || row.source === "exo-merged" || row.source === "exo-voice-note" || Number(row.metadata?.transcript_count ?? 0) > 0;
      const notesBody = notesProvenance(row) && row.metadata?.notes_association !== "conference" && !Number(row.metadata?.transcript_count ?? 0);
      const sourceKind = notesBody ? "notes" : knownTranscript ? "transcript_excerpt" : "body_excerpt";
      if (request.focus === "summary" || (request.focus === "transcript" && !request.query && !request.speaker)) {
        const available = Math.max(0, 12_000 - outcome.evidence.reduce((n, item) => n + item.text.length, 0));
        const broad = broadBodyPassages(sentences, available);
        for (const item of broad.passages) add(sourceKind, item.text, `body-${item.start}`, {
          ...(item.speaker ? { speaker: item.speaker } : {}), ...(item.startSecs !== undefined ? { startSecs: item.startSecs } : {}),
          offsets: { start: item.start, end: item.end }, truncated: item.truncated,
        }, available);
        if (broad.excerpted || broad.omitted) outcome.coverage.omissionReasons.push("body_excerpted");
        if (broad.omitted) { outcome.coverage.omittedEvidenceCount += broad.omitted; outcome.coverage.omissionReasons.push("body_segment_limit"); }
      } else {
        const query = request.focus === "decisions" ? request.query ?? "decided decision agreed chose final" : request.query;
        sentences = sentences.filter(item => (!request.speaker || (sourceKind === "transcript_excerpt" && item.speaker?.toLowerCase().includes(request.speaker.toLowerCase())))
          && (!request.assignee || `${item.speaker ?? ""} ${item.text}`.toLowerCase().includes(request.assignee.toLowerCase()))
          && (request.focus !== "actions" || /\b(?:action item|to-?do|follow up|i(?:'ll| will| need to| have to)|we(?:'ll| will| need to| have to)|send|schedule|prepare|share|confirm|review|deliver)\b/i.test(item.text)) && matches(item.text, query));
        outcome.search.examinedMatches += sentences.length;
        for (const item of sentences.slice(0, 4)) add(sourceKind, item.text, `body-${item.start}`, { ...(item.speaker ? { speaker: item.speaker } : {}), ...(item.startSecs !== undefined ? { startSecs: item.startSecs } : {}), offsets: { start: item.start, end: Math.min(item.end, item.start + 1_400) } }, 1_400);
        if (sentences.length > 4) { outcome.coverage.omittedEvidenceCount += sentences.length - 4; outcome.coverage.omissionReasons.push("match_limit"); }
      }
      if (body.partialDecoding) outcome.coverage.omissionReasons.push(body.reasonCode ?? "partial_decoding");
    }
  }
  if (focused) {
    outcome.search.examinedMatches += (topic ? outcome.evidence.filter(item => item.id === "summary" || item.kind === "action").length : request.focus === "actions" ? retainedActions.length : 0);
    outcome.search.state = outcome.search.examinedMatches > 0 ? "matched" : "no_match";
  }
  updateCoverage(outcome);
  if (context.signal?.aborted) checkContext(context);
  reader.assertAccess?.();
  return outcome;
}

export type MeetingOperation = "find" | "read" | "search" | "actions";
const TOOL_NAMES = { find: "TINYCLOUD_FIND_MEETINGS", read: "TINYCLOUD_READ_MEETING", search: "TINYCLOUD_SEARCH_TRANSCRIPTS", actions: "TINYCLOUD_LIST_MEETING_ACTIONS" } as const;
function citation(index: number, evidence: MeetingEvidence, count: number): string {
  if (evidence.kind === "summary" || (evidence.kind === "notes" && evidence.id === "summary")) return `[M${index}:S]`;
  if (evidence.kind === "action") return `[M${index}:A${count}]`;
  if (evidence.kind === "metadata") return `[M${index}]`;
  const time = evidence.startSecs === undefined ? undefined : [Math.floor(evidence.startSecs / 3600), Math.floor(evidence.startSecs % 3600 / 60), Math.floor(evidence.startSecs % 60)].map(part => String(part).padStart(2, "0")).join(":");
  const attribution = [evidence.speaker, time].filter(Boolean);
  return `[M${index}:E${count}${attribution.length ? `, ${attribution.join(", ")}` : ""}]`;
}
function projectMeeting(outcome: MeetingOutcome, index: number) {
  let actionIndex = 0; let excerptIndex = 0;
  const actionItems: Array<{ citation: string; text: string }> = [];
  const excerpts: Array<{ citation: string; text: string; speaker?: string; startSecs?: number }> = [];
  let summary: { citation: string; text: string } | null = null;
  for (const evidence of outcome.evidence) {
    if (evidence.kind === "metadata") continue;
    if (evidence.kind === "summary" || (evidence.kind === "notes" && evidence.id === "summary")) summary = { citation: citation(index, evidence, 0), text: evidence.text };
    else if (evidence.kind === "action") actionItems.push({ citation: citation(index, evidence, ++actionIndex), text: evidence.text });
    else excerpts.push({ citation: citation(index, evidence, ++excerptIndex), text: evidence.text, ...(evidence.speaker ? { speaker: evidence.speaker } : {}), ...(evidence.startSecs !== undefined ? { startSecs: evidence.startSecs } : {}) });
  }
  return { ...outcome.meeting, citation: `[M${index}]`, summary, actionItems, excerpts, transcriptCandidates: excerpts };
}
function projectResult(operation: MeetingOperation, outcomes: MeetingOutcome[], discovery?: Discovery) {
  const projected = outcomes.map((outcome, i) => projectMeeting(outcome, i + 1));
  const retained = projected.filter((_, i) => outcomes[i]!.coverage.support !== "none");
  const matches = retained.filter(() => operation === "search" || operation === "actions").map(item => ({
    citation: item.citation, meetingRef: item.meetingRef, source: item.source, title: item.title, startedAt: item.startedAt,
    actionItems: operation === "actions" ? item.actionItems : [],
    transcriptCandidates: operation === "actions" ? item.excerpts : [],
    excerpts: operation === "search" ? [...(item.summary ? [item.summary] : []), ...item.actionItems, ...item.excerpts] : [],
  }));
  const partial = outcomes.some(outcome => outcome.state === "unavailable" || outcome.state === "not_read" || outcome.state === "meeting_not_found" || ["invalid_json", "unsupported_shape", "size_limit", "access_denied", "unavailable", "timeout", "cancelled"].includes(outcome.body.state));
  const truncated = Boolean(discovery?.scanLimited || (discovery && discovery.matchedCount > discovery.returnedCount)) || outcomes.some(outcome => outcome.coverage.omissionReasons.length > 0 || outcome.evidence.some(item => item.truncated));
  const first = projected[0];
  const data = {
    contractVersion: 2 as const, outcomes, ...(discovery ? { discovery } : {}),
    meeting: first ? { ...first, summary: undefined, actionItems: undefined, excerpts: undefined, transcriptCandidates: undefined } : null,
    meetings: operation === "find" ? projected.map(({ summary, actionItems, excerpts, transcriptCandidates, ...meeting }) => meeting) : [],
    summary: operation === "read" ? first?.summary ?? null : null,
    actionItems: operation === "read" ? first?.actionItems ?? [] : [], excerpts: operation === "read" ? first?.excerpts ?? [] : [], matches,
    focus: outcomes[0]?.coverage.purpose,
    corpus: { candidateCount: discovery?.matchedCount ?? outcomes.length, returnedCount: outcomes.length, examinedCount: outcomes.filter(outcome => outcome.state === "read").length,
      matchedCount: matches.length, transcriptRead: outcomes.some(outcome => outcome.coverage.bodyAttempted), transcriptFallbackCount: outcomes.filter(outcome => outcome.coverage.bodyAttempted).length, truncated, partial },
  };
  const text = operation === "find" ? `Found ${discovery?.countKind === "lower_bound" ? "at least " : ""}${discovery?.matchedCount ?? outcomes.length} matching meetings; returned ${outcomes.length} metadata records. Discovery does not inspect bodies.`
    : `Retrieved ${retained.length} purpose-supported meeting outcomes from ${outcomes.length} included records. Use retained evidence citations; body and coverage outcomes describe retrieval limitations.`;
  return { text: text + (truncated || partial ? " Coverage is bounded; narrow the requested scope for more evidence." : ""), data };
}
export type MeetingToolResult = ReturnType<typeof projectResult>;
/** Fit legacy and v2 together, measuring the real dispatcher wrapper and callback frame. */
export function formatMeetingResult(operation: MeetingOperation, rawOutcomes: MeetingOutcome[], discovery?: Discovery): MeetingToolResult {
  const outcomes = structuredClone(rawOutcomes);
  const omit = (outcome: MeetingOutcome, reason: string) => { outcome.coverage.omittedEvidenceCount++; if (!outcome.coverage.omissionReasons.includes(reason)) outcome.coverage.omissionReasons.push(reason); updateCoverage(outcome); };
  const regenerate = () => projectResult(operation, outcomes, discovery);
  const size = (result: MeetingToolResult) => JSON.stringify({ ok: true, tool: TOOL_NAMES[operation], result: { ...result, frames: [{ text: result.text }] } }).length;
  for (const outcome of outcomes) {
    // Content responses reserve identity/status and useful evidence before long
    // attendee lists. Metadata-only answers retain those fields through fitting.
    if (operation !== "find") {
      while (JSON.stringify(outcome.meeting).length > Math.floor(2_800 / outcomes.length)) {
        if (outcome.meeting.participants.length) outcome.meeting.participants.pop();
        else if ((outcome.meeting.title?.length ?? 0) > 40) outcome.meeting.title = outcome.meeting.title!.slice(0, Math.max(40, Math.floor(outcome.meeting.title!.length / 2)));
        else if (outcome.meeting.organizerEmail) outcome.meeting.organizerEmail = null;
        else break;
        if (!outcome.coverage.omissionReasons.includes("metadata_response_limit")) outcome.coverage.omissionReasons.push("metadata_response_limit");
      }
    }
    while (outcome.evidence.reduce((sum, item) => sum + item.text.length, 0) > 12_000) { outcome.evidence.pop(); omit(outcome, "evidence_limit"); }
  }
  let result = regenerate();
  while (size(result) > 16_000) {
    // Reduce the meeting using the most space; preserve overview/actions before body windows.
    const ordered = [...outcomes].sort((a, b) => JSON.stringify(b).length - JSON.stringify(a).length);
    const outcome = ordered.find(item => item.evidence.filter(e => e.kind !== "metadata").length > 1)
      ?? ordered.find(item => item.evidence.some(e => e.kind !== "metadata"));
    if (outcome) {
      const evidence = [...outcome.evidence].reverse().find(e => ["transcript_excerpt", "body_excerpt"].includes(e.kind))
        ?? (operation === "actions" ? outcome.evidence.find(e => e.kind === "summary" || e.kind === "notes") : undefined)
        ?? [...outcome.evidence].reverse().find(e => e.kind === "action") ?? outcome.evidence.find(e => e.kind !== "metadata")!;
      if (evidence.text.length > 100) {
        evidence.text = evidence.text.slice(0, Math.max(60, Math.floor(evidence.text.length * 0.6))); evidence.truncated = true;
        if (evidence.offsets) evidence.offsets.end = evidence.offsets.start + evidence.text.length;
        if (!outcome.coverage.omissionReasons.includes("response_limit")) outcome.coverage.omissionReasons.push("response_limit"); updateCoverage(outcome);
      } else { outcome.evidence.splice(outcome.evidence.indexOf(evidence), 1); omit(outcome, "response_limit"); }
    } else {
      const metadata = ordered.find(item => item.meeting.participants.length || (item.meeting.title?.length ?? 0) > 40 || item.meeting.organizerEmail);
      if (!metadata) throw new MeetingRetrievalError("meeting_result_size_limit", 413);
      if (metadata.meeting.participants.length) metadata.meeting.participants.pop();
      else if (metadata.meeting.organizerEmail) metadata.meeting.organizerEmail = null;
      else metadata.meeting.title = metadata.meeting.title!.slice(0, 40);
      for (const evidence of metadata.evidence) if (evidence.kind === "metadata") { evidence.metadata = metadata.meeting; evidence.truncated = true; }
      omit(metadata, "metadata_response_limit");
    }
    result = regenerate();
  }
  return result;
}
