import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import {
  archiveKvKey,
  connectorMeetingId,
  CONNECTORS_SQL_DB_NAME,
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
import { reportStorageError, reportStorageWriteSucceeded, storageScopeFor, storageSaveMessage } from "./storageStatus";
import { captureEvents } from "../capture/captureEvents";
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
    reportStorageError(saved, storageScopeFor(tcw));
    return { ok: false, error: { code: saved.code, message: storageSaveMessage(saved) ?? saved.message } };
  }
  if (saved.data.row === "inserted" || saved.data.body === "written") reportStorageWriteSucceeded(storageScopeFor(tcw));
  return { ok: true, data: saved.data };
}

/** Saved IDs separated from rows whose saved-body completeness is unknown. */
export async function listSavedTranscriberMeetingIds(
  tcw: TinyCloudWeb,
  scheduleRead: TranscriberSpaceReadScheduler = (read) => read(),
  isCurrent: () => boolean = () => true,
): Promise<StoreResult<{ saved: string[]; unknown: string[] }>> {
  const rows = await scheduleRead(() => listKnownSourceIds(tcw, TRANSCRIBER_MEETING_SOURCE));
  if (rows === null) return { ok: true, data: { saved: [], unknown: [] } };
  if (!rows.ok) return rows;
  const saved: string[] = [];
  const unknown: string[] = [];
  for (const id of rows.data) {
    // Don't queue more old-account reads after the pass has been cancelled.
    if (!isCurrent()) break;
    try {
      const body = await scheduleRead(() => tcw.kv.get(transcriptKvKey(TRANSCRIBER_MEETING_SOURCE, id)));
      if (body === null || !isCurrent()) break;
      if (body.ok) saved.push(id);
      else {
        unknown.push(id);
        console.debug("[transcriberSave] incomplete meeting", id, "kv-read-failed");
      }
      // Unknown reads remain incomplete. Save rechecks this key before writing,
      // so one unavailable body cannot block the other records or be overwritten.
    } catch {
      unknown.push(id);
      console.debug("[transcriberSave] incomplete meeting", id, "kv-read-threw");
    }
  }
  return { ok: true, data: { saved, unknown } };
}

/** Read only publication numbers: full metadata also contains transcript text. */
export async function listSavedTranscriberVersions(
  tcw: TinyCloudWeb,
  scheduleRead: TranscriberSpaceReadScheduler = (read) => read(),
): Promise<StoreResult<Map<string, number>>> {
  try {
    const result = await scheduleRead(() => tcw.sql.db(CONNECTORS_SQL_DB_NAME).query(
      "SELECT source_id, json_extract(metadata, '$.ptx_transcript_version') FROM connector_meeting WHERE source = ?",
      [TRANSCRIBER_MEETING_SOURCE],
    ));
    if (result === null) return { ok: true, data: new Map() };
    if (!result.ok) return storageFailure(result.error, tcw);
    const rows = result.data.rows as unknown[][];
    return { ok: true, data: new Map(rows.map((row) => [String(row[0]), row[1] == null ? 1 : Number(row[1])])) };
  } catch { return storageFailure({ code: "SQL_ERROR" }, tcw); }
}

function storageFailure(error: { code?: string }, tcw: TinyCloudWeb): StoreResult<never> {
  reportStorageError(error, storageScopeFor(tcw));
  return { ok: false, error: { code: error.code ?? "STORE_ERROR", message: "Transcriber storage operation failed" } };
}

interface TranscriberArchive {
  version: number;
  archived_at: string;
  row: { title: string | null; participants: string | null; duration_secs: number | null; metadata: string };
  body: string;
}

