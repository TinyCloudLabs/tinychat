// Read-only catalog and immutable published-artifact reads under Library grants.
// UI callers receive explicit unavailable states; diagnostics can use listMeetings.

import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { CONNECTORS_SQL_DB_NAME, snapshotKvKey, publicationSha256 } from "./connectorStore";
import type { FirefliesSentence } from "./firefliesClient";
import { GMEET_MEETING_SOURCE } from "./gmeetNormalize";
import {
  TRANSCRIBER_MEETING_SOURCE,
  TRANSCRIBER_MEETING_SOURCE_LABEL,
} from "../transcriberSave";
import { CONNECTORS } from "./registry";

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
  GMEET_MEETING_SOURCE,
  TRANSCRIBER_MEETING_SOURCE,
];

/**
 * Human label for a `source` column value — the registry's connector name, so
 * the per-row chip can never drift from what Settings calls the same
 * connector. An unknown source falls back to its raw string rather than
 * rendering blank.
 */
export function meetingSourceLabel(source: string): string {
  if (source === TRANSCRIBER_MEETING_SOURCE) return TRANSCRIBER_MEETING_SOURCE_LABEL;
  return CONNECTORS.find((c) => c.source === source)?.name ?? source;
}

/** One row of the meetings list — identity plus what the list renders. */
export interface MeetingListItem {
  id: string;
  /** `connector_meeting.source` — half of the transcript's KV identity. */
  source: string;
  sourceId: string;
  title: string | null;
  startedAt: string | null;
  revision: string | null;
  readiness: "published" | "unverified" | "unavailable";
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
 * Meetings stored for `sources`, newest first ACROSS the whole set — one query,
 * one merged list, ordered by `started_at` over the union rather than grouped
 * by connector. A failed read (including the table not existing) is
 * indistinguishable from "no meetings" on purpose.
 *
 * An empty `sources` runs no query at all: `source IN ()` is not valid SQL, and
 * "browse nothing" already has an answer.
 */
export type MeetingListRead = { status: "ok"; meetings: MeetingListItem[] } | { status: "unavailable" };

export async function listMeetingsResult(
  tcw: TinyCloudWeb,
  sources: readonly string[] = EXPLORER_MEETING_SOURCES,
): Promise<MeetingListRead> {
  if (sources.length === 0) return { status: "ok", meetings: [] };
  const placeholders = sources.map(() => "?").join(", ");
  const res = await tolerate(() =>
    tcw.sql.db(CONNECTORS_SQL_DB_NAME).query(
      `SELECT id, source, source_id, title, started_at, head_revision, publication_state FROM connector_meeting
       WHERE source IN (${placeholders}) AND (publication_state IS NULL OR publication_state != 'deleted') ORDER BY started_at DESC`,
      [...sources],
    ),
  );
  if (!res || !res.ok) {
    if (res && !res.ok && /no such table/i.test(res.error.message ?? "")) return { status: "ok", meetings: [] };
    return { status: "unavailable" };
  }
  const rows: unknown = res.data?.rows;
  if (!Array.isArray(rows)) return { status: "unavailable" };

  const meetings: MeetingListItem[] = [];
  for (const row of rows as unknown[][]) {
    if (!Array.isArray(row)) continue;
    const id = cellStr(row, 0);
    const source = cellStr(row, 1);
    const sourceId = cellStr(row, 2);
    // A row with no identity cannot be opened — the transcript key is
    // (source, source_id), so a row missing either half is unreadable. Drop it
    // rather than render a row that can only ever fail to expand.
    if (!id || !source || !sourceId) continue;
    meetings.push({
      id,
      source,
      sourceId,
      title: cellStr(row, 3),
      startedAt: cellStr(row, 4),
      revision: cellStr(row, 5),
      readiness: cellStr(row, 5) ? "published" : cellStr(row, 6) === "unavailable" ? "unavailable" : "unverified",
    });
  }
  return { status: "ok", meetings };
}

/** Tolerant count/diagnostic adapter; user-facing lists use listMeetingsResult. */
export async function listMeetings(tcw: TinyCloudWeb, sources: readonly string[] = EXPLORER_MEETING_SOURCES): Promise<MeetingListItem[]> {
  const result = await listMeetingsResult(tcw, sources);
  return result.status === "ok" ? result.meetings : [];
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
  | { status: "ok"; sentences: FirefliesSentence[]; revision: string; basis: "transcript" | "notes"; overview: string | null }
  /** The read landed; there is nothing readable stored under this key. */
  | { status: "absent" }
  /** The read itself did not land (transport, auth, unknown store error). */
  | { status: "failed" };

/** Result-shaped error codes come back as strings; anything else reads as unknown. */
function errorCode(res: unknown): string {
  const err = (res as { error?: { code?: unknown } } | null)?.error;
  return typeof err?.code === "string" ? err.code : "";
}

/** Verify exact immutable snapshot bytes and live catalog identity before display. */
export async function readTranscript(
  tcw: TinyCloudWeb,
  source: string,
  sourceId: string,
  requestedRevision?: string | null,
): Promise<TranscriptRead> {
  try {
    const head = await tcw.sql.db(CONNECTORS_SQL_DB_NAME).query(
      "SELECT id, head_revision, head_snapshot_key, publication_state FROM connector_meeting WHERE source = ? AND source_id = ?",
      [source, sourceId]);
    if (!head.ok) return { status: "failed" };
    if (head.data.rows.length !== 1) return { status: head.data.rows.length === 0 ? "absent" : "failed" };
    const [id, currentRevision, , state] = head.data.rows[0] as unknown as unknown[];
    if (state === "deleted") return { status: "absent" };
    const revision = requestedRevision ?? currentRevision;
    if (typeof revision !== "string" || !/^[a-f0-9]{64}$/.test(revision)) return { status: "absent" };
    const membership = async (): Promise<"ok" | "absent" | "failed"> => {
      const result = await tcw.sql.db(CONNECTORS_SQL_DB_NAME).query(
        "SELECT s.revision FROM connector_publication_snapshot s JOIN connector_meeting m ON m.id = s.meeting_id WHERE s.revision = ? AND s.meeting_id = ? AND s.staged = 1 AND s.published = 1 AND m.source = ? AND m.source_id = ? AND m.publication_state IN ('published','reserved')",
        [revision, id as string, source, sourceId]);
      if (!result.ok) return "failed";
      const rows = result.data.rows as unknown as unknown[][];
      return rows.length === 1 && rows[0]?.[0] === revision ? "ok" : "absent";
    };
    const admitted = await membership();
    if (admitted !== "ok") return { status: admitted };
    const result = await tcw.kv.get(snapshotKvKey(source, sourceId, revision), { raw: true });
    if (!result.ok) return /NOT_FOUND/i.test(errorCode(result)) ? { status: "absent" } : { status: "failed" };
    const raw = result.data.data;
    if (typeof raw !== "string" || new TextEncoder().encode(raw).byteLength > 2_097_152
      || await publicationSha256(raw) !== revision) return { status: "failed" };
    const snapshot = JSON.parse(raw);
    if (snapshot.contractVersion !== 3 || snapshot.meetingRef !== id || snapshot.source !== source || snapshot.sourceId !== sourceId) return { status: "failed" };
    const body = snapshot.body;
    if (!body) return { status: "absent" };
    if (typeof body.raw !== "string" || !["transcript", "notes"].includes(body.basis)
      || new TextEncoder().encode(body.raw).byteLength !== body.original?.byteLength
      || body.original.byteLength > 1_048_576 || await publicationSha256(body.raw) !== body.original.digest) return { status: "failed" };
    let records: Array<Record<string, unknown>>;
    if (body.schema === "text") records = [{ text: body.raw }];
    else if (body.schema === "json-records") {
      const parsed: unknown = JSON.parse(body.raw);
      if (!Array.isArray(parsed) || parsed.some((item) => !item || typeof item !== "object" || typeof item.text !== "string")) return { status: "failed" };
      records = parsed;
    } else if (body.schema === "google-docs" && body.basis === "notes") {
      const doc = JSON.parse(body.raw);
      records = [];
      const visit = (value: unknown): void => {
        if (!value || typeof value !== "object") return;
        if (Array.isArray(value)) { for (const child of value) visit(child); return; }
        const item = value as Record<string, unknown>;
        if (item.textRun && typeof item.textRun === "object" && typeof (item.textRun as { content?: unknown }).content === "string") {
          records.push({ text: (item.textRun as { content: string }).content }); return;
        }
        for (const child of Object.values(item)) visit(child);
      };
      visit(doc);
    } else return { status: "failed" };
    const originMs = Date.parse(snapshot.metadata?.startedAt ?? "");
    const seconds = (value: unknown): number => typeof value === "number" && Number.isFinite(value) ? value
      : typeof value === "string" && Number.isFinite(originMs) && Number.isFinite(Date.parse(value)) ? (Date.parse(value) - originMs) / 1000 : 0;
    const names = snapshot.metadata?.metadata?.participantNamesByResource ?? {};
    const sentences = records.map((record, index) => ({ index, text: record.text as string,
      speaker_name: typeof record.speaker_name === "string" ? record.speaker_name
        : typeof record.participant === "string" && typeof names[record.participant] === "string" ? names[record.participant] : null,
      start_time: seconds(record.start_time ?? record.start ?? record.startTime),
      end_time: seconds(record.end_time ?? record.end ?? record.endTime) }));
    const stillAdmitted = await membership();
    if (stillAdmitted !== "ok") return { status: stillAdmitted };
    return { status: "ok", sentences, revision, basis: body.basis, overview: snapshot.overview?.text ?? null };
  } catch { return { status: "failed" }; }
}

/**
 * The raw transcript as the user copies it: one speaker-attributed line per
 * sentence. Deliberately unlike `meetingsView.transcriptText`, which drops
 * speakers — a pasted transcript without "who said it" is far less useful.
 */
export function transcriptCopyText(sentences: FirefliesSentence[]): string {
  return sentences
    .map((s) => (s.speaker_name ? `${s.speaker_name}: ${s.text}` : s.text))
    .join("\n");
}
