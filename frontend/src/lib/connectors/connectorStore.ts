// Connectors persistence — SQL + KV. See docs/connectors-spec.md §6.
//
// SQL handle: `${APP_ID}/connectors` — the FULL app-id path, verbatim.
// The SQL service authorizes against the resource string as-is; a bare
// db("connectors") 401s (see the DB HANDLE CONVENTION note in
// threadStore.ts:16-22). KV IS app-prefixed automatically — do not
// double-prefix.
//
// TinyCloud SQLite authorizer restrictions (from listen): no CREATE INDEX,
// no UNIQUE constraints, no REFERENCES. Dedup is app-level (SELECT before
// INSERT). CREATE TABLE IF NOT EXISTS can return "not authorized" when the
// table already exists — on that error, probe SELECT 1 FROM <table> LIMIT 1
// and treat success as schema-ready.
//
// Sequential writes only — TinyCloud drops concurrent responses.
//
// All exported functions return Result-style objects (spec §4). Callers
// branch on `.ok`; nothing throws across the module boundary.

import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { APP_ID } from "../threadStore";
import type {
  FirefliesSentence,
  FirefliesTranscript,
} from "./firefliesClient";
import type { ConnectorConnection, ConnectorId } from "./types";

/** Full resolved SQL db path — must match the granted resource string. */
export const CONNECTORS_SQL_DB_NAME = `${APP_ID}/connectors`;

/** KV key prefix for a source's transcript bodies. KV is app-prefixed by the SDK. */
export function transcriptKvKey(source: string, sourceId: string): string {
  return `connectors/${source}/transcript/${sourceId}`;
}

export interface StoreError {
  code: string;
  message: string;
}

export type StoreResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: StoreError };

type UnderlyingError = { code?: string; message?: string };

function fail(err: UnderlyingError, context: string): { ok: false; error: StoreError } {
  const code = typeof err.code === "string" && err.code.length > 0 ? err.code : "STORE_ERROR";
  const msg = typeof err.message === "string" && err.message.length > 0 ? err.message : "unknown";
  return { ok: false, error: { code, message: `${context}: [${code}] ${msg}` } };
}

/** Schema statements, executed one at a time so the "not authorized" fallback
 *  can probe per-table. Kept intentionally minimal — no CREATE INDEX / UNIQUE /
 *  REFERENCES (authorizer forbids them); dedup is app-level. */
