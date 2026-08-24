/**
 * Conservative, metadata-only parsing for meeting questions.
 *
 * This first retrieval building block deliberately does not discover or read
 * anything.  It merely decides whether a question is safely in the small
 * meeting-retrieval grammar and exposes the selectors needed by later,
 * deterministic selection work.
 */

import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { meetingKvKey, transcriptKvKey } from "../connectors/connectorStore";
import type { ConnectorMeetingContent, ConnectorMeetingsClient } from "../connectors/meetingsApi";
import { CONNECTORS_SQL_DB_NAME } from "../connectors/connectorStore";
import { USER_SPACE_MEETING_VERSION, type ReconciledMeetingKvRecordV1 } from "../connectors/backendReconcile";
import {
  buildMeetingContext,
  normalizeAndChunkTranscript,
  rankMeetingExcerptsWithStatus,
} from "./context";
import { discoverMeetingCorpus } from "./corpus";
import {
  MAX_EVIDENCE_READS,
  type MeetingCandidate,
  type MeetingCorpus,
  type MeetingEvidence,
  type MeetingEvidenceLocator,
  type MeetingEvidenceLocatorKind,
  type MeetingExcerpt,
  type MeetingRetrievalOutcome,
  type MeetingRef,
  type MeetingThreadState,
} from "./types";

/**
 * The adapter-facing boundary for one ephemeral meeting retrieval attempt.
 * Implementations may discover and read selected evidence, but may not retain
 * it beyond this call. Keeping this small interface here lets the chat adapter
 * stay unaware of corpus/storage details.
 */
export interface MeetingTurnRetriever {
  retrieve(input: {
    threadId: string;
    question: string;
    signal?: AbortSignal;
  }): Promise<MeetingRetrievalOutcome>;
}

/** The selected-only SQL evidence read. It is never used for discovery. */
export const SQL_MEETING_SUMMARY_QUERY = `SELECT summary_overview, summary_action_items
FROM connector_meeting
WHERE id = ? AND source = ? AND source_id = ?
LIMIT 1`;

/**
 * Evidence outcomes remain distinct until the chat adapter decides how to
 * respond. In particular, a local storage failure is not softened into an
 * ordinary no-content result, while a stale/malformed selected item is.
 */
export type MeetingEvidenceReadOutcome =
  | { status: "evidence"; evidence: MeetingEvidence }
  | { status: "no-content"; partial: boolean; summaryAvailable: boolean }
  | { status: "storage-error"; partial: true }
  | { status: "aborted" };

export interface MeetingEvidenceReadOptions {
  /** Browser-local SQL and KV, read only after a meeting has been selected. */
  tcw: Pick<TinyCloudWeb, "kv" | "sql">;
  /** The authenticated browser client used only as the final server fallback. */
  meetings: Pick<ConnectorMeetingsClient, "read">;
  signal?: AbortSignal;
  /** Transcript-specific requests cannot be grounded by a summary alone. */
  requireTranscript?: boolean;
}

/**
 * Dependencies for the one mounted browser retriever. The instance owns only
 * its ephemeral thread selection state; its callers own the TinyCloud/session
 * handles and recreate it on a workspace reload.
 */
export interface BrowserMeetingTurnRetrieverOptions {
  tcw: Pick<TinyCloudWeb, "kv" | "sql">;
  meetings: Pick<ConnectorMeetingsClient, "list" | "read">;
}

interface ResultError {
  code?: unknown;
}

interface LocalReadResult {
  ok: boolean;
  data?: { data?: unknown; rows?: unknown };
  error?: ResultError;
}

export interface MeetingIntentOptions {
  /**
   * Whether the live (non-persisted) thread already selected a meeting.
   * Passing a boolean instead of a thread object keeps intent detection
   * independent of state storage and raw meeting data.
   */
  hasSelectedMeeting?: boolean;
  /** Injected for deterministic relative-date parsing; defaults to now. */
  now?: Date;
}

export interface MeetingDateSelector {
  /** A browser-local calendar day in the stable YYYY-MM-DD form. */
  day: string;
  kind: "explicit" | "relative";
}

/**
 * A content-free interpretation of a supported meeting question.  Later
 * selection code is responsible for matching these selectors to corpus
 * metadata; this parser never reads a meeting body.
 */
export interface MeetingIntent {
  date: MeetingDateSelector | null;
  emails: readonly string[];
  emailDomains: readonly string[];
  hasMeetingNoun: boolean;
  hasReferentialFollowUp: boolean;
  hasRetrievalPhrase: boolean;
  hasStrongSelector: boolean;
  latest: boolean;
  phrases: readonly string[];
}

/** A deterministic, content-free result of selecting from one discovered corpus. */
export type MeetingSelection =
  | { status: "selected"; meeting: MeetingCandidate }
  | { status: "clarification"; choices: readonly MeetingCandidate[]; partial?: true; truncated?: true }
  | { status: "no-match"; partial: boolean }
  | { status: "storage-error"; partial: true };

export interface MeetingSelectionOptions {
  /**
   * The live thread's already-selected identity. This remains a reference,
   * rather than retained meeting text or metadata, and is used only for a
   * selector-free/referential follow-up.
   */
  selected?: MeetingRef | null;
}

/**
 * The deliberately small, in-memory portion of a meeting retriever.  It is
 * keyed by the chat thread so one live workspace can support interleaved
 * conversations without letting a selection leak between them.  This class
 * has no storage dependency: recreating it (as happens on reload) clears all
 * follow-up state.
 */
export class MeetingRetriever {
  readonly #threads = new Map<string, MeetingThreadState>();

