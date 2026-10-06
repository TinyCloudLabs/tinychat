// Voice notes in the user's own TinyCloud space, stored the way every other
// capture source is: one `connector_meeting` row (SQL) plus bodies in KV under
// the granted `connectors/` prefix. No new manifest permission is needed, and
// a voice note is a Library item like any meeting.
//
//   SQL  connector_meeting  source = "exo-voice-note", source_id = recording id
//   KV   {APP_ID}/connectors/exo-voice-note/audio/{id}/p/000000  raw audio, part 0 (≤ 1 MiB)
//   KV   {APP_ID}/connectors/exo-voice-note/audio/{id}/p/000001  part 1, ...
//   KV   {APP_ID}/connectors/exo-voice-note/audio/{id}/manifest  JSON, written LAST
//   KV   {APP_ID}/connectors/exo-voice-note/transcript/{id}      FirefliesSentence[]
//
// Notes saved before TC-517 hold their audio as ONE value at
// `{APP_ID}/connectors/exo-voice-note/audio/{id}` (JSON { mimeType, base64 });
// they are still read (manifest first, then that value) but never written.
//
// Why parts: the node itself accepts up to 1 GB per KV put, but the ingress in
// front of the production node refuses request bodies over 1 MiB, so the old
// single base64 value failed for any note over about 750 KB of audio (~1.5
// minutes). Parts, manifest, resume and read checks are the shared audio
// store's (lib/audio/audioStore.ts), the same one uploaded meeting audio uses.
//
// The transcript key (transcriptKvKey) is written empty with the note and
// filled when private cloud transcription lands (saveVoiceNoteTranscript);
// the Library and the meeting chat corpus read it like any other.

import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import {
  AUDIO_CORRUPT,
  AUDIO_SOURCE_READ_FAILED,
  AUDIO_STORAGE_FULL,
  AUDIO_TOO_LARGE,
  AudioStoreError,
  audioManifestKey,
  audioPartKey,
  getAudio,
  putAudio,
  type AudioPartSource,
  type StoredAudioManifest,
} from "../audio/audioStore";
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
import { base64ToBytes, bytesToBase64 } from "./voiceNoteAudio";

/** `connector_meeting.source` for every voice note. */
export const VOICE_NOTE_SOURCE = "exo-voice-note";

/** Human label for the Library chip. */
export const VOICE_NOTE_SOURCE_LABEL = "Voice note";

/**
 * The note's audio base key: its parts are under `${base}/p/`, its manifest at
 * `${base}/manifest`. A note saved before TC-517 holds its whole audio AT this key.
 */
export function voiceNoteAudioKvKey(id: string): string {
  return `${CONNECTORS_KV_PREFIX}/${VOICE_NOTE_SOURCE}/audio/${id}`;
}

export function voiceNoteAudioPartKey(id: string, index: number): string {
  return audioPartKey(voiceNoteAudioKvKey(id), index);
}

export function voiceNoteAudioManifestKey(id: string): string {
  return audioManifestKey(voiceNoteAudioKvKey(id));
}

/**
 * The note's audio, read one part at a time (on the phone, from the native
 * recorder through readAudioChunk), so the whole file never sits in one string.
 */
export interface VoiceNoteAudioSource extends AudioPartSource {
  mimeType: string;
  readPart(offset: number, length: number): Promise<Uint8Array>;
}

/** A source over audio already in memory as base64. */
export function voiceNoteAudioSourceFromBase64(audio: VoiceNoteAudio): VoiceNoteAudioSource {
  const bytes = base64ToBytes(audio.base64);
  return {
    mimeType: audio.mimeType,
    size: bytes.byteLength,
    readPart: async (offset, length) => bytes.slice(offset, offset + length),
  };
}

export interface StoreAudioOptions {
  partSize?: number;
  onProgress?: (storedBytes: number, totalBytes: number) => void;
  /** Injected in tests. */
  retryDelaysMs?: readonly number[];
}

/** Storage error codes the voice notes UI tells apart. */
export const VOICE_NOTE_STORAGE_FULL = AUDIO_STORAGE_FULL;
export const VOICE_NOTE_AUDIO_TOO_LARGE = "VOICE_NOTE_AUDIO_TOO_LARGE";
export const VOICE_NOTE_AUDIO_CORRUPT = AUDIO_CORRUPT;

type StoreFailure = { ok: false; error: { code: string; message: string } };

