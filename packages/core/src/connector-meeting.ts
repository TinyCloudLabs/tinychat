import type { NonEmptyServerInfoPermissions } from "./index.js";

/** The manifest app prefix is part of both the SQL handle and every connector KV key. */
export const APP_ID = "xyz.tinycloud.tinychat";
export const CONNECTORS_SQL_DB_NAME = `${APP_ID}/connectors`;
export const CONNECTORS_KV_PREFIX = `${APP_ID}/connectors`;
export const TRANSCRIBER_MEETING_SOURCE = "tinycloud-transcriber";

export function transcriptKvKey(source: string, sourceId: string): string {
  return `${CONNECTORS_KV_PREFIX}/${source}/transcript/${sourceId}`;
}

/** Immutable snapshot of a previously saved transcriber publication. */
export function archiveKvKey(sourceId: string, version: number): string {
  return `${CONNECTORS_KV_PREFIX}/${TRANSCRIBER_MEETING_SOURCE}/archive/${sourceId}/v${version}`;
}

/** These are manifest-relative paths; the session already grants both resources. */
export const TRANSCRIPT_WRITER_POLICY: NonEmptyServerInfoPermissions = [
  { service: "tinycloud.sql", path: "connectors", actions: ["read", "write"] },
  { service: "tinycloud.kv", path: "connectors/tinycloud-transcriber/", actions: ["get", "put"] },
];

/** Fully resolved paths for the session-key delegateTo call. */
export const TRANSCRIPT_WRITER_PERMISSIONS: NonEmptyServerInfoPermissions = [
  { service: "tinycloud.sql", space: "applications", path: CONNECTORS_SQL_DB_NAME, actions: ["read", "write"], skipPrefix: true },
  { service: "tinycloud.kv", space: "applications", path: `${CONNECTORS_KV_PREFIX}/${TRANSCRIBER_MEETING_SOURCE}/`, actions: ["get", "put"], skipPrefix: true },
];

