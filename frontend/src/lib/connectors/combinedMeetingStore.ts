// TC-1152 S2b: persistence for combined meetings (`source = 'exo-merged'`).
//
// A combined meeting is ONE `connector_meeting` row plus ONE transcript body:
//
//   SQL  connector_meeting  source = 'exo-merged', source_id = stitchedSourceId(member refs)
//   KV   {APP_ID}/connectors/exo-merged/transcript/{source_id}   [{index, speaker_name, text, start_time, end_time, sources}]
//
// INVARIANTS (the review checklist for this file)
//   I1  Nothing is ever written to a member row or member body. The combined row points at its
//       members by (source, source_id); members never point back. Member reads are SELECT / kv.get.
//   I2  Every SQL statement that changes data names `source = 'exo-merged'` in its WHERE/INSERT,
//       and every KV write/delete key is built by `mergedBodyKey()` from the exo-merged prefix only.
//   I3  `deleteCombined` throws, before any I/O, for any source other than exo-merged.
//   I4  Members are referenced by (source, source_id), never by row `id` (other clients may
//       re-create or de-duplicate member rows).
//   I5  Cascade and sweep delete only exo-merged data. The cascade fails closed: any error is
//       returned to the caller, which must abort the purge it was part of.
//   I6  Sequential node calls only (TinyCloud drops concurrent responses on one space).
//   I7  The summary step (3b) writes the two `summary_*` columns of one exo-merged row and nothing else,
//       and never writes `metadata` (the combine record is written once, by `writeCombined`).
//
// No local (browser) state lives here, so there is nothing to key by account (TC-1376).
//
// Sections: 1 guards and low-level I/O · 2 reading members · 3 WRITE · 3b SUMMARY · 4 DELETE · 5 CASCADE ·
// 6 SWEEP · 7 stale detection.
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import {
  CONNECTORS_KV_PREFIX,
  CONNECTORS_SQL_DB_NAME,
  EXO_MERGED_SOURCE,
  StitchInputError,
  stitchMeetings,
  transcriptKvKey,
  type MeetingSnapshot,
  type StitchResult,
} from "@tinyboilerplate/core";

import { readTranscriptCommit } from "../voiceNotes/voiceNoteCommits";
import type { StoreError, StoreResult } from "./connectorStore";

// ═══ 1. Guards and low-level I/O ═════════════════════════════════════════════════════════════

/** A member, referenced the only way that survives re-sync: (source, source_id). */
export interface MeetingRef {
  source: string;
  sourceId: string;
}

const MERGED_BODY_PREFIX = `${CONNECTORS_KV_PREFIX}/${EXO_MERGED_SOURCE}/transcript/`;

function failure(code: string, message: string, cause?: unknown): { ok: false; error: StoreError } {
  return { ok: false, error: { code, message, ...(cause === undefined ? {} : { cause }) } };
}

/** The ONLY builder of KV keys this module writes or deletes (I2). */
function mergedBodyKey(sourceId: string): string | null {
  // A source_id with a slash could address a different key under the same prefix.
  if (sourceId.length === 0 || sourceId.includes("/") || sourceId.includes("..")) return null;
  return `${MERGED_BODY_PREFIX}${sourceId}`;
}

type SqlOutcome = { ok: true; rows: unknown[][] } | { ok: false; error: StoreError };

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Reads a field off the SDK's Result envelope; every level may be missing on a bad response. */
function field(v: unknown, key: string): unknown {
  return isRecord(v) ? v[key] : undefined;
}

type SqlParam = string | number | null;

async function sql(tcw: TinyCloudWeb, method: "query" | "execute", statement: string, params: SqlParam[]): Promise<SqlOutcome> {
  try {
    const res: unknown = await tcw.sql.db(CONNECTORS_SQL_DB_NAME)[method](statement, params);
    if (field(res, "ok") !== true) {
      const code = field(field(res, "error"), "code");
      return failure(typeof code === "string" && code.length > 0 ? code : "SQL_ERROR", "connector store statement failed", field(res, "error"));
    }
    const rows = field(field(res, "data"), "rows");
    return { ok: true, rows: Array.isArray(rows) ? rows.filter(Array.isArray) : [] };
  } catch (e) {
    return failure("SQL_TRANSPORT", "connector store statement threw", e);
  }
}

