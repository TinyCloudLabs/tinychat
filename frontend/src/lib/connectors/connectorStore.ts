// Connectors persistence — SQL + KV. See docs/connectors-spec.md §6.
//
// RESOURCE PATH CONVENTION (critical — applies to BOTH backends). Neither
// service app-prefixes for you: the SQL db name and the KV key are each sent
// VERBATIM as the invoke path, and the node authorizes against that string.
// The manifest resolves every permission path with the app id (its `prefix`
// defaults to `app_id`), so the session's granted resources are
// `${APP_ID}/connectors` for SQL and `${APP_ID}/connectors/` for KV. Both
// handles must therefore carry the full `${APP_ID}/connectors` path; a bare
// `connectors/...` key fails AUTH_UNAUTHORIZED, exactly like db("connectors")
// does (see the DB HANDLE CONVENTION note in threadStore.ts:16-22).
//
// The native publication command owns uniqueness, immutable snapshots and
// conditional head updates. Old nodes are unsupported for canonical writes.
// Legacy schema creation remains for connector state and pre-cutover discovery.
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

/**
 * Full resolved KV key prefix — must match the granted resource string.
 * The manifest grants `tinycloud.kv` on `connectors/`, which resolves to
 * `${APP_ID}/connectors/` (trailing slash = prefix match), so every key the
 * store writes has to start here. Single source of the prefix — callers build
 * keys through {@link transcriptKvKey}, never by hand.
 */
export const CONNECTORS_KV_PREFIX = `${APP_ID}/connectors`;

/** Full KV key for a source's transcript body. */
export function transcriptKvKey(source: string, sourceId: string): string {
  return `${CONNECTORS_KV_PREFIX}/${source}/transcript/${sourceId}`;
}

/** Connector-scoped Drive Changes cursor; it is not the UI sync timestamp. */
export function driveCursorKvKey(source: string): string {
  return `${CONNECTORS_KV_PREFIX}/${source}/drive-page-token`;
}

/**
 * Full KV key for one meeting's record in the user's own space.
 *
 * Written ONLY by the backend-ingest reconcile (`backendReconcile.ts`, plan §8.1 W6), which is
 * KV-only by rule — it holds no SQL handle, so a reconciled meeting needs a key of its own to
 * live at rather than a `connector_meeting` row. Built here for the same reason
 * {@link transcriptKvKey} is: the granted resource is the `${APP_ID}/connectors/` prefix, and a
 * key assembled by hand somewhere else is the one that 401s.
 */
