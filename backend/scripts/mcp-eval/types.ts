/**
 * Backend-agnostic types for the frozen meeting-answer eval.
 * Synthetic material only: no real account, source ID or provider transcript.
 */

export type EvidenceKind = "summary" | "notes" | "action" | "transcript_excerpt" | "metadata";

export interface FixtureEvidence {
  /** Stable label, `M<n>:E<m>`; this is the id a citation must reference. */
  id: string;
  kind: EvidenceKind;
  text: string;
  speaker?: string;
  startSecs?: number;
}

export interface FixtureMeeting {
  /** Stable label `M<n>`, ordered newest first. */
  id: string;
  title: string;
  startedAt: string;
  participants: string[];
  /** `read`: content evidence retained. `metadata`: discovered only. `not_read`: listed, content not read. */
  state: "read" | "metadata" | "not_read";
  evidence: FixtureEvidence[];
  /** Raw `connector_meeting.metadata` JSON. Only the size-limit generator fills it. */
  rawMetadata?: string;
}

export interface PublicSource {
  title: string;
  url: string;
  snippet: string;
}

/** Deterministic row generator for the size-limit case (501 transcript-heavy rows). */
export interface TranscriptHeavyGenerator {
  kind: "transcript-heavy-rows";
  rows: number;
  /** Lines of transcript text stored in each row's raw metadata. */
  transcriptLines: number;
  /** Newest row timestamp (ISO); each later row is one hour older. */
  newestStartedAt: string;
}

export interface FixtureSpace {
  access: "granted" | "revoked";
  meetings: FixtureMeeting[];
  publicSources?: PublicSource[];
  generator?: TranscriptHeavyGenerator;
}

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface EvalExpectation {
  /** `content`: answer from meeting evidence. `metadata`: listing/attendance. `decline`: no supported answer exists (clarify, none, revoked, no match). `general`: not about meetings. */
  behavior: "content" | "metadata" | "decline" | "general";
  /** Every string must appear (case-insensitive) in the answer. */
  requiredFacts: string[];
  /** Answer must not match any of these case-insensitive regex sources. */
  forbiddenPatterns: string[];
  /** Distinct meetings whose evidence the answer must cite (ids from the space). */
  minCitedMeetings: number;
  /** Evidence ids of which at least `minCitedMeetings` meetings must be cited from; empty = any content evidence in the space. */
  citableEvidenceIds: string[];
  /** Citations must match this syntax: `[M1:E1]` or `[M1:E1, Speaker, hh:mm:ss]`; metadata answers may use `[M1]`. */
  citationSyntax: string;
  /** `### Coverage` section expectation. */
  coverage: {
    required: boolean;
    /** Meeting ids the coverage section must mention. */
    mentionsMeetings: string[];
    mustMatch: string[];
    mustNotMatch: string[];
  };
  /** Public source URLs that must appear in the answer. */
  publicSourceUrls: string[];
  /** Answer must have no size-limit tool errors and no size-limit text. */
  noSizeLimitErrors: boolean;
}

export interface EvalCase {
  id: string;
  /** Where the case was derived from (tinychat meeting-eval scenario or Eliza test at the pinned commit). */
  origin: string;
  /** Size-limit case that gates `sizeLimitErrors`. */
  sizeLimit?: boolean;
  question: string;
  history?: ChatTurn[];
  space: FixtureSpace;
  expect: EvalExpectation;
}

export interface CasesFile {
  version: number;
  cases: EvalCase[];
}

export interface Manifest {
  version: number;
  frozenOn: string;
  caseCount: number;
  casesSha256: string;
  sizeLimitCaseIds: string[];
  derivedFrom: Record<string, string>;
  notes: string[];
}

export interface ChatQuestion {
  text: string;
  history: ChatTurn[];
  /** Offered model id the backend must answer with. */
  model: string;
}

export interface ChatAnswer {
  /** Final answer text, including its coverage section and source list. */
  text: string;
  /** Tool/transport error codes observed while answering (size-limit codes are counted from here). */
  toolErrors?: string[];
}

export interface ChatBackend {
  readonly id: string;
  /** Offered model ids this backend can answer with. */
  models(): readonly string[];
  answer(question: ChatQuestion, fixtureSpace: FixtureSpace): Promise<ChatAnswer>;
}

/** Thrown by a backend that cannot answer; the runner records the model as NOT RUN, never as a pass or a fail. */
export class BackendUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackendUnavailableError";
  }
}