type KvOutcome = { ok: true; data: unknown } | { ok: false; notFound: boolean; error: StoreError };

async function kv(call: () => Promise<unknown>): Promise<KvOutcome> {
  try {
    const res = await call();
    if (field(res, "ok") === true) return { ok: true, data: field(field(res, "data"), "data") };
    const raw = field(field(res, "error"), "code");
    const code = typeof raw === "string" ? raw : "KV_ERROR";
    // An un-hosted space also answers KV_NOT_FOUND ("Space not found"): the key's absence is not
    // established, so it is a failed read, never a settled "nothing stored".
    const message = field(field(res, "error"), "message");
    const spaceMissing = typeof message === "string" && /space not found/i.test(message);
    return { ok: false, notFound: /NOT_FOUND/i.test(code) && !spaceMissing, error: { code, message: "connector store kv call failed", cause: field(res, "error") } };
  } catch (e) {
    return { ok: false, notFound: false, error: { code: "KV_TRANSPORT", message: "connector store kv call threw", cause: e } };
  }
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

interface MergeMember extends MeetingRef {
  bodySha256: string | null;
}

/** `metadata.merge.members` of a combined row, or null when the row is not readable as one. */
function mergeMembers(rawMetadata: unknown): MergeMember[] | null {
  let meta = rawMetadata;
  if (typeof meta === "string") {
    try { meta = JSON.parse(meta); } catch { return null; }
  }
  const merge = isRecord(meta) ? meta.merge : null;
  const members = isRecord(merge) ? merge.members : null;
  if (!Array.isArray(members) || members.length === 0) return null;
  const out: MergeMember[] = [];
  for (const m of members) {
    if (!isRecord(m) || typeof m.source !== "string" || typeof m.source_id !== "string" || !m.source || !m.source_id) return null;
    out.push({ source: m.source, sourceId: m.source_id, bodySha256: typeof m.body_sha256 === "string" ? m.body_sha256 : null });
  }
  return out;
}

/**
 * Members of a combined row, or null when they cannot be determined. The union of the v1
 * `metadata.merge.members` record and every distinct (source, source_id) in the body's per-segment
 * `sources[]` (chosen or not: an unchosen source's text is carried in `alternate`), so a source that
 * only one of them names is still found. Either alone is enough; with neither (read failure,
 * unparseable body, a segment without `sources`, empty `members`) it is null, never a guess.
 */
async function membersOf(tcw: TinyCloudWeb, sourceId: string, rawMetadata: unknown): Promise<MeetingRef[] | null> {
  const seen = new Map<string, MeetingRef>();
  const add = (source: string, sid: string) => seen.set(`${source}\u0000${sid}`, { source, sourceId: sid });
  for (const m of mergeMembers(rawMetadata) ?? []) add(m.source, m.sourceId);
  const key = mergedBodyKey(sourceId);
  const res = key === null ? null : await kv(() => tcw.kv.get(key));
  if (res?.ok) {
    let body: unknown = res.data;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch { body = null; }
    }
    let valid = Array.isArray(body) && body.length > 0;
    const fromBody: [string, string][] = [];
    for (const seg of valid ? (body as unknown[]) : []) {
      const sources = isRecord(seg) ? seg.sources : null;
      if (!Array.isArray(sources) || sources.length === 0) { valid = false; break; }
      for (const s of sources) {
        if (!isRecord(s) || typeof s.source !== "string" || typeof s.source_id !== "string" || !s.source || !s.source_id) { valid = false; break; }
        fromBody.push([s.source, s.source_id]);
      }
      if (!valid) break;
    }
    if (valid) for (const [s, i] of fromBody) add(s, i);
  }
  return seen.size === 0 ? null : [...seen.values()];
}

// ═══ 2. Reading members (read-only, I1) ══════════════════════════════════════════════════════

/**
 * Same three-way answer as `TranscriptRead` in meetingExplorer.ts: `absent` is a settled "nothing
 * stored" (the sweep may act on it); `failed` is anything that did not land or cannot be trusted
 * (the sweep must not act on it). A body that landed but is not JSON is `failed` here, not
 * `absent` as in the explorer: deleting a combined meeting on ambiguous bytes is the wrong side.
 */