/** The two existing connector tables, with the statements preserved byte-for-byte. */
export const CONNECTOR_SCHEMA: { sql: string; table: string }[] = [
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

export interface NormalizedMeeting {
  /** Candidate ID for transcriber writes; browser connector writes derive new IDs from source/sourceId. */
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

export interface TranscriptGap {
  start: number;
  end: number;
  speaker_name: string | null;
}

export interface TranscriptSentence {
  source?: "recording" | "fallback";
  attribution?: "identified" | "unknown" | "overlap";
  index: number;
  speaker_name: string | null;
  text: string;
  start_time: number;
  end_time: number;
}

export interface TranscriberMeetingJson {
  id: string;
  meeting_url: string;
  platform: string;
  created_at: string;
  started_at?: string | null;
  completed_at?: string | null;
  capture?: unknown;
  transcript_provider?: string | null;
  fallback_from?: string | null;
  fallback_reason?: string | null;
  metadata?: Record<string, unknown>;
}

export interface TranscriberTranscriptJson {
  version?: number;
  language?: string;
  duration_seconds?: number;
  capture?: unknown;
  provider?: string | null;
  fallback_from?: string | null;
  fallback_reason?: string | null;
  speakers?: { id: string; name: string | null }[];
  partial?: boolean;
  gaps?: TranscriptGap[];
  segments?: { speaker_name: string | null; text: string; start: number; end: number; source?: TranscriptSentence["source"]; attribution?: TranscriptSentence["attribution"] }[];
  text?: string;
}

/** SHA-256 namespaced to this data model, truncated to 128 bits with UUIDv8/variant bits. */
export async function connectorMeetingId(source: string, sourceId: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`tinychat.connector_meeting.v1\0${source}\0${sourceId}`),
  ));
  digest[6] = (digest[6]! & 0x0f) | 0x80;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = Array.from(digest.subarray(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function transcriberMeetingTitle(meeting: Pick<TranscriberMeetingJson, "meeting_url" | "metadata">): string {
  const calendarTitle = meeting.metadata?.calendar_title;
  if (meeting.metadata?.source === "google-calendar-autojoin" && typeof calendarTitle === "string" && calendarTitle.trim()) {
    return calendarTitle.trim();
  }
  try {
    const u = new URL(meeting.meeting_url);
    const room = u.pathname.split("/").filter(Boolean).pop();
    return room ? `${room} (${u.host})` : u.host;
  } catch {
    return meeting.meeting_url;
  }
}

/** PTX's legacy placeholder and nullable speaker names both mean unattributed speech. */
function transcriberSpeakerName(name: string | null): string | null {
  const trimmed = name?.trim();
  return trimmed && trimmed !== "Unknown" ? trimmed : null;
}

export async function normalizeTranscriberTranscript(
  meeting: TranscriberMeetingJson,
  transcript: TranscriberTranscriptJson,
): Promise<{ meeting: NormalizedMeeting; sentences: TranscriptSentence[]; body: string }> {
  const segments = Array.isArray(transcript.segments) ? transcript.segments : [];
  const sentences: TranscriptSentence[] = segments.map((s, index) => ({
    index,
    ...(s.source !== undefined ? { source: s.source } : {}),
    ...(s.attribution !== undefined ? { attribution: s.attribution } : {}),
    speaker_name: transcriberSpeakerName(s.speaker_name),
    text: s.text,
    start_time: Number.isFinite(s.start) ? s.start : 0,
    end_time: Number.isFinite(s.end) ? s.end : 0,
  }));

  const seen = new Set<string>();
  const participants: { name: string; email: string | null }[] = [];
  for (const sp of transcript.speakers ?? []) {
    const name = transcriberSpeakerName(sp.name);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    participants.push({ name, email: null });
  }

  const lastEnd = sentences.length > 0 ? sentences[sentences.length - 1]!.end_time : 0;
  const durationSecs =
    typeof transcript.duration_seconds === "number" && Number.isFinite(transcript.duration_seconds)
      ? Math.round(transcript.duration_seconds)
      : lastEnd > 0
        ? Math.round(lastEnd)
        : null;

  return {
    meeting: {
      id: await connectorMeetingId(TRANSCRIBER_MEETING_SOURCE, meeting.id),
      source: TRANSCRIBER_MEETING_SOURCE,
      sourceId: meeting.id,
      title: transcriberMeetingTitle(meeting),
      startedAt: (meeting.metadata?.source === "google-calendar-autojoin" ? meeting.metadata.scheduled_start as string | null | undefined : null)
        ?? meeting.started_at ?? meeting.created_at ?? null,
      durationSecs,
      organizerEmail: null,
      participants,
      summaryOverview: null,
      summaryActionItems: null,
      keywords: null,
      meetingType: null,
      metadata: {
        ...meeting.metadata,
        ...(transcript.partial !== undefined ? { partial: transcript.partial } : {}),
        ...(transcript.gaps !== undefined ? { gaps: transcript.gaps } : {}),
        meeting_url: meeting.meeting_url,
        platform: meeting.platform,
        language: transcript.language ?? null,
        ptx_transcript_version: Number.isInteger(transcript.version) ? transcript.version : 1,
        transcript_text: transcript.text ?? null,
        capture: transcript.capture ?? meeting.capture ?? null,
        transcript_provider: transcript.provider ?? meeting.transcript_provider ?? null,
        fallback_from: transcript.fallback_from ?? meeting.fallback_from ?? null,
        fallback_reason: transcript.fallback_reason ?? meeting.fallback_reason ?? null,
      },
    },
    sentences,
    body: JSON.stringify(sentences),
  };
}

/** `status` is the storage HTTP status, when the adapter saw one (it may differ from `code`). */
export type PortResult<T> = { ok: true; data: T } | { ok: false; code: string; message: string; status?: number };

export interface ConnectorStorePort {
  query(sql: string, params: unknown[]): Promise<PortResult<{ rows: unknown[][] }>>;
  execute(sql: string, params?: unknown[]): Promise<PortResult<{ changes: number }>>;
  kvGet(key: string): Promise<PortResult<"present" | "missing">>;
  kvPutIfAbsent(key: string, body: string): Promise<PortResult<"written" | "exists">>;
}

/** Check tables by read-only probe; only create the tables that do not exist. */
export async function ensureConnectorSchema(port: ConnectorStorePort): Promise<PortResult<void>> {
  const tables = CONNECTOR_SCHEMA.map(({ table }) => table);
  const result = await port.query(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${tables.map(() => "?").join(", ")})`,
    tables,
  );
  if (!result.ok) return result;
  const existing = new Set(result.data.rows.map((row) => row[0]).filter((name): name is string => typeof name === "string"));
  for (const { sql, table } of CONNECTOR_SCHEMA) {
    if (existing.has(table)) continue;
    const created = await port.execute(sql);
    if (!created.ok) return created;
  }
  return { ok: true, data: undefined };
}

export interface NormalizedTranscriberMeeting {
  meeting: NormalizedMeeting;
  body: string;
}

export interface WrittenTranscriberMeeting {
  id: string;
  row: "inserted" | "existing";
  body: "written" | "exists";
}

/** Preserve any legacy row and body; repair a missing body without overwriting existing bytes. */
export async function writeTranscriberMeeting(
  port: ConnectorStorePort,
  normalized: NormalizedTranscriberMeeting,
  options: { ensureSchema: boolean },
): Promise<PortResult<WrittenTranscriberMeeting>> {
  if (options.ensureSchema) {
    const schema = await ensureConnectorSchema(port);
    if (!schema.ok) return schema;
  }
  const meeting = normalized.meeting;
  const existing = await port.query(
    "SELECT id FROM connector_meeting WHERE source = ? AND source_id = ? LIMIT 1",
    [meeting.source, meeting.sourceId],
  );
  if (!existing.ok) return existing;
  const oldId = existing.data.rows[0]?.[0];
  const row = typeof oldId === "string" ? "existing" : "inserted";
  const id = typeof oldId === "string" ? oldId : meeting.id;
  if (row === "inserted") {
    const now = new Date().toISOString();
    const inserted = await port.execute(
      `INSERT INTO connector_meeting
      (id, source, source_id, title, started_at, duration_secs, organizer_email,
       participants, summary_overview, summary_action_items, keywords, meeting_type,
       metadata, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
      [meeting.id, meeting.source, meeting.sourceId, meeting.title, meeting.startedAt,
        meeting.durationSecs, meeting.organizerEmail, JSON.stringify(meeting.participants),
        meeting.summaryOverview, meeting.summaryActionItems,
        meeting.keywords === null ? null : JSON.stringify(meeting.keywords),
        meeting.meetingType, JSON.stringify(meeting.metadata), now, now],
    );
    if (!inserted.ok) return inserted;
  }
  const body = await port.kvPutIfAbsent(transcriptKvKey(meeting.source, meeting.sourceId), normalized.body);
  if (!body.ok) return body;
  return { ok: true, data: { id, row, body: body.data } };
}

/** One meeting identity in the user's applications space, independent of the caller's SDK. */
export async function writeConnectorMeeting(
  port: ConnectorStorePort,
  meeting: NormalizedMeeting,
  body: string,
  options: { preserveExistingTitle?: boolean; preserveTranscriptBody?: boolean } = {},
): Promise<PortResult<{ id: string; inserted: boolean; createdAt: string }>> {
  const columns = "id, created_at, title, started_at, duration_secs, organizer_email, participants, "
    + "summary_overview, summary_action_items, keywords, meeting_type, metadata";
  const lookup = () => port.query(
    `SELECT ${columns} FROM connector_meeting WHERE source = ? AND source_id = ? LIMIT 1`,
    [meeting.source, meeting.sourceId],
  );
  const first = await lookup();
  if (!first.ok) return first;
  let row = first.data.rows[0];
  let inserted = false;
  const bodyFirst = meeting.source === "google-meet";
  const needsBody = body !== "[]" || !row || options.preserveTranscriptBody;
  if (bodyFirst && needsBody) {
    const saved = await writeMissingConnectorBody(port, meeting, body);
    if (!saved.ok) return saved;
  }
  if (!row) {
    // The pre-INSERT lookup protects legacy random UUIDs; the primary key makes
    // simultaneous upgraded writers for the same identity converge.
    const id = await connectorMeetingId(meeting.source, meeting.sourceId);
    const now = new Date().toISOString();
    const write = await port.execute(
      `INSERT INTO connector_meeting
        (id, source, source_id, title, started_at, duration_secs, organizer_email,
         participants, summary_overview, summary_action_items, keywords, meeting_type,
         metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
      [id, meeting.source, meeting.sourceId, meeting.title, meeting.startedAt,
        meeting.durationSecs, meeting.organizerEmail, JSON.stringify(meeting.participants),
        meeting.summaryOverview, meeting.summaryActionItems,
        meeting.keywords === null ? null : JSON.stringify(meeting.keywords),
        meeting.meetingType, JSON.stringify(meeting.metadata), now, now],
    );
    if (!write.ok) return write;
    inserted = write.data.changes > 0;
    const winner = await lookup();
    if (!winner.ok) return winner;
    row = winner.data.rows[0];
  }
  const id = row?.[0];
  const createdAt = row?.[1];
  if (typeof id !== "string" || typeof createdAt !== "string") {
    return { ok: false, code: "STORE_CORRUPT_ROW", message: "meeting row missing id or created_at" };
  }
  // Reconcile the winner even after our INSERT attempt: another writer may
  // have won the primary-key race with an earlier/partial source response.
  {
    const text = (index: number) => typeof row![index] === "string" ? row![index] as string : null;
    const number = (index: number) => typeof row![index] === "number" ? row![index] as number : null;
    const existingMetadata = parseMeetingMetadata(row[11]);
    const acceptsDatetime = meeting.startedAt !== null && (text(3) === null
      || meetingDatetimeConfidence(meeting.metadata, true) >= meetingDatetimeConfidence(existingMetadata, true));
    const metadata = { ...existingMetadata, ...meeting.metadata };
    if (!acceptsDatetime) {
      for (const key of ["datetime_source", "datetime_exact", "datetime_resolution_version"] as const) {
        if (key in existingMetadata) metadata[key] = existingMetadata[key];
        else delete metadata[key];
      }
    }
    const notesOwnedFields = meeting.metadata.notes_owned_fields;
    const ownsNotes = (field: "summary_overview" | "summary_action_items") =>
      meeting.source === "google-meet"
      && meeting.metadata.notes_association === "standalone"
      && meeting.metadata.notes_kind === "gemini"
      && Array.isArray(notesOwnedFields) && notesOwnedFields.includes(field);
    const keep = (next: string | null, index: number) => next ?? text(index);
    const next = [
      options.preserveExistingTitle ? text(2) ?? meeting.title : keep(meeting.title, 2),
      acceptsDatetime ? meeting.startedAt : text(3),
      meeting.durationSecs ?? number(4),
      keep(meeting.organizerEmail, 5),
      meeting.participants.length ? JSON.stringify(meeting.participants) : text(6) ?? "[]",
      ownsNotes("summary_overview") ? meeting.summaryOverview : keep(meeting.summaryOverview, 7),
      ownsNotes("summary_action_items") ? meeting.summaryActionItems : keep(meeting.summaryActionItems, 8),
      meeting.keywords === null ? text(9) : JSON.stringify(meeting.keywords),
      keep(meeting.meetingType, 10),
      JSON.stringify(metadata),
    ];
    const current = [text(2), text(3), number(4), text(5), text(6) ?? "[]",
      text(7), text(8), text(9), text(10), JSON.stringify(existingMetadata)];
    if (next.some((value, index) => value !== current[index])) {
      const updated = await port.execute(
        `UPDATE connector_meeting SET
           title = ?, started_at = ?, duration_secs = ?, organizer_email = ?,
           participants = ?, summary_overview = ?, summary_action_items = ?,
           keywords = ?, meeting_type = ?, metadata = ?, updated_at = ?
         WHERE id = ?`,
        [...next, new Date().toISOString(), id],
      );
      if (!updated.ok) return updated;
    }
  }
  if (!bodyFirst && needsBody) {
    const saved = await writeMissingConnectorBody(port, meeting, body);
    if (!saved.ok) return saved;
  }
  return { ok: true, data: { id, inserted, createdAt } };
}

async function writeMissingConnectorBody(
  port: ConnectorStorePort, meeting: NormalizedMeeting, body: string,
): Promise<PortResult<void>> {
  const key = transcriptKvKey(meeting.source, meeting.sourceId);
  const existing = await port.kvGet(key);
  if (!existing.ok) return existing;
  if (existing.data === "present") return { ok: true, data: undefined };
  const written = await port.kvPutIfAbsent(key, body);
  return written.ok ? { ok: true, data: undefined } : written;
}

function parseMeetingMetadata(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== "string") return {};
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function meetingDatetimeConfidence(metadata: Record<string, unknown>, hasStartedAt: boolean): number {
  switch (metadata.datetime_source) {
    case "meet_conference_start": return 3;
    case "docs_content": return 2;
    case "drive_created_time": return 1;
    case "unavailable": return 0;
    default: return hasStartedAt ? 3 : 0;
  }
}

/** Both parts must exist; never create schema while merely checking delivery status. */
export async function transcriberMeetingInSpace(
  port: ConnectorStorePort,
  sourceId: string,
): Promise<PortResult<boolean>> {
  const tables = await port.query(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    ["connector_meeting"],
  );
  if (!tables.ok) return tables;
  if (tables.data.rows.length === 0) return { ok: true, data: false };
  const rows = await port.query(
    "SELECT id FROM connector_meeting WHERE source = ? AND source_id = ? LIMIT 1",
    [TRANSCRIBER_MEETING_SOURCE, sourceId],
  );
  if (!rows.ok) return rows;
  if (rows.data.rows.length === 0) return { ok: true, data: false };
  const body = await port.kvGet(transcriptKvKey(TRANSCRIBER_MEETING_SOURCE, sourceId));
  if (!body.ok) return body;
  return { ok: true, data: body.data === "present" };
}