  /** Return a defensive, content-free snapshot of one thread's live state. */
  getThreadState(threadId: string): MeetingThreadState {
    const state = this.#threads.get(threadId);
    return {
      selected: state?.selected === null || state?.selected === undefined
        ? null
        : { ...state.selected },
      ambiguityChoices: state?.ambiguityChoices.map(copyCandidate) ?? [],
    };
  }

  /** Parse intent with this thread's selected reference, if it has one. */
  detectIntent(threadId: string, question: string, options: Omit<MeetingIntentOptions, "hasSelectedMeeting"> = {}): MeetingIntent | null {
    const selected = this.#threads.get(threadId)?.selected;
    return detectMeetingIntent(question, {
      ...options,
      hasSelectedMeeting: selected !== null && selected !== undefined,
    });
  }

  /**
   * Run metadata-only selection using this thread's selected reference, then
   * retain only the reference or content-free clarification choices needed by
   * the next turn.
   */
  selectMeeting(threadId: string, intent: MeetingIntent, corpus: MeetingCorpus): MeetingSelection {
    const selection = selectMeeting(intent, corpus, { selected: this.#threads.get(threadId)?.selected });
    if (selection.status === "selected") {
      this.#threads.set(threadId, {
        selected: copyRef(selection.meeting),
        ambiguityChoices: [],
      });
    } else if (selection.status === "clarification") {
      this.#threads.set(threadId, {
        selected: null,
        ambiguityChoices: selection.choices.map(copyCandidate),
      });
    }
    return selection;
  }

  /**
   * Resolve a reply against only the previous clarification choices.  A reply
   * must identify exactly one displayed title or calendar day; otherwise the
   * ambiguity is retained unchanged.  No corpus discovery or meeting-body
   * read happens here.
   */
  resolveClarification(threadId: string, reply: string, now?: Date): MeetingCandidate | null {
    const state = this.#threads.get(threadId);
    if (state === undefined || state.ambiguityChoices.length === 0) return null;

    const normalizedReply = normalized(reply);
    const offered = [...state.ambiguityChoices].sort(stableCandidateOrder);
    const optionMatch = normalizedReply.match(/^(?:option\s+)?([1-5])$/i);
    if (optionMatch !== null) {
      const selected = offered[Number(optionMatch[1]) - 1];
      if (selected !== undefined) {
        const meeting = copyCandidate(selected);
        this.#threads.set(threadId, { selected: copyRef(meeting), ambiguityChoices: [] });
        return meeting;
      }
    }
    const exactTitle = state.ambiguityChoices.filter((candidate) => candidate.title !== null
      && normalized(candidate.title) === normalizedReply);
    const date = isExactDateReply(reply) ? parseDateSelector(reply, now ?? new Date()) : null;
    const dateMatches = date === null
      ? []
      : state.ambiguityChoices.filter((candidate) => calendarDay(candidate.startedAt) === date.day);
    const matches = exactTitle.length > 0 ? exactTitle : dateMatches;

    if (matches.length !== 1) return null;

    const meeting = copyCandidate(matches[0]);
    this.#threads.set(threadId, {
      selected: copyRef(meeting),
      ambiguityChoices: [],
    });
    return meeting;
  }
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/**
 * Create the browser-only retriever used by chat. Metadata discovery happens
 * only after conservative intent detection, and raw evidence remains local to
 * this method until it is incorporated into the transient system block.
 */
export function createBrowserMeetingTurnRetriever(
  options: BrowserMeetingTurnRetrieverOptions,
): MeetingTurnRetriever {
  const state = new MeetingRetriever();

  return {
    async retrieve({ threadId, question, signal }): Promise<MeetingRetrievalOutcome> {
      if (isAborted(signal)) return { status: "aborted" };

      // A reply to an earlier deterministic clarification can select from the
      // already-content-free choices without rediscovering the corpus.
      const clarified = state.resolveClarification(threadId, question);
      const intent = clarified === null ? state.detectIntent(threadId, question) : null;
      if (clarified === null && intent === null) return { status: "not-applicable" };

      let meeting: MeetingCandidate;
      let corpusPartial = false;
      if (clarified !== null) {
        meeting = clarified;
      } else {
        let corpus;
        try {
          corpus = await discoverMeetingCorpus(
            options.tcw,
            options.meetings,
            undefined,
            signal,
            state.getThreadState(threadId).selected,
          );
        } catch {
          if (isAborted(signal)) return { status: "aborted" };
          return { status: "storage-error", partial: true };
        }
        if (isAborted(signal)) return { status: "aborted" };

        const selection = state.selectMeeting(threadId, intent!, corpus);
        if (selection.status === "clarification") return selection;
        if (selection.status === "no-match") return selection;
        if (selection.status === "storage-error") return selection;
        meeting = selection.meeting;
        corpusPartial = corpus.partial;
      }

      const evidenceOutcome = await readMeetingEvidence(meeting, {
        tcw: options.tcw,
        meetings: options.meetings,
        signal,
        requireTranscript: requiresTranscript(question),
      });
      if (evidenceOutcome.status === "aborted") return evidenceOutcome;
      if (evidenceOutcome.status === "storage-error") return evidenceOutcome;
      if (evidenceOutcome.status === "no-content") {
        return {
          status: "no-content",
          meeting,
          partial: corpusPartial || evidenceOutcome.partial,
          summaryAvailable: evidenceOutcome.summaryAvailable,
          transcriptRequired: requiresTranscript(question),
        };
      }

      const normalized = evidenceOutcome.evidence.transcript === null
        ? { chunks: [], partial: false }
        : { chunks: evidenceOutcome.evidence.transcriptChunks ?? normalizeAndChunkTranscript(evidenceOutcome.evidence.transcript).chunks, partial: false };
      if (evidenceOutcome.evidence.summary === null && normalized.chunks.length === 0) {
        return {
          status: "no-content",
          meeting,
          partial: corpusPartial || evidenceOutcome.evidence.partial || normalized.partial,
          summaryAvailable: false,
          transcriptRequired: requiresTranscript(question),
        };
      }
      const ranked = rankMeetingExcerptsWithStatus(question, normalized.chunks);
      const partial = corpusPartial || evidenceOutcome.evidence.partial || normalized.partial || ranked.truncated;
      return {
        status: "grounded",
        meeting,
        evidence: evidenceOutcome.evidence,
        systemMessage: buildMeetingContext({
          meeting,
          summary: evidenceOutcome.evidence.summary,
          excerpts: ranked.excerpts,
          partial,
          evidenceTruncated: ranked.truncated,
          unavailableLocators: evidenceOutcome.evidence.unavailableLocators,
        }),
        partial,
      };
    },
  };
}

