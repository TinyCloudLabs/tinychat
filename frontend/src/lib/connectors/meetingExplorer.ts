// Meeting explorer reads — the browse-only half of the connectors store.
//
// CONTRACT (why this lives apart from connectorStore.ts):
//
//  - READ-ONLY. Never bootstraps the schema, never issues DDL, INSERT, UPDATE,
//    DELETE or any KV write. Opening a list of meetings must not mutate the
//    user's space, and DDL-on-mount is precisely what connectorStore's
//    getConnection doc comment warns against.
//
//  - TOLERANT. Every failure reads as "nothing to show": a `{ ok: false }`
//    Result, a `connector_meeting` table that does not exist yet (never
//    connected, or a session predating the connectors permissions), a
//    transport-level throw (SDK rejection, session torn down mid-call), or a
//    malformed payload all return `[]` / a non-`ok` read. Nothing throws across
//    the module boundary, so a storage hiccup can never render an error page —
//    same posture as connectorStore.getConnection. Transcript reads still SAY
//    which kind of nothing they hit (`absent` vs `failed`, see TranscriptRead)
//    so a caller can cache the settled answer and retry the transient one.
//
//  - MULTI-SOURCE. The list spans every connector in EXPLORER_MEETING_SOURCES,
//    merged newest-first; transcript reads are source-scoped because the KV key
//    is. Fail-to-empty makes an unlisted source silently invisible, so this is
//    the one place a new connector must be registered to be browsable.
//
//  - SEQUENTIAL storage calls only. TinyCloud drops concurrent responses on one
//    space. Voice-note lists first check whether the optional commit table exists,
//    then read the projected list; no transcript bodies are fetched.

import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { CONNECTORS_SQL_DB_NAME, transcriptKvKey } from "./connectorStore";
import { normalizeTranscriptText } from "../voiceNotes/voiceNoteCommits";
import {
  EXO_MERGED_SOURCE,
  FIREFLIES_KV_LIST_MAX_PAGES,
  FIREFLIES_KV_LIST_MAX_RECORDS,
  FIREFLIES_KV_RECORD_MAX_BYTES,
  FIREFLIES_MEETING_KV_PREFIX,
  FIREFLIES_MEETING_SOURCE,
  FIREFLIES_SERVER_IMPORT_TAG,
  emptyFirefliesKvDiscoveryStats,
  extractFirefliesMeetingSourceId,
  firefliesMeetingKvKey,
  parseFirefliesKvMeetingRecord,
  type FirefliesKvDiscoveryStats,
} from "@tinyboilerplate/core";
import { firefliesServerImportEnabled } from "./firefliesServerImportFeature";
import type { FirefliesSentence } from "./firefliesClient";
import { GMEET_MEETING_SOURCE } from "./gmeetNormalize";
import {
  TRANSCRIBER_MEETING_SOURCE,
  TRANSCRIBER_MEETING_SOURCE_LABEL,
} from "../transcriberSave";
import {
  LOCAL_MEETING_SOURCE,
  LOCAL_MEETING_SOURCE_LABEL,
} from "../localTranscriber";
import { VOICE_NOTE_SOURCE, VOICE_NOTE_SOURCE_LABEL } from "../voiceNotes/voiceNoteStore";
import { preciseDurationSeconds } from "../voiceNotes/noteDuration";
import { UPLOAD_MEETING_SOURCE, UPLOAD_MEETING_SOURCE_LABEL } from "../audioUpload";
import { CONNECTORS } from "./registry";

/** Chip text for a meeting combined from two partial captures. */
export const EXO_MERGED_SOURCE_LABEL = "Combined meeting";

/**
 * Every source the explorer browses, merged into ONE newest-first list.
 *
 * This list is load-bearing for visibility: a source missing here is not
 * "filtered out", it is invisible — the module is fail-to-empty by contract, so
 * rows that synced perfectly would simply never render and nothing would say
 * so. Any connector that writes `connector_meeting` rows belongs here.
 */
export const EXPLORER_MEETING_SOURCES: readonly string[] = [
  "fireflies",
  "granola",
  GMEET_MEETING_SOURCE,
  TRANSCRIBER_MEETING_SOURCE,
  LOCAL_MEETING_SOURCE,
  VOICE_NOTE_SOURCE,
  UPLOAD_MEETING_SOURCE,
  EXO_MERGED_SOURCE,
];

/**
 * Human label for a `source` column value — the registry's connector name, so
 * the per-row chip can never drift from what Settings calls the same
 * connector. An unknown source falls back to its raw string rather than
 * rendering blank.
 */