const SCHEMA: { sql: string; table: string }[] = [
  {
    table: "connector_state",
    sql: `CREATE TABLE IF NOT EXISTS connector_state (
      connector_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      last_synced_at TEXT,
      last_sync_status TEXT,
      last_sync_error TEXT,
      item_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    )`,
  },
  {
    table: "connector_meeting",
    sql: `CREATE TABLE IF NOT EXISTS connector_meeting (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      source_id TEXT NOT NULL,
      title TEXT,
      started_at TEXT,
      duration_secs REAL,
      organizer_email TEXT,
      participants TEXT,
      summary_overview TEXT,
      summary_action_items TEXT,
      keywords TEXT,
      meeting_type TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
  },
];

function store(tcw: TinyCloudWeb) {
  return tcw.sql.db(CONNECTORS_SQL_DB_NAME);
}

function cellStr(row: unknown[], idx: number, fallback: string | null): string | null {
  const v = row[idx];
  if (typeof v === "string") return v;
  return fallback;
}

function cellNum(row: unknown[], idx: number, fallback: number | null): number | null {
  const v = row[idx];
  if (typeof v === "number") return v;
  return fallback;
}

// ── Schema bootstrap (memoized per space, keyed by tcw.did) ─────────────

const schemaReadySpaces = new Set<string>();
const schemaInFlight = new Map<string, Promise<StoreResult<void>>>();

/** For tests only — clear the per-process memo between cases. */
export function _resetConnectorSchemaMemoForTests(): void {
  schemaReadySpaces.clear();
  schemaInFlight.clear();
}

export async function ensureSchema(tcw: TinyCloudWeb): Promise<StoreResult<void>> {
  const did = typeof tcw.did === "string" && tcw.did.length > 0 ? tcw.did : null;
  const space =
    typeof tcw.spaceId === "string" && tcw.spaceId.length > 0 ? tcw.spaceId : null;
  const memoKey = did ?? space ?? "";
  if (memoKey && schemaReadySpaces.has(memoKey)) return { ok: true, data: undefined };

  const inFlight = memoKey ? schemaInFlight.get(memoKey) : undefined;
  if (inFlight) return inFlight;

  const run = (async (): Promise<StoreResult<void>> => {
    const db = store(tcw);
    for (const { sql, table } of SCHEMA) {
      const res = await db.execute(sql);
      if (res.ok) continue;
      // "not authorized" on CREATE TABLE IF NOT EXISTS most likely means the
      // table already exists and the authorizer blocks redundant DDL. Probe
      // with a SELECT — success means schema is ready for this table.
      const msg = (res.error.message ?? "").toLowerCase();
      if (msg.includes("not authorized")) {
        const probe = await db.query(`SELECT 1 FROM ${table} LIMIT 1`);
        if (probe.ok) continue;
      }
      return fail(res.error, `ensureSchema(${table})`);
    }
    if (memoKey) schemaReadySpaces.add(memoKey);
    return { ok: true, data: undefined };
  })();

  if (memoKey) {
    schemaInFlight.set(memoKey, run);
    void run.catch(() => {}).finally(() => schemaInFlight.delete(memoKey));
  }
  return run;
}

// ── Connector state ─────────────────────────────────────────────────────

export async function getConnection(
  tcw: TinyCloudWeb,
  connectorId: ConnectorId,
): Promise<StoreResult<ConnectorConnection | null>> {
  const schema = await ensureSchema(tcw);
  if (!schema.ok) return schema;
  const res = await store(tcw).query(
    `SELECT connector_id, status, last_synced_at, last_sync_status, last_sync_error, item_count
     FROM connector_state WHERE connector_id = ?`,
    [connectorId],
  );
  if (!res.ok) return fail(res.error, "getConnection");
  if (res.data.rows.length === 0) return { ok: true, data: null };
  const row = res.data.rows[0];
  return {
    ok: true,
    data: {
      connectorId: (cellStr(row, 0, connectorId) as ConnectorId) ?? connectorId,
      status: (cellStr(row, 1, "disconnected") ?? "disconnected") as "connected" | "disconnected",
      lastSyncedAt: cellStr(row, 2, null),
      lastSyncStatus: cellStr(row, 3, null) as "ok" | "error" | null,
      lastSyncError: cellStr(row, 4, null),
      itemCount: cellNum(row, 5, 0) ?? 0,
    },
  };
}

export interface UpdateSyncStateInput {
  connectorId: ConnectorId;
  status: "connected" | "disconnected";
  lastSyncedAt: string | null;
  lastSyncStatus: "ok" | "error" | null;
  lastSyncError: string | null;
  itemCount: number;
}

export async function updateSyncState(
  tcw: TinyCloudWeb,
  input: UpdateSyncStateInput,
): Promise<StoreResult<void>> {
  const schema = await ensureSchema(tcw);
  if (!schema.ok) return schema;
  const now = new Date().toISOString();
  const res = await store(tcw).execute(
    `INSERT INTO connector_state
      (connector_id, status, last_synced_at, last_sync_status, last_sync_error, item_count, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(connector_id) DO UPDATE SET
       status = excluded.status,
       last_synced_at = excluded.last_synced_at,
       last_sync_status = excluded.last_sync_status,
       last_sync_error = excluded.last_sync_error,
       item_count = excluded.item_count,
       updated_at = excluded.updated_at`,
    [
      input.connectorId,
      input.status,
      input.lastSyncedAt,
      input.lastSyncStatus,
      input.lastSyncError,
      input.itemCount,
      now,
    ],
  );
  if (!res.ok) return fail(res.error, "updateSyncState");
  return { ok: true, data: undefined };
}

// ── Meeting rows ────────────────────────────────────────────────────────

export interface NormalizedMeeting {
  /** crypto.randomUUID() — assigned by normalize, kept stable across retries. */
  id: string;
  source: string;
  sourceId: string;
  title: string | null;
  startedAt: string | null;
  durationSecs: number | null;
  organizerEmail: string | null;
  participants: { name: string; email: string | null }[];
  summaryOverview: string | null;
  summaryActionItems: string | null;
  keywords: string[] | null;
  meetingType: string | null;
  metadata: Record<string, unknown>;
}

export async function listKnownSourceIds(
  tcw: TinyCloudWeb,
  source: string,
): Promise<StoreResult<string[]>> {
  const schema = await ensureSchema(tcw);
  if (!schema.ok) return schema;
  const res = await store(tcw).query(
    "SELECT source_id FROM connector_meeting WHERE source = ?",
    [source],
  );
  if (!res.ok) return fail(res.error, "listKnownSourceIds");
  const ids: string[] = [];
  for (const row of res.data.rows) {
    const v = row[0];
    if (typeof v === "string") ids.push(v);
  }
  return { ok: true, data: ids };
}

export async function countMeetings(
  tcw: TinyCloudWeb,
  source: string,
): Promise<StoreResult<number>> {
  const schema = await ensureSchema(tcw);
  if (!schema.ok) return schema;
  const res = await store(tcw).query(
    "SELECT COUNT(*) FROM connector_meeting WHERE source = ?",
    [source],
  );
  if (!res.ok) return fail(res.error, "countMeetings");
  const row = res.data.rows[0];
  if (!row) return { ok: true, data: 0 };
  const n = row[0];
  const parsed = typeof n === "number" ? n : Number.parseInt(String(n ?? "0"), 10) || 0;
  return { ok: true, data: parsed };
}

/**
 * Insert a normalized meeting row, dedup'd on (source, source_id).
 * Returns true if inserted, false if a row for this (source, source_id) already
 * existed and the insert was skipped. Writes are sequential — SELECT-before-INSERT
 * is race-safe under the single-writer model.
 */
export async function insertMeeting(
  tcw: TinyCloudWeb,
  meeting: NormalizedMeeting,
): Promise<StoreResult<boolean>> {
  const schema = await ensureSchema(tcw);
  if (!schema.ok) return schema;
  const existing = await store(tcw).query(
    "SELECT id FROM connector_meeting WHERE source = ? AND source_id = ? LIMIT 1",
    [meeting.source, meeting.sourceId],
  );
  if (!existing.ok) return fail(existing.error, "insertMeeting(dedupSelect)");
  if (existing.data.rows.length > 0) return { ok: true, data: false };

  const now = new Date().toISOString();
  const res = await store(tcw).execute(
    `INSERT INTO connector_meeting
      (id, source, source_id, title, started_at, duration_secs, organizer_email,
       participants, summary_overview, summary_action_items, keywords, meeting_type,
       metadata, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      meeting.id,
      meeting.source,
      meeting.sourceId,
      meeting.title,
      meeting.startedAt,
      meeting.durationSecs,
      meeting.organizerEmail,
      JSON.stringify(meeting.participants),
      meeting.summaryOverview,
      meeting.summaryActionItems,
      meeting.keywords === null ? null : JSON.stringify(meeting.keywords),
      meeting.meetingType,
      JSON.stringify(meeting.metadata),
      now,
      now,
    ],
  );
  if (!res.ok) return fail(res.error, "insertMeeting(insert)");
  return { ok: true, data: true };
}

// ── Transcript bodies (KV) ──────────────────────────────────────────────

export async function putTranscriptBody(
  tcw: TinyCloudWeb,
  source: string,
  sourceId: string,
  sentences: FirefliesSentence[],
): Promise<StoreResult<void>> {
  const key = transcriptKvKey(source, sourceId);
  const res = await tcw.kv.put(key, JSON.stringify(sentences));
  if (!res.ok) return fail(res.error, "putTranscriptBody");
  return { ok: true, data: undefined };
}

// ── Purge ───────────────────────────────────────────────────────────────

/**
 * Delete every meeting row for `source`, the corresponding KV transcript
 * bodies, and the state row. Writes are sequential (SQL rows in a single
 * batch, KV deletes one-at-a-time — TinyCloud drops concurrent responses).
 */
export async function purgeConnector(
  tcw: TinyCloudWeb,
  source: string,
): Promise<StoreResult<void>> {
  const schema = await ensureSchema(tcw);
  if (!schema.ok) return schema;
  const sourceIdsRes = await listKnownSourceIds(tcw, source);
  if (!sourceIdsRes.ok) return sourceIdsRes;
  for (const sid of sourceIdsRes.data) {
    const del = await tcw.kv.delete(transcriptKvKey(source, sid));
    if (!del.ok) {
      // KV_NOT_FOUND is fine — nothing to remove. Anything else is a real
      // failure and must surface.
      const code = del.error?.code ?? "";
      if (code !== "KV_NOT_FOUND") {
        return fail(del.error, `purgeConnector(kv:${sid})`);
      }
    }
  }
  const res = await store(tcw).batch([
    { sql: "DELETE FROM connector_meeting WHERE source = ?", params: [source] },
    { sql: "DELETE FROM connector_state WHERE connector_id = ?", params: [source] },
  ]);
  if (!res.ok) return fail(res.error, "purgeConnector(sql)");
  return { ok: true, data: undefined };
}

// ── Normalization (Fireflies raw → NormalizedMeeting) ──────────────────

/** True when |a - b| exceeds max(120, 0.5 * b). Guards against unit drift. */
function durationMismatch(computed: number, sentenceEnd: number): boolean {
  if (!(sentenceEnd > 0)) return false;
  const tolerance = Math.max(120, 0.5 * sentenceEnd);
  return Math.abs(computed - sentenceEnd) > tolerance;
}

/** Coerce `date` (number epoch ms, or ISO string) to an ISO timestamp. */
function coerceStartedAt(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return null;
    return new Date(raw).toISOString();
  }
  if (typeof raw === "string") {
    const t = Date.parse(raw);
    if (!Number.isFinite(t)) return null;
    return new Date(t).toISOString();
  }
  return null;
}