export function meetingKvKey(source: string, sourceId: string): string {
  return `${CONNECTORS_KV_PREFIX}/${source}/meeting/${sourceId}`;
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

/** Legacy bootstrap; the native publication command upgrades and fences the catalog. */
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

// The node owns the conditional boundary. Generic SQL/KV writes cannot enforce
// old-client fencing, so callers must never fall back when this command is absent.
export const PUBLICATION_STATEMENT = "tinycloud.meetingPublication.v3";

export interface PublicationInput {
  meeting: NormalizedMeeting;
  sentences: FirefliesSentence[];
  aliases?: string[];
  body?: {
    basis: "transcript" | "notes";
    schema: "text" | "json-records" | "google-docs";
    raw: string;
    originalExtent: "known" | "unknown";
    captureComplete?: boolean | null;
    omissions?: { code: string; detail?: string }[];
  };
}

type PublicationReceipt = {
  contractVersion: 3;
  status?: string;
  writerFencing?: boolean;
  snapshotImmutability?: boolean;
  digestVerification?: boolean;
  operationId?: string;
  generation?: number;
  expectedHead?: string | null;
  meetingRef?: string;
  revision?: string;
  snapshotKey?: string;
  inserted?: boolean;
  createdAt?: string;
  previousMeeting?: NormalizedMeeting;
  deletedCount?: number;
};

async function publicationCommand(
  tcw: TinyCloudWeb,
  command: Record<string, unknown>,
): Promise<StoreResult<PublicationReceipt>> {
  try {
    const result = await store(tcw).execute(PUBLICATION_STATEMENT,
      [JSON.stringify({ contractVersion: 3, ...command })]);
    if (!result.ok) return fail(result.error, `publication(${command.operation})`);
    const data = result.data as { columns?: unknown; rows?: unknown };
    if (!Array.isArray(data.columns) || data.columns[0] !== "receipt" || !Array.isArray(data.rows)
      || data.rows.length !== 1 || !Array.isArray(data.rows[0]) || typeof data.rows[0][0] !== "string") {
      return fail({ code: "PUBLICATION_INVALID_RECEIPT", message: "Complete native publication receipt required" }, "publication");
    }
    const receipt = JSON.parse(data.rows[0][0]) as PublicationReceipt;
    if (receipt?.contractVersion !== 3) return fail({ code: "PUBLICATION_INVALID_RECEIPT", message: "Unsupported contract" }, "publication");
    return { ok: true, data: receipt };
  } catch (error) {
    return fail({ code: "PUBLICATION_TRANSPORT", message: error instanceof Error ? error.message : String(error) }, "publication");
  }
}

export async function publicationSha256(raw: string): Promise<string> {
  const bytes = new TextEncoder().encode(raw);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function snapshotKvKey(source: string, sourceId: string, revision: string): string {
  return `${CONNECTORS_KV_PREFIX}/${source}/snapshot/${encodeURIComponent(sourceId)}/${revision}`;
}

function mergePublicationMeeting(next: NormalizedMeeting, previous?: NormalizedMeeting): NormalizedMeeting {
  if (!previous) return next;
  const owns = (field: string) => next.source === "google-meet"
    && next.metadata.notes_association === "standalone" && next.metadata.notes_kind === "gemini"
    && Array.isArray(next.metadata.notes_owned_fields) && next.metadata.notes_owned_fields.includes(field);
  const acceptsDate = next.startedAt !== null && (previous.startedAt === null
    || datetimeConfidence(next.metadata, true) >= datetimeConfidence(previous.metadata, true));
  const metadata = { ...previous.metadata, ...next.metadata };
  if (!acceptsDate) for (const field of ["datetime_source", "datetime_exact", "datetime_resolution_version"]) {
    if (field in previous.metadata) metadata[field] = previous.metadata[field]; else delete metadata[field];
  }
  return { ...next, title: next.title ?? previous.title, startedAt: acceptsDate ? next.startedAt : previous.startedAt,
    durationSecs: next.durationSecs ?? previous.durationSecs, organizerEmail: next.organizerEmail ?? previous.organizerEmail,
    participants: next.participants.length ? next.participants : previous.participants,
    summaryOverview: owns("summary_overview") ? next.summaryOverview : next.summaryOverview ?? previous.summaryOverview,
    summaryActionItems: owns("summary_action_items") ? next.summaryActionItems : next.summaryActionItems ?? previous.summaryActionItems,
    keywords: next.keywords ?? previous.keywords, meetingType: next.meetingType ?? previous.meetingType, metadata };
}

async function ensurePublicationReady(tcw: TinyCloudWeb): Promise<StoreResult<void>> {
  const capabilities = await publicationCommand(tcw, { operation: "capabilities" });
  if (!capabilities.ok || capabilities.data.writerFencing !== true
    || capabilities.data.snapshotImmutability !== true || capabilities.data.digestVerification !== true) {
    return fail({ code: "PUBLICATION_UPGRADE_REQUIRED", message: "This space requires a node with fenced immutable meeting publication" }, "publication");
  }
  const ready = await publicationCommand(tcw, { operation: "activate" });
  if (!ready.ok) return ready;
  if (ready.data.status !== "ready") return fail({ code: "PUBLICATION_MIGRATION_REQUIRED", message: "Catalog identity inventory must be verified first" }, "publication");
  return { ok: true, data: undefined };
}

/** Reserve once, then fetch current upstream data. Never re-reserve a cached payload. */
export async function publishConnectorMeeting(
  tcw: TinyCloudWeb,
  identity: { source: string; sourceId: string },
  fetchCurrent: () => Promise<PublicationInput>,
  signal?: AbortSignal,
): Promise<StoreResult<UpsertMeetingOutcome & { revision: string }>> {
  const cancelled = () => signal?.aborted === true;
  const cancel = () => fail({ code: "PUBLICATION_CANCELLED", message: "Publication cancelled" }, "publication");
  if (cancelled()) return cancel();
  if (!["fireflies", "google-meet", "tinycloud-transcriber"].includes(identity.source) || !identity.sourceId) {
    return fail({ code: "PUBLICATION_INVALID_IDENTITY", message: "An enabled connector identity is required" }, "publication");
  }
  const ready = await ensurePublicationReady(tcw);
  if (!ready.ok) return ready;
  const operationId = crypto.randomUUID();
  const reserved = await publicationCommand(tcw, { operation: "reserve", ...identity, operationId });
  if (!reserved.ok) return reserved;
  const reservation = reserved.data;
  if (reservation.status !== "reserved" || reservation.operationId !== operationId
    || typeof reservation.generation !== "number" || typeof reservation.meetingRef !== "string"
    || !(reservation.expectedHead === null || typeof reservation.expectedHead === "string")) {
    return fail({ code: "PUBLICATION_CONFLICT", message: "Reservation was not confirmed" }, "publication");
  }
  if (cancelled()) return cancel();
  let input: PublicationInput;
  try { input = await fetchCurrent(); } catch (error) {
    return fail({ code: "PUBLICATION_FETCH_FAILED", message: error instanceof Error ? error.message : String(error) }, "publication");
  }
  if (cancelled()) return cancel();
  const { sentences } = input;
  const meeting = mergePublicationMeeting(input.meeting, reservation.previousMeeting);
  if (meeting.source !== identity.source || meeting.sourceId !== identity.sourceId) {
    return fail({ code: "PUBLICATION_IDENTITY_MISMATCH", message: "Fetched artifact does not match reserved identity" }, "publication");
  }
  const raw = input.body?.raw ?? JSON.stringify(sentences);
  const originalBytes = new TextEncoder().encode(raw).byteLength;
  if (originalBytes > 1_048_576) return fail({ code: "PUBLICATION_CAPACITY", message: "Original body exceeds 1 MiB" }, "publication");
  let recordCount: number | null = null;
  const bodySchema = input.body?.schema ?? "json-records";
  if (bodySchema === "text") recordCount = 1;
  if (bodySchema === "json-records") {
    try { const original = JSON.parse(raw); if (Array.isArray(original)) recordCount = original.length; } catch { /* Decoder reports malformed original bytes. */ }
  }
  const snapshot = {
    contractVersion: 3,
    meetingRef: reservation.meetingRef,
    ...identity,
    operationId,
    createdAt: new Date().toISOString(),
    metadata: {
      title: meeting.title,
      startedAt: meeting.startedAt,
      organizerEmail: meeting.organizerEmail,
      participants: meeting.participants.map((p) => ({ name: p.name, ...(p.email === null ? {} : { email: p.email }) })),
      metadata: { ...meeting.metadata, connector_fields: { durationSecs: meeting.durationSecs,
        summaryActionItems: meeting.summaryActionItems, keywords: meeting.keywords, meetingType: meeting.meetingType } },
    },
    body: {
      basis: input.body?.basis ?? (meeting.metadata.notes_kind ? "notes" : "transcript"),
      encoding: "utf-8",
      schema: input.body?.schema ?? "json-records",
      raw,
      original: { digest: await publicationSha256(raw), byteLength: originalBytes,
        recordCount,
        extent: input.body?.originalExtent ?? "unknown", captureComplete: input.body?.captureComplete ?? null },
      omissions: input.body?.omissions ?? [],
    },
    overview: meeting.summaryOverview === null ? null : { text: meeting.summaryOverview,
      provenance: { provider: identity.source, generatedAt: null, sourceDigest: null, freshness: "unknown" } },
    aliases: input.aliases ?? [],
  };
  const snapshotRaw = JSON.stringify(snapshot);
  const revision = await publicationSha256(snapshotRaw);
  const snapshotKey = snapshotKvKey(identity.source, identity.sourceId, revision);
  const command = { ...identity, operationId, generation: reservation.generation,
    expectedHead: reservation.expectedHead, meetingRef: reservation.meetingRef, revision, snapshotKey };
  // SQL transports the command as a JSON string parameter, so both escaping
  // layers and the outer execute frame count toward the limit.
  const stageCommand = { contractVersion: 3, operation: "stage", ...command, snapshotRaw };
  const transport = { action: "execute", sql: PUBLICATION_STATEMENT, params: [JSON.stringify(stageCommand)] };
  if (new TextEncoder().encode(JSON.stringify(transport)).byteLength > 2_097_152) {
    return fail({ code: "PUBLICATION_CAPACITY", message: "Complete publication envelope exceeds 2 MiB" }, "publication");
  }
  const staged = await publicationCommand(tcw, { operation: "stage", ...command, snapshotRaw });
  if (!staged.ok) return staged;
  if (staged.data.status !== "staged" || staged.data.revision !== revision || staged.data.snapshotKey !== snapshotKey) {
    return fail({ code: "PUBLICATION_DIGEST_MISMATCH", message: "Immutable snapshot was not verified" }, "publication");
  }
  if (cancelled()) return cancel();
  let published = await publicationCommand(tcw, { operation: "publish", ...command });
  if (!published.ok && ["PUBLICATION_TRANSPORT", "PUBLICATION_INVALID_RECEIPT", "NETWORK_ERROR", "TIMEOUT"].includes(published.error.code)) {
    published = await publicationCommand(tcw, { operation: "inspect", ...identity, operationId });
  }
  if (!published.ok) return published;
  if (published.data.status !== "published" || published.data.operationId !== operationId
    || published.data.revision !== revision || published.data.meetingRef !== reservation.meetingRef) {
    return fail({ code: "PUBLICATION_SUPERSEDED", message: "This operation is no longer the published head" }, "publication");
  }
  return { ok: true, data: { id: reservation.meetingRef, inserted: reservation.inserted === true,
    createdAt: reservation.createdAt ?? snapshot.createdAt, revision } };
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

/**
 * Read-only and deliberately tolerant: this runs on settings mount (the App
 * keeps views mounted via visibility toggles, so it effectively runs at app
 * load). It must NOT run schema DDL, and a session that was signed in before
 * the connectors permissions existed in the manifest (or a space where the
 * connectors db doesn't exist yet) reads as "not connected" rather than an
 * error. Schema creation happens lazily in the write paths (connect/sync).
 */
export async function getConnection(
  tcw: TinyCloudWeb,
  connectorId: ConnectorId,
): Promise<StoreResult<ConnectorConnection | null>> {
  const res = await store(tcw).query(
    `SELECT connector_id, status, last_synced_at, last_sync_status, last_sync_error, item_count
     FROM connector_state WHERE connector_id = ?`,
    [connectorId],
  );
  if (!res.ok) {
    const code = (res.error as { code?: string }).code ?? "";
    const msg = (res.error.message ?? "").toLowerCase();
    const notReadable =
      code === "AUTH_UNAUTHORIZED"
      || msg.includes("unauthorized")
      || msg.includes("not authorized")
      || msg.includes("no such table");
    if (notReadable) return { ok: true, data: null };
    return fail(res.error, "getConnection");
  }
  if (res.data.rows.length === 0) return { ok: true, data: null };
  const row = res.data.rows[0];
  return {
    ok: true,
    data: {
      connectorId: (cellStr(row, 0, connectorId) as ConnectorId) ?? connectorId,
      status: (cellStr(row, 1, "disconnected") ?? "disconnected") as "connected" | "disconnected",
      lastSyncedAt: cellStr(row, 2, null),
      lastSyncStatus: cellStr(row, 3, null) as "ok" | "partial" | "error" | null,
      lastSyncError: cellStr(row, 4, null),
      itemCount: cellNum(row, 5, 0) ?? 0,
    },
  };
}

export interface UpdateSyncStateInput {
  connectorId: ConnectorId;
  status: "connected" | "disconnected";
  lastSyncedAt: string | null;
  lastSyncStatus: "ok" | "partial" | "error" | null;
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
    "SELECT source_id FROM connector_meeting WHERE source = ? AND head_revision IS NOT NULL AND publication_state != 'deleted'",
    [source],
  );
  if (!res.ok) {
    // A pre-cutover catalog has no published identities. Let the first sync
    // reach native activation, then reserve and re-fetch each original artifact.
    if ((res.error.message ?? "").toLowerCase().includes("no such column: head_revision")) return { ok: true, data: [] };
    return fail(res.error, "listKnownSourceIds");
  }
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
  let res = await store(tcw).query(
    "SELECT COUNT(*) FROM connector_meeting WHERE source = ? AND (publication_state IS NULL OR publication_state != 'deleted')", [source]);
  if (!res.ok && /no such column: publication_state/i.test(res.error.message ?? "")) {
    res = await store(tcw).query("SELECT COUNT(*) FROM connector_meeting WHERE source = ?", [source]);
  }
  if (!res.ok) return fail(res.error, "countMeetings");
  const row = res.data.rows[0];
  if (!row) return { ok: true, data: 0 };
  const n = row[0];
  const parsed = typeof n === "number" ? n : Number.parseInt(String(n ?? "0"), 10) || 0;
  return { ok: true, data: parsed };
}

export interface UpsertMeetingOutcome {
  /** The row id actually in the store — the PRE-EXISTING id when updated. */
  id: string;
  /** true when a brand-new row was inserted, false when an existing row was updated. */
  inserted: boolean;
  /** Original creation timestamp — preserved verbatim across updates. */
  createdAt: string;
}

export interface MeetingDatetimeStats {
  rows: number;
  dated: number;
  sourceMeet: number;
  sourceDocs: number;
  sourceDriveCreatedApprox: number;
  sourceUnavailable: number;
  invalidAmbiguous: number;
  duplicates: number;
}

export async function getMeetingDatetimeStats(
  tcw: TinyCloudWeb,
  source: string,
): Promise<StoreResult<MeetingDatetimeStats>> {
  const schema = await ensureSchema(tcw);
  if (!schema.ok) return schema;
  let res = await store(tcw).query(
    "SELECT source_id, started_at, metadata FROM connector_meeting WHERE source = ? AND (publication_state IS NULL OR publication_state != 'deleted')", [source]);
  if (!res.ok && /no such column: publication_state/i.test(res.error.message ?? "")) {
    res = await store(tcw).query("SELECT source_id, started_at, metadata FROM connector_meeting WHERE source = ?", [source]);
  }
  if (!res.ok) return fail(res.error, "getMeetingDatetimeStats");
  const stats: MeetingDatetimeStats = {
    rows: res.data.rows.length, dated: 0, sourceMeet: 0, sourceDocs: 0,
    sourceDriveCreatedApprox: 0, sourceUnavailable: 0,
    invalidAmbiguous: 0, duplicates: 0,
  };
  const seen = new Set<string>();
  for (const row of res.data.rows) {
    const sourceId = cellStr(row, 0, null);
    if (sourceId !== null) {
      if (seen.has(sourceId)) stats.duplicates++;
      else seen.add(sourceId);
    }
    const startedAt = cellStr(row, 1, null);
    if (startedAt !== null) {
      if (Number.isFinite(Date.parse(startedAt))) stats.dated++;
      else stats.invalidAmbiguous++;
    }
    const metadata = parseJsonObject(row[2]);
    switch (metadata.datetime_source) {
      case "meet_conference_start": stats.sourceMeet++; break;
      case "docs_content": stats.sourceDocs++; break;
      case "drive_created_time": stats.sourceDriveCreatedApprox++; break;
      default: stats.sourceUnavailable++; break;
    }
  }
  return { ok: true, data: stats };
}

function parseJsonObject(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw !== "string") return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Corrupt metadata is not worth failing an ingest over — the new payload
    // simply replaces it wholesale.
  }
  return {};
}

