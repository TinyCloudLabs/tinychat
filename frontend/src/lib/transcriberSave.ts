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

/** Lets callers serialize each individual completeness read without holding
 *  the shared lane for the full list of saved recordings. */
export type TranscriberSpaceReadScheduler = <T>(read: () => Promise<T>) => Promise<T | null>;

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
export async function listSavedTranscriberMeetingIds(
  tcw: TinyCloudWeb,
  scheduleRead: TranscriberSpaceReadScheduler = (read) => read(),
  isCurrent: () => boolean = () => true,
): Promise<StoreResult<string[]>> {
  const rows = await scheduleRead(() => listKnownSourceIds(tcw, TRANSCRIBER_MEETING_SOURCE));
  if (rows === null) return { ok: true, data: [] };
  if (!rows.ok) return rows;
  const complete: string[] = [];
  for (const id of rows.data) {
    // Don't queue more old-account reads after the pass has been cancelled.
    if (!isCurrent()) break;
    try {
      const body = await scheduleRead(() => tcw.kv.get(transcriptKvKey(TRANSCRIBER_MEETING_SOURCE, id)));
      if (body === null || !isCurrent()) break;
      if (body.ok) complete.push(id);
      else console.debug("[transcriberSave] incomplete meeting", id, "kv-read-failed");
      // Unknown reads remain incomplete. Save rechecks this key before writing,
      // so one unavailable body cannot block the other records or be overwritten.
    } catch { console.debug("[transcriberSave] incomplete meeting", id, "kv-read-threw"); }
  }
  return { ok: true, data: complete };
}