function locator(kind: MeetingEvidenceLocatorKind, meeting: MeetingCandidate): MeetingEvidenceLocator {
  switch (kind) {
    case "sql-summary":
      return { kind, source: meeting.source, sourceId: meeting.sourceId, localRowId: meeting.localRowId! };
    case "local-kv-record":
      return { kind, source: meeting.source, sourceId: meeting.sourceId };
    case "local-kv-transcript":
      return { kind, source: meeting.source, sourceId: meeting.sourceId };
    case "server-meeting":
      return { kind, source: meeting.source, sourceId: meeting.sourceId };
  }
}

function emptyEvidence(): MeetingEvidence {
  return {
    summary: null,
    summaryLocator: null,
    transcript: null,
    transcriptLocator: null,
    transcriptChunks: [],
    reads: 0,
    partial: false,
    unavailableLocators: [],
  };
}

function withUnavailable(evidence: MeetingEvidence, kind: MeetingEvidenceLocatorKind): MeetingEvidence {
  return evidence.unavailableLocators.includes(kind)
    ? evidence
    : { ...evidence, unavailableLocators: [...evidence.unavailableLocators, kind] };
}

function errorIsNotFound(value: unknown): boolean {
  const code = (value as { error?: ResultError } | null)?.error?.code;
  return typeof code === "string" && /(?:KV_)?NOT_FOUND/i.test(code);
}

function contentString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * Preserve only the small, established summary shapes. This intentionally does
 * not stringify arbitrary provider objects: unknown fields are metadata, not
 * evidence, and must never be smuggled into chat context by a selected read.
 */
function summaryText(value: unknown): string | null {
  const direct = contentString(value);
  if (direct !== null) return direct;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const summary = value as {
    overview?: unknown;
    action_items?: unknown;
    actionItems?: unknown;
    text?: unknown;
  };
  const overview = contentString(summary.overview);
  const actionItems = contentString(summary.action_items) ?? contentString(summary.actionItems);
  const text = contentString(summary.text);
  const sections = [
    overview === null ? null : `Overview:\n${overview}`,
    actionItems === null ? null : `Action items:\n${actionItems}`,
    // Some historical summaries use a single `text` field. It is only used
    // when no structured Fireflies summary fields are present.
    overview === null && actionItems === null ? text : null,
  ].filter((section): section is string => section !== null);
  return sections.length > 0 ? sections.join("\n\n") : null;
}

function decodeStoredValue(value: unknown): { ok: true; value: unknown } | { ok: false } {
  if (typeof value !== "string") return { ok: true, value };
  try {
    return { ok: true, value: JSON.parse(value) as unknown };
  } catch {
    return { ok: false };
  }
}

function parseReconciledRecord(
  value: unknown,
  meeting: MeetingCandidate,
): { summary: string | null; malformed: boolean } {
  if (typeof value !== "object" || value === null) return { summary: null, malformed: true };
  const record = value as Partial<ReconciledMeetingKvRecordV1>;
  if (
    record.v !== USER_SPACE_MEETING_VERSION
    || record.source !== meeting.source
    || record.sourceId !== meeting.sourceId
    || typeof record.hasSummary !== "boolean"
    || typeof record.hasTranscript !== "boolean"
  ) return { summary: null, malformed: true };

  if (!record.hasSummary) return { summary: null, malformed: false };
  const summary = summaryText(record.summary);
  return { summary, malformed: summary === null };
}

function parseSqlSummary(rows: unknown): { summary: string | null; malformed: boolean; stale: boolean } {
  if (!Array.isArray(rows)) return { summary: null, malformed: true, stale: false };
  if (rows.length === 0) return { summary: null, malformed: false, stale: true };
  const row = rows[0];
  if (!Array.isArray(row)) return { summary: null, malformed: true, stale: false };
  const overview = row[0];
  const actionItems = row[1];
  if ((overview !== null && overview !== undefined && typeof overview !== "string")
    || (actionItems !== null && actionItems !== undefined && typeof actionItems !== "string")) {
    return { summary: null, malformed: true, stale: false };
  }
  const sections = [
    contentString(overview) === null ? null : `Overview:\n${overview}`,
    contentString(actionItems) === null ? null : `Action items:\n${actionItems}`,
  ].filter((section): section is string => section !== null);
  return { summary: sections.length > 0 ? sections.join("\n\n") : null, malformed: false, stale: false };
}