/** A shared audio store rejection as this module's Result, in the codes the UI shows. */
function audioFailure(op: string, err: unknown): StoreFailure {
  if (!(err instanceof AudioStoreError)) {
    return { ok: false, error: { code: "STORE_ERROR", message: `${op}: ${err instanceof Error ? err.message : String(err)}` } };
  }
  switch (err.code) {
    case AUDIO_STORAGE_FULL:
      return { ok: false, error: { code: VOICE_NOTE_STORAGE_FULL, message: `${op}: your TinyCloud storage is full` } };
    case AUDIO_SOURCE_READ_FAILED:
      return { ok: false, error: { code: "VOICE_NOTE_SOURCE_READ_FAILED", message: `${op}: ${err.message}` } };
    case AUDIO_TOO_LARGE:
      return { ok: false, error: { code: VOICE_NOTE_AUDIO_TOO_LARGE, message: `${op}: ${err.message}` } };
    default:
      return { ok: false, error: { code: err.code, message: `${op}: ${err.message}` } };
  }
}

/**
 * Store a note's audio with the shared audio store: raw parts of at most 1 MiB,
 * then its manifest (last, so a manifest always means a complete file). Saving
 * again after any failure resumes after the parts already stored, so a retry
 * never reads, sends or duplicates anything twice. Until the manifest is
 * written the note reads as having no audio.
 */