export type MemberBodyRead =
  | { status: "ok"; raw: string }
  | { status: "absent" }
  | { status: "failed" };

/** Voice-note members read the committed `transcript-rev/<id>/<hash>` body, not the legacy mirror. */
async function memberBodyKey(tcw: TinyCloudWeb, ref: MeetingRef): Promise<{ key: string } | { failed: true }> {
  if (ref.source !== "exo-voice-note") return { key: transcriptKvKey(ref.source, ref.sourceId) };
  try {
    const commit = await readTranscriptCommit(tcw, ref.sourceId);
    if (!commit) return { key: transcriptKvKey(ref.source, ref.sourceId) };
    // Mirrors retrieval.mjs voiceNoteBodyKey: a commit without a usable committed body is unverified
    // (the key would otherwise read "null", look absent, and get a combined meeting deleted).
    const prefix = `${CONNECTORS_KV_PREFIX}/exo-voice-note/transcript-rev/${ref.sourceId}/`;
    if (commit.outcome !== "transcribed" || !commit.bodyKey.startsWith(prefix) || !/^[a-f0-9]{32}$/.test(commit.bodyKey.slice(prefix.length))) return { failed: true };
    return { key: commit.bodyKey };
  } catch {
    return { failed: true };
  }
}

export async function readMemberBody(tcw: TinyCloudWeb, ref: MeetingRef): Promise<MemberBodyRead> {
  const target = await memberBodyKey(tcw, ref);
  if ("failed" in target) return { status: "failed" };
  const res = await kv(() => tcw.kv.get(target.key, { source: "network" }));
  if (!res.ok) return res.notFound ? { status: "absent" } : { status: "failed" };
  let raw: string;
  if (typeof res.data === "string") raw = res.data;
  else if (isRecord(res.data) || Array.isArray(res.data)) raw = JSON.stringify(res.data);
  else return { status: "failed" };
  try { JSON.parse(raw); } catch { return { status: "failed" }; }
  return { status: "ok", raw };
}

type SnapshotRead = { status: "ok"; snapshot: MeetingSnapshot } | { status: "absent" } | { status: "failed" };

async function readMemberSnapshot(tcw: TinyCloudWeb, ref: MeetingRef): Promise<SnapshotRead> {
  const rowRes = await sql(tcw, "query",
    "SELECT title, started_at, duration_secs, participants, metadata FROM connector_meeting WHERE source = ? AND source_id = ? ORDER BY id LIMIT 1",
    [ref.source, ref.sourceId]);
  if (!rowRes.ok) return { status: "failed" };
  const body = await readMemberBody(tcw, ref);
  if (body.status !== "ok") return { status: body.status };
  const r = rowRes.rows[0];
  if (r) {
    return { status: "ok", snapshot: { source: ref.source, source_id: ref.sourceId, body: body.raw,
      row: { title: asString(r[0]), started_at: asString(r[1]), duration_secs: typeof r[2] === "number" ? r[2] : null,
        participants: r[3], metadata: r[4] } } };
  }
  // No SQL row: a KV-only reconciled record (connectors/<source>/meeting/<id>) is also a member.
  const rec = await kv(() => tcw.kv.get(`${CONNECTORS_KV_PREFIX}/${ref.source}/meeting/${ref.sourceId}`));
  if (!rec.ok) return rec.notFound ? { status: "absent" } : { status: "failed" };
  let record = rec.data;
  if (typeof record === "string") {
    try { record = JSON.parse(record); } catch { return { status: "failed" }; }
  }
  if (!isRecord(record)) return { status: "failed" };
  return { status: "ok", snapshot: { source: ref.source, source_id: ref.sourceId, body: body.raw, kv_record: record } };
}

// ═══ 3. WRITE (combine; touches exo-merged data only) ════════════════════════════════════════

export interface CombineOptions {
  /** Write a pair the detector refused, recording `detection.passed = false`. */
  force?: boolean;
  /** Clock for `decided_at` and row timestamps (tests). */
  now?: () => Date;
}

