// Renames a recording. The stored shape and the helpers every title writer shares are in recordingTitleMeta.ts.
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { storageScopeFor, trackStorageWrites } from "@/lib/storageStatus";
import { autoMeetingTitle } from "@/lib/meetingTitle";
import { transcriptionModelLabel } from "@/lib/transcriptionModelLabel";
import { CONNECTORS_SQL_DB_NAME } from "./connectors/connectorStore";
import { hasUserTitle, normalizeRecordingTitle, TITLE_AUTO_VALUE_KEY, TITLE_USER_KEY } from "./recordingTitleMeta";

const VOICE_NOTE = "exo-voice-note";
const ATTEMPTS = 3;

function parseObject(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string") return {};
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch { return {}; }
}

/** The automatic title a row returns to when its name is cleared; null when none is known. */
function autoTitleOf(row: { source: string; startedAt: unknown; participants: unknown; metadata: Record<string, unknown> }): string | null {
  const m = row.metadata;
  if (row.source === VOICE_NOTE && m.transcription_outcome === "transcribed") {
    let names: unknown = [];
    try { names = JSON.parse(typeof row.participants === "string" ? row.participants : "[]"); } catch { /* no names */ }
    const recomputed = autoMeetingTitle({ startedAt: row.startedAt, modelLabel: transcriptionModelLabel(m.model),
      participantNames: Array.isArray(names) ? names.map((p) => (p as { name?: unknown } | null)?.name) : [] });
    if (recomputed) return recomputed;
  }
  for (const value of [m.title_auto, m[TITLE_AUTO_VALUE_KEY]]) if (typeof value === "string" && value) return value;
  return null;
}

export type RenameResult = { ok: true; title: string | null } | { ok: false; error: Error };

/**
 * Names the recording, or (an empty `raw`) returns it to its automatic title. Reads the row, then
 * writes only if it is unchanged since, so a sync landing in between is not overwritten.
 */
export async function renameRecording(tcw: TinyCloudWeb, rowId: string, raw: string): Promise<RenameResult> {
  const name = normalizeRecordingTitle(raw);
  const db = trackStorageWrites(tcw.sql.db(CONNECTORS_SQL_DB_NAME), storageScopeFor(tcw), { reportSuccessfulWrites: true });
  try {
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const read = await db.query(
        "SELECT title, metadata, updated_at, source, started_at, participants FROM connector_meeting WHERE id = ?", [rowId]);
      if (!read.ok) throw Object.assign(new Error(read.error?.message ?? "TinyCloud storage failed"), { code: read.error?.code });
      const row = (read.data.rows as unknown[][])[0];
      if (!row) return { ok: false, error: new Error("This recording is no longer in your space.") };
      const title = typeof row[0] === "string" ? row[0] : null;
      const metadata = parseObject(row[1]);
      const { [TITLE_USER_KEY]: _user, [TITLE_AUTO_VALUE_KEY]: _auto, ...rest } = metadata;
      let next: string | null;
      let nextMetadata: Record<string, unknown>;
      if (name) {
        const auto = hasUserTitle(metadata) ? metadata[TITLE_AUTO_VALUE_KEY] ?? null : title;
        next = name;
        nextMetadata = { ...rest, [TITLE_USER_KEY]: true, [TITLE_AUTO_VALUE_KEY]: auto };
      } else {
        if (!hasUserTitle(metadata)) return { ok: true, title };
        const auto = autoTitleOf({ source: String(row[3]), startedAt: row[4], participants: row[5], metadata });
        next = auto ?? title;
        // `title_auto` stays: an untranscribed note returns to that title, so its commit still names it.
        nextMetadata = rest;
      }
      const now = new Date().toISOString();
      const written = await db.execute(
        "UPDATE connector_meeting SET title = ?, metadata = ?, updated_at = ? WHERE id = ? AND updated_at = ?",
        [next, JSON.stringify(nextMetadata), now, rowId, row[2] as string]);
      if (!written.ok) throw Object.assign(new Error(written.error?.message ?? "TinyCloud storage failed"), { code: written.error?.code });
      if (Number((written.data as { changes?: number }).changes ?? 0) > 0) return { ok: true, title: next };
    }
    return { ok: false, error: new Error("This recording changed while you were renaming it. Try again.") };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
  }
}

/** The ids of the rows whose title the user typed. Read apart from the list, whose row shape is fixed. */
export async function readUserTitledIds(tcw: TinyCloudWeb): Promise<ReadonlySet<string>> {
  const db = tcw.sql.db(CONNECTORS_SQL_DB_NAME);
  const res = await db.query(`SELECT id FROM connector_meeting WHERE json_valid(metadata) AND json_extract(metadata, '$.${TITLE_USER_KEY}') = 1`, []);
  if (!res.ok) throw new Error(res.error?.message ?? "TinyCloud storage failed");
  return new Set((res.data.rows as unknown[][]).map((row) => String(row[0])));
}
