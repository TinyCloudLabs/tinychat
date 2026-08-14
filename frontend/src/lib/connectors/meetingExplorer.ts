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
//    malformed payload all return `[]` / `null`. Nothing throws across the
//    module boundary, so a storage hiccup can never render an error page —
//    same posture as connectorStore.getConnection.
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

/** One row of the meetings list — identity plus what the list renders. */
export interface MeetingListItem {
  id: string;
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
 * Meetings stored for `source`, newest first. A failed read (including the
 * table not existing) is indistinguishable from "no meetings" on purpose.
 */
export async function listMeetings(
  tcw: TinyCloudWeb,
  source = "fireflies",
): Promise<MeetingListItem[]> {
  const res = await tolerate(() =>
    tcw.sql.db(CONNECTORS_SQL_DB_NAME).query(
      `SELECT id, source_id, title, started_at FROM connector_meeting
       WHERE source = ? ORDER BY started_at DESC`,
      [source],
    ),
  );
  if (!res || !res.ok) return [];
  const rows: unknown = res.data?.rows;
  if (!Array.isArray(rows)) return [];

  const meetings: MeetingListItem[] = [];
  for (const row of rows as unknown[][]) {
    if (!Array.isArray(row)) continue;
    const id = cellStr(row, 0);
    const sourceId = cellStr(row, 1);
    // A row with no identity cannot be opened — drop it rather than render it.
    if (!id || !sourceId) continue;
    meetings.push({
      id,
      sourceId,
      title: cellStr(row, 2),
      startedAt: cellStr(row, 3),
    });
  }
  return meetings;
}

/**
 * The transcript body for one meeting, or null when there is nothing readable.
 *
 * The store writes a JSON-stringified `FirefliesSentence[]`, but the KV client
 * hands back either the parsed array or the raw string depending on the stored
 * content-type — so both are accepted, and anything else is treated as absent.
 */
export async function readTranscriptSentences(
  tcw: TinyCloudWeb,
  sourceId: string,
  source = "fireflies",
): Promise<FirefliesSentence[] | null> {
  const res = await tolerate(() => tcw.kv.get(transcriptKvKey(source, sourceId)));
  if (!res || !res.ok) return null;

  let payload: unknown = res.data?.data;
  if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(payload)) return null;

  return payload.filter(
    (s): s is FirefliesSentence =>
      typeof s === "object"
      && s !== null
      && typeof (s as { text?: unknown }).text === "string",
  );
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