export type CombineOutcome =
  | { status: "written"; id: string; sourceId: string; created: boolean; passed: boolean }
  | { status: "refused"; result: StitchResult };

const ID_SELECT = "SELECT id, metadata FROM connector_meeting WHERE source = 'exo-merged' AND source_id = ? ORDER BY id";

/**
 * Read both members, read-only (I1). The UI reads, stitches off the UI thread to show the evidence,
 * and only after an explicit tap calls `writeCombined`; `combineMeetings` is the same three steps in one call.
 */
export async function readCombinePair(tcw: TinyCloudWeb, memberA: MeetingRef, memberB: MeetingRef): Promise<StoreResult<readonly [MeetingSnapshot, MeetingSnapshot]>> {
  for (const m of [memberA, memberB]) {
    if (m.source === EXO_MERGED_SOURCE) return failure("COMBINE_MEMBER_INVALID", "a combined meeting cannot be a member");
  }
  // Sequential: row + body of A, then of B.
  const snaps: MeetingSnapshot[] = [];
  for (const m of [memberA, memberB]) {
    const read = await readMemberSnapshot(tcw, m);
    if (read.status === "absent") return failure("COMBINE_MEMBER_ABSENT", "a member meeting or its transcript is not stored");
    if (read.status === "failed") return failure("COMBINE_MEMBER_UNREADABLE", "a member meeting could not be read");
    snaps.push(read.snapshot);
  }
  return { ok: true, data: [snaps[0]!, snaps[1]!] };
}

export async function combineMeetings(
  tcw: TinyCloudWeb,
  memberA: MeetingRef,
  memberB: MeetingRef,
  options: CombineOptions = {},
): Promise<StoreResult<CombineOutcome>> {
  const pair = await readCombinePair(tcw, memberA, memberB);
  if (!pair.ok) return pair;
  const snaps = pair.data;
  let result: StitchResult;
  try {
    result = stitchMeetings(snaps[0]!, snaps[1]!, { force: options.force === true });
  } catch (e) {
    if (e instanceof StitchInputError) return failure("COMBINE_INPUT_INVALID", e.message);
    throw e;
  }
  // A refused pair writes nothing unless the caller forced it.
  if (result.combined === null) return { ok: true, data: { status: "refused", result } };
  return writeCombined(tcw, result, options);
}