/**
 * Turn a raw Fireflies `GetTranscript` payload into a NormalizedMeeting and
 * the sentences body (stored separately in KV).
 *
 * Key decisions (spec §6):
 *  - `duration` is empirically MINUTES; we `*60` then cross-check against the
 *    last sentence's `end_time`. If off by more than max(120, 0.5*end) and the
 *    end is positive, we prefer the sentence end and record
 *    `metadata.duration_source = "sentences"`.
 *  - Participants merge attendees + speaker names; dedupe by name, first
 *    occurrence wins; email is best-effort — no fuzzy matching.
 *  - Summary fields are all nullable (Fireflies summaries can lag transcripts).
 */
export function normalizeFirefliesTranscript(
  raw: FirefliesTranscript,
): { meeting: NormalizedMeeting; sentences: FirefliesSentence[] } {
  const sentences = Array.isArray(raw.sentences) ? raw.sentences : [];
  const lastEnd =
    sentences.length > 0
      ? Number(sentences[sentences.length - 1]?.end_time ?? 0) || 0
      : 0;

  const metadata: Record<string, unknown> = {};
  let durationSecs: number | null = null;
  if (typeof raw.duration === "number" && Number.isFinite(raw.duration)) {
    const computed = Math.round(raw.duration * 60);
    if (durationMismatch(computed, lastEnd)) {
      durationSecs = Math.round(lastEnd);
      metadata.duration_source = "sentences";
    } else {
      durationSecs = computed;
    }
  } else if (lastEnd > 0) {
    durationSecs = Math.round(lastEnd);
    metadata.duration_source = "sentences";
  }

  // Participants: attendees (with email) first, then speaker names. Dedup by
  // name — first occurrence wins; email is `null` when not present on the
  // attendee entry. Deliberately no fuzzy match — listen's exact-match
  // silently loses emails, and guessing would be worse than honesty.
  const participants: { name: string; email: string | null }[] = [];
  const seenNames = new Set<string>();
  const pushParticipant = (name: string | null | undefined, email: string | null | undefined) => {
    if (typeof name !== "string") return;
    const trimmed = name.trim();
    if (trimmed.length === 0) return;
    if (seenNames.has(trimmed)) return;
    seenNames.add(trimmed);
    participants.push({
      name: trimmed,
      email: typeof email === "string" && email.length > 0 ? email : null,
    });
  };
  for (const att of raw.meeting_attendees ?? []) {
    pushParticipant(att?.displayName, att?.email);
  }
  for (const sp of raw.speakers ?? []) {
    pushParticipant(sp?.name, null);
  }

  const summary = raw.summary ?? null;
  const summaryOverview = summary && typeof summary.overview === "string" ? summary.overview : null;
  const summaryActionItems =
    summary && typeof summary.action_items === "string" ? summary.action_items : null;
  const keywords = summary && Array.isArray(summary.keywords) ? summary.keywords : null;
  const meetingType =
    summary && typeof summary.meeting_type === "string" ? summary.meeting_type : null;

  const meeting: NormalizedMeeting = {
    id: crypto.randomUUID(),
    source: "fireflies",
    sourceId: raw.id,
    title: typeof raw.title === "string" ? raw.title : null,
    startedAt: coerceStartedAt(raw.date),
    durationSecs,
    organizerEmail:
      typeof raw.organizer_email === "string" && raw.organizer_email.length > 0
        ? raw.organizer_email
        : null,
    participants,
    summaryOverview,
    summaryActionItems,
    keywords,
    meetingType,
    metadata,
  };

  return { meeting, sentences };
}
