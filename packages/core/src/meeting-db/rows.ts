/**
 * Row types for the three meeting databases, plus validators for each table.
 * The validators accept only the declared scalar fields, so content such as
 * transcript or summary text cannot be written into details by accident:
 * unknown keys, objects, arrays and over-long strings are rejected.
 */

export class MeetingDbRowError extends Error {
  constructor(table: string, reason: string) {
    super(`invalid ${table} row: ${reason}`);
    this.name = "MeetingDbRowError";
  }
}

// ── Details database ─────────────────────────────────────────────────

export interface MeetingDetailsRow {
  id: string;
  source: string;
  source_id: string | null;
  title: string | null;
  started_at: string | null;
  duration_secs: number | null;
  meeting_type: string | null;
  content_kind: string | null;
  has_summary: 0 | 1;
  has_transcript: 0 | 1;
  transcript_start_secs: number | null;
  transcript_end_secs: number | null;
  coverage_status: string | null;
  parent_meeting_id: string | null;
  created_at: string;
  updated_at: string;
  schema_version: number;
}

export interface MeetingParticipantRow {
  meeting_id: string;
  ordinal: number;
  display_name: string | null;
  email: string | null;
  role: string | null;
}

export interface MeetingKeywordRow {
  meeting_id: string;
  keyword: string;
}

export interface MeetingSourceRefRow {
  meeting_id: string;
  source: string;
  source_id: string;
}

export interface ConnectorStateRow {
  connector_id: string;
  last_synced_at: string | null;
  status: string | null;
}

// ── Summaries database ───────────────────────────────────────────────

export interface MeetingSummaryRow {
  meeting_id: string;
  summary: string | null;
  updated_at: string;
  revision: string | null;
}

export interface MeetingActionItemRow {
  meeting_id: string;
  ordinal: number;
  text: string;
  assignee: string | null;
  due_at: string | null;
  status: string | null;
}

// ── Transcripts database ─────────────────────────────────────────────

export interface MeetingTranscriptRow {
  meeting_id: string;
  format: string | null;
  language: string | null;
  revision: string | null;
  updated_at: string;
}

export interface TranscriptSegmentRow {
  meeting_id: string;
  ordinal: number;
  speaker: string | null;
  start_secs: number | null;
  end_secs: number | null;
  text: string;
}

// ── Field validation ─────────────────────────────────────────────────

type FieldSpec =
  | { kind: "text"; max: number; nullable: boolean; nonBlank: boolean }
  | { kind: "integer"; nullable: boolean }
  | { kind: "real"; nullable: boolean }
  | { kind: "flag" };

const text = (max: number, nullable = true, nonBlank = false): FieldSpec => ({ kind: "text", max, nullable, nonBlank });
const integer = (nullable = true): FieldSpec => ({ kind: "integer", nullable });
const real = (nullable = true): FieldSpec => ({ kind: "real", nullable });
const flag: FieldSpec = { kind: "flag" };

const MEETING_FIELDS: Record<keyof MeetingDetailsRow, FieldSpec> = {
  id: text(200, false, true),
  source: text(100, false),
  source_id: text(500),
  title: text(500),
  started_at: text(100),
  duration_secs: integer(),
  meeting_type: text(100),
  content_kind: text(100),
  has_summary: flag,
  has_transcript: flag,
  transcript_start_secs: real(),
  transcript_end_secs: real(),
  coverage_status: text(100),
  parent_meeting_id: text(200, true, true),
  created_at: text(100, false, true),
  updated_at: text(100, false, true),
  schema_version: integer(false),
};

const PARTICIPANT_FIELDS: Record<keyof MeetingParticipantRow, FieldSpec> = {
  meeting_id: text(200, false, true),
  ordinal: integer(false),
  display_name: text(200),
  email: text(320),
  role: text(100),
};

const KEYWORD_FIELDS: Record<keyof MeetingKeywordRow, FieldSpec> = {
  meeting_id: text(200, false, true),
  keyword: text(100, false),
};

const SOURCE_REF_FIELDS: Record<keyof MeetingSourceRefRow, FieldSpec> = {
  meeting_id: text(200, false, true),
  source: text(100, false, true),
  source_id: text(500, false, true),
};

const CONNECTOR_STATE_FIELDS: Record<keyof ConnectorStateRow, FieldSpec> = {
  connector_id: text(200, false, true),
  last_synced_at: text(100),
  status: text(100),
};

const SUMMARY_FIELDS: Record<keyof MeetingSummaryRow, FieldSpec> = {
  meeting_id: text(200, false, true),
  summary: text(20_000),
  updated_at: text(100, false, true),
  revision: text(100),
};

const ACTION_ITEM_FIELDS: Record<keyof MeetingActionItemRow, FieldSpec> = {
  meeting_id: text(200, false, true),
  ordinal: integer(false),
  text: text(2_000, false),
  assignee: text(200),
  due_at: text(100),
  status: text(100),
};