type TranscriptReadability = "readable" | "empty" | "malformed";

function normalizedTranscript(value: unknown | null): { readability: TranscriptReadability; chunks: readonly MeetingExcerpt[]; partial: boolean } {
  if (value === null || value === undefined) return { readability: "malformed", chunks: [], partial: true };
  const normalized = normalizeAndChunkTranscript(value);
  return {
    readability: normalized.chunks.length > 0 ? "readable" : normalized.partial ? "malformed" : "empty",
    chunks: normalized.chunks,
    partial: normalized.partial,
  };
}

function transcriptReadability(value: unknown | null): TranscriptReadability {
  if (value === null || value === undefined) return "malformed";
  return normalizedTranscript(value).readability;
}

function readableTranscript(value: unknown | null): boolean {
  return transcriptReadability(value) === "readable";
}

function isSufficient(evidence: MeetingEvidence, requireTranscript = false): boolean {
  const transcript = evidence.transcriptChunks !== undefined
    ? evidence.transcriptChunks.length > 0
    : readableTranscript(evidence.transcript);
  return requireTranscript ? transcript : evidence.summary !== null || transcript;
}

function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function validatedServerContent(value: unknown, meeting: MeetingCandidate): ConnectorMeetingContent["content"] | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const envelope = value as Partial<ConnectorMeetingContent>;
  if (envelope.source !== meeting.source || envelope.sourceId !== meeting.sourceId) return null;
  if (typeof envelope.meta !== "object" || envelope.meta === null || Array.isArray(envelope.meta)) return null;
  const meta = envelope.meta as Partial<ConnectorMeetingContent["meta"]>;
  if (meta.sourceId !== meeting.sourceId) return null;
  if (typeof envelope.content !== "object" || envelope.content === null || Array.isArray(envelope.content)) return null;
  return envelope.content as ConnectorMeetingContent["content"];
}

/**
 * Read at most three likely locators for an already-selected meeting. Every
 * branch awaits before starting the next one: TinyCloud local storage must not
 * receive concurrent requests, and this keeps the read ceiling auditable.
 *
 * Discovery flags decide which locators are eligible. No candidate is ever
 * changed here; raw values live only in the returned ephemeral evidence.
 */
