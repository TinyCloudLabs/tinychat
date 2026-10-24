/**
 * Meeting storage format: three SQLite databases and their table definitions.
 *
 * - details: meeting metadata, participants, keywords, source references and
 *   connector state. Scalar and identifying fields only; see rows.ts.
 * - summaries: summary text and action items.
 * - transcripts: transcript metadata and transcript segments.
 *
 * Rows are joined client-side by meeting id; there are no cross-database
 * foreign keys or transactions. Privacy levels grant exact database paths
 * (see levels.ts).
 *
 * No CREATE INDEX statements: the node's SQLite authorizer denies them, so
 * every lookup relies on a PRIMARY KEY.
 */
import { APP_ID } from "../connector-meeting.js";

/** Version written to `meeting.schema_version` for rows in this format. */
export const MEETING_DB_SCHEMA_VERSION = 1;

export const MEETING_DB_DETAILS = `${APP_ID}/details` as const;
export const MEETING_DB_SUMMARIES = `${APP_ID}/summaries` as const;
export const MEETING_DB_TRANSCRIPTS = `${APP_ID}/transcripts` as const;

export type MeetingDbPath =
  | typeof MEETING_DB_DETAILS
  | typeof MEETING_DB_SUMMARIES
  | typeof MEETING_DB_TRANSCRIPTS;

/** Details database: metadata only. Must never hold summary, action, transcript or payload text. */
export const DETAILS_SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS meeting (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    source_id TEXT,
    title TEXT,
    started_at TEXT,
    duration_secs INTEGER,
    meeting_type TEXT,
    content_kind TEXT,
    has_summary INTEGER NOT NULL DEFAULT 0,
    has_transcript INTEGER NOT NULL DEFAULT 0,
    transcript_start_secs REAL,
    transcript_end_secs REAL,
    coverage_status TEXT,
    parent_meeting_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    schema_version INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS meeting_participant (
    meeting_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    display_name TEXT,
    email TEXT,
    role TEXT,
    PRIMARY KEY(meeting_id, ordinal)
  )`,
  `CREATE TABLE IF NOT EXISTS meeting_keyword (
    meeting_id TEXT NOT NULL,
    keyword TEXT NOT NULL,
    PRIMARY KEY(meeting_id, keyword)
  )`,
  // Combined meetings reference every source capture they were built from.
  `CREATE TABLE IF NOT EXISTS meeting_source_ref (
    meeting_id TEXT NOT NULL,
    source TEXT NOT NULL,
    source_id TEXT NOT NULL,
    PRIMARY KEY(meeting_id, source, source_id)
  )`,
  `CREATE TABLE IF NOT EXISTS connector_state (
    connector_id TEXT PRIMARY KEY,
    last_synced_at TEXT,
    status TEXT
  )`,
];

/** Summaries database: summary text and action items, keyed by meeting id. */
export const SUMMARIES_SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS meeting_summary (
    meeting_id TEXT PRIMARY KEY,
    summary TEXT,
    updated_at TEXT NOT NULL,
    revision TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS meeting_action_item (
    meeting_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    text TEXT NOT NULL,
    assignee TEXT,
    due_at TEXT,
    status TEXT,
    PRIMARY KEY(meeting_id, ordinal)
  )`,
];

/** Transcripts database: transcript metadata and segments, keyed by meeting id. */
export const TRANSCRIPTS_SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS meeting_transcript (
    meeting_id TEXT PRIMARY KEY,
    format TEXT,
    language TEXT,
    revision TEXT,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS transcript_segment (
    meeting_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    speaker TEXT,
    start_secs REAL,
    end_secs REAL,
    text TEXT NOT NULL,
    PRIMARY KEY(meeting_id, ordinal)
  )`,
];