const TRANSCRIPT_FIELDS: Record<keyof MeetingTranscriptRow, FieldSpec> = {
  meeting_id: text(200, false, true),
  format: text(100),
  language: text(100),
  revision: text(100),
  updated_at: text(100, false, true),
};

const SEGMENT_FIELDS: Record<keyof TranscriptSegmentRow, FieldSpec> = {
  meeting_id: text(200, false, true),
  ordinal: integer(false),
  speaker: text(200),
  start_secs: real(),
  end_secs: real(),
  text: text(10_000, false),
};

/**
 * Returns a fresh object holding only the allowlisted fields. Missing nullable
 * fields become null; anything else unknown, non-scalar, out of range or over
 * length throws MeetingDbRowError.
 */
function parseRecord<T>(table: string, input: unknown, spec: Record<string, FieldSpec>): T {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new MeetingDbRowError(table, "expected a plain object");
  }
  const source = input as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    if (!Object.hasOwn(spec, key)) throw new MeetingDbRowError(table, `unknown field "${key}"`);
  }
  const out: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(spec)) {
    const value = source[name] ?? null;
    if (value === null) {
      if (field.kind === "flag" || !field.nullable) {
        throw new MeetingDbRowError(table, `field "${name}" is required`);
      }
      out[name] = null;
      continue;
    }
    switch (field.kind) {
      case "text":
        if (typeof value !== "string") throw new MeetingDbRowError(table, `field "${name}" must be a string`);
        if (value.length > field.max) {
          throw new MeetingDbRowError(table, `field "${name}" exceeds ${field.max} characters`);
        }
        if (field.nonBlank && value.trim() === "") {
          throw new MeetingDbRowError(table, `field "${name}" must not be blank`);
        }
        break;
      case "integer":
        if (!Number.isSafeInteger(value) || (value as number) < 0) {
          throw new MeetingDbRowError(table, `field "${name}" must be a non-negative integer`);
        }
        break;
      case "real":
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
          throw new MeetingDbRowError(table, `field "${name}" must be a finite, non-negative number`);
        }
        break;
      case "flag":
        if (value !== 0 && value !== 1) throw new MeetingDbRowError(table, `field "${name}" must be 0 or 1`);
        break;
    }
    out[name] = value;
  }
  return out as T;
}

/** Rejects an end time before its start time when both are present. */
function assertOrderedSpan(table: string, start: number | null, end: number | null, label: string): void {
  if (start !== null && end !== null && end < start) {
    throw new MeetingDbRowError(table, `${label}_end_secs is before ${label}_start_secs`);
  }
}

/** Validates one `meeting` row for the details database. */
export function parseDetailsRow(input: unknown): MeetingDetailsRow {
  const row = parseRecord<MeetingDetailsRow>("meeting", input, MEETING_FIELDS);
  assertOrderedSpan("meeting", row.transcript_start_secs, row.transcript_end_secs, "transcript");
  return row;
}

/** Validates one `meeting_participant` row for the details database. */
export function parseParticipantRow(input: unknown): MeetingParticipantRow {
  return parseRecord<MeetingParticipantRow>("meeting_participant", input, PARTICIPANT_FIELDS);
}

/** Validates one `meeting_keyword` row for the details database. */
export function parseKeywordRow(input: unknown): MeetingKeywordRow {
  return parseRecord<MeetingKeywordRow>("meeting_keyword", input, KEYWORD_FIELDS);
}

/** Validates one `meeting_source_ref` row for the details database. */
export function parseSourceRefRow(input: unknown): MeetingSourceRefRow {
  return parseRecord<MeetingSourceRefRow>("meeting_source_ref", input, SOURCE_REF_FIELDS);
}

/** Validates one `connector_state` row for the details database. */
export function parseConnectorStateRow(input: unknown): ConnectorStateRow {
  return parseRecord<ConnectorStateRow>("connector_state", input, CONNECTOR_STATE_FIELDS);
}

/** Validates one `meeting_summary` row for the summaries database. */
export function parseSummaryRow(input: unknown): MeetingSummaryRow {
  return parseRecord<MeetingSummaryRow>("meeting_summary", input, SUMMARY_FIELDS);
}

/** Validates one `meeting_action_item` row for the summaries database. */
export function parseActionItemRow(input: unknown): MeetingActionItemRow {
  return parseRecord<MeetingActionItemRow>("meeting_action_item", input, ACTION_ITEM_FIELDS);
}

/** Validates one `meeting_transcript` row for the transcripts database. */
export function parseTranscriptRow(input: unknown): MeetingTranscriptRow {
  return parseRecord<MeetingTranscriptRow>("meeting_transcript", input, TRANSCRIPT_FIELDS);
}

/** Validates one `transcript_segment` row for the transcripts database. */
export function parseTranscriptSegmentRow(input: unknown): TranscriptSegmentRow {
  const row = parseRecord<TranscriptSegmentRow>("transcript_segment", input, SEGMENT_FIELDS);
  assertOrderedSpan("transcript_segment", row.start_secs, row.end_secs, "segment");
  return row;
}