export async function putVoiceNoteAudio(
  tcw: TinyCloudWeb,
  id: string,
  source: VoiceNoteAudioSource,
  opts: StoreAudioOptions = {},
): Promise<StoreResult<StoredAudioManifest>> {
  try {
    const manifest = await putAudio(tcw.kv, voiceNoteAudioKvKey(id), source, {
      ...opts,
      fileName: `${id}.m4a`,
      mimeType: source.mimeType,
    });
    return { ok: true, data: manifest };
  } catch (err) {
    return audioFailure("saveVoiceNote(audio)", err);
  }
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

/**
 * Audio first (every part, then its manifest), then the row: a listed note
 * always has audio behind it. A failure anywhere leaves the recording on the
 * phone (pending); saving it again resumes after the parts already stored, and
 * the row is an upsert on the recording id, so nothing is ever duplicated.
 */
export async function saveVoiceNote(
  tcw: TinyCloudWeb,
  recording: VoiceNoteRecording,
  source: VoiceNoteAudioSource,
  platform: string,
  opts: StoreAudioOptions = {},
): Promise<StoreResult<UpsertMeetingOutcome>> {
  const audio = await putVoiceNoteAudio(tcw, recording.id, source, opts);
  if (!audio.ok) return audio;
  const base = voiceNoteAudioKvKey(recording.id);
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
        audio_kv_key: base,
        audio_format: "parts-v1",
        audio_mime_type: audio.data.mimeType,
        audio_bytes: audio.data.size,
        audio_parts: audio.data.parts.length,
        // Where stored-audio readers (TC-593's Library player) look: parts + manifest under `base`.
        audio: { stored: true, base },
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

/** One note's row as transcription needs it; `null` when the note does not exist. */
export interface VoiceNoteForTranscription {
  transcript: VoiceNoteTranscriptState;
  /** From the row (or its capture metadata); null when neither says. */
  durationSeconds: number | null;
}

export async function readVoiceNoteForTranscription(
  tcw: TinyCloudWeb,
  sourceId: string,
): Promise<StoreResult<VoiceNoteForTranscription | null>> {
  const schema = await ensureSchema(tcw);
  if (!schema.ok) return schema;
  const res = await tcw.sql.db(CONNECTORS_SQL_DB_NAME).query(
    `SELECT duration_secs, metadata FROM connector_meeting WHERE source = ? AND source_id = ? LIMIT 1`,
    [VOICE_NOTE_SOURCE, sourceId],
  );
  if (!res.ok) {
    return { ok: false, error: { code: res.error.code ?? "STORE_ERROR", message: `readVoiceNoteForTranscription: ${res.error.message}` } };
  }
  const row = res.data.rows[0];
  if (!row) return { ok: true, data: null };
  let durationSeconds: number | null = typeof row[0] === "number" ? row[0] : null;
  if (durationSeconds === null && typeof row[1] === "string") {
    try {
      const ms = (JSON.parse(row[1]) as { capture?: { duration_ms?: unknown } }).capture?.duration_ms;
      if (typeof ms === "number") durationSeconds = ms / 1000;
    } catch {
      // Unknown length: the audio's own size is checked before it is decoded.
    }
  }
  return { ok: true, data: { transcript: voiceNoteTranscriptState(row[1]), durationSeconds } };
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

export interface LoadAudioOptions {
  /** Refuse (VOICE_NOTE_AUDIO_TOO_LARGE) a note larger than this before downloading it. */
  maxBytes?: number;
  onProgress?: (loadedBytes: number, totalBytes: number) => void;
  /** Stops the read between parts (the note's player was closed). */
  signal?: AbortSignal;
  /** Injected in tests. */
  retryDelaysMs?: readonly number[];
}

/** The note's audio from its parts; null when it has no manifest (a note saved before TC-517, or no audio at all). */
async function readStoredAudio(tcw: TinyCloudWeb, sourceId: string, opts: LoadAudioOptions): Promise<StoreResult<Blob | null>> {
  try {
    return { ok: true, data: await getAudio(tcw.kv, voiceNoteAudioKvKey(sourceId), opts) };
  } catch (err) {
    return audioFailure("loadVoiceNoteAudio", err);
  }
}

/** A note saved before TC-517: its whole audio as one JSON value at the base key. */
async function readLegacyAudio(tcw: TinyCloudWeb, sourceId: string): Promise<StoreResult<VoiceNoteAudio>> {
  const res = await tcw.kv.get(voiceNoteAudioKvKey(sourceId));
  if (!res.ok) {
    return { ok: false, error: { code: res.error.code ?? "STORE_ERROR", message: `loadVoiceNoteAudio: ${res.error.message}` } };
  }
  const raw = res.data.data;
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      parsed = null;
    }
  }
  if (
    !parsed || typeof parsed !== "object"
    || typeof (parsed as VoiceNoteAudio).mimeType !== "string"
    || typeof (parsed as VoiceNoteAudio).base64 !== "string"
  ) {
    return { ok: false, error: { code: VOICE_NOTE_AUDIO_CORRUPT, message: "loadVoiceNoteAudio: stored audio is malformed" } };
  }
  const audio = parsed as VoiceNoteAudio;
  return { ok: true, data: { mimeType: audio.mimeType, base64: audio.base64 } };
}

function tooLarge(size: number, maxBytes: number | undefined): StoreFailure | null {
  return maxBytes !== undefined && size > maxBytes
    ? { ok: false, error: { code: VOICE_NOTE_AUDIO_TOO_LARGE, message: `loadVoiceNoteAudio: the note's audio is ${size} bytes, over ${maxBytes}` } }
    : null;
}

/**
 * The note's audio as a Blob for playback (an object URL, never a data: URL):
 * read part by part from a manifest, or decoded from a pre-TC-517 single value.
 */
export async function loadVoiceNoteAudioBlob(
  tcw: TinyCloudWeb,
  sourceId: string,
  opts: LoadAudioOptions = {},
): Promise<StoreResult<Blob>> {
  const stored = await readStoredAudio(tcw, sourceId, opts);
  if (!stored.ok) return stored;
  if (stored.data) return { ok: true, data: stored.data };
  if (opts.signal?.aborted) return audioFailure("loadVoiceNoteAudio", new DOMException("The read was cancelled.", "AbortError"));
  const legacy = await readLegacyAudio(tcw, sourceId);
  if (!legacy.ok) return legacy;
  const bytes = base64ToBytes(legacy.data.base64);
  const refused = tooLarge(bytes.byteLength, opts.maxBytes);
  if (refused) return refused;
  opts.onProgress?.(bytes.byteLength, bytes.byteLength);
  return { ok: true, data: new Blob([bytes as Uint8Array<ArrayBuffer>], { type: legacy.data.mimeType }) };
}

/**
 * The note's audio as base64 (what transcription prepares and uploads). Pass
 * `maxBytes`: a note over it is refused from its manifest, before any part is
 * downloaded.
 */
export async function loadVoiceNoteAudio(
  tcw: TinyCloudWeb,
  sourceId: string,
  opts: LoadAudioOptions = {},
): Promise<StoreResult<VoiceNoteAudio>> {
  const stored = await readStoredAudio(tcw, sourceId, opts);
  if (!stored.ok) return stored;
  if (stored.data) {
    const bytes = new Uint8Array(await stored.data.arrayBuffer());
    return { ok: true, data: { mimeType: stored.data.type, base64: bytesToBase64(bytes) } };
  }
  const legacy = await readLegacyAudio(tcw, sourceId);
  if (!legacy.ok) return legacy;
  return tooLarge(Math.floor((legacy.data.base64.length * 3) / 4), opts.maxBytes) ?? legacy;
}