function datetimeConfidence(metadata: Record<string, unknown>, hasStartedAt: boolean): number {
  switch (metadata.datetime_source) {
    case "meet_conference_start": return 3;
    case "docs_content": return 2;
    case "drive_created_time": return 1;
    case "unavailable": return 0;
    default: return hasStartedAt ? 3 : 0;
  }
}

export async function getDriveCursor(
  tcw: TinyCloudWeb,
  source: string,
): Promise<StoreResult<string | null>> {
  const res = await tcw.kv.get(driveCursorKvKey(source));
  if (!res.ok) {
    if (res.error?.code === "KV_NOT_FOUND") return { ok: true, data: null };
    return fail(res.error, "getDriveCursor");
  }
  const value = res.data.data;
  if (typeof value !== "string" || value.length === 0) {
    return { ok: false, error: { code: "STORE_CORRUPT_CURSOR", message: "getDriveCursor: cursor is not a string" } };
  }
  return { ok: true, data: value };
}

export async function putDriveCursor(
  tcw: TinyCloudWeb,
  source: string,
  cursor: string,
): Promise<StoreResult<void>> {
  if (!cursor) return { ok: false, error: { code: "STORE_INVALID_CURSOR", message: "putDriveCursor: cursor is required" } };
  const res = await tcw.kv.put(driveCursorKvKey(source), cursor);
  if (!res.ok) return fail(res.error, "putDriveCursor");
  return { ok: true, data: undefined };
}

