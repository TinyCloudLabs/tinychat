/**
 * Shared, browser-only meeting-chat contracts.
 *
 * Discovery values deliberately stop at metadata. Raw summary and transcript
 * text belongs only in {@link MeetingEvidence}, which is ephemeral and is
 * never suitable for a thread item, checkpoint, or memory write.
 */

/** The only identity used to relate data from separate meeting stores. */
export interface MeetingRef {
  source: string;
  sourceId: string;
}

/**
 * Metadata discovered for a meeting. Keep this contract content-free: neither
 * summaries nor transcript/provider payloads may be added here.
 */
export interface MeetingCandidate extends MeetingRef {
  title: string | null;
  startedAt: string | null;
  participantNames: readonly string[];
  participantEmails: readonly string[];
  organizerEmail: string | null;
  hasSqlSummary: boolean;
  hasLocalRecord: boolean;
  hasLocalTranscript: boolean;
  hasServerSummary: boolean;
  hasServerTranscript: boolean;
  localRowId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

/** A SQL summary location which may be read only after selection. */
export interface SqlSummaryLocator extends MeetingRef {
  kind: "sql-summary";
  localRowId: string;
}

/** A reconciled local meeting-record location. */
export interface LocalKvRecordLocator extends MeetingRef {
  kind: "local-kv-record";
}

/** A reconciled local transcript location. */
export interface LocalKvTranscriptLocator extends MeetingRef {
  kind: "local-kv-transcript";
}

/** The server's selected-meeting read location. */
export interface ServerMeetingLocator extends MeetingRef {
  kind: "server-meeting";
}

/** A local or remote location which may be read only after selection. */
export type MeetingEvidenceLocator =
  | SqlSummaryLocator
  | LocalKvRecordLocator
  | LocalKvTranscriptLocator
  | ServerMeetingLocator;

export type MeetingEvidenceLocatorKind = MeetingEvidenceLocator["kind"];

/** A normalized, citation-ready transcript span. */
export interface MeetingExcerpt {
  speaker: string | null;
  startSecs: number | null;
  endSecs: number | null;
  text: string;
}

/**
 * Ephemeral raw evidence for one selected meeting. `transcript` remains
 * unknown until context normalization validates its supported payload shape.
 */
export interface MeetingEvidence {
  summary: string | null;
  summaryLocator: MeetingEvidenceLocator | null;
  transcript: unknown | null;
  transcriptLocator: MeetingEvidenceLocator | null;
  /** Normalized once at the evidence boundary; never persisted. */
  transcriptChunks?: readonly MeetingExcerpt[];
  reads: number;
  partial: boolean;
  unavailableLocators: readonly MeetingEvidenceLocatorKind[];
}

/** Health for one metadata-discovery lane. Failures are never empty results. */
export type MeetingLaneHealth =
  | { state: "unused"; reason: "missing-table" }
  | { state: "healthy" }
  | { state: "partial"; malformedRows: number; truncated?: boolean }
  | { state: "feature-dark" }
  | { state: "signed-out" }
  | { state: "offline" }
  | { state: "retryable"; httpStatus: number | null }
  | { state: "rejected"; httpStatus: number | null }
  | { state: "failed"; reason: "storage" | "transport" | "malformed-response" };

/** Content-free discovery result assembled from SQL, server, and KV lanes. */
export interface MeetingCorpus {
  candidates: readonly MeetingCandidate[];
  lanes: {
    sql: MeetingLaneHealth;
    server: MeetingLaneHealth;
    kv: MeetingLaneHealth;
  };
  partial: boolean;
}

/** In-memory-only state associated with a live chat thread. */
export interface MeetingThreadState {
  selected: MeetingRef | null;
  ambiguityChoices: readonly MeetingCandidate[];
}

/** Every result of meeting retrieval, including deterministic no-model paths. */
export type MeetingRetrievalOutcome =
  | { status: "not-applicable" }
  | {
      status: "clarification";
      choices: readonly MeetingCandidate[];
      /** Discovery omitted or could not validate some candidates. */
      partial?: true;
      /** More matching candidates existed than the five displayed choices. */
      truncated?: true;
    }
  | { status: "no-match"; partial: boolean }
  | {
      status: "no-content";
      meeting: MeetingCandidate;
      partial: boolean;
      /** A readable summary exists, but this turn specifically needed a transcript. */
      summaryAvailable?: boolean;
      transcriptRequired?: boolean;
    }
  | { status: "storage-error"; partial: boolean }
  | { status: "aborted" }
  | {
      status: "grounded";
      meeting: MeetingCandidate;
      evidence: MeetingEvidence;
      /** The escaped, bounded system message assembled after evidence retrieval. */
      systemMessage: string;
      partial: boolean;
    };

export const MAX_EVIDENCE_READS = 3;
export const MAX_EXCERPTS = 4;
export const CHUNK_TARGET_CHARS = 1_000;
export const CHUNK_HARD_CHARS = 1_400;
export const CHUNK_MAX_SPAN_SECS = 90;
export const MEETING_CONTEXT_MAX_CHARS = 12_000;

// Compile-time tripwire: candidates and live thread state must remain
// content-free even as later retrieval/context work evolves.
type AssertNever<T extends never> = T;
type _CandidateHasNoRawContent = AssertNever<
  Extract<keyof MeetingCandidate, "summary" | "transcript" | "providerMetadata" | "provenance">
>;
type _ThreadStateHasNoRawContent = AssertNever<
  Extract<keyof MeetingThreadState, "summary" | "transcript" | "providerMetadata" | "provenance">
>;

export type { _CandidateHasNoRawContent, _ThreadStateHasNoRawContent };
