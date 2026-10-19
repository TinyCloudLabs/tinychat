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
//
// No local (browser) state lives here, so there is nothing to key by account (TC-1376).
//
// Sections: 1 guards and low-level I/O · 2 reading members · 3 WRITE · 4 DELETE · 5 CASCADE ·
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
    return { ok: false, notFound: /NOT_FOUND/i.test(code), error: { code, message: "connector store kv call failed", cause: field(res, "error") } };
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
  if (!Array.isArray(members)) return null;
  const out: MergeMember[] = [];
  for (const m of members) {
    if (!isRecord(m) || typeof m.source !== "string" || typeof m.source_id !== "string" || !m.source || !m.source_id) return null;
    out.push({ source: m.source, sourceId: m.source_id, bodySha256: typeof m.body_sha256 === "string" ? m.body_sha256 : null });
  }
  return out;
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
    // A note with no commit record predates the commit format; its legacy key is its only body.
    return { key: commit ? commit.bodyKey : transcriptKvKey(ref.source, ref.sourceId) };
  } catch {
    return { failed: true };
  }
}

export async function readMemberBody(tcw: TinyCloudWeb, ref: MeetingRef): Promise<MemberBodyRead> {
  const target = await memberBodyKey(tcw, ref);
  if ("failed" in target) return { status: "failed" };
  const res = await kv(() => tcw.kv.get(target.key));
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

const ID_SELECT = "SELECT id FROM connector_meeting WHERE source = 'exo-merged' AND source_id = ? ORDER BY id";

export async function combineMeetings(
  tcw: TinyCloudWeb,
  memberA: MeetingRef,
  memberB: MeetingRef,
  options: CombineOptions = {},
): Promise<StoreResult<CombineOutcome>> {
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

  let result: StitchResult;
  try {
    result = stitchMeetings(snaps[0]!, snaps[1]!, { force: options.force === true });
  } catch (e) {
    if (e instanceof StitchInputError) return failure("COMBINE_INPUT_INVALID", e.message);
    throw e;
  }
  // A refused pair writes nothing unless the caller forced it.
  if (result.combined === null) return { ok: true, data: { status: "refused", result } };

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
  for (const extra of ids.slice(1)) {
    const del = await sql(tcw, "execute", "DELETE FROM connector_meeting WHERE id = ? AND source = 'exo-merged'", [extra]);
    if (!del.ok) return del;
  }
  // Re-combine, or a collapse onto another writer's row: replace the keeper's content in place.
  // Summary columns are untouched (a later summary step owns them); created_at is preserved.
  if (!created || keeper !== row.id) {
    const upd = await sql(tcw, "execute",
      "UPDATE connector_meeting SET title = ?, started_at = ?, duration_secs = ?, participants = ?, metadata = ?, updated_at = ? WHERE id = ? AND source = 'exo-merged'",
      [row.title, row.started_at, row.duration_secs, participants, metadata, now, keeper]);
    if (!upd.ok) return upd;
  }
  return { ok: true, data: { status: "written", id: keeper, sourceId, created: created && keeper === row.id, passed: row.metadata.merge.detection.passed } };
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

/** Body first (a retry still finds the row), then the rows. `bodySourceId = null` keeps the body. */
async function removeMerged(tcw: TinyCloudWeb, bodySourceId: string | null, rowIds: string[]): Promise<StoreResult<void>> {
  if (bodySourceId !== null) {
    const key = mergedBodyKey(bodySourceId);
    if (key === null) return failure("COMBINED_ID_INVALID", "combined source id is not a valid key segment");
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
 * `sourceId`). FAIL CLOSED: any error is returned and the caller MUST abort its own deletion, so
 * a combined meeting quoting an original's text is never left behind.
 *
 * An exo-merged row whose metadata cannot be read as a merge record has no knowable members. It is
 * derived data of unknown provenance, so it is deleted rather than kept.
 */
export async function deleteCombinedReferencing(
  tcw: TinyCloudWeb,
  source: string,
  sourceId?: string,
): Promise<StoreResult<{ deletedIds: string[] }>> {
  const rows = await sql(tcw, "query", "SELECT id, source_id, metadata FROM connector_meeting WHERE source = 'exo-merged'", []);
  if (!rows.ok) return rows;
  const hits: { id: string; sourceId: string }[] = [];
  for (const r of rows.rows) {
    const id = asString(r[0]);
    const sid = asString(r[1]);
    if (id === null || sid === null) continue;
    const members = mergeMembers(r[2]);
    const lists = members === null || members.some((m) => m.source === source && (sourceId === undefined || m.sourceId === sourceId));
    if (lists) hits.push({ id, sourceId: sid });
  }
  // One body per source_id (duplicates share it), then every matching row.
  const bodies = new Set(hits.map((h) => h.sourceId));
  for (const sid of bodies) {
    const removed = await removeMerged(tcw, sid, hits.filter((h) => h.sourceId === sid).map((h) => h.id));
    if (!removed.ok) return removed;
  }
  return { ok: true, data: { deletedIds: hits.map((h) => h.id) } };
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
  return { ok: true, data: { status: cascade.data.deletedIds.length > 0 ? "deleted" : "kept" } };
}

/** Read every member of one combined meeting; delete it if any member is `absent`. */
export async function sweepCombinedMeeting(tcw: TinyCloudWeb, id: string): Promise<StoreResult<SweepOutcome>> {
  const found = await sql(tcw, "query", "SELECT source_id, metadata FROM connector_meeting WHERE id = ? AND source = 'exo-merged'", [id]);
  if (!found.ok) return found;
  if (found.rows.length === 0) return { ok: true, data: { status: "kept" } };
  const members = mergeMembers(found.rows[0]![1]);
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