export interface GmeetNotesAssociation {
  id: string;
  sourceId: string;
  title: string | null;
  startedAt: string | null;
  /** An exact provider link, kept separate from the independently owned notes. */
  linkedMeetingSourceId?: string;
  summaryOverview: string | null;
  summaryActionItems: string | null;
  metadata: Record<string, unknown>;
}

export type GmeetNotesRemovalOutcome = "deleted" | "cleared" | "unchanged";

/** Read only rows that can match the supplied Drive id or exact meeting identity. */
export async function findGmeetNotesAssociation(
  tcw: TinyCloudWeb,
  source: string,
  fileId: string,
  title: string | null,
  startedAt: string | null,
  excludeSourceId?: string,
): Promise<StoreResult<GmeetNotesAssociation | null>> {
  const schema = await ensureSchema(tcw);
  if (!schema.ok) return schema;
  const terms = ["source_id = ?", "metadata LIKE ? ESCAPE '\\'"];
  const params: (string | null)[] = [source, fileId, `%${fileId.replace(/[\\%_]/g, "\\$&")}%`];
  const res = await store(tcw).query(
    `SELECT id, source_id, title, started_at, summary_overview, summary_action_items, metadata FROM connector_meeting
     WHERE source = ? AND (${terms.join(" OR ")})`,
    params,
  );
  if (!res.ok) return fail(res.error, "findGmeetNotesAssociation");
  const rows = res.data.rows.map((row) => ({
    id: cellStr(row, 0, null), sourceId: cellStr(row, 1, null), title: cellStr(row, 2, null),
    startedAt: cellStr(row, 3, null), summaryOverview: cellStr(row, 4, null),
    summaryActionItems: cellStr(row, 5, null), metadata: parseJsonObject(row[6]),
  })).filter((row): row is GmeetNotesAssociation => row.id !== null && row.sourceId !== null);
  const candidates = excludeSourceId === undefined ? rows : rows.filter((row) => row.sourceId !== excludeSourceId);
  const standalone = candidates.filter((row) => row.sourceId === fileId);
  if (standalone.length > 1) return fail({ code: "PUBLICATION_IDENTITY_COLLISION", message: "Multiple catalog IDs identify this Notes document" }, "findGmeetNotesAssociation");
  const conferences = candidates.filter((row) => row.sourceId !== fileId
    && Array.isArray(row.metadata.docs_export_uris) && row.metadata.docs_export_uris.some((uri) => typeof uri === "string" && extractDriveFileId(uri) === fileId));
  const linked = conferences.length === 1 ? conferences[0] : undefined;
  if (standalone.length === 1) return { ok: true, data: { ...standalone[0]!, ...(linked ? { linkedMeetingSourceId: linked.sourceId } : {}) } };
  if (linked) return { ok: true, data: { ...linked, linkedMeetingSourceId: linked.sourceId } };
  // Earlier clients could infer drive_file_id from title/date. It is only a
  // reason to re-fetch this document, never proof of a conference link.
  const legacyCandidates = candidates.filter((row) => row.metadata.drive_file_id === fileId);
  return { ok: true, data: legacyCandidates.length === 1 ? legacyCandidates[0]! : null };
}

