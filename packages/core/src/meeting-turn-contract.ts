import type {
  SourceReference,
  EvidenceBasis,
  EvidenceSpan,
  EvidenceOmission,
  EvidenceEnvelope,
  OriginalBodyAccounting,
} from "./meeting-contract.js";

export type MeetingResultStatus =
  | "completed"
  | "partial"
  | "unavailable"
  | "failed"
  | "cancelled"
  | "clarification_required";
export type MeetingMode = "listing" | "analysis" | "overview" | "search";
export interface MeetingPart {
  id: string;
  question: string;
}
export interface MeetingRequestFilters {
  source?: SourceReference["source"];
  title?: string;
  participant?: string;
  from?: string;
  to?: string;
  timeZone?: string;
}
export interface MeetingIntent {
  mode: MeetingMode;
  parts: MeetingPart[];
  basis?: EvidenceBasis;
  references?: SourceReference[];
  filters?: MeetingRequestFilters;
  ordinal?: number;
  select?: "newest" | "oldest";
  selection?: "one" | "all";
  terms?: string[];
  scope?: "explicit" | "observed" | "exhaustive";
}
export interface MeetingParent {
  messageId: string;
  turnId: string;
  sources: SourceReference[];
}
export interface MeetingContinuation {
  version: 3;
  intent: MeetingIntent;
  /** Last catalog ID examined; pending contains fetched but unread sources. */
  cursor: string | null;
  pending: SourceReference[];
  encountered: SourceReference[];
  examinedSources: number;
  matchedSources: number;
  exhausted: boolean;
}
export interface MeetingTurnInput {
  turnId: string;
  /** Browser Send timestamp. Server clamps it to its own receipt time. */
  sentAt: number;
  parentMessageId?: string;
  parent?: MeetingParent;
  intent?: MeetingIntent;
  continuation?: MeetingContinuation;
}
export interface MeetingObligation {
  id: string;
  source: SourceReference | null;
  partId: string;
  state: "fulfilled" | "unmet";
  reason?: string;
}
export interface MeetingCitation extends SourceReference, EvidenceSpan {
  id: string;
  basis: EvidenceBasis;
}
export interface MeetingResult {
  version: 3;
  turnId: string;
  private: true;
  status: MeetingResultStatus;
  text: string;
  sources: SourceReference[];
  obligations: MeetingObligation[];
  citations: MeetingCitation[];
  limitations: EvidenceOmission[];
  continuation?: MeetingContinuation;
  coverage: Array<{
    reference: SourceReference;
    state: EvidenceEnvelope["state"];
    basis: EvidenceBasis;
    original: OriginalBodyAccounting | null;
    overviewProvenance: EvidenceEnvelope["overviewProvenance"];
    fetched: boolean;
    decodedRecords: number;
    suppliedRecords: number;
    processedRecords: number;
    totalRecords: number | null;
  }>;
  receipts: {
    modelCalls: number;
    ioAttempts: number;
    recovery: "none" | "transient" | "repair";
    elapsedMs: number;
    providerStatus?: number;
    requestId?: string;
    phase?: string;
  };
}
