// Voice notes in the user's own TinyCloud space, stored the way every other
// capture source is: one `connector_meeting` row (SQL) plus bodies in KV under
// the granted `connectors/` prefix. No new manifest permission is needed, and
// a voice note is a Library item like any meeting.
//
//   SQL  connector_meeting  source = "exo-voice-note", source_id = recording id
//   KV   {APP_ID}/connectors/exo-voice-note/audio/{id}  → JSON { mimeType, base64 }
//
// The transcript key (transcriptKvKey) is written empty until transcription
// lands; the Library and the meeting chat corpus read it like any other.

import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import {
  CONNECTORS_KV_PREFIX,
  CONNECTORS_SQL_DB_NAME,
  ensureSchema,
  upsertMeeting,
  type StoreResult,
  type UpsertMeetingOutcome,
} from "../connectors/connectorStore";
import type { VoiceNoteRecording } from "./nativeVoiceNotes";

/** `connector_meeting.source` for every voice note. */
export const VOICE_NOTE_SOURCE = "exo-voice-note";

/** Human label for the Library chip. */
export const VOICE_NOTE_SOURCE_LABEL = "Voice note";

export function voiceNoteAudioKvKey(id: string): string {
  return `${CONNECTORS_KV_PREFIX}/${VOICE_NOTE_SOURCE}/audio/${id}`;
}

export function voiceNoteTitle(startedAt: number): string {
  const when = new Date(startedAt);
  return `Voice note · ${when.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })}`;
}

export interface VoiceNoteAudio {
  mimeType: string;
  base64: string;
}

export interface VoiceNoteListItem {
  id: string;
  sourceId: string;
  title: string | null;
  startedAt: string | null;
  durationSecs: number | null;
}

/** Audio first, then the row: a listed note always has audio behind it. */
export async function saveVoiceNote(
  tcw: TinyCloudWeb,
  recording: VoiceNoteRecording,
  audio: VoiceNoteAudio,
  platform: string,
): Promise<StoreResult<UpsertMeetingOutcome>> {
  const put = await tcw.kv.put(voiceNoteAudioKvKey(recording.id), JSON.stringify(audio));
  if (!put.ok) {
    return { ok: false, error: { code: put.error.code ?? "STORE_ERROR", message: `saveVoiceNote(audio): ${put.error.message}` } };
  }
  return upsertMeeting(
    tcw,
    {
      id: crypto.randomUUID(),
      source: VOICE_NOTE_SOURCE,
      sourceId: recording.id,
      title: voiceNoteTitle(recording.startedAt),
      startedAt: new Date(recording.startedAt).toISOString(),
      durationSecs: Math.round(recording.durationMs / 1000),
      organizerEmail: null,
      participants: [],
      summaryOverview: null,
      summaryActionItems: null,
      keywords: null,
      meetingType: null,
      metadata: {
        audio_kv_key: voiceNoteAudioKvKey(recording.id),
        audio_mime_type: audio.mimeType,
        audio_bytes: recording.sizeBytes,
        capture: {
          platform,
          duration_ms: recording.durationMs,
          silenced_ms: recording.silencedMs,
          silenced_events: recording.silencedEvents,
          no_signal_ms: recording.noSignalMs,
        },
      },
    },
    [],
  );
}

/** Newest first. A space with no connectors db yet reads as empty. */
export async function listVoiceNotes(tcw: TinyCloudWeb, limit = 20): Promise<StoreResult<VoiceNoteListItem[]>> {
  const schema = await ensureSchema(tcw);
  if (!schema.ok) return schema;
  const res = await tcw.sql.db(CONNECTORS_SQL_DB_NAME).query(
    `SELECT id, source_id, title, started_at, duration_secs FROM connector_meeting
     WHERE source = ? ORDER BY started_at DESC LIMIT ?`,
    [VOICE_NOTE_SOURCE, limit],
  );
  if (!res.ok) {
    return { ok: false, error: { code: res.error.code ?? "STORE_ERROR", message: `listVoiceNotes: ${res.error.message}` } };
  }
  // Dedup is app-level (the authorizer forbids UNIQUE): one note per recording id, even if a
  // racing save ever wrote a second row.
  const seen = new Set<string>();
  const notes: VoiceNoteListItem[] = [];
  for (const row of res.data.rows) {
    const sourceId = String(row[1]);
    if (seen.has(sourceId)) continue;
    seen.add(sourceId);
    notes.push({
      id: String(row[0]),
      sourceId,
      title: typeof row[2] === "string" ? row[2] : null,
      startedAt: typeof row[3] === "string" ? row[3] : null,
      durationSecs: typeof row[4] === "number" ? row[4] : null,
    });
  }
  return { ok: true, data: notes };
}

export async function loadVoiceNoteAudio(tcw: TinyCloudWeb, sourceId: string): Promise<StoreResult<VoiceNoteAudio>> {
  const res = await tcw.kv.get(voiceNoteAudioKvKey(sourceId));
  if (!res.ok) {
    return { ok: false, error: { code: res.error.code ?? "STORE_ERROR", message: `loadVoiceNoteAudio: ${res.error.message}` } };
  }
  const raw = res.data.data;
  const parsed = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
  if (
    !parsed || typeof parsed !== "object"
    || typeof (parsed as VoiceNoteAudio).mimeType !== "string"
    || typeof (parsed as VoiceNoteAudio).base64 !== "string"
  ) {
    return { ok: false, error: { code: "STORE_CORRUPT_AUDIO", message: "loadVoiceNoteAudio: stored audio is malformed" } };
  }
  return { ok: true, data: parsed as VoiceNoteAudio };
}