/** The row's publication number commits the refresh; the archive survives retries unchanged. */
export async function refreshTranscriberMeeting(
  tcw: TinyCloudWeb,
  row: TranscriberMeeting,
  transcript: TranscriberTranscript,
  fetchTranscript: () => Promise<TranscriberTranscript | null>,
): Promise<StoreResult<void>> {
  // An old ptx image (or malformed publication number) must never replace a saved copy.
  if (!Number.isInteger(transcript.version)) return { ok: true, data: undefined };
  try {
    const id = await connectorMeetingId(TRANSCRIBER_MEETING_SOURCE, row.id);
    const db = tcw.sql.db(CONNECTORS_SQL_DB_NAME);
    const current = await db.query(
      "SELECT id, title, participants, duration_secs, metadata FROM connector_meeting WHERE id = ?", [id],
    );
    if (!current.ok) return storageFailure(current.error, tcw);
    const old = (current.data.rows as unknown[][])[0];
    if (!old) {
      const saved = await saveTranscriberMeeting(tcw, row, transcript);
      return saved.ok ? { ok: true, data: undefined } : saved;
    }
    const metadata = JSON.parse(old[4] as string || "{}") as Record<string, unknown>;
    const oldVersion = Number.isInteger(metadata.ptx_transcript_version) ? metadata.ptx_transcript_version as number : 1;
    if (transcript.version! <= oldVersion) return { ok: true, data: undefined };
    const oldBody = await tcw.kv.get(transcriptKvKey(TRANSCRIBER_MEETING_SOURCE, row.id));
    if (!oldBody.ok) return storageFailure(oldBody.error, tcw);
    const archive: TranscriberArchive = {
      version: oldVersion, archived_at: new Date().toISOString(),
      row: { title: old[1] as string | null, participants: old[2] as string | null,
        duration_secs: old[3] as number | null, metadata: old[4] as string },
      body: oldBody.data.data as string,
    };
    const archived = await tcw.kv.put(archiveKvKey(row.id, oldVersion), JSON.stringify(archive), { ifNoneMatch: "*" });
    if (!archived.ok && archived.error.code !== "KV_PRECONDITION_FAILED") return storageFailure(archived.error, tcw);
    const normalized = await normalizeTranscriberTranscript(row, transcript);
    const body = await tcw.kv.put(transcriptKvKey(TRANSCRIBER_MEETING_SOURCE, row.id), normalized.body);
    if (!body.ok) return storageFailure(body.error, tcw);
    // Transcriber metadata is publication-owned; user edits live in separate columns.
    const updated = await db.execute(
      "UPDATE connector_meeting SET participants = ?, duration_secs = ?, metadata = ?, updated_at = ? WHERE id = ? AND COALESCE(json_extract(metadata, '$.ptx_transcript_version'), 1) = ?",
      [JSON.stringify(normalized.meeting.participants), normalized.meeting.durationSecs, JSON.stringify({
        ...normalized.meeting.metadata,
        ptx_transcript_version: transcript.version,
        previous_transcript_versions: [...(metadata.previous_transcript_versions as number[] ?? []), oldVersion],
      }), new Date().toISOString(), id, oldVersion],
    );
    if (!updated.ok) return storageFailure(updated.error, tcw);
    const committed = await db.query(
      "SELECT COALESCE(json_extract(metadata, '$.ptx_transcript_version'), 1) FROM connector_meeting WHERE id = ?", [id],
    );
    if (!committed.ok) return storageFailure(committed.error, tcw);
    const vNow = Number((committed.data.rows as unknown[][])[0]?.[0]);
    if (vNow !== transcript.version) {
      if (vNow >= transcript.version!) {
        const latest = await fetchTranscript();
        if (latest?.version === vNow) {
          const repaired = await normalizeTranscriberTranscript(row, latest);
          const repair = await tcw.kv.put(transcriptKvKey(TRANSCRIBER_MEETING_SOURCE, row.id), repaired.body);
          if (!repair.ok) return storageFailure(repair.error, tcw);
        }
      }
      return { ok: true, data: undefined };
    }
    reportStorageWriteSucceeded(storageScopeFor(tcw));
    captureEvents.emit("library-changed", { source: TRANSCRIBER_MEETING_SOURCE, sourceId: row.id });
    return { ok: true, data: undefined };
  } catch { return storageFailure({ code: "STORE_ERROR" }, tcw); }
}