export function meetingSourceLabel(source: string): string {
  if (source === TRANSCRIBER_MEETING_SOURCE) return TRANSCRIBER_MEETING_SOURCE_LABEL;
  if (source === LOCAL_MEETING_SOURCE) return LOCAL_MEETING_SOURCE_LABEL;
  if (source === VOICE_NOTE_SOURCE) return VOICE_NOTE_SOURCE_LABEL;
  if (source === UPLOAD_MEETING_SOURCE) return UPLOAD_MEETING_SOURCE_LABEL;
  if (source === EXO_MERGED_SOURCE) return EXO_MERGED_SOURCE_LABEL;
  return CONNECTORS.find((c) => c.source === source)?.name ?? source;
}

/** One row of the meetings list — identity plus what the list renders. */
export interface MeetingListItem {
  id: string;
  /** `connector_meeting.source` — half of the transcript's KV identity. */
  source: string;
  /** Present on KV-only server-imported records promoted in memory (`"server-import"`). */
  importSource?: typeof FIREFLIES_SERVER_IMPORT_TAG;
  sourceId: string;
  title: string | null;
  startedAt: string | null;
  /** `connector_meeting.duration_secs`; null when the source did not say. */
  durationSecs: number | null;
  /** Voice-note row metadata needed to derive the list pipeline after a relaunch. */
  metadata?: Record<string, unknown> | null;
  /**
   * A combined (`exo-merged`) row's members, from `metadata.merge.members`, read in this same list
   * query. Present only when EVERY member entry is well formed (the combined store's own strictness);
   * absent for every other row and for a combined row whose record is unreadable.
   */
  mergeMembers?: readonly { source: string; sourceId: string }[];
}

export interface ListMeetingsOptions {
  /** Opt-in to discovering KV-only Fireflies server-import records. Defaults to `firefliesServerImportEnabled()`. */
  includeFirefliesKv?: boolean;
  /** Optional purge-ledger check; returning true or throwing hides the KV record (fail-closed). */
  isFirefliesPurged?: (meetingId: string, sourceTimestamp?: string) => Promise<boolean> | boolean;
  /** Optional observer for numeric KV discovery/skip counts (never receives titles or text). */
  onFirefliesKvStats?: (stats: FirefliesKvDiscoveryStats) => void;
  /** Per-record max UTF-8 byte cap (defaults to FIREFLIES_KV_RECORD_MAX_BYTES). */
  maxFirefliesKvRecordBytes?: number;
  /** Max KV records inspected per list (defaults to FIREFLIES_KV_LIST_MAX_RECORDS). */
  maxFirefliesKvRecords?: number;
  /** Max KV list pages per discovery pass (defaults to FIREFLIES_KV_LIST_MAX_PAGES). */
  maxFirefliesKvPages?: number;
}

/** Exact identity of a capture, `(source, source_id)`, never normalised: the key hiding and Feed share. */
export const memberKey = (source: string, sourceId: string): string => JSON.stringify([source, sourceId]);

/** `metadata.merge.members` as the list query returned it (JSON text), or undefined when not readable as members. */
function parseMergeMembers(raw: string | null): { source: string; sourceId: string }[] | undefined {
  if (raw === null) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return undefined; }
  if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
  const out: { source: string; sourceId: string }[] = [];
  for (const m of parsed as unknown[]) {
    const entry = m as { source?: unknown; source_id?: unknown } | null;
    if (entry === null || typeof entry !== "object" || typeof entry.source !== "string" || typeof entry.source_id !== "string" || !entry.source || !entry.source_id) return undefined;
    out.push({ source: entry.source, sourceId: entry.source_id });
  }
  return out;
}

/**
 * The captures a combined meeting stands in for: every member named by a combined row, so the Library
 * lists the combined meeting alone. Derived on each read from the combined rows themselves; nothing is
 * stored, so deleting the combined row brings its members back.
 *
 * Fail direction: a combined row whose members are unreadable contributes nothing (its sources stay
 * listed). A member that is itself combined is never hidden. Exact `(source, source_id)` match.
 */
export function hiddenMemberKeys(meetings: readonly MeetingListItem[]): Set<string> {
  const hidden = new Set<string>();
  for (const row of meetings) {
    if (row.source !== EXO_MERGED_SOURCE) continue;
    for (const m of row.mergeMembers ?? []) if (m.source !== EXO_MERGED_SOURCE) hidden.add(memberKey(m.source, m.sourceId));
  }
  return hidden;
}

/**
 * Runs one storage read and absorbs a transport-level throw as `null`.
 *
 * The `{ ok: false }` Result covers storage saying no; this covers the layer
 * below it (a rejecting SDK call, a session torn down mid-read) so the "nothing
 * throws across the module boundary" contract above holds here rather than
 * relying on every caller remembering a `.catch`. The thunk is invoked inside
 * the `try`, so a synchronous throw from `sql.db(...)` is caught too.
 */
async function tolerate<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch {
    return null;
  }
}

/** Rows come back POSITIONAL; anything that is not a string reads as absent. */
function cellStr(row: unknown[], idx: number): string | null {
  const v = row[idx];
  return typeof v === "string" ? v : null;
}

