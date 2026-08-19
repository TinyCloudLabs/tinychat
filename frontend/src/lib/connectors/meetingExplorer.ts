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
//    space, so these never Promise.all over sql/kv calls.
//
//  - Paths come from connectorStore (CONNECTORS_SQL_DB_NAME, transcriptKvKey).
//    The session is authorized against the full `${APP_ID}/connectors` string;
//    a hand-built db name or key fails AUTH_UNAUTHORIZED.

import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { CONNECTORS_SQL_DB_NAME, transcriptKvKey } from "./connectorStore";
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
export async function listMeetings(
  tcw: TinyCloudWeb,
  sources: readonly string[] = EXPLORER_MEETING_SOURCES,
): Promise<MeetingListItem[]> {
  if (sources.length === 0) return [];
  const placeholders = sources.map(() => "?").join(", ");
  const res = await tolerate(() =>
    tcw.sql.db(CONNECTORS_SQL_DB_NAME).query(
      `SELECT id, source, source_id, title, started_at FROM connector_meeting
       WHERE source IN (${placeholders}) ORDER BY started_at DESC`,
      [...sources],
    ),
  );
  if (!res || !res.ok) return [];
  const rows: unknown = res.data?.rows;
  if (!Array.isArray(rows)) return [];

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
    });
  }
  return meetings;
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
): Promise<TranscriptRead> {
  const res = await tolerate(() => tcw.kv.get(transcriptKvKey(source, sourceId)));
  if (!res) return { status: "failed" };
  if (!res.ok) {
    // A missing key is the ordinary "no transcript stored" answer; every other
    // error (auth, transport, store) is a miss worth retrying.
    return /NOT_FOUND/i.test(errorCode(res))
      ? { status: "absent" }
      : { status: "failed" };
  }

  let payload: unknown = res.data?.data;
  if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload);
    } catch {
      return { status: "absent" };
    }
  }
  if (!Array.isArray(payload)) return { status: "absent" };

  return {
    status: "ok",
    sentences: payload.filter(
      (s): s is FirefliesSentence =>
        typeof s === "object"
        && s !== null
        && typeof (s as { text?: unknown }).text === "string",
    ),
  };
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
