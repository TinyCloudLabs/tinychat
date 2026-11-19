// Renames a recording. The stored shape and the rename plan are in recordingTitleMeta.ts; the write goes through
// the space write lane (writeRecordingTitle in voiceNotes/voiceNoteRows.ts).
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { CONNECTORS_SQL_DB_NAME } from "./connectors/connectorStore";
import { normalizeRecordingTitle, TITLE_USER_KEY } from "./recordingTitleMeta";
import { writeRecordingTitle } from "./voiceNotes/voiceNoteRows";

export type RenameResult = { ok: true; title: string | null } | { ok: false; error: Error };

/** Names the recording, or (an empty `raw`) returns it to its automatic title. */
export async function renameRecording(tcw: TinyCloudWeb, rowId: string, raw: string): Promise<RenameResult> {
  try {
    const result = await writeRecordingTitle(tcw, rowId, normalizeRecordingTitle(raw));
    if (!("title" in result)) {
      return { ok: false, error: new Error(result.status === "missing" ? "This recording is no longer in your space." : "This recording changed while you were renaming it. Try again.") };
    }
    return { ok: true, title: result.title };
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