function extractDriveFileId(uri: string): string | null {
  const match = /\/d\/([A-Za-z0-9_-]+)/.exec(uri) ?? /[?&]id=([A-Za-z0-9_-]+)/.exec(uri);
  return match?.[1] ?? null;
}

/** Notes are independently identified; deleting them never destroys a conference. */
export async function removeGmeetNotes(
  tcw: TinyCloudWeb, source: string, fileId: string,
): Promise<StoreResult<GmeetNotesRemovalOutcome>> {
  const ready = await ensurePublicationReady(tcw);
  if (!ready.ok) return ready;
  const result = await publicationCommand(tcw, { operation: "delete", source, sourceId: fileId, operationId: crypto.randomUUID() });
  if (!result.ok) return result;
  return result.data.status === "deleted" ? { ok: true, data: result.data.deletedCount === 0 ? "unchanged" : "deleted" }
    : fail({ code: "PUBLICATION_DELETE_UNCONFIRMED", message: "Fenced deletion was not confirmed" }, "removeGmeetNotes");
}

/** Purge is a fenced native operation, including snapshots and tombstones. */
export async function purgeConnector(tcw: TinyCloudWeb, source: string): Promise<StoreResult<void>> {
  if (!source || source.includes("/")) return fail({ code: "PUBLICATION_INVALID_IDENTITY", message: "Invalid source" }, "purgeConnector");
  const ready = await ensurePublicationReady(tcw);
  if (!ready.ok) return ready;
  const result = await publicationCommand(tcw, { operation: "purge", source, operationId: crypto.randomUUID() });
  if (!result.ok) return result;
  return result.data.status === "purged" ? { ok: true, data: undefined }
    : fail({ code: "PUBLICATION_PURGE_UNCONFIRMED", message: "Fenced purge was not confirmed" }, "purgeConnector");
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