/** Write a stitched pair (`result.combined` non-null: a passing pair, or one stitched with `force`). */
export async function writeCombined(
  tcw: TinyCloudWeb,
  result: StitchResult,
  options: Pick<CombineOptions, "now"> = {},
): Promise<StoreResult<Extract<CombineOutcome, { status: "written" }>>> {
  if (result.combined === null) return failure("COMBINE_NOTHING_TO_WRITE", "the pair was refused and not forced");
  const now = (options.now ?? (() => new Date()))().toISOString();
  const { row, body } = result.combined;
  const sourceId = row.source_id;
  const bodyKey = mergedBodyKey(sourceId);
  if (bodyKey === null) return failure("COMBINE_ID_INVALID", "combined source id is not a valid key segment");
  const metadata = JSON.stringify({ ...row.metadata, merge: { ...row.metadata.merge, decided_at: now } });
  const participants = JSON.stringify(row.participants);

  // Body first: a row must never be visible without its body. A failed row write below leaves only
  // an overwritable body at a deterministic key.
  const put = await kv(() => tcw.kv.put(bodyKey, JSON.stringify(body)));
  if (!put.ok) return { ok: false, error: put.error };

  // Select-before-insert. No unique key exists besides `id`, so a concurrent writer with another
  // id can still produce a duplicate; the MIN(id) collapse below resolves it (voiceNoteRows.ts).
  const before = await sql(tcw, "query", ID_SELECT, [sourceId]);
  if (!before.ok) return before;
  let created = false;
  if (before.rows.length === 0) {
    const ins = await sql(tcw, "execute",
      `INSERT INTO connector_meeting
        (id, source, source_id, title, started_at, duration_secs, organizer_email,
         participants, summary_overview, summary_action_items, keywords, meeting_type,
         metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, EXO_MERGED_SOURCE, sourceId, row.title, row.started_at, row.duration_secs, null, participants, null, null, null, null, metadata, now, now]);
    // A lost race on the primary key is not a failure: the winner's row is re-read below.
    created = ins.ok;
    if (!ins.ok) {
      const retry = await sql(tcw, "query", ID_SELECT, [sourceId]);
      if (!retry.ok || retry.rows.length === 0) return ins;
    }
  }
  const after = await sql(tcw, "query", ID_SELECT, [sourceId]);
  if (!after.ok) return after;
  const ids = after.rows.map((r) => String(r[0]));
  const keeper = ids[0];
  if (keeper === undefined) return failure("COMBINE_ROW_MISSING", "combined row not found after write");
  // A re-combine (or a collapse onto another writer's row) replaces the keeper's content in place,
  // but the user data beside the record — renamed speakers — belongs to the row, not to this merge.
  let keeperMeta: unknown = after.rows[0]?.[1];
  if (typeof keeperMeta === "string") {
    try { keeperMeta = JSON.parse(keeperMeta); } catch { keeperMeta = null; }
  }
  const keptNames = isRecord(keeperMeta) ? keeperMeta.speaker_names : undefined;
  const updateMetadata = keptNames === undefined ? metadata
    : JSON.stringify({ ...row.metadata, speaker_names: keptNames, merge: { ...row.metadata.merge, decided_at: now } });
  for (const extra of ids.slice(1)) {
    const del = await sql(tcw, "execute", "DELETE FROM connector_meeting WHERE id = ? AND source = 'exo-merged'", [extra]);
    if (!del.ok) return del;
  }
  // Summary columns are untouched (section 3b owns them); created_at is preserved.
  if (!created || keeper !== row.id) {
    const upd = await sql(tcw, "execute",
      "UPDATE connector_meeting SET title = ?, started_at = ?, duration_secs = ?, participants = ?, metadata = ?, updated_at = ? WHERE id = ? AND source = 'exo-merged'",
      [row.title, row.started_at, row.duration_secs, participants, updateMetadata, now, keeper]);
    if (!upd.ok) return upd;
  }
  return { ok: true, data: { status: "written", id: keeper, sourceId, created: created && keeper === row.id, passed: row.metadata.merge.detection.passed } };
}

// ═══ 3b. SUMMARY (the two summary columns of one combined row, I7) ══════════════════════════

export interface CombinedSummaryRead {
  sourceId: string;
  overview: string | null;
  actionItems: string | null;
}

/** The row's summary columns and its source_id; null when there is no such combined row. Reads no metadata. */
export async function readCombinedSummary(tcw: TinyCloudWeb, id: string): Promise<StoreResult<CombinedSummaryRead | null>> {
  const res = await sql(tcw, "query", "SELECT source_id, summary_overview, summary_action_items FROM connector_meeting WHERE id = ? AND source = 'exo-merged'", [id]);
  if (!res.ok) return res;
  const row = res.rows[0];
  const sourceId = row === undefined ? null : asString(row[0]);
  if (row === undefined || sourceId === null) return { ok: true, data: null };
  return { ok: true, data: { sourceId, overview: asString(row[1]), actionItems: asString(row[2]) } };
}

/** The stored body of a combined meeting (a JSON string or parsed value, as the space returns it). */
export async function readCombinedBody(tcw: TinyCloudWeb, sourceId: string): Promise<StoreResult<unknown>> {
  const key = mergedBodyKey(sourceId);
  if (key === null) return failure("COMBINE_ID_INVALID", "combined source id is not a valid key segment");
  const res = await kv(() => tcw.kv.get(key));
  return res.ok ? { ok: true, data: res.data } : { ok: false, error: res.error };
}

/**
 * ONE UPDATE of `summary_overview` and `summary_action_items` on one exo-merged row. No other column
 * (not `metadata`, not `updated_at`) is touched. `null`s clear a summary that no longer matches the text.
 */
export async function writeCombinedSummary(
  tcw: TinyCloudWeb,
  id: string,
  summary: { overview: string | null; actionItems: string | null },
): Promise<StoreResult<void>> {
  const res = await sql(tcw, "execute",
    "UPDATE connector_meeting SET summary_overview = ?, summary_action_items = ? WHERE id = ? AND source = 'exo-merged'",
    [summary.overview, summary.actionItems, id]);
  return res.ok ? { ok: true, data: undefined } : res;
}

// ═══ 4. DELETE (exo-merged only, I2/I3) ══════════════════════════════════════════════════════

/**
 * Delete one combined meeting by row id. THROWS for any source other than exo-merged, before a
 * single SQL or KV call. The SQL names exo-merged again and the body key comes from the exo-merged
 * prefix, so a wrong `source` can never reach an original even if the first guard is removed.
 */
export async function deleteCombined(tcw: TinyCloudWeb, source: string, id: string): Promise<StoreResult<{ deleted: boolean }>> {
  if (source !== EXO_MERGED_SOURCE) {
    throw new Error(`deleteCombined refuses source "${source}": only ${EXO_MERGED_SOURCE} meetings can be deleted here`);
  }
  const found = await sql(tcw, "query", "SELECT source_id FROM connector_meeting WHERE id = ? AND source = 'exo-merged'", [id]);
  if (!found.ok) return found;
  const sourceId = asString(found.rows[0]?.[0]);
  if (sourceId === null) return { ok: true, data: { deleted: false } };
  // Another exo-merged row with the same source_id shares this body; only the last one removes it.
  const siblings = await sql(tcw, "query", ID_SELECT, [sourceId]);
  if (!siblings.ok) return siblings;
  const others = siblings.rows.filter((r) => String(r[0]) !== id);
  const removed = await removeMerged(tcw, others.length === 0 ? sourceId : null, [id]);
  if (!removed.ok) return removed;
  return { ok: true, data: { deleted: true } };
}

/**
 * Body first (a retry still finds the row), then the rows. `bodySourceId = null` keeps the body. A
 * source_id that is not a valid key segment has no body this module could have written (the writer
 * refuses it), so only the row is deleted: one malformed row must not block a purge forever.
 */
async function removeMerged(tcw: TinyCloudWeb, bodySourceId: string | null, rowIds: string[]): Promise<StoreResult<void>> {
  const key = bodySourceId === null ? null : mergedBodyKey(bodySourceId);
  if (key !== null) {
    const del = await kv(() => tcw.kv.delete(key));
    if (!del.ok && !del.notFound) return { ok: false, error: del.error };
  }
  for (const rowId of rowIds) {
    const del = await sql(tcw, "execute", "DELETE FROM connector_meeting WHERE id = ? AND source = 'exo-merged'", [rowId]);
    if (!del.ok) return del;
  }
  return { ok: true, data: undefined };
}

// ═══ 5. CASCADE (an original is deleted or purged -> every combined meeting listing it goes) ═

/**
 * Delete every exo-merged meeting that lists a member from `source` (and, when given, that exact
 * `sourceId`). Members come from `metadata.merge.members` (v1) or, failing that, the body's
 * `sources[]`. FAIL CLOSED two ways:
 *   - any error is returned and the caller MUST abort its own deletion;
 *   - a row whose members cannot be determined is NEVER deleted on a guess (it may list an unrelated
 *     member): its id is returned in `unverifiedIds`. The caller decides: `purgeConnector` fails the
 *     purge (the row might quote the purged source), the read-time sweep just reports it.
 */
export async function deleteCombinedReferencing(
  tcw: TinyCloudWeb,
  source: string,
  sourceId?: string,
): Promise<StoreResult<{ deletedIds: string[]; unverifiedIds: string[] }>> {
  const rows = await sql(tcw, "query", "SELECT id, source_id, metadata FROM connector_meeting WHERE source = 'exo-merged'", []);
  if (!rows.ok) return rows;
  const hits: { id: string; sourceId: string }[] = [];
  const unverifiedIds: string[] = [];
  for (const r of rows.rows) {
    const id = asString(r[0]);
    const sid = asString(r[1]);
    if (id === null || sid === null) continue;
    const members = await membersOf(tcw, sid, r[2]);
    if (members === null) unverifiedIds.push(id);
    else if (members.some((m) => m.source === source && (sourceId === undefined || m.sourceId === sourceId))) hits.push({ id, sourceId: sid });
  }
  // One body per source_id (duplicates share it), then every matching row.
  const bodies = new Set(hits.map((h) => h.sourceId));
  for (const sid of bodies) {
    const removed = await removeMerged(tcw, sid, hits.filter((h) => h.sourceId === sid).map((h) => h.id));
    if (!removed.ok) return removed;
  }
  return { ok: true, data: { deletedIds: hits.map((h) => h.id), unverifiedIds } };
}

// ═══ 6. SWEEP (read-time repair for deletes made outside this client) ════════════════════════

export type SweepOutcome =
  | { status: "kept" }
  /** At least one member read did not land: nothing was deleted. */
  | { status: "unverified" }
  | { status: "deleted" };

/**
 * When a caller already has a member read, act on it: `absent` deletes every combined meeting that
 * lists the member; `failed` and `ok` delete nothing. The two missing-states are distinct on purpose.
 */
export async function sweepOnMemberRead(
  tcw: TinyCloudWeb,
  member: MeetingRef,
  read: { status: "ok" | "absent" | "failed" },
): Promise<StoreResult<SweepOutcome>> {
  if (read.status === "failed") return { ok: true, data: { status: "unverified" } };
  if (read.status === "ok") return { ok: true, data: { status: "kept" } };
  const cascade = await deleteCombinedReferencing(tcw, member.source, member.sourceId);
  if (!cascade.ok) return cascade;
  const { deletedIds, unverifiedIds } = cascade.data;
  return { ok: true, data: { status: deletedIds.length > 0 ? "deleted" : unverifiedIds.length > 0 ? "unverified" : "kept" } };
}

/** Read every member of one combined meeting; delete it if any member is `absent`. */
export async function sweepCombinedMeeting(tcw: TinyCloudWeb, id: string): Promise<StoreResult<SweepOutcome>> {
  const found = await sql(tcw, "query", "SELECT source_id, metadata FROM connector_meeting WHERE id = ? AND source = 'exo-merged'", [id]);
  if (!found.ok) return found;
  if (found.rows.length === 0) return { ok: true, data: { status: "kept" } };
  const members = await membersOf(tcw, String(found.rows[0]![0]), found.rows[0]![1]);
  if (members === null) return { ok: true, data: { status: "unverified" } };
  let unverified = false;
  for (const m of members) {
    const read = await readMemberBody(tcw, m);
    if (read.status === "absent") {
      const del = await deleteCombined(tcw, EXO_MERGED_SOURCE, id);
      if (!del.ok) return del;
      return { ok: true, data: { status: "deleted" } };
    }
    if (read.status === "failed") unverified = true;
  }
  return { ok: true, data: { status: unverified ? "unverified" : "kept" } };
}

// ═══ 7. Stale detection ══════════════════════════════════════════════════════════════════════

export interface MemberDrift extends MeetingRef {
  state: "changed" | "absent" | "unknown";
}

/**
 * Members whose body no longer hashes to the `body_sha256` recorded at combine time. A UI can show
 * "a source changed · Re-combine"; re-combining the same pair keeps the same id (combineMeetings).
 */
export async function staleMembers(tcw: TinyCloudWeb, id: string): Promise<StoreResult<MemberDrift[]>> {
  const found = await sql(tcw, "query", "SELECT source_id, metadata FROM connector_meeting WHERE id = ? AND source = 'exo-merged'", [id]);
  if (!found.ok) return found;
  const metadata = found.rows[0]?.[1];
  const members = mergeMembers(metadata);
  if (members === null) return failure("COMBINED_METADATA_INVALID", "combined meeting has no readable merge record");
  const drift: MemberDrift[] = [];
  for (const m of members) {
    const read = await readMemberBody(tcw, m);
    if (read.status === "absent") drift.push({ source: m.source, sourceId: m.sourceId, state: "absent" });
    else if (read.status === "failed") drift.push({ source: m.source, sourceId: m.sourceId, state: "unknown" });
    else if ((await sha256Hex(read.raw)) !== m.bodySha256) drift.push({ source: m.source, sourceId: m.sourceId, state: "changed" });
  }
  return { ok: true, data: drift };
}
