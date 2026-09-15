/** TinyChat/companion publication and evidence contract, proposed version 3. */
export const MEETING_CONTRACT_VERSION = 3 as const;
export const MEETING_ORIGINAL_BODY_BYTE_LIMIT = 1_048_576;
export const MEETING_ENVELOPE_BYTE_LIMIT = 2_097_152;
export type MeetingSource = 'fireflies' | 'google-meet' | 'tinycloud-transcriber';
export type EvidenceBasis = 'transcript' | 'notes' | 'overview';
export interface SourceReference { source: MeetingSource; sourceId: string; meetingRef: string; revision: string }
export interface MeetingMetadata {
  title: string | null;
  startedAt: string | null;
  organizerEmail: string | null;
  participants: Array<{ name?: string; email?: string }>;
  /** Original connector metadata is preserved in the snapshot, never prompt instructions. */
  metadata: Record<string, unknown>;
}
export interface EvidenceOmission {
  code: string;
  recordIndex?: number;
  byteStart?: number;
  byteEnd?: number;
  detail?: string;
}
export interface OriginalBodyAccounting {
  digest: string;
  byteLength: number;
  recordCount: number | null;
  /** Artifact extent only; this does not assert complete capture of the meeting. */
  extent: 'known' | 'unknown';
  captureComplete: boolean | null;
}
export interface PublishedMeetingSnapshot {
  contractVersion: 3;
  meetingRef: string;
  source: MeetingSource;
  sourceId: string;
  operationId: string;
  createdAt: string;
  metadata: MeetingMetadata;
  body: null | {
    basis: 'transcript' | 'notes';
    encoding: 'utf-8';
    /** raw is exact UTF-8 artifact text; JSON is decoded only by companion. */
    schema: 'text' | 'json-records' | 'google-docs';
    raw: string;
    original: OriginalBodyAccounting;
    omissions: EvidenceOmission[];
  };
  overview: null | {
    text: string;
    provenance: { provider: string | null; generatedAt: string | null; sourceDigest: string | null; freshness: 'known' | 'unknown' };
  };
  aliases: string[];
}
/** revision = lowercase sha256(snapshot UTF-8 bytes); never included in hashed payload. */
export interface CatalogMeeting extends Omit<SourceReference, 'revision'> {
  revision: string | null;
  readiness: 'published' | 'unverified' | 'unavailable';
  title: string | null;
  startedAt: string | null;
  organizerEmail: string | null;
  participants: Array<{ name?: string; email?: string }>;
  basis: 'transcript' | 'notes' | null;
}
export interface CatalogFilters { source?: MeetingSource }
export interface CatalogPageRequest { contractVersion: 3; after?: string; filters?: CatalogFilters; limit?: 100 }
export interface CatalogPageEnvelope {
  contractVersion: 3;
  kind: 'page';
  rows: CatalogMeeting[];
  /** Last raw catalog ID examined, not last decoded/matched row. */
  nextCursor: string | null;
  exhausted: boolean;
  examinedRows: number;
  observedAt: string;
  scope: 'observed';
  omissions: EvidenceOmission[];
}
export interface ExactReadRequest { contractVersion: 3; reference: SourceReference; basis: EvidenceBasis }
export interface EvidenceSpan {
  text: string;
  /** Stable original record index plus offsets in that record's text (UTF-16). */
  recordIndex: number;
  start: number;
  end: number;
  path?: string;
  speaker?: string;
  startSecs?: number;
}
export interface EvidenceEnvelope {
  contractVersion: 3;
  kind: 'evidence';
  reference: SourceReference;
  basis: EvidenceBasis;
  metadata: MeetingMetadata | null;
  state: 'complete' | 'partial' | 'missing' | 'unavailable' | 'capacity';
  original: OriginalBodyAccounting | null;
  coverage: {
    fetched: boolean;
    decodedRecords: number;
    totalRecords: number | null;
    suppliedRecords: number;
    /** Companion does not know model processing; backend fills its own receipt. */
    processedRecords: null;
  };
  spans: EvidenceSpan[];
  omissions: EvidenceOmission[];
  overviewProvenance: NonNullable<PublishedMeetingSnapshot['overview']>['provenance'] | null;
}