export async function readMeetingEvidence(
  meeting: MeetingCandidate,
  options: MeetingEvidenceReadOptions,
): Promise<MeetingEvidenceReadOutcome> {
  if (aborted(options.signal)) return { status: "aborted" };

  let evidence = emptyEvidence();
  const markPartial = () => { evidence = { ...evidence, partial: true }; };
  const readStarted = () => { evidence = { ...evidence, reads: evidence.reads + 1 }; };
  const canRead = () => evidence.reads < MAX_EVIDENCE_READS && !isSufficient(evidence, options.requireTranscript);

  // 1. SQL has no transcript body, so its summary gets the first opportunity.
  if (meeting.hasSqlSummary && meeting.localRowId !== null && canRead()) {
    readStarted();
    let result: LocalReadResult;
    try {
      result = await options.tcw.sql.db(CONNECTORS_SQL_DB_NAME).query(
        SQL_MEETING_SUMMARY_QUERY,
        [meeting.localRowId, meeting.source, meeting.sourceId],
        { signal: options.signal },
      ) as LocalReadResult;
    } catch {
      if (aborted(options.signal)) return { status: "aborted" };
      return { status: "storage-error", partial: true };
    }
    if (aborted(options.signal)) return { status: "aborted" };
    if (!result || result.ok !== true) return { status: "storage-error", partial: true };
    const parsed = parseSqlSummary(result.data?.rows);
    if (parsed.malformed || parsed.stale) markPartial();
    if (parsed.summary === null) {
      evidence = withUnavailable(evidence, "sql-summary");
    } else {
      evidence = { ...evidence, summary: parsed.summary, summaryLocator: locator("sql-summary", meeting) };
    }
  }

  // 2. A reconciled record can carry a server-originated summary. It is parsed
  // only here, after exact-identity selection, never while building a corpus.
  // A reconciled record contains only summary fields. Transcript turns keep a
  // readable SQL summary for honest no-content copy, but never spend another
  // read on this redundant summary-only locator.
  if (meeting.hasLocalRecord && canRead() && (!options.requireTranscript || evidence.summary === null)) {
    readStarted();
    let result: LocalReadResult;
    try {
      result = await options.tcw.kv.get(meetingKvKey(meeting.source, meeting.sourceId), { signal: options.signal }) as LocalReadResult;
    } catch {
      if (aborted(options.signal)) return { status: "aborted" };
      return { status: "storage-error", partial: true };
    }
    if (aborted(options.signal)) return { status: "aborted" };
    if (!result || result.ok !== true) {
      if (errorIsNotFound(result)) {
        markPartial();
        evidence = withUnavailable(evidence, "local-kv-record");
      } else {
        return { status: "storage-error", partial: true };
      }
    } else {
      const decoded = decodeStoredValue(result.data?.data);
      const parsed = decoded.ok ? parseReconciledRecord(decoded.value, meeting) : { summary: null, malformed: true };
      if (parsed.malformed) markPartial();
      if (parsed.summary === null) {
        evidence = withUnavailable(evidence, "local-kv-record");
      } else {
        evidence = { ...evidence, summary: parsed.summary, summaryLocator: locator("local-kv-record", meeting) };
      }
    }
  }

  // A transcript is a separate KV value. It follows the record only when the
  // preceding sources did not provide usable evidence, and still consumes the
  // same hard read budget.
  if (meeting.hasLocalTranscript && canRead()) {
    readStarted();
    let result: LocalReadResult;
    try {
      result = await options.tcw.kv.get(transcriptKvKey(meeting.source, meeting.sourceId), { signal: options.signal }) as LocalReadResult;
    } catch {
      if (aborted(options.signal)) return { status: "aborted" };
      return { status: "storage-error", partial: true };
    }
    if (aborted(options.signal)) return { status: "aborted" };
    if (!result || result.ok !== true) {
      if (errorIsNotFound(result)) {
        markPartial();
        evidence = withUnavailable(evidence, "local-kv-transcript");
      } else {
        return { status: "storage-error", partial: true };
      }
    } else {
      const decoded = decodeStoredValue(result.data?.data);
      if (!decoded.ok) {
        markPartial();
        evidence = withUnavailable(evidence, "local-kv-transcript");
      } else {
        const normalized = normalizedTranscript(decoded.value);
        const readability = normalized.readability;
      if (normalized.partial) markPartial();
      if (readability !== "readable") {
        if (readability === "malformed") markPartial();
        evidence = withUnavailable(evidence, "local-kv-transcript");
      } else {
        evidence = {
          ...evidence,
          transcript: decoded.value,
          transcriptChunks: normalized.chunks,
          transcriptLocator: locator("local-kv-transcript", meeting),
        };
      }
      }
    }
  }

  // 3. The authenticated server is a final fallback. A server problem makes
  // source completeness partial, but never turns a local no-content result
  // into a critical local-storage failure.
  if ((meeting.hasServerSummary || meeting.hasServerTranscript) && canRead()) {
    readStarted();
    let result: Awaited<ReturnType<ConnectorMeetingsClient["read"]>>;
    try {
      result = await options.meetings.read(meeting.source, meeting.sourceId, { signal: options.signal });
    } catch {
      if (aborted(options.signal)) return { status: "aborted" };
      return isSufficient(evidence, options.requireTranscript)
        ? { status: "evidence", evidence: { ...withUnavailable(evidence, "server-meeting"), partial: true } }
        : { status: "storage-error", partial: true };
    }
    if (aborted(options.signal)) return { status: "aborted" };
    if (result.status !== "ok") {
      markPartial();
      evidence = withUnavailable(evidence, "server-meeting");
      if (result.status !== "not-found" && !isSufficient(evidence, options.requireTranscript)) {
        return { status: "storage-error", partial: true };
      }
    } else {
      const content = validatedServerContent(result.value, meeting);
      if (content === null) {
        markPartial();
        evidence = withUnavailable(evidence, "server-meeting");
        return isSufficient(evidence, options.requireTranscript)
          ? { status: "evidence", evidence }
          : { status: "no-content", partial: true, summaryAvailable: evidence.summary !== null };
      }
      const summary = summaryText(content.summary);
      const normalizedTranscriptContent = content.transcript === undefined ? null : normalizedTranscript(content.transcript);
      const transcriptState = normalizedTranscriptContent?.readability ?? null;
      const transcript = transcriptState === "readable" ? content.transcript : null;
      if ((content.summary !== undefined && summary === null)
        || (meeting.hasServerSummary && content.summary === undefined)
        || normalizedTranscriptContent?.partial === true
        || transcriptState === "malformed"
        || (meeting.hasServerTranscript && transcriptState === null)) {
        markPartial();
      }
      if (summary === null && transcript === null) {
        evidence = withUnavailable(evidence, "server-meeting");
      } else {
        const serverLocator = locator("server-meeting", meeting);
        evidence = {
          ...evidence,
          summary: summary ?? evidence.summary,
          summaryLocator: summary === null ? evidence.summaryLocator : serverLocator,
          transcript: transcript ?? evidence.transcript,
          transcriptChunks: transcript === null ? evidence.transcriptChunks : normalizedTranscriptContent?.chunks,
          transcriptLocator: transcript === null ? evidence.transcriptLocator : serverLocator,
        };
      }
    }
  }

  // Every known locator that could still contribute evidence must be accounted
  // for when the fixed read budget prevented its attempt. A valid-but-empty
  // earlier read is not proof that later advertised evidence is absent.
  const skippedRelevant = [
    meeting.hasSqlSummary && meeting.localRowId !== null ? "sql-summary" : null,
    meeting.hasLocalRecord ? "local-kv-record" : null,
    meeting.hasLocalTranscript ? "local-kv-transcript" : null,
    meeting.hasServerSummary || meeting.hasServerTranscript ? "server-meeting" : null,
  ].filter((kind): kind is MeetingEvidenceLocatorKind => kind !== null)
    .filter((kind) => !evidence.unavailableLocators.includes(kind))
    .filter((kind) => {
      if (kind === "sql-summary") return evidence.summaryLocator?.kind !== kind;
      if (kind === "local-kv-record") return evidence.summaryLocator?.kind !== kind;
      if (kind === "local-kv-transcript") return evidence.transcriptLocator?.kind !== kind;
      return evidence.summaryLocator?.kind !== kind && evidence.transcriptLocator?.kind !== kind;
    });
  if (evidence.reads >= MAX_EVIDENCE_READS && skippedRelevant.length > 0 && !isSufficient(evidence, options.requireTranscript)) {
    evidence = { ...evidence, partial: true };
    for (const kind of skippedRelevant) evidence = withUnavailable(evidence, kind);
  }

  return isSufficient(evidence, options.requireTranscript)
    ? { status: "evidence", evidence }
    : { status: "no-content", partial: evidence.partial, summaryAvailable: evidence.summary !== null };
}