/**
 * The list read with "nothing stored" kept apart from "the read did not land"
 * (the Library offers Try again for the second). A connectors db or table that
 * does not exist yet is an ordinary empty list. A refused read (an expired
 * session) is a failure, never "no meetings": a user with notes must not be
 * told they have none.
 */
export type MeetingListRead = { status: "ok"; meetings: MeetingListItem[] } | { status: "failed" };

function notStoredYet(res: unknown): boolean {
  const code = errorCode(res);
  const err = (res as { error?: { message?: unknown } } | null)?.error;
  const message = typeof err?.message === "string" ? err.message.toLowerCase() : "";
  return /NOT_FOUND/i.test(code) || message.includes("no such table");
}

/** Rows come back POSITIONAL; anything that is not a finite number reads as absent. */
function cellNum(row: unknown[], idx: number): number | null {
  const v = row[idx];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

const FIREFLIES_KV_READ_CONCURRENCY = 8;

/**
 * Extract the node-supplied write timestamp (`lastModified` / `last-modified`) from KV response
 * headers (`@tinycloud/sdk-services` `KVResponseHeaders`). Never falls back to attacker-controlled
 * JSON body fields (`startedAt` / `importedAt`).
 */
function nodeLastModifiedFromHeaders(headers: unknown): string | undefined {
  if (!headers || typeof headers !== "object") return undefined;
  const record = headers as Record<string, unknown> & { get?: (name: string) => string | null };
  const fromGetter = typeof record.get === "function" ? record.get("last-modified") : null;
  const raw =
    typeof record.lastModified === "string"
      ? record.lastModified
      : typeof fromGetter === "string"
        ? fromGetter
        : typeof record["last-modified"] === "string"
          ? record["last-modified"]
          : typeof record["Last-Modified"] === "string"
            ? record["Last-Modified"]
            : undefined;
  if (!raw) return undefined;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (nextIndex < items.length) {
      const idx = nextIndex;
      nextIndex += 1;
      results[idx] = await worker(items[idx]!);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Discover and promote KV-only Fireflies server-import records read-only.
 *
 * Security & untrusted-data posture:
 * - FAIL CLOSED on purge: when `isFirefliesPurged` is not supplied, returns empty with zero KV calls.
 * - Purge check uses ONLY the deterministic `sourceId` (from the key) and node-supplied KV
 *   `lastModified` header (never attacker-controlled JSON `startedAt`/`importedAt`). When
 *   `lastModified` is absent and a purge ledger stands, the backend purge check fails closed.
 * - Bounded pages, bounded record count, bounded per-record byte size, bounded concurrency (8;
 *   `scheduledSpace(tcw)` serializes when required by the per-space queue).
 * - Tolerates missing/garbled/oversize records (skips and counts; never throws).
 * - Browser-imported SQL rows win on `sourceId` or `id` collision.
 */
export async function discoverFirefliesKvMeetings(
  tcw: TinyCloudWeb,
  options: {
    existingFirefliesSourceIds?: ReadonlySet<string>;
    existingMeetingIds?: ReadonlySet<string>;
    isFirefliesPurged?: ListMeetingsOptions["isFirefliesPurged"];
    maxRecordBytes?: number;
    maxRecords?: number;
    maxPages?: number;
    concurrency?: number;
  } = {},
): Promise<{ items: MeetingListItem[]; stats: FirefliesKvDiscoveryStats }> {
  const stats = emptyFirefliesKvDiscoveryStats();
  // Fail closed: never list or surface KV records without a live purge-ledger checker.
  if (!options.isFirefliesPurged) {
    return { items: [], stats };
  }
  const maxRecordBytes = options.maxRecordBytes ?? FIREFLIES_KV_RECORD_MAX_BYTES;
  const maxRecords = Math.max(1, options.maxRecords ?? FIREFLIES_KV_LIST_MAX_RECORDS);
  const maxPages = Math.max(1, options.maxPages ?? FIREFLIES_KV_LIST_MAX_PAGES);
  const concurrency = Math.max(1, options.concurrency ?? FIREFLIES_KV_READ_CONCURRENCY);
  const kv = (tcw as { kv?: { list?: TinyCloudWeb["kv"]["list"]; get?: TinyCloudWeb["kv"]["get"] } }).kv;
  if (typeof kv?.list !== "function" || typeof kv?.get !== "function") {
    return { items: [], stats };
  }

  const keys: string[] = [];
  const seenKeys = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    const page = await tolerate(() =>
      kv.list!({ path: FIREFLIES_MEETING_KV_PREFIX, ...(cursor === undefined ? {} : { cursor }) }),
    );
    if (!page || !page.ok || !Array.isArray(page.data?.keys)) {
      return { items: [], stats };
    }
    for (const rawKey of page.data.keys) {
      if (typeof rawKey !== "string") {
        stats.garbled += 1;
        continue;
      }
      if (seenKeys.has(rawKey)) continue;
      seenKeys.add(rawKey);
      if (keys.length >= maxRecords) {
        stats.truncated = true;
        break;
      }
      keys.push(rawKey);
    }
    if (stats.truncated) break;

    const nextCursor = (page.data as { cursor?: unknown }).cursor;
    if (nextCursor === undefined || nextCursor === null) break;
    if (typeof nextCursor !== "string" || nextCursor.length === 0 || seenCursors.has(nextCursor) || page.data.keys.length === 0) {
      stats.truncated = true;
      break;
    }
    if (pageIndex + 1 >= maxPages) {
      stats.truncated = true;
      break;
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  stats.listed = keys.length;
  const checkPurged = options.isFirefliesPurged;

  type KeyOutcome =
    | { kind: "promoted"; item: MeetingListItem }
    | { kind: "shadowed" | "purged" | "garbled" | "oversize" | "missing" };

  const outcomes = await mapWithConcurrency(keys, concurrency, async (key): Promise<KeyOutcome> => {
    const sourceId = extractFirefliesMeetingSourceId(key);
    if (!sourceId) return { kind: "garbled" };
    if (options.existingFirefliesSourceIds?.has(sourceId)) return { kind: "shadowed" };

    const read = await tolerate(() => kv.get!(key));
    if (!read || !read.ok) {
      if (read && /NOT_FOUND/i.test(errorCode(read))) return { kind: "missing" };
      if (read && /TOO_LARGE/i.test(errorCode(read))) return { kind: "oversize" };
      return { kind: "garbled" };
    }
    const parsed = await parseFirefliesKvMeetingRecord(read.data?.data, sourceId, {
      maxBytes: maxRecordBytes,
    });
    if (!parsed.ok) {
      return { kind: parsed.reason === "oversize" ? "oversize" : "garbled" };
    }
    const record = parsed.record;
    if (options.existingMeetingIds?.has(record.id)) return { kind: "shadowed" };

    // Bobbie binding rule: purge check uses ONLY the deterministic sourceId + node-supplied KV
    // lastModified header, NEVER attacker-controlled JSON startedAt/importedAt.
    const writtenAt = nodeLastModifiedFromHeaders(read.data?.headers);
    let purged: boolean;
    try {
      purged = Boolean(await checkPurged(record.sourceId, writtenAt));
    } catch {
      // Fail closed: never surface a KV meeting when the purge ledger cannot be verified.
      purged = true;
    }
    if (purged) return { kind: "purged" };

    return {
      kind: "promoted",
      item: {
        id: record.id,
        source: FIREFLIES_MEETING_SOURCE,
        importSource: FIREFLIES_SERVER_IMPORT_TAG,
        sourceId: record.sourceId,
        title: record.title,
        startedAt: record.startedAt,
        durationSecs: record.durationSecs,
        metadata: record.metadata,
      },
    };
  });

  const items: MeetingListItem[] = [];
  const seenPromotedIds = new Set<string>();
  for (const outcome of outcomes) {
    if (outcome.kind === "promoted") {
      if (seenPromotedIds.has(outcome.item.id)) {
        stats.shadowedBySql += 1;
      } else {
        seenPromotedIds.add(outcome.item.id);
        items.push(outcome.item);
        stats.promoted += 1;
      }
    } else if (outcome.kind === "shadowed") stats.shadowedBySql += 1;
    else if (outcome.kind === "purged") stats.purged += 1;
    else if (outcome.kind === "garbled") stats.garbled += 1;
    else if (outcome.kind === "oversize") stats.oversize += 1;
    else stats.missing += 1;
  }

  return { items, stats };
}

function compareStartedAtDesc(a: MeetingListItem, b: MeetingListItem): number {
  const aMs = a.startedAt !== null ? Date.parse(a.startedAt) : Number.NaN;
  const bMs = b.startedAt !== null ? Date.parse(b.startedAt) : Number.NaN;
  const aValid = Number.isFinite(aMs);
  const bValid = Number.isFinite(bMs);
  if (aValid && bValid) return bMs - aMs;
  if (aValid) return -1;
  if (bValid) return 1;
  return 0;
}

/**
 * Meetings stored for `sources`, newest first ACROSS the whole set — one query,
 * one merged list, ordered by `started_at` over the union rather than grouped
 * by connector.
 *
 * An empty `sources` runs no query at all: `source IN ()` is not valid SQL, and
 * "browse nothing" already has an answer.
 */
export async function listMeetingsRead(
  tcw: TinyCloudWeb,
  sources: readonly string[] = EXPLORER_MEETING_SOURCES,
  options?: ListMeetingsOptions,
): Promise<MeetingListRead> {
  if (sources.length === 0) return { status: "ok", meetings: [] };
  const includeFirefliesKv =
    (options?.includeFirefliesKv ?? firefliesServerImportEnabled()) &&
    sources.includes(FIREFLIES_MEETING_SOURCE);
  const placeholders = sources.map(() => "?").join(", ");
  let hasCommitTable = false;
  let sqlAbsent = false;
  const listsVoiceNotes = sources.includes(VOICE_NOTE_SOURCE);
  if (listsVoiceNotes) {
    const schema = await tolerate(() => tcw.sql.db(CONNECTORS_SQL_DB_NAME).query(
      "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'voice_note_transcript'",
      [],
    ));
    if (!schema) return { status: "failed" };
    if (!schema.ok) {
      if (!notStoredYet(schema)) return { status: "failed" };
      if (!includeFirefliesKv) return { status: "ok", meetings: [] };
      sqlAbsent = true;
    } else {
      hasCommitTable = Array.isArray(schema.data?.rows) && schema.data.rows.length > 0;
    }
  }
  const commitOutcome = hasCommitTable
    ? "(SELECT t.outcome FROM voice_note_transcript t WHERE t.source_id = c.source_id LIMIT 1)"
    : "NULL";
  // The legacy transcript winner for each voice note is computed once for the whole
  // set (TC-1274): a per-row correlated subquery rescanned the table for every note.
  // The winner is the eligible row with the latest transcribed_at, then the lowest id.
  // The node authorizer allows no window functions, so this uses MAX/MIN groupings;
  // `winner` takes `outcome` from its MIN(id) row (SQLite's bare-column rule).
  // `LIMIT -1 OFFSET 0` makes SQLite materialize `legacy` once instead of inlining it
  // into both readers, so each row's JSON is parsed once (the node's SQL parser rejects
  // `AS MATERIALIZED`). A list without voice notes never reads the winner, so it skips
  // the step. The outer `+c.source` keeps the full-table read a sequential scan in rowid
  // order even if a source index is added later: every listed source is read, and the
  // scan order decides the order of rows with equal started_at.
  const legacyWinner = listsVoiceNotes ? `WITH legacy AS (
         SELECT source_id, id,
                COALESCE(json_extract(metadata, '$.transcribed_at'), '') AS transcribed_at,
                CASE WHEN json_extract(metadata, '$.transcription_outcome') IN ('transcribed','no_speech')
                     THEN json_extract(metadata, '$.transcription_outcome') ELSE 'transcribed' END AS outcome
         FROM connector_meeting
         WHERE source IN ('exo-voice-note','exo-voice-note-dup')
           AND json_valid(metadata)
           AND (json_extract(metadata, '$.transcription_outcome') IN ('transcribed','no_speech')
             OR (json_extract(metadata, '$.transcription_outcome') IS NULL
               AND typeof(json_extract(metadata, '$.transcript_text')) = 'text'
               AND length(trim(json_extract(metadata, '$.transcript_text'))) > 0))
         LIMIT -1 OFFSET 0),
       latest AS (SELECT source_id, MAX(transcribed_at) AS transcribed_at FROM legacy GROUP BY source_id),
       winner AS (
         SELECT l.source_id, MIN(l.id) AS id, l.outcome FROM legacy l
         JOIN latest m ON m.source_id = l.source_id AND m.transcribed_at = l.transcribed_at
         GROUP BY l.source_id)
       ` : "";
  const meetings: MeetingListItem[] = [];
  if (!sqlAbsent) {
    const res = await tolerate(() =>
      tcw.sql.db(CONNECTORS_SQL_DB_NAME).query(
        `${legacyWinner}SELECT c.id, c.source, c.source_id, c.title, c.started_at, c.duration_secs,
              CASE WHEN c.source = 'exo-voice-note' THEN
                CASE WHEN json_valid(COALESCE(c.metadata, '{}')) THEN json_object(
                  'transcription_outcome', json_extract(c.metadata, '$.transcription_outcome'),
                  'transcription_error_code', json_extract(c.metadata, '$.transcription_error_code'),
                  'legacy_transcript_outcome', ${listsVoiceNotes ? "w.outcome" : "NULL"},
                  'transcript_commit_outcome', ${commitOutcome},
                  'has_transcript_text',   (typeof(json_extract(c.metadata, '$.transcript_text')) = 'text'
                    AND length(trim(json_extract(c.metadata, '$.transcript_text'))) > 0),
                  'note_kv_key',           json_extract(c.metadata, '$.note_kv_key'),
                  'note_edited_at',        json_extract(c.metadata, '$.note_edited_at'),
                  'audio_kv_key',          json_extract(c.metadata, '$.audio_kv_key'),
                  'audio_stored',          json_extract(c.metadata, '$.audio.stored'),
                  'audio_device_platform', json_extract(c.metadata, '$.audio.device.platform'),
                  'capture',               json_extract(c.metadata, '$.capture'))
                ELSE 'invalid' END
              END AS pipeline_metadata,
              CASE WHEN c.source = 'exo-voice-note' AND json_valid(COALESCE(c.metadata, '{}'))
                THEN json_extract(c.metadata, '$.capture.duration_ms') END AS capture_duration_ms,
              CASE WHEN c.source = '${EXO_MERGED_SOURCE}' AND json_valid(COALESCE(c.metadata, '{}'))
                THEN json_extract(c.metadata, '$.merge.members') END AS merge_members
       FROM connector_meeting c${listsVoiceNotes ? " LEFT JOIN winner w ON w.source_id = c.source_id" : ""}
       WHERE +c.source IN (${placeholders}) ORDER BY c.started_at DESC`,
        [...sources],
      ),
    );
    if (!res) return { status: "failed" };
    if (!res.ok) {
      if (!notStoredYet(res)) return { status: "failed" };
      if (!includeFirefliesKv) return { status: "ok", meetings: [] };
    } else {
      const rows: unknown = res.data?.rows;
      if (Array.isArray(rows)) {
        for (const row of rows as unknown[][]) {
          if (!Array.isArray(row)) continue;
          const id = cellStr(row, 0);
          const source = cellStr(row, 1);
          const sourceId = cellStr(row, 2);
          // A row with no identity cannot be opened — the transcript key is
          // (source, source_id), so a row missing either half is unreadable. Drop it
          // rather than render a row that can only ever fail to expand.
          if (!id || !source || !sourceId) continue;
          const item: MeetingListItem = {
            id,
            source,
            sourceId,
            title: cellStr(row, 3),
            startedAt: cellStr(row, 4),
            durationSecs: source === VOICE_NOTE_SOURCE ? preciseDurationSeconds(cellNum(row, 5), row[7]) : cellNum(row, 5),
          };
          if (source === VOICE_NOTE_SOURCE) {
            const rawPipelineMetadata = cellStr(row, 6);
            if (rawPipelineMetadata === null) {
              // The listing read the row and confirmed there is no metadata. Keep
              // this distinct from an unreadable value, which lets the pipeline
              // hook batch-read only the missing evidence.
              item.metadata = null;
            } else if (rawPipelineMetadata === "invalid") {
              console.warn(`Meeting explorer: voice-note row ${id} has invalid metadata JSON; its pipeline will batch-read metadata`);
            } else {
              try {
                const metadata: unknown = JSON.parse(rawPipelineMetadata);
                if (metadata !== null && typeof metadata === "object" && !Array.isArray(metadata)) {
                  item.metadata = metadata as Record<string, unknown>;
                } else {
                  console.warn(`Meeting explorer: voice-note row ${id} has non-object metadata; its pipeline will batch-read metadata`);
                }
              } catch {
                console.warn(`Meeting explorer: voice-note row ${id} has invalid metadata JSON; its pipeline will batch-read metadata`);
              }
            }
          }
          if (source === EXO_MERGED_SOURCE) {
            const members = parseMergeMembers(cellStr(row, 8));
            if (members) item.mergeMembers = members;
          }
          meetings.push(item);
        }
      }
    }
  }

  if (!includeFirefliesKv) {
    return { status: "ok", meetings };
  }

  const existingFirefliesSourceIds = new Set(
    meetings.filter((row) => row.source === FIREFLIES_MEETING_SOURCE).map((row) => row.sourceId),
  );
  const existingMeetingIds = new Set(meetings.map((row) => row.id));
  const kv = await discoverFirefliesKvMeetings(tcw, {
    existingFirefliesSourceIds,
    existingMeetingIds,
    isFirefliesPurged: options?.isFirefliesPurged,
    maxRecordBytes: options?.maxFirefliesKvRecordBytes,
    maxRecords: options?.maxFirefliesKvRecords,
    maxPages: options?.maxFirefliesKvPages,
  });
  options?.onFirefliesKvStats?.(kv.stats);
  if (kv.items.length === 0) {
    return { status: "ok", meetings };
  }
  const merged = [...meetings, ...kv.items].sort(compareStartedAtDesc);
  return { status: "ok", meetings: merged };
}

/**
 * The same list, with every failure read as "no meetings" (including the
 * table not existing): the tolerant answer for callers that have no failed
 * state to show.
 */
export async function listMeetings(
  tcw: TinyCloudWeb,
  sources: readonly string[] = EXPLORER_MEETING_SOURCES,
  options?: ListMeetingsOptions,
): Promise<MeetingListItem[]> {
  const read = await listMeetingsRead(tcw, sources, options);
  return read.status === "ok" ? read.meetings : [];
}

/**
 * The `connector_meeting.id` of the row a source wrote for `sourceId` (a voice
 * note's row, by its recording id): what a note's address needs. One read;
 * `absent` when no row has it yet, `failed` when the read did not land.
 */
export type MeetingIdRead = { status: "ok"; id: string } | { status: "absent" } | { status: "failed" };

export async function findMeetingId(
  tcw: TinyCloudWeb,
  source: string,
  sourceId: string,
): Promise<MeetingIdRead> {
  const res = await tolerate(() =>
    tcw.sql.db(CONNECTORS_SQL_DB_NAME).query(
      "SELECT id FROM connector_meeting WHERE source = ? AND source_id = ? LIMIT 1",
      [source, sourceId],
    ),
  );
  if (!res) return { status: "failed" };
  if (!res.ok) return notStoredYet(res) ? { status: "absent" } : { status: "failed" };
  const row: unknown = res.data?.rows?.[0];
  const id = Array.isArray(row) ? cellStr(row, 0) : null;
  return id ? { status: "ok", id } : { status: "absent" };
}

/**
 * The outcome of one transcript read, with "nothing stored" kept distinct from
 * "the read did not land".
 *
 * The difference is the whole point: `absent` is a settled answer a caller may
 * cache forever, `failed` is a transient miss that must stay retryable. Collapsing
 * both to `null` is what pins a row on "not synced yet" for the life of the page
 * after a single storage hiccup.
 */
export type TranscriptRead =
  /** The read landed and the stored body parsed. May be empty. */
  | { status: "ok"; sentences: FirefliesSentence[] }
  /** The read landed; there is nothing readable stored under this key. */
  | { status: "absent" }
  /** The read itself did not land (transport, auth, unknown store error). */
  | { status: "failed" };

/** Result-shaped error codes come back as strings; anything else reads as unknown. */
function errorCode(res: unknown): string {
  const err = (res as { error?: { code?: unknown } } | null)?.error;
  return typeof err?.code === "string" ? err.code : "";
}

/**
 * The transcript body for one meeting, keyed by BOTH halves of its identity.
 *
 * `source` is required rather than defaulted: the KV key is source-scoped, and
 * a defaulted source silently reads the Fireflies key for a Google Meet
 * meeting — a miss that would render as "not synced yet" forever.
 *
 * The store writes a JSON-stringified `FirefliesSentence[]`, but the KV client
 * hands back either the parsed array or the raw string depending on the stored
 * content-type — so both are accepted. A body that landed but cannot be read
 * (malformed JSON, wrong shape) is `absent`, not `failed`: re-reading it will
 * return the same unusable bytes.
 */
export async function readTranscript(
  tcw: TinyCloudWeb,
  source: string,
  sourceId: string,
  bodyKey: string = transcriptKvKey(source, sourceId),
  expectedText?: string | null,
  options?: {
    requirePurgeCheck?: boolean;
    isFirefliesPurged?: ListMeetingsOptions["isFirefliesPurged"];
  },
): Promise<TranscriptRead> {
  const untimed = (): TranscriptRead => ({ status: "ok", sentences: [{ index: 0, speaker_name: null,
    text: expectedText ?? "", start_time: 0, end_time: 0 }] });
  if (options?.requirePurgeCheck && source === FIREFLIES_MEETING_SOURCE) {
    if (!options.isFirefliesPurged) return { status: "absent" };
  }
  const res = await tolerate(() => tcw.kv.get(bodyKey));
  if (!res) return { status: "failed" };
  if (!res.ok) {
    // A missing key is the ordinary "no transcript stored" answer; every other
    // error (auth, transport, store) is a miss worth retrying.
    return /NOT_FOUND/i.test(errorCode(res))
      ? expectedText ? untimed() : { status: "absent" }
      : { status: "failed" };
  }
  if (options?.requirePurgeCheck && source === FIREFLIES_MEETING_SOURCE) {
    // Check purge using ONLY deterministic sourceId + node-supplied KV lastModified header.
    const writtenAt = nodeLastModifiedFromHeaders(res.data?.headers);
    let purged: boolean;
    try {
      purged = Boolean(await options.isFirefliesPurged!(sourceId, writtenAt));
    } catch {
      purged = true;
    }
    if (purged) return { status: "absent" };
  }

  let payload: unknown = res.data?.data;
  if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload);
    } catch {
      return expectedText ? untimed() : { status: "absent" };
    }
  }
  if (!Array.isArray(payload)) return expectedText ? untimed() : { status: "absent" };

  const sentences = payload.filter(
    (s): s is FirefliesSentence =>
      typeof s === "object"
      && s !== null
      && typeof (s as { text?: unknown }).text === "string",
  );
  if (expectedText != null && normalizeTranscriptText(sentences.map((s) => s.text).join(" ")) !== normalizeTranscriptText(expectedText)) {
    console.info("[VoiceNotes] legacy_body_mismatch", { sourceId });
    return untimed();
  }
  return {
    status: "ok",
    sentences,
  };
}

/**
 * The raw transcript as the user copies it: one speaker-attributed line per
 * sentence. Deliberately unlike `meetingsView.transcriptText`, which drops
 * speakers — a pasted transcript without "who said it" is far less useful.
 */
export function transcriptCopyText(sentences: readonly FirefliesSentence[]): string {
  return sentences
    .map((s) => (s.speaker_name ? `${s.speaker_name}: ${s.text}` : s.text))
    .join("\n");
}

/**
 * One meeting's own row metadata (provenance, the stored audio's place, a
 * voice note's transcript outcome), read when the meeting is opened — the list
 * query never selects `metadata`, which can carry a whole transcript. Same
 * settled/transient split as {@link TranscriptRead}: no row, or metadata that
 * is not a JSON object, is `absent`.
 */
export type MeetingMetadataRead =
  | { status: "ok"; metadata: Record<string, unknown> }
  | { status: "absent" }
  | { status: "failed" };

export async function readMeetingMetadata(
  tcw: TinyCloudWeb,
  id: string,
  options?: {
    includeFirefliesKv?: boolean;
    source?: string;
    sourceId?: string;
    isFirefliesPurged?: ListMeetingsOptions["isFirefliesPurged"];
  },
): Promise<MeetingMetadataRead> {
  const includeFirefliesKv =
    (options?.includeFirefliesKv ?? firefliesServerImportEnabled()) &&
    options?.source === FIREFLIES_MEETING_SOURCE &&
    typeof options?.sourceId === "string" &&
    options.sourceId.length > 0;
  const res = await tolerate(() =>
    tcw.sql.db(CONNECTORS_SQL_DB_NAME).query(
      "SELECT metadata FROM connector_meeting WHERE id = ?",
      [id],
    ),
  );
  if (!res) return { status: "failed" };
  if (!res.ok) {
    if (includeFirefliesKv && notStoredYet(res)) {
      return readFirefliesKvMetadata(tcw, id, options!.sourceId!, options?.isFirefliesPurged);
    }
    return { status: "failed" };
  }
  const row: unknown = res.data?.rows?.[0];
  const raw = Array.isArray(row) ? cellStr(row, 0) : null;
  if (raw === null) {
    if (includeFirefliesKv) {
      return readFirefliesKvMetadata(tcw, id, options!.sourceId!, options?.isFirefliesPurged);
    }
    return { status: "absent" };
  }
  let metadata: unknown;
  try {
    metadata = JSON.parse(raw);
  } catch {
    return { status: "absent" };
  }
  return metadata !== null && typeof metadata === "object" && !Array.isArray(metadata)
    ? { status: "ok", metadata: metadata as Record<string, unknown> }
    : { status: "absent" };
}

async function readFirefliesKvMetadata(
  tcw: TinyCloudWeb,
  expectedId: string,
  sourceId: string,
  isFirefliesPurged?: ListMeetingsOptions["isFirefliesPurged"],
): Promise<MeetingMetadataRead> {
  // Fail closed: never read or return KV metadata without a live purge-ledger checker.
  if (!isFirefliesPurged) return { status: "absent" };
  const kvRes = await tolerate(() => tcw.kv.get(firefliesMeetingKvKey(sourceId)));
  if (!kvRes) return { status: "failed" };
  if (!kvRes.ok) {
    return /NOT_FOUND/i.test(errorCode(kvRes)) ? { status: "absent" } : { status: "failed" };
  }
  const parsed = await parseFirefliesKvMeetingRecord(kvRes.data?.data, sourceId);
  if (!parsed.ok || parsed.record.id !== expectedId) return { status: "absent" };
  const writtenAt = nodeLastModifiedFromHeaders(kvRes.data?.headers);
  let purged: boolean;
  try {
    purged = Boolean(await isFirefliesPurged(sourceId, writtenAt));
  } catch {
    purged = true;
  }
  if (purged) return { status: "absent" };
  return { status: "ok", metadata: parsed.record.metadata };
}

/**
 * Where a meeting's original audio is stored. `stored` only for a finished
 * upload (`metadata.audio.stored === true`); same settled/transient split as
 * {@link TranscriptRead}.
 */
export type MeetingAudioRead =
  | { status: "stored"; base: string }
  | { status: "absent" }
  | { status: "failed" };

/** The stored audio a row's metadata points at, if any. */
export function meetingAudioFrom(metadata: Record<string, unknown> | null): MeetingAudioRead {
  const audio = (metadata as { audio?: { stored?: unknown; base?: unknown } } | null)?.audio;
  return audio?.stored === true && typeof audio.base === "string" && audio.base.length > 0
    ? { status: "stored", base: audio.base }
    : { status: "absent" };
}

export async function readMeetingAudio(
  tcw: TinyCloudWeb,
  id: string,
): Promise<MeetingAudioRead> {
  const read = await readMeetingMetadata(tcw, id);
  if (read.status === "failed") return { status: "failed" };
  return meetingAudioFrom(read.status === "ok" ? read.metadata : null);
}
