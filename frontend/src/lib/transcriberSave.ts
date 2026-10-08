import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import {
  normalizeTranscriberTranscript,
  transcriberMeetingTitle,
  TRANSCRIBER_MEETING_SOURCE,
  transcriptKvKey,
  writeTranscriberMeeting,
} from "@tinyboilerplate/core";
import type { WrittenTranscriberMeeting } from "@tinyboilerplate/core";
import { listKnownSourceIds } from "./connectors/connectorStore";
import type { StoreResult } from "./connectors/connectorStore";
import { webConnectorPort } from "./connectors/connectorPort";
import { reportStorageError, reportStorageWriteSucceeded, storageSaveMessage } from "./storageStatus";
import type { TranscriberMeeting, TranscriberTranscript } from "./transcriberApi";
export { normalizeTranscriberTranscript, transcriberMeetingTitle, TRANSCRIBER_MEETING_SOURCE };

/** Human label for the explorer chip. */
export const TRANSCRIBER_MEETING_SOURCE_LABEL = "TinyCloud Transcriber";

/** Insert the row and body if absent; repair a missing body without replacing user edits. */
export async function saveTranscriberMeeting(
  tcw: TinyCloudWeb,
  meeting: TranscriberMeeting,
  transcript: TranscriberTranscript,
): Promise<StoreResult<WrittenTranscriberMeeting>> {
  const saved = await writeTranscriberMeeting(
    webConnectorPort(tcw), await normalizeTranscriberTranscript(meeting, transcript), { ensureSchema: true },
  );
  if (!saved.ok) {
    reportStorageError(saved);
    return { ok: false, error: { code: saved.code, message: storageSaveMessage(saved) ?? saved.message } };
  }
  if (saved.data.row === "inserted" || saved.data.body === "written") reportStorageWriteSucceeded();
  return { ok: true, data: saved.data };
}

/** The transcriber meeting ids already saved in this space. */
export async function listSavedTranscriberMeetingIds(tcw: TinyCloudWeb): Promise<StoreResult<string[]>> {
  const rows = await listKnownSourceIds(tcw, TRANSCRIBER_MEETING_SOURCE);
  if (!rows.ok) return rows;
  const complete: string[] = [];
  for (const id of rows.data) {
    try {
      const body = await tcw.kv.get(transcriptKvKey(TRANSCRIBER_MEETING_SOURCE, id));
      if (body.ok) complete.push(id);
      // Unknown reads remain incomplete. Save rechecks this key before writing,
      // so one unavailable body cannot block the other records or be overwritten.
    } catch { /* This recording is retried independently by the sync pass. */ }
  }
  return { ok: true, data: complete };
}