const MEETING_NOUN = /\bmeetings?\b/i;

// These are deliberately meeting-specific. Generic requests such as
// "summarize the budget" must remain ordinary chat rather than starting a
// corpus scan.
const RETRIEVAL_PHRASE = /\b(?:meeting\s+(?:notes|transcript|summary)|notes\s+from\s+(?:the\s+)?meeting|transcript\s+from\s+(?:the\s+)?meeting|recap\s+(?:the\s+)?meeting|action\s+items?\s+from\s+(?:the\s+)?meeting|what\s+(?:did|was)\s+.*\b(?:decide|discuss|agree|assign)\b.*\bmeeting\b)\b/i;
// "sync" and "stand-up" also occur in ordinary calendar/data requests. They
// enter retrieval only when coupled to an explicit evidence request.
const AMBIGUOUS_MEETING_RETRIEVAL = /\b(?:sync|stand-?up)\b(?:\s+meeting)?\s+(?:notes|transcript|summary)\b|\b(?:notes|transcript|summary)\s+(?:from|for)\s+(?:the\s+)?(?:sync|stand-?up)\b/i;

const REFERENTIAL_FOLLOW_UP = /\b(?:that|this)\s+(?:meeting|call|one|discussion)\b|\b(?:it|they|them)\s+(?:decide|discuss|agree|say|mention|choose|plan|assign)\b|\b(?:tell\s+me\s+more|what\s+else|and\s+then)\b/i;
const ISO_DAY = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
const NUMERIC_DAY = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g;
const MONTH_DAY = /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:,?\s+(\d{4}))?\b/gi;
const EMAIL = /\b([a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)\b/gi;
const DOMAIN = /\b([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)\b/gi;

const MONTHS: Readonly<Record<string, number>> = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
};

function localDay(now: Date): string {
  return `${now.getFullYear().toString().padStart(4, "0")}-${(now.getMonth() + 1).toString().padStart(2, "0")}-${now.getDate().toString().padStart(2, "0")}`;
}

function formatDay(year: number, month: number, day: number): string | null {
  const value = new Date(year, month - 1, day);
  if (
    value.getFullYear() !== year
    || value.getMonth() !== month - 1
    || value.getDate() !== day
  ) return null;
  return localDay(value);
}

function previousLocalDay(now: Date): string {
  const value = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  return localDay(value);
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function collectExplicitDays(question: string, now: Date): string[] {
  const days: string[] = [];
  for (const match of question.matchAll(ISO_DAY)) {
    const day = formatDay(Number(match[1]), Number(match[2]), Number(match[3]));
    if (day !== null) days.push(day);
  }
  for (const match of question.matchAll(NUMERIC_DAY)) {
    const day = formatDay(Number(match[3]), Number(match[1]), Number(match[2]));
    if (day !== null) days.push(day);
  }
  for (const match of question.matchAll(MONTH_DAY)) {
    const month = MONTHS[match[1].toLowerCase()];
    const day = formatDay(Number(match[3] ?? now.getFullYear()), month, Number(match[2]));
    if (day !== null) days.push(day);
  }
  return uniqueSorted(days);
}

function parseDateSelector(question: string, now: Date): MeetingDateSelector | null {
  const explicitDays = collectExplicitDays(question, now);
  const hasToday = /\btoday\b/i.test(question);
  const hasYesterday = /\byesterday\b/i.test(question);
  const relativeDays = uniqueSorted([
    ...(hasToday ? [localDay(now)] : []),
    ...(hasYesterday ? [previousLocalDay(now)] : []),
  ]);
  const allDays = uniqueSorted([...explicitDays, ...relativeDays]);

  // A question that names multiple calendar days is not silently assigned to
  // one of them. Later selection will ask for clarification instead.
  if (allDays.length !== 1) return null;
  return {
    day: allDays[0],
    kind: explicitDays.length === 1 ? "explicit" : "relative",
  };
}

function isExactDateReply(reply: string): boolean {
  return /^(?:today|yesterday|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4}|(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}(?:,?\s+\d{4})?)$/i.test(reply.trim());
}

function collectEmails(question: string): string[] {
  return uniqueSorted([...question.matchAll(EMAIL)].map((match) => match[1].toLowerCase()));
}

function collectDomains(question: string, emails: readonly string[]): string[] {
  const emailDomains = emails.map((email) => email.slice(email.lastIndexOf("@") + 1));
  const bareDomains = [...question.matchAll(DOMAIN)]
    .map((match) => match[1].toLowerCase())
    // An e-mail's domain also matches DOMAIN, but it is already represented
    // through the exact e-mail selector and should not be treated as a second
    // independent selector.
    .filter((domain) => !emails.some((email) => email.endsWith(`@${domain}`)));
  return uniqueSorted([...emailDomains, ...bareDomains]);
}

function collectPhrases(question: string): string[] {
  const phrases: string[] = [];
  const addPhrase = (value: string) => {
    const phrase = value.trim().replace(/^(?:["'])|(?:["'])$/g, "").trim();
    if (phrase.length > 0 && !/^(?:a|an|the|latest|most\s+recent)$/i.test(phrase)) phrases.push(phrase);
  };
  for (const match of question.matchAll(/["']([^"']{1,80})["']/g)) {
    addPhrase(match[1]);
  }
  for (const match of question.matchAll(/\b(?:meeting|stand-?up|sync)\s+(?:with|titled|called)\s+([^?!.,;]{1,80})/gi)) {
    addPhrase(match[1]);
  }
  for (const match of question.matchAll(/\bnotes\s+from\s+(?:the\s+)?([^?!.,;]{1,80}?)\s+(?:meeting|stand-?up|sync)\b/gi)) {
    addPhrase(match[1]);
  }
  for (const match of question.matchAll(/\b([^?!.,;]{1,80}?)\s+(?:meeting|stand-?up|sync)\s+(?:notes|summary|transcript)\b/gi)) {
    addPhrase(match[1].replace(/^(?:show\s+me|give\s+me|find)\s+/i, ""));
  }
  for (const match of question.matchAll(/\bwhat\s+did\s+([^?!.,;]{1,80}?)\s+(?:say|mention)\b/gi)) {
    addPhrase(match[1]);
  }
  return uniqueSorted(phrases);
}

/**
 * Parse only the supported meeting grammar. `null` means callers must take
 * the ordinary-chat path and, importantly, perform no meeting discovery.
 */
export function detectMeetingIntent(
  question: string,
  options: MeetingIntentOptions = {},
): MeetingIntent | null {
  const normalized = question.trim();
  if (normalized.length === 0) return null;

  const now = options.now ?? new Date();
  const hasMeetingNoun = MEETING_NOUN.test(normalized);
  const hasRetrievalPhrase = RETRIEVAL_PHRASE.test(normalized) || AMBIGUOUS_MEETING_RETRIEVAL.test(normalized);
  const hasReferentialFollowUp = options.hasSelectedMeeting === true && REFERENTIAL_FOLLOW_UP.test(normalized);
  const date = parseDateSelector(normalized, now);
  const emails = collectEmails(normalized);
  const emailDomains = collectDomains(normalized, emails);
  const phrases = collectPhrases(normalized).filter((phrase) => {
    const value = phrase.toLocaleLowerCase();
    return !emailDomains.some((domain) => domain === value || domain.startsWith(`${value}.`));
  });
  const latest = /\b(?:latest|most\s+recent)\b/i.test(normalized);

  // A date, identity, quoted/title phrase, or `latest` is a selector. A
  // meeting noun alone intentionally is not: selection must not search bodies
  // to make a vague request useful.
  const hasStrongSelector = date !== null || emails.length > 0 || emailDomains.length > 0 || phrases.length > 0 || latest;
  if (!hasMeetingNoun && !hasRetrievalPhrase && !hasReferentialFollowUp) return null;

  return {
    date,
    emails,
    emailDomains,
    hasMeetingNoun,
    hasReferentialFollowUp,
    hasRetrievalPhrase,
    hasStrongSelector,
    latest,
    phrases,
  };
}

const MAX_CLARIFICATION_CHOICES = 5;
const TOKEN = /[\p{L}\p{N}]+/gu;

function normalized(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function tokens(value: string): string[] {
  return [...new Set((value.toLocaleLowerCase().match(TOKEN) ?? []).filter((token) => token.length > 0))];
}

function candidateText(candidate: MeetingCandidate): string[] {
  return [candidate.title, ...candidate.participantNames]
    .filter((value): value is string => value !== null)
    .map(normalized);
}

function calendarDay(value: string | null): string | null {
  if (value === null || !/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : localDay(date);
}

function requiresTranscript(question: string): boolean {
  return /\b(?:transcript|quote|speaker|what\s+(?:was|did)\s+(?:said|they\s+say)|what\s+did\s+[\p{L}][\p{L}'-]{0,79}\s+(?:say|mention))\b/iu.test(question);
}

function isOpaqueKvOnly(candidate: MeetingCandidate): boolean {
  return candidate.title === null
    && candidate.startedAt === null
    && candidate.participantNames.length === 0
    && candidate.participantEmails.length === 0
    && candidate.organizerEmail === null
    && candidate.localRowId === null
    && !candidate.hasServerSummary
    && !candidate.hasServerTranscript;
}

function recency(candidate: MeetingCandidate): number {
  const value = candidate.startedAt === null ? Number.NaN : Date.parse(candidate.startedAt);
  return Number.isNaN(value) ? Number.NEGATIVE_INFINITY : value;
}

function stableCandidateOrder(a: MeetingCandidate, b: MeetingCandidate): number {
  // Recency is a deliberate selection tie-breaker; all remaining properties
  // make output independent of discovery/page input order.
  return recency(b) - recency(a)
    || (a.title ?? "").localeCompare(b.title ?? "")
    || (a.startedAt ?? "").localeCompare(b.startedAt ?? "")
    || a.source.localeCompare(b.source)
    || a.sourceId.localeCompare(b.sourceId);
}

function sameRef(candidate: MeetingCandidate, ref: MeetingRef): boolean {
  return candidate.source === ref.source && candidate.sourceId === ref.sourceId;
}

function copyRef({ source, sourceId }: MeetingRef): MeetingRef {
  return { source, sourceId };
}

function copyCandidate(candidate: MeetingCandidate): MeetingCandidate {
  return {
    ...candidate,
    participantNames: [...candidate.participantNames],
    participantEmails: [...candidate.participantEmails],
  };
}

function candidateEmails(candidate: MeetingCandidate): string[] {
  return [candidate.organizerEmail, ...candidate.participantEmails]
    .filter((value): value is string => value !== null)
    .map((value) => value.toLocaleLowerCase());
}

function isDomainMatch(candidate: MeetingCandidate, domains: readonly string[]): boolean {
  if (domains.length === 0) return true;
  return candidateEmails(candidate).some((email) => {
    const at = email.lastIndexOf("@");
    return at >= 0 && domains.includes(email.slice(at + 1));
  });
}

function countTokenOverlap(candidate: MeetingCandidate, phrases: readonly string[]): number {
  const requested = new Set(phrases.flatMap(tokens));
  if (requested.size === 0) return 0;
  const available = new Set(candidateText(candidate).flatMap(tokens));
  let overlap = 0;
  for (const token of requested) if (available.has(token)) overlap += 1;
  return overlap;
}

function exactPhraseMatch(candidate: MeetingCandidate, phrases: readonly string[]): boolean {
  if (phrases.length === 0) return true;
  const text = new Set(candidateText(candidate));
  return phrases.some((phrase) => text.has(normalized(phrase)));
}

function noMatchForCorpus(corpus: MeetingCorpus): MeetingSelection {
  return corpus.partial
    ? { status: "storage-error", partial: true }
    : { status: "no-match", partial: false };
}

function clarification(candidates: readonly MeetingCandidate[], corpus: MeetingCorpus): MeetingSelection {
  const ordered = [...candidates].sort(stableCandidateOrder);
  return {
    status: "clarification",
    choices: ordered.slice(0, MAX_CLARIFICATION_CHOICES),
    ...(corpus.partial ? { partial: true } : {}),
    ...(ordered.length > MAX_CLARIFICATION_CHOICES ? { truncated: true } : {}),
  };
}

/**
 * Select exactly one candidate without reading meeting bodies. All filtering
 * and ordering is metadata-only and produces the same result regardless of
 * discovery lane or pagination order.
 */
export function selectMeeting(
  intent: MeetingIntent,
  corpus: MeetingCorpus,
  options: MeetingSelectionOptions = {},
): MeetingSelection {
  let candidates = corpus.candidates.filter((candidate) => !isOpaqueKvOnly(candidate));
  // The narrow "meeting with …" intent grammar intentionally also captures
  // a plain participant phrase. When that tail is an e-mail address, its
  // address selector is authoritative; a partial `name@example` phrase must
  // not accidentally veto the exact e-mail match.
  const domainSet = new Set(intent.emailDomains.map(normalized));
  const phrases = intent.phrases.filter((phrase) =>
    !phrase.includes("@") && !domainSet.has(normalized(phrase)),
  );

  // Explicit and small relative dates are calendar filters, never fuzzy text
  // scores. A malformed timestamp simply cannot satisfy the explicit day.
  if (intent.date !== null) {
    candidates = candidates.filter((candidate) => calendarDay(candidate.startedAt) === intent.date?.day);
  }

  // A selected thread identity is sufficient only for a follow-up that has no
  // new selector. A fresh title/date/email selector must still be allowed to
  // choose a different meeting.
  if (!intent.hasStrongSelector && options.selected !== null && options.selected !== undefined) {
    const selected = corpus.candidates.find((candidate) => sameRef(candidate, options.selected!));
    if (selected !== undefined) return { status: "selected", meeting: selected };
  }

  if (candidates.length === 0) return noMatchForCorpus(corpus);

  if (!intent.hasStrongSelector) return clarification(candidates, corpus);

  // Exact e-mail is intentionally a hard identity selector. Do not weaken a
  // failed exact address into a broad domain or title search.
  if (intent.emails.length > 0) {
    const wanted = new Set(intent.emails.map((email) => email.toLocaleLowerCase()));
    candidates = candidates.filter((candidate) => candidateEmails(candidate).some((email) => wanted.has(email)));
    if (candidates.length === 0) return noMatchForCorpus(corpus);
  } else if (intent.emailDomains.length > 0) {
    candidates = candidates.filter((candidate) => isDomainMatch(candidate, intent.emailDomains));
    if (candidates.length === 0) return noMatchForCorpus(corpus);
  }

  // Exact title or participant phrases outrank token overlap. If an exact
  // phrase exists, only those candidates remain plausible; otherwise phrases
  // use a conservative title/participant token intersection.
  if (phrases.length > 0) {
    const exact = candidates.filter((candidate) => exactPhraseMatch(candidate, phrases));
    if (exact.length > 0) {
      candidates = exact;
    } else {
      const scored = candidates
        .map((candidate) => ({ candidate, overlap: countTokenOverlap(candidate, phrases) }))
        .filter(({ overlap }) => overlap > 0);
      if (scored.length === 0) return noMatchForCorpus(corpus);
      const bestOverlap = Math.max(...scored.map(({ overlap }) => overlap));
      candidates = scored
        .filter(({ overlap }) => overlap === bestOverlap)
        .map(({ candidate }) => candidate);
    }
  }

  // `latest` must have one, valid, uniquely newest timestamp. A lexical
  // fallback would make an undated or tied archive look more certain than it is.
  const ordered = [...candidates].sort(stableCandidateOrder);
  if (intent.latest) {
    if (ordered.some((candidate) => recency(candidate) === Number.NEGATIVE_INFINITY)) {
      return clarification(ordered, corpus);
    }
    const newest = recency(ordered[0]);
    if (newest === Number.NEGATIVE_INFINITY) return clarification(ordered, corpus);
    const equallyRecent = ordered.filter((candidate) => recency(candidate) === newest);
    return equallyRecent.length === 1
      ? { status: "selected", meeting: ordered[0] }
      : clarification(ordered, corpus);
  }
  if (ordered.length === 1) return { status: "selected", meeting: ordered[0] };

  const newest = recency(ordered[0]);
  const equallyRecent = ordered.filter((candidate) => recency(candidate) === newest);
  if (equallyRecent.length === 1) return { status: "selected", meeting: ordered[0] };

  return clarification(ordered, corpus);
}
