// Ported from tinycloud-agents eliza-service transcript-registry.ts (ed320bd, TC-2163 projection and
// byte-bounded paging), reading through the hosted MCP instead of a delegated node session.
import {
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
import { isTombstoned } from "../services/connector-drain.js";
import { TRANSCRIPT_SOURCES } from "./tools.js";
import type { TranscriptMetadata, TranscriptReader } from "./tools.js";
import { checkContext, decodeBody, discoveryResult, MeetingRetrievalError, scopedRows, withinContext } from "./evidence.js";
import type { BodyResult, RetrievalContext } from "./evidence.js";
import { COMBINED_SOURCE, combinedMemberKeys, isCombinedMember, readCombinedMembers } from "./combined.js";
import { McpPortError, MCP_SQL_PAGE_BYTE_BUDGET } from "./port.js";
import type { McpMeetingPort } from "./port.js";

type FirefliesPurgeLedger = NonNullable<Parameters<typeof isTombstoned>[1]>;

export type FirefliesPurgeLedgerRead =
  | { status: "absent" }
  | { status: "unparseable"; raw: unknown }
  | { status: "ok"; ledger: FirefliesPurgeLedger };

export interface ReaderOptions {
  /** Opt-in KV discovery for server-imported Fireflies records (default false). */
  firefliesKvEnabled?: boolean;
  /** Optional purge-ledger reader for the owner; corrupt or throwing ledger fails closed and hides KV records. */
  readFirefliesPurgeLedger?: () => Promise<FirefliesPurgeLedgerRead>;
  /** Optional observer for numeric KV discovery/skip counts (never receives titles or text). */
  onFirefliesKvStats?: (stats: FirefliesKvDiscoveryStats) => void;
  /** Per-record max UTF-8 byte cap override (defaults to FIREFLIES_KV_RECORD_MAX_BYTES). */
  maxFirefliesKvRecordBytes?: number;
  /** Max KV records per list scan override (defaults to FIREFLIES_KV_LIST_MAX_RECORDS). */
  maxFirefliesKvRecords?: number;
}

export const SQL_PATH = "xyz.tinycloud.tinychat/connectors";
const METADATA_ROW_LIMIT = 501;
const METADATA_DISCOVERY_SCAN_LIMIT = 500;
const VOICE_NOTE_SOURCE = "exo-voice-note";
const VOICE_NOTE_INDEX = "voice_note_transcript";
const VOICE_NOTE_REV_PREFIX = `${SQL_PATH}/${VOICE_NOTE_SOURCE}/transcript-rev/`;
const VOICE_NOTE_REV_HASH = /^[0-9a-f]{32}$/;
const VOICE_NOTE_MIRROR_READABLE = "(CASE WHEN json_valid(metadata) THEN (json_extract(metadata, '$.transcription_outcome') = 'transcribed') ELSE 0 END)";

const MARKER_KEYS = ["artifactType", "artifact_type", "type", "kind", "documentType", "document_type", "notes_kind", "notes_association"] as const;
/** Combined member refs are small; oversized combined rows fall back to listing their member rows. */
const COMBINED_MEMBERS_MAX_BYTES = 128;
/** Upper bound on combined-row pages read for exclusion; a missed exclusion is a recoverable duplicate. */
const COMBINED_KEYS_MAX_PAGES = 20;
const SQL_PAGE_MAX_ROWS = 500;
const SQL_PAGE_BYTE_BUDGET = MCP_SQL_PAGE_BYTE_BUDGET;
const SQL_PAGE_ROW_OVERHEAD_BYTES = 32;
const MEETING_REF_MAX_LENGTH = 128;
const SOURCE_ID_MAX_LENGTH = 512;
const LIST_SOURCE_MAX_BYTES = 64;
const LIST_TITLE_MAX_LENGTH = 512;
const LIST_STARTED_AT_MAX_LENGTH = 64;
const LIST_ORGANIZER_MAX_LENGTH = 254;
const LIST_PARTICIPANTS_MAX_BYTES = 4_096;
const LIST_SUMMARY_MAX_LENGTH = 4_096;
const METADATA_PROJECTION = `CASE WHEN json_valid(metadata) THEN json_object(${[
  ...MARKER_KEYS.map(key => `'${key}', CASE WHEN json_type(metadata, '$.${key}') = 'text' AND length(json_extract(metadata, '$.${key}')) < 100 THEN json_extract(metadata, '$.${key}') END`),
  "'transcript_count', CASE WHEN json_type(metadata, '$.transcript_count') IN ('integer', 'real') THEN json_extract(metadata, '$.transcript_count') END",
  `'merge', CASE WHEN source = '${COMBINED_SOURCE}' AND json_type(metadata, '$.merge.members') = 'array' AND length(CAST(json(json_extract(metadata, '$.merge.members')) AS BLOB)) <= ${COMBINED_MEMBERS_MAX_BYTES} THEN json_object('members', json(json_extract(metadata, '$.merge.members'))) END`,
].join(", ")}) END`;
const COMBINED_KEYS_METADATA_PROJECTION = `json_object('merge', json_object('members', json(json_extract(metadata, '$.merge.members'))))`;
const LISTING_METADATA_PROJECTION = `CASE WHEN json_valid(metadata) THEN json_object(${[
  ...MARKER_KEYS.map(key => `'${key}', CASE WHEN json_type(metadata, '$.${key}') = 'text' THEN substr(json_extract(metadata, '$.${key}'), 1, 99) END`),
  "'transcript_count', CASE WHEN json_type(metadata, '$.transcript_count') IN ('integer', 'real') THEN json_extract(metadata, '$.transcript_count') END",
  `'merge', CASE WHEN source = '${COMBINED_SOURCE}' AND json_type(metadata, '$.merge.members') = 'array' AND length(CAST(json(json_extract(metadata, '$.merge.members')) AS BLOB)) <= ${COMBINED_MEMBERS_MAX_BYTES} THEN json_object('members', json(json_extract(metadata, '$.merge.members')) ) END`,
].join(", ")}) END`;
const COLUMNS = `id, source, source_id, title, started_at, organizer_email, participants, summary_overview, summary_action_items, ${METADATA_PROJECTION}`;
const LISTING_ID = `CASE WHEN length(CAST(id AS BLOB)) <= ${MEETING_REF_MAX_LENGTH} THEN id END`;
const LISTING_SOURCE = `CASE WHEN length(CAST(source AS BLOB)) <= ${LIST_SOURCE_MAX_BYTES} THEN source END`;
const LISTING_SOURCE_ID = `CASE WHEN length(CAST(source_id AS BLOB)) <= ${SOURCE_ID_MAX_LENGTH} THEN source_id END`;
const LISTING_TITLE = `substr(title, 1, ${LIST_TITLE_MAX_LENGTH})`;
const LISTING_STARTED_AT = `substr(started_at, 1, ${LIST_STARTED_AT_MAX_LENGTH})`;
const LISTING_ORGANIZER = `substr(organizer_email, 1, ${LIST_ORGANIZER_MAX_LENGTH})`;
const LISTING_PARTICIPANTS = `CASE WHEN participants IS NULL THEN NULL WHEN json_valid(participants) AND length(CAST(participants AS BLOB)) <= ${LIST_PARTICIPANTS_MAX_BYTES} THEN participants ELSE '[]' END`;
const LISTING_OVERVIEW = `substr(summary_overview, 1, ${LIST_SUMMARY_MAX_LENGTH})`;
const LISTING_ACTIONS = `substr(summary_action_items, 1, ${LIST_SUMMARY_MAX_LENGTH})`;
const LISTING_TRUNCATED = `CASE WHEN length(CAST(id AS BLOB)) > ${MEETING_REF_MAX_LENGTH} OR length(CAST(source AS BLOB)) > ${LIST_SOURCE_MAX_BYTES} OR length(CAST(source_id AS BLOB)) > ${SOURCE_ID_MAX_LENGTH} OR length(title) > ${LIST_TITLE_MAX_LENGTH} OR length(started_at) > ${LIST_STARTED_AT_MAX_LENGTH} OR length(organizer_email) > ${LIST_ORGANIZER_MAX_LENGTH} OR (participants IS NOT NULL AND (NOT json_valid(participants) OR length(CAST(participants AS BLOB)) > ${LIST_PARTICIPANTS_MAX_BYTES})) OR length(summary_overview) > ${LIST_SUMMARY_MAX_LENGTH} OR length(summary_action_items) > ${LIST_SUMMARY_MAX_LENGTH}${MARKER_KEYS.map(key => ` OR (json_valid(metadata) AND json_type(metadata, '$.${key}') = 'text' AND length(json_extract(metadata, '$.${key}')) >= 100)`).join("")} OR (source = '${COMBINED_SOURCE}' AND json_valid(metadata) AND json_type(metadata, '$.merge.members') = 'array' AND length(CAST(json(json_extract(metadata, '$.merge.members')) AS BLOB)) > ${COMBINED_MEMBERS_MAX_BYTES}) THEN 1 ELSE 0 END`;
const LISTING_ID_OVERSIZED = `CASE WHEN length(CAST(id AS BLOB)) > ${MEETING_REF_MAX_LENGTH} THEN 1 ELSE 0 END`;
const LISTING_COLUMNS = `${LISTING_ID}, ${LISTING_SOURCE}, ${LISTING_SOURCE_ID}, ${LISTING_TITLE}, ${LISTING_STARTED_AT}, ${LISTING_ORGANIZER}, ${LISTING_PARTICIPANTS}, ${LISTING_OVERVIEW}, ${LISTING_ACTIONS}, ${LISTING_METADATA_PROJECTION}, ${LISTING_TRUNCATED}, ${LISTING_ID_OVERSIZED}`;
function decodeMetadata(row: unknown): TranscriptMetadata | null {
  if (!Array.isArray(row)) return null;
  const [meetingRef, source, sourceId, title, startedAt, organizerEmail, participants, summaryOverview, summaryActionItems, metadata, listingTruncated] = row;
  if (typeof meetingRef !== "string" || !safeMeetingRef(meetingRef) || !isSource(source) || typeof sourceId !== "string" || !safeSegment(sourceId)) return null;
  const parsed = parseParticipants(participants);
  let provenance: unknown = metadata;
  if (typeof provenance === "string") { try { provenance = JSON.parse(provenance); } catch { provenance = undefined; } }
  // Only keep existing artifact type markers, never opaque provider metadata.
  const known: Record<string, unknown> = {};
  if (provenance && typeof provenance === "object") for (const key of MARKER_KEYS) {
    const value = (provenance as Record<string, unknown>)[key]; if (typeof value === "string" && value.length < 100) known[key] = value;
  }
  const transcriptCount = provenance && typeof provenance === "object" ? (provenance as Record<string, unknown>).transcript_count : undefined;
  if (typeof transcriptCount === "number" && Number.isInteger(transcriptCount) && transcriptCount >= 0) known.transcript_count = transcriptCount;
  return { meetingRef, source, sourceId, title: typeof title === "string" ? title : null,
    startedAt: typeof startedAt === "string" && Number.isFinite(Date.parse(startedAt)) ? startedAt : null,
    participantNames: parsed.names, participantEmails: parsed.emails, metadataLimited: parsed.limited, organizerEmail: typeof organizerEmail === "string" ? organizerEmail : null,
    summaryOverview: typeof summaryOverview === "string" ? summaryOverview : null, summaryActionItems: typeof summaryActionItems === "string" ? summaryActionItems : null,
    listingTruncated: listingTruncated === 1,
    ...(Object.keys(known).length ? { metadata: known } : {}),
  };
}
function logSkippedOversizedIds(count: number): void {
  if (count > 0) console.warn("transcript_listing_oversized_ids_skipped", { count });
}
/** Classify a port failure into the body states the evidence layer understands. */
export function classifyBodyFailure(error: unknown): BodyResult {
  if (error instanceof McpPortError) {
    if (error.code === "KV_RESPONSE_TOO_LARGE" || error.code === "SQL_RESULT_LIMIT_EXCEEDED") return { state: "size_limit", reasonCode: error.code };
    if (error.code === "KV_NOT_FOUND") return { state: "missing", reasonCode: error.code };
    if (error.code === "TIMEOUT") return { state: "timeout", reasonCode: error.code };
    if (error.code === "ABORTED") return { state: "cancelled", reasonCode: error.code };
    if (error.code === "GRANT_REQUIRED") return { state: "access_denied", reasonCode: "AUTH_REQUIRED" };
    if (error.code === "GRANT_EXPIRED") return { state: "access_denied", reasonCode: "DELEGATION_EXPIRED" };
    // A rejected grant needs the same user action as a revoked one: approve access again.
    if (error.code === "GRANT_REJECTED") return { state: "access_denied", reasonCode: "DELEGATION_REVOKED" };
    return { state: "unavailable", reasonCode: error.code };
  }
  return { state: "unavailable", reasonCode: "UNKNOWN" };
}
const SPEAKER_NAMES_MAX_BYTES = 16_384;
// The frontend's own cap for a shown name (MAX_SPEAKER_NAME_LENGTH in frontend/src/capture/library/speakerNames.ts).
const SPEAKER_NAME_MAX_LENGTH = 80;
const SPEAKER_FIELDS = ["speaker_name", "speaker", "speakerName"] as const;
function parseSpeakerNames(value: unknown): Map<string, string> | null {
  let parsed = value;
  if (typeof value === "string") { try { parsed = JSON.parse(value); } catch { return null; } }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const names = new Map<string, string>();
  for (const [label, name] of Object.entries(parsed)) {
    if (typeof name !== "string") continue;
    // Same cleaning as the frontend's cleanSpeakerName: one line, trimmed, capped.
    const shown = name.replaceAll(/\s+/g, " ").trim().slice(0, SPEAKER_NAME_MAX_LENGTH).trim();
    if (shown) names.set(label, shown);
  }
  return names.size ? names : null;
}
function renameSpeakers(item: unknown, names: ReadonlyMap<string, string>): unknown {
  if (!item || typeof item !== "object") return item;
  const renamed: Record<string, unknown> = { ...item };
  for (const field of SPEAKER_FIELDS) {
    const label = renamed[field];
    if (typeof label === "string" && names.has(label)) renamed[field] = names.get(label);
  }
  return renamed;
}

export function createReader(
  port: McpMeetingPort,
  assertAccess: () => void = () => {},
  invalidateAccess: () => void = () => {},
  options: ReaderOptions = {},
): TranscriptReader {
  const firefliesKvEnabled = options.firefliesKvEnabled === true;
  const maxFirefliesKvRecordBytes = options.maxFirefliesKvRecordBytes ?? FIREFLIES_KV_RECORD_MAX_BYTES;
  const maxFirefliesKvRecords = Math.max(1, options.maxFirefliesKvRecords ?? FIREFLIES_KV_LIST_MAX_RECORDS);
  const withAccess = async <T>(signal: AbortSignal | undefined, operation: (active: McpMeetingPort) => Promise<T>) => {
    checkContext({ signal });
    assertAccess();
    return operation(port);
  };
  const enforceAccess = (body: BodyResult) => {
    if (body.state !== "access_denied") return;
    const code = body.reasonCode === "DELEGATION_REVOKED" ? "delegation_revoked" : body.reasonCode === "DELEGATION_EXPIRED" || body.reasonCode === "AUTH_EXPIRED" ? "delegation_expired" : body.reasonCode === "AUTH_REQUIRED" ? "delegation_required" : "access_denied";
    if (code !== "access_denied") invalidateAccess();
    throw new MeetingRetrievalError(code, 409);
  };
  const query = async (sql: string, params: Array<string | number | null> = [], context: RetrievalContext = {}): Promise<unknown[][]> => {
    assertAccess();
    try {
      const rows = await withinContext(signal => withAccess(signal, active => active.sqlQuery(sql, params, { signal })), context);
      assertAccess();
      return rows;
    } catch (error) {
      if (error instanceof MeetingRetrievalError) throw error;
      enforceAccess(classifyBodyFailure(error));
      throw new MeetingRetrievalError("transcript_unavailable");
    }
  };
  // The MCP's SELECT validator (node-sql-parser, sqlite) rejects window functions, so the byte budget is applied in two
  // plain SELECTs: first measure each candidate row's serialized size, then fetch exactly the prefix that fits. The cursor
  // advances only over emitted rows so callers can continue partial pages.
  const queryPage = async (
    columns: string,
    columnCount: number,
    where: string,
    params: Array<string | number | null>,
    order: string,
    cursor: number,
    pageRows: number,
    context: RetrievalContext = {},
  ): Promise<{ rows: unknown[][]; cursor: number | null }> => {
    // The validator also rejects bound LIMIT/OFFSET placeholders; both are integers computed in this module, so they are inlined.
    const int = (value: number) => Math.max(0, Math.trunc(Number.isFinite(value) ? value : 0));
    const sizes = (await query(
      `SELECT length(CAST(json_array(${columns}) AS BLOB)) FROM connector_meeting WHERE ${where} ORDER BY ${order} LIMIT ${int(pageRows)} OFFSET ${int(cursor)}`,
      params, context)).map(row => Number(row[0]));
    let fit = 0;
    for (let total = 0; fit < sizes.length; fit += 1) {
      total += (Number.isFinite(sizes[fit]) ? sizes[fit]! : SQL_PAGE_BYTE_BUDGET) + SQL_PAGE_ROW_OVERHEAD_BYTES;
      if (total > SQL_PAGE_BYTE_BUDGET) break;
    }
    const page = fit === 0 ? [] : (await query(
      `SELECT ${columns} FROM connector_meeting WHERE ${where} ORDER BY ${order} LIMIT ${int(fit)} OFFSET ${int(cursor)}`,
      params, context)).map(row => row.slice(0, columnCount));
    // A short page the byte budget did not trim is the last one; only full or trimmed pages need a continuation probe.
    const trimmed = fit < sizes.length;
    if (!trimmed && sizes.length < pageRows) return { rows: page, cursor: null };
    const hasMore = (await query(
      `SELECT 1 FROM connector_meeting WHERE ${where} LIMIT 1 OFFSET ${int(cursor + page.length)}`,
      params, context)).length > 0;
    return { rows: page, cursor: hasMore ? cursor + page.length : null };
  };
  const readKey = async (key: string, context: RetrievalContext): Promise<BodyResult> => {
    let text: string;
    try {
      text = await withinContext(signal => withAccess(signal, active => active.kvGetText(key, { signal })), context);
    } catch (error) {
      if (error instanceof MeetingRetrievalError) throw error;
      assertAccess();
      const failed = classifyBodyFailure(error);
      enforceAccess(failed);
      return failed;
    }
    assertAccess();
    return decodeBody(text);
  };
  // TC-2189 stores renames on the note row as metadata.speaker_names (original label -> shown name); the stored sentences keep their original labels.
  // Read only that key, bounded in SQL, so the opaque metadata blob and the listing projection stay untouched.
  const withSpeakerNames = async (body: BodyResult, source: string, sourceId: string, context: RetrievalContext): Promise<BodyResult> => {
    if (body.state !== "present" || !Array.isArray(body.value)) return body;
    let row: unknown[] | undefined;
    try {
      [row] = await query(
        `SELECT CASE WHEN json_valid(metadata) THEN CASE WHEN json_type(metadata, '$.speaker_names') = 'object' AND length(CAST(json_extract(metadata, '$.speaker_names') AS BLOB)) <= ${SPEAKER_NAMES_MAX_BYTES} THEN json_extract(metadata, '$.speaker_names') END END FROM connector_meeting WHERE source = ? AND source_id = ? LIMIT 1`,
        [source, sourceId], context);
    } catch (error) {
      // The names are optional: if they cannot be read, the body keeps its stored labels. Access and cancellation errors still propagate.
      if (error instanceof MeetingRetrievalError && error.code === "transcript_unavailable") return body;
      throw error;
    }
    const names = parseSpeakerNames(row?.[0]);
    if (!names) return body;
    return { ...body, value: body.value.map(item => renameSpeakers(item, names)) };
  };
  const readBody = async (source: TranscriptMetadata["source"], sourceId: string, context: RetrievalContext = {}): Promise<BodyResult> => {
    if (!isSource(source) || !safeSegment(sourceId)) throw new MeetingRetrievalError("invalid_stored_metadata");
    assertAccess();
    if (source === FIREFLIES_MEETING_SOURCE && firefliesKvEnabled && options.readFirefliesPurgeLedger) {
      let hasSqlRow = false;
      try {
        const sqlRows = await query(
          "SELECT 1 FROM connector_meeting WHERE source = ? AND source_id = ? LIMIT 1",
          [FIREFLIES_MEETING_SOURCE, sourceId],
          context,
        );
        hasSqlRow = sqlRows.length > 0;
      } catch (error) {
        if (!(error instanceof MeetingRetrievalError && error.code === "transcript_unavailable")) throw error;
      }
      if (!hasSqlRow) {
        const ledger = await loadPurgeLedger();
        if (ledger.status === "fail_closed") return { state: "missing" };
        if (ledger.status === "ok") {
          const metaKey = firefliesMeetingKvKey(sourceId);
          let metaText: string;
          try {
            metaText = await withinContext(
              signal => withAccess(signal, active => active.kvGetText(metaKey, { signal })),
              context,
            );
          } catch (error) {
            if (error instanceof MeetingRetrievalError) throw error;
            enforceAccess(classifyBodyFailure(error));
            return { state: "missing" };
          }
          const parsed = await parseFirefliesKvMeetingRecord(metaText, sourceId, { maxBytes: maxFirefliesKvRecordBytes });
          if (!parsed.ok) return { state: "missing" };
          const item = {
            meetingId: sourceId,
            receivedAt: parsed.record.importedAt ?? parsed.record.startedAt ?? new Date(0).toISOString(),
            ...(parsed.record.startedAt ? { sourceTimestamp: parsed.record.startedAt } : {}),
          };
          if (isTombstoned(item, ledger.ledger)) return { state: "missing" };
        }
      }
    }
    if (source === VOICE_NOTE_SOURCE && await hasVoiceNoteIndex(context)) {
      const [commit] = await query(`SELECT outcome, hash, body_key FROM ${VOICE_NOTE_INDEX} WHERE source_id = ? LIMIT 1`, [sourceId], context);
      // The index names the one committed revision. No commit row, or any outcome other than transcribed, has no readable body.
      if (!commit) return { state: "missing" };
      const [outcome, hash, bodyKey] = commit;
      // The body key must be exactly the writer's key for this source id and hash, so the index cannot reach any other KV key.
      if (outcome !== "transcribed" || typeof hash !== "string" || !VOICE_NOTE_REV_HASH.test(hash)
        || bodyKey !== `${VOICE_NOTE_REV_PREFIX}${sourceId}/${hash}`) return { state: "missing" };
      return withSpeakerNames(await readKey(bodyKey, context), source, sourceId, context);
    }
    return withSpeakerNames(await readKey(`${SQL_PATH}/${source}/transcript/${sourceId}`, context), source, sourceId, context);
  };
  const loadPurgeLedger = async (): Promise<
    { status: "none" } | { status: "fail_closed" } | { status: "ok"; ledger: FirefliesPurgeLedger }
  > => {
    if (!options.readFirefliesPurgeLedger) return { status: "none" };
    let read: FirefliesPurgeLedgerRead;
    try {
      read = await options.readFirefliesPurgeLedger();
    } catch {
      return { status: "fail_closed" };
    }
    if (read.status === "unparseable") return { status: "fail_closed" };
    if (read.status === "ok") return { status: "ok", ledger: read.ledger };
    return { status: "none" };
  };
  const loadSqlFirefliesCollisions = async (
    context: RetrievalContext = {},
  ): Promise<{ sourceIds: Set<string>; meetingRefs: Set<string> }> => {
    const sourceIds = new Set<string>();
    const meetingRefs = new Set<string>();
    try {
      const rows = await query(
        `SELECT id, source_id FROM connector_meeting WHERE source = ? LIMIT ${METADATA_ROW_LIMIT}`,
        [FIREFLIES_MEETING_SOURCE],
        context,
      );
      for (const row of rows) {
        if (typeof row[0] === "string") meetingRefs.add(row[0]);
        if (typeof row[1] === "string") sourceIds.add(row[1]);
      }
    } catch (error) {
      if (!(error instanceof MeetingRetrievalError && error.code === "transcript_unavailable")) throw error;
    }
    return { sourceIds, meetingRefs };
  };
  const listFirefliesKvMetadata = async (
    sqlSourceIds: ReadonlySet<string>,
    sqlMeetingRefs: ReadonlySet<string>,
    context: RetrievalContext = {},
  ): Promise<{ rows: TranscriptMetadata[]; stats: FirefliesKvDiscoveryStats }> => {
    const stats = emptyFirefliesKvDiscoveryStats();
    if (!firefliesKvEnabled || typeof port.kvList !== "function") {
      return { rows: [], stats };
    }
    const ledgerState = await loadPurgeLedger();
    if (ledgerState.status === "fail_closed") {
      options.onFirefliesKvStats?.(stats);
      return { rows: [], stats };
    }
    let listed: { keys: string[]; truncated: boolean };
    try {
      listed = await withinContext(
        signal => withAccess(signal, active => active.kvList!(FIREFLIES_MEETING_KV_PREFIX, { limit: maxFirefliesKvRecords, signal })),
        context,
      );
    } catch (error) {
      if (error instanceof MeetingRetrievalError) throw error;
      enforceAccess(classifyBodyFailure(error));
      options.onFirefliesKvStats?.(stats);
      return { rows: [], stats };
    }
    const keys = listed.keys.slice(0, maxFirefliesKvRecords);
    stats.listed = keys.length;
    stats.truncated = listed.truncated || listed.keys.length > maxFirefliesKvRecords;

    const promoted: TranscriptMetadata[] = [];
    const seenRefs = new Set<string>();
    for (const key of keys) {
      const sourceId = extractFirefliesMeetingSourceId(key);
      if (!sourceId) {
        stats.garbled += 1;
        continue;
      }
      if (sqlSourceIds.has(sourceId)) {
        stats.shadowedBySql += 1;
        continue;
      }
      let text: string;
      try {
        text = await withinContext(
          signal => withAccess(signal, active => active.kvGetText(key, { signal })),
          context,
        );
      } catch (error) {
        if (error instanceof MeetingRetrievalError) throw error;
        const failed = classifyBodyFailure(error);
        enforceAccess(failed);
        if (failed.state === "missing") stats.missing += 1;
        else if (failed.state === "size_limit") stats.oversize += 1;
        else stats.garbled += 1;
        continue;
      }
      const parsed = await parseFirefliesKvMeetingRecord(text, sourceId, { maxBytes: maxFirefliesKvRecordBytes });
      if (!parsed.ok) {
        if (parsed.reason === "oversize") stats.oversize += 1;
        else stats.garbled += 1;
        continue;
      }
      const record = parsed.record;
      if (sqlMeetingRefs.has(record.id) || seenRefs.has(record.id)) {
        stats.shadowedBySql += 1;
        continue;
      }
      if (ledgerState.status === "ok") {
        const item = {
          meetingId: record.sourceId,
          receivedAt: record.importedAt ?? record.startedAt ?? new Date(0).toISOString(),
          ...(record.startedAt ? { sourceTimestamp: record.startedAt } : {}),
        };
        if (isTombstoned(item, ledgerState.ledger)) {
          stats.purged += 1;
          continue;
        }
      }
      seenRefs.add(record.id);
      promoted.push({
        meetingRef: record.id,
        source: FIREFLIES_MEETING_SOURCE,
        sourceId: record.sourceId,
        title: record.title,
        startedAt: record.startedAt,
        participantNames: record.participantNames,
        participantEmails: record.participantEmails,
        metadataLimited: record.participantsLimited,
        organizerEmail: record.organizerEmail,
        summaryOverview: record.summaryOverview,
        summaryActionItems: record.summaryActionItems,
        listingTruncated: false,
        metadata: { import_source: FIREFLIES_SERVER_IMPORT_TAG },
      });
      stats.promoted += 1;
    }
    options.onFirefliesKvStats?.(stats);
    return { rows: promoted, stats };
  };
  // Member keys come from every combined row, never from the page being listed: a source filter or
  // date window could otherwise return members whose combined row is outside the result.
  // If this read fails the list proceeds without exclusion: a duplicate is recoverable, a hidden meeting is not.
  // Access and cancellation errors still propagate.
  // Projections for combined-meetings.ts: combined-key rows are (source, NULL, metadata); listed rows follow LISTING_COLUMNS.
  const combinedColumns = (row: unknown[]) => ({ source: row[0], sourceId: row[1], metadata: row[2] });
  const listedColumns = (row: unknown[]) => ({ source: row[1], sourceId: row[2], metadata: row[9] });
  const combinedKeys = async (context: RetrievalContext = {}): Promise<Set<string>> => {
    try {
      const keys = new Set<string>();
      let cursor = 0;
      for (let pages = 0; pages < COMBINED_KEYS_MAX_PAGES; pages += 1) {
        const page = await queryPage(
          `source, NULL, ${COMBINED_KEYS_METADATA_PROJECTION}`,
          3,
          `source = ? AND (CASE WHEN json_valid(metadata) THEN (CASE WHEN json_type(metadata, '$.merge.members') = 'array' AND length(CAST(json(json_extract(metadata, '$.merge.members')) AS BLOB)) <= ${COMBINED_MEMBERS_MAX_BYTES} THEN 1 ELSE 0 END) ELSE 0 END) = 1`,
          [COMBINED_SOURCE], "id ASC", cursor, SQL_PAGE_MAX_ROWS, context);
        for (const key of combinedMemberKeys(page.rows, combinedColumns)) keys.add(key);
        if (page.cursor === null) return keys;
        if (page.cursor <= cursor) return keys;
        cursor = page.cursor;
      }
      return keys;
    } catch (error) {
      // Only the generic unavailable failure fails open; access, timeout and cancellation errors propagate.
      if (error instanceof MeetingRetrievalError && error.code === "transcript_unavailable") return new Set();
      throw error;
    }
  };
  // Drops unreadable combined rows and every capture named by a readable combined row.
  const visibleRows = (rows: unknown[][], hidden: ReadonlySet<string>): unknown[][] => rows.filter(row =>
    !(row[1] === COMBINED_SOURCE && readCombinedMembers(row[9]) === null) && !isCombinedMember(row, hidden, listedColumns));
  // The commit index is absent in spaces that never saved a voice note; recheck until found.
  let voiceNoteIndexFound = false;
  const hasVoiceNoteIndex = async (context: RetrievalContext = {}): Promise<boolean> => {
    if (!voiceNoteIndexFound) voiceNoteIndexFound = (await query("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?", [VOICE_NOTE_INDEX], context)).length > 0;
    return voiceNoteIndexFound;
  };
  // SQL prefilter: the metadata mirror, which is also the whole readable test when the commit index table is absent. Other sources are unaffected.
  const readableClause = (): string => `(source != '${VOICE_NOTE_SOURCE}' OR source IS NULL OR ${VOICE_NOTE_MIRROR_READABLE})`;
  // With the commit index present, a listed voice note must be one readBody can read: same predicate (transcribed outcome,
  // writer-shaped hash, writer's exact body key), so a mirror/commit disagreement never lists an unreadable note.
  // The index is queried only when the page holds a voice note, so other sources cost no extra round trip.
  const commitReadable = async (rows: unknown[][], context: RetrievalContext = {}): Promise<unknown[][]> => {
    const ids = rows.flatMap(row => row[1] === VOICE_NOTE_SOURCE && typeof row[2] === "string" ? [row[2]] : []);
    if (ids.length === 0 || !await hasVoiceNoteIndex(context)) return rows;
    // The node SQL parser has no GLOB/REGEXP, so the lowercase-hex shape of the hash is checked here, not in SQL.
    const committed = await query(
      `SELECT source_id, hash FROM ${VOICE_NOTE_INDEX} WHERE outcome = 'transcribed' AND length(hash) = 32 AND body_key = '${VOICE_NOTE_REV_PREFIX}' || source_id || '/' || hash AND source_id IN (${ids.map(() => "?").join(", ")})`,
      ids, context);
    const readable = new Set(committed.filter(row => typeof row[1] === "string" && /^[0-9a-f]{32}$/.test(row[1])).map(row => row[0]));
    return rows.filter(row => row[1] !== VOICE_NOTE_SOURCE || readable.has(row[2]));
  };
  return {
    assertAccess,
    async listMetadata() {
      const readable = readableClause();
      const order = "julianday(started_at) IS NULL ASC, julianday(started_at) DESC, id ASC";
      const rows: unknown[][] = [];
      let cursor = 0;
      let sqlUnavailable = false;
      try {
        while (rows.length < METADATA_ROW_LIMIT) {
          const pageRows = Math.min(SQL_PAGE_MAX_ROWS, METADATA_ROW_LIMIT - rows.length);
          const page = await queryPage(LISTING_COLUMNS, 12, readable, [], order, cursor, pageRows);
          rows.push(...page.rows);
          if (page.cursor === null) break;
          cursor = page.cursor;
        }
      } catch (error) {
        if (!firefliesKvEnabled || !(error instanceof MeetingRetrievalError && error.code === "transcript_unavailable")) {
          throw error;
        }
        sqlUnavailable = true;
      }
      logSkippedOversizedIds(rows.filter(row => row[11] === 1).length);
      const usableRows = rows.filter(row => row[11] !== 1);
      const hidden = sqlUnavailable ? new Set<string>() : await combinedKeys();
      const sqlMetadata = sqlUnavailable
        ? []
        : visibleRows(await commitReadable(usableRows), hidden).flatMap(row => {
            const decoded = decodeMetadata(row);
            return decoded ? [decoded] : [];
          });
      if (!firefliesKvEnabled) return sqlMetadata;
      const sqlSourceIds = new Set(
        sqlMetadata.filter(row => row.source === FIREFLIES_MEETING_SOURCE).map(row => row.sourceId),
      );
      const sqlMeetingRefs = new Set(sqlMetadata.map(row => row.meetingRef));
      const kv = await listFirefliesKvMetadata(sqlSourceIds, sqlMeetingRefs);
      const visibleKv = kv.rows.filter(
        row => !hidden.has(JSON.stringify([row.source, row.sourceId])),
      );
      if (visibleKv.length === 0) return sqlMetadata;
      return scopedRows([...sqlMetadata, ...visibleKv], {}, undefined, "newest");
    },
    async getMetadata(reference, context = {}) {
      if (!safeMeetingRef(reference)) throw new MeetingRetrievalError("invalid_args", 400);
      const readable = readableClause();
      let sqlUnavailable = false;
      let rows: unknown[][] = [];
      try {
        rows = await query(`SELECT ${COLUMNS} FROM connector_meeting WHERE id = ? AND ${readable} LIMIT 1`, [reference], context);
      } catch (error) {
        if (!firefliesKvEnabled || !(error instanceof MeetingRetrievalError && error.code === "transcript_unavailable")) {
          throw error;
        }
        sqlUnavailable = true;
      }
      const hidden = sqlUnavailable ? new Set<string>() : await combinedKeys(context);
      // Check identity even when a faulty upstream ignores its predicate.
      const sqlMatch = sqlUnavailable
        ? null
        : (visibleRows(await commitReadable(rows, context), hidden).map(decodeMetadata).find(row => row?.meetingRef === reference) ?? null);
      if (sqlMatch || !firefliesKvEnabled) return sqlMatch;
      const collisions = sqlUnavailable
        ? { sourceIds: new Set<string>(), meetingRefs: new Set<string>() }
        : await loadSqlFirefliesCollisions(context);
      const kv = await listFirefliesKvMetadata(collisions.sourceIds, collisions.meetingRefs, context);
      return kv.rows.find(
        row => row.meetingRef === reference && !hidden.has(JSON.stringify([row.source, row.sourceId])),
      ) ?? null;
    },
    async discoverMetadata(args, context = {}) {
      const clauses: string[] = []; const params: Array<string | number | null> = [];
      if (args.source) { clauses.push("source = ?"); params.push(args.source); }
      // Conservative UTC superset for every IANA offset, followed by exact local-day checks.
      if (args.from) { clauses.push("julianday(started_at) >= julianday(?)"); params.push(new Date(Date.parse(args.from) - 86_400_000).toISOString()); }
      if (args.to) { clauses.push("julianday(started_at) < julianday(?)"); params.push(new Date(Date.parse(args.to) + 2 * 86_400_000).toISOString()); }
      clauses.push(readableClause());
      const order = `julianday(started_at) IS NULL ASC, julianday(started_at) ${args.sort === "oldest" ? "ASC" : "DESC"}, id ASC`;
      const includeKv = firefliesKvEnabled && (args.source === undefined || args.source === FIREFLIES_MEETING_SOURCE);
      let sqlUnavailable = false;
      const hidden = await combinedKeys(context);
      const scanStart = args.cursor ?? 0;
      let scannedRows = 0;
      let skippedIds = 0;
      let cursor: number | null = scanStart;
      const decoded: TranscriptMetadata[] = [];
      const requestedCount = args.limit ?? 5;
      try {
        while (scannedRows < METADATA_DISCOVERY_SCAN_LIMIT && cursor !== null
          && scopedRows(decoded, args, context.timeZone, args.sort).length < requestedCount) {
          const visibleCount = scopedRows(decoded, args, context.timeZone, args.sort).length;
          const page = await queryPage(
            LISTING_COLUMNS, 12, clauses.join(" AND "), params, order, cursor,
            Math.min(requestedCount - visibleCount, SQL_PAGE_MAX_ROWS, METADATA_DISCOVERY_SCAN_LIMIT - scannedRows), context);
          scannedRows += page.rows.length;
          cursor = page.cursor;
          skippedIds += page.rows.filter(row => row[11] === 1).length;
          const usableRows = page.rows.filter(row => row[11] !== 1);
          const visible = visibleRows(await commitReadable(usableRows, context), hidden);
          for (const row of visible) {
            const value = decodeMetadata(row);
            if (value) decoded.push(value);
          }
        }
      } catch (error) {
        if (!includeKv || !(error instanceof MeetingRetrievalError && error.code === "transcript_unavailable")) {
          throw error;
        }
        sqlUnavailable = true;
        cursor = null;
      }
      logSkippedOversizedIds(skippedIds);
      let kvCount = 0;
      if (includeKv && scanStart === 0) {
        const collisions = sqlUnavailable
          ? { sourceIds: new Set<string>(), meetingRefs: new Set<string>() }
          : await loadSqlFirefliesCollisions(context);
        for (const row of decoded) {
          collisions.meetingRefs.add(row.meetingRef);
          if (row.source === FIREFLIES_MEETING_SOURCE) collisions.sourceIds.add(row.sourceId);
        }
        const kv = await listFirefliesKvMetadata(collisions.sourceIds, collisions.meetingRefs, context);
        const visibleKv = kv.rows.filter(
          row => !hidden.has(JSON.stringify([row.source, row.sourceId])),
        );
        decoded.push(...visibleKv);
        kvCount = visibleKv.length;
      }
      // Discovery fills the requested visible result count across byte-bounded SQL pages; callers may continue.
      const rawCount = cursor !== null || scanStart > 0 ? METADATA_ROW_LIMIT : scannedRows + kvCount;
      const result = discoveryResult(decoded, rawCount, args, context);
      return { ...result, discovery: { ...result.discovery, ...(cursor === null ? {} : { nextCursor: cursor }) } };
    },
    readBody,
    async getTranscript(source, sourceId) {
      const body = await readBody(source, sourceId);
      if (body.state === "missing" || body.state === "empty") return null;
      if (body.state !== "present") throw new MeetingRetrievalError(body.reasonCode ?? body.state);
      return body.value;
    },
  };
}

function isSource(value: unknown): value is TranscriptMetadata["source"] {
  return (TRANSCRIPT_SOURCES as readonly unknown[]).includes(value);
}

function safeSegment(value: string): boolean {
  return value.length > 0 && value.length <= 512 && !value.includes("/") && !value.includes("\\") && !value.includes("..");
}

function safeMeetingRef(value: string): boolean {
  return value.length > 0 && value.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(value) && !value.includes("..");
}

function parseParticipants(value: unknown): { names: string[]; emails: string[]; limited: boolean } {
  let parsed = value;
  if (typeof value === "string") {
    try { parsed = JSON.parse(value) as unknown; } catch { return { names: [], emails: [], limited: true }; }
  }
  if (!Array.isArray(parsed)) return { names: [], emails: [], limited: true };
  const names: string[] = [];
  const emails: string[] = [];
  for (const entry of parsed.slice(0, 100)) {
    if (!entry || typeof entry !== "object") continue;
    const participant = entry as { name?: unknown; email?: unknown; displayName?: unknown };
    const name = typeof participant.name === "string" ? participant.name : participant.displayName;
    if (typeof name === "string" && name.length <= 160) names.push(name);
    if (typeof participant.email === "string" && participant.email.length <= 254) emails.push(participant.email);
  }
  return { names: [...new Set(names)], emails: [...new Set(emails)], limited: parsed.length > 100 };
}
