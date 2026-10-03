// Voice notes in the user's own TinyCloud space, stored the way every other
// capture source is: one `connector_meeting` row (SQL) plus bodies in KV under
// the granted `connectors/` prefix. No new manifest permission is needed, and
// a voice note is a Library item like any meeting.
//
//   SQL  connector_meeting  source = "exo-voice-note", source_id = recording id
//   KV   {APP_ID}/connectors/exo-voice-note/audio/{id}       → JSON { mimeType, base64 }
//   KV   {APP_ID}/connectors/exo-voice-note/transcript/{id}  → FirefliesSentence[]
//
// The transcript key (transcriptKvKey) is written empty with the note and
// filled when private cloud transcription lands (saveVoiceNoteTranscript);
// the Library and the meeting chat corpus read it like any other.

import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import type { FirefliesSentence } from "../connectors/firefliesClient";
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

/** Where a note's transcript stands, from its row's metadata. */
export interface VoiceNoteTranscriptState {
  status: "none" | "transcribed" | "no_speech";
  /** The start of the transcript text, for the card; the full text is in Library. */
  preview: string | null;
}

export interface VoiceNoteListItem {
  id: string;
  sourceId: string;
  title: string | null;
  startedAt: string | null;
  durationSecs: number | null;
  transcript: VoiceNoteTranscriptState;
}

const TRANSCRIPT_PREVIEW_CHARS = 280;

/** Reads the transcript fields saveVoiceNoteTranscript writes; anything else is "none". */
export function voiceNoteTranscriptState(metadata: unknown): VoiceNoteTranscriptState {
  let parsed = metadata;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed) as unknown;
    } catch {
      parsed = null;
    }
  }
  if (!parsed || typeof parsed !== "object") return { status: "none", preview: null };
  const m = parsed as Record<string, unknown>;
  if (m.transcription_outcome === "no_speech") return { status: "no_speech", preview: null };
  if (typeof m.transcript_text === "string" && m.transcript_text.trim().length > 0) {
    const text = m.transcript_text.trim();
    return {
      status: "transcribed",
      preview: text.length > TRANSCRIPT_PREVIEW_CHARS ? `${text.slice(0, TRANSCRIPT_PREVIEW_CHARS).trimEnd()}…` : text,
    };
  }
  return { status: "none", preview: null };
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
    `SELECT id, source_id, title, started_at, duration_secs, metadata FROM connector_meeting
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
      transcript: voiceNoteTranscriptState(row[5]),
    });
  }
  return { ok: true, data: notes };
}

/** What a transcription adds to a note: the sentences for its transcript key and row metadata. */
export interface VoiceNoteTranscriptSave {
  /** Empty when no speech was found: the transcript key stays `[]`. */
  sentences: FirefliesSentence[];
  /** Merged into the row's metadata (engine, provider, model, transcript_text, ...). */
  metadata: Record<string, unknown>;
  /** Speakers named in the sentences, as the row's participants. */
  speakers: string[];
}

/**
 * Write a transcription onto an EXISTING note: the sentences go to the note's
 * transcript key (`transcriptKvKey("exo-voice-note", id)`) and the metadata is
 * merged into its row through upsertMeeting, which keeps the title, start time
 * and duration because they are passed as null. Refuses (rather than create a
 * row with no audio behind it) when the note is gone.
 */
export async function saveVoiceNoteTranscript(
  tcw: TinyCloudWeb,
  sourceId: string,
  transcript: VoiceNoteTranscriptSave,
): Promise<StoreResult<UpsertMeetingOutcome>> {
  const schema = await ensureSchema(tcw);
  if (!schema.ok) return schema;
  const existing = await tcw.sql.db(CONNECTORS_SQL_DB_NAME).query(
    `SELECT id FROM connector_meeting WHERE source = ? AND source_id = ? LIMIT 1`,
    [VOICE_NOTE_SOURCE, sourceId],
  );
  if (!existing.ok) {
    return { ok: false, error: { code: existing.error.code ?? "STORE_ERROR", message: `saveVoiceNoteTranscript: ${existing.error.message}` } };
  }
  if (existing.data.rows.length === 0) {
    return { ok: false, error: { code: "VOICE_NOTE_NOT_FOUND", message: "saveVoiceNoteTranscript: the voice note no longer exists" } };
  }
  return upsertMeeting(
    tcw,
    {
      id: crypto.randomUUID(),
      source: VOICE_NOTE_SOURCE,
      sourceId,
      title: null,
      startedAt: null,
      durationSecs: null,
      organizerEmail: null,
      participants: transcript.speakers.map((name) => ({ name, email: null })),
      summaryOverview: null,
      summaryActionItems: null,
      keywords: null,
      meetingType: null,
      metadata: transcript.metadata,
    },
    transcript.sentences,
  );
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
