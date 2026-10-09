// Voice notes in the owner's TinyCloud space: one indexed live
// `connector_meeting` row, a `voice_note_transcript` commit record, and bodies
// in KV under the granted `connectors/` prefix.
//
//   SQL  connector_meeting  source = "exo-voice-note", source_id = recording id
//   KV   {APP_ID}/connectors/exo-voice-note/audio/{id}/p/000000  raw audio, part 0 (≤ 1 MiB)
//   KV   {APP_ID}/connectors/exo-voice-note/audio/{id}/p/000001  part 1, ...
//   KV   {APP_ID}/connectors/exo-voice-note/audio/{id}/manifest  JSON, written LAST
//   KV   {APP_ID}/connectors/exo-voice-note/transcript/{id}      old-reader mirror
//   KV   {APP_ID}/connectors/exo-voice-note/transcript-rev/{id}/{hash} immutable body
//   KV   {APP_ID}/connectors/exo-voice-note/audio/{id}/note.md Markdown + frontmatter
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
// The fixed transcript key is created empty for legacy readers. New readers
// follow the commit record, so a late old-client PUT cannot change their view.

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
  transcriptKvKey,
  type StoreResult,
  type UpsertMeetingOutcome,
} from "../connectors/connectorStore";
import type { VoiceNoteRecording } from "./nativeVoiceNotes";
import type { LocalTranscript } from "./nativeVoiceNotes";
import { readLegacyTranscriptWinner, readTranscriptCommit, legacyTranscriptMetadata, type TranscriptCommit } from "./voiceNoteCommits";
import { commitVoiceNoteTranscript, createVoiceNoteRow, ensureVoiceNoteIdentity, patchVoiceNoteAudio,
  patchVoiceNoteMarkdown, resolveVoiceNoteRow } from "./voiceNoteRows";
import { runOnSpaceLane } from "../spaceWriteLane";
import { base64ToBytes, bytesToBase64 } from "./voiceNoteAudio";
import { loadNote, noteMarkdown, parseNoteMarkdown, type RecordingNote } from "./recordingNotes";

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

export function voiceNoteMarkdownKvKey(id: string): string {
  return `${voiceNoteAudioKvKey(id)}/note.md`;
}

const noteSyncs = new Map<string, Promise<boolean>>();
export type NoteSyncErrorCode = "sync_failed";
const noteSyncErrors = new Map<string, NoteSyncErrorCode>();
const noteSyncListeners = new Set<() => void>();
const noteSyncKey = (tcw: TinyCloudWeb, id: string) => JSON.stringify([tcw.spaceId, tcw.did, id]);

/** Account-scoped status; UI never receives a raw storage or network error. */
export function recordingNoteSyncError(tcw: TinyCloudWeb, id: string): NoteSyncErrorCode | null {
  return noteSyncErrors.get(noteSyncKey(tcw, id)) ?? null;
}
export function subscribeRecordingNoteSync(listener: () => void): () => void {
  noteSyncListeners.add(listener);
  return () => { noteSyncListeners.delete(listener); };
}
export function reportRecordingNoteSyncError(tcw: TinyCloudWeb, id: string, code: NoteSyncErrorCode | null): void {
  const key = noteSyncKey(tcw, id);
  if ((noteSyncErrors.get(key) ?? null) === code) return;
  if (code) noteSyncErrors.set(key, code);
  else noteSyncErrors.delete(key);
  for (const listener of [...noteSyncListeners]) listener();
}

/** The T18 row and its audio prefix own note sync; there is no separate upload queue. */
export function syncRecordingNote(tcw: TinyCloudWeb, id: string,
  checkpoint: () => void = () => undefined): Promise<boolean> {
  const syncKey = noteSyncKey(tcw, id);
  const inFlight = noteSyncs.get(syncKey);
  if (inFlight) return inFlight;
  const sync = (async () => {
    checkpoint();
    for (;;) {
      const note = await loadNote(id);
      if (!note) return false;
      const row = await resolveVoiceNoteRow(tcw, id, checkpoint);
      if (!row) return false;
      const key = voiceNoteMarkdownKvKey(id);
      if (row.metadata.note_kv_key === key && row.metadata.note_edited_at === note.editedAt) return true;
      const body = noteMarkdown(note);
      const put = await runOnSpaceLane(() => { checkpoint(); return tcw.kv.put(key, body, { contentType: "text/markdown" }); });
      if (!put.ok) throw new Error(`Could not sync recording note: ${put.error.message}`);
      checkpoint();
      await patchVoiceNoteMarkdown(tcw, id, key, note.editedAt, checkpoint);
      const latest = await loadNote(id);
      if (!latest || latest.revision === note.revision) return true;
    }
  })().then((result) => {
    if (result) { checkpoint(); reportRecordingNoteSyncError(tcw, id, null); }
    return result;
  }, (error: unknown) => {
    checkpoint(); // A cancelled account never publishes a note status for its old client.
    reportRecordingNoteSyncError(tcw, id, "sync_failed");
    throw error;
  }).finally(() => { if (noteSyncs.get(syncKey) === sync) noteSyncs.delete(syncKey); });
  noteSyncs.set(syncKey, sync);
  return sync;
}

export async function readRecordingNoteFromSpace(tcw: TinyCloudWeb, id: string): Promise<RecordingNote | null> {
  const result = await tcw.kv.get(voiceNoteMarkdownKvKey(id));
  if (!result.ok) {
    if (/NOT_FOUND|404/i.test(`${result.error.code ?? ""} ${result.error.message}`)) return null;
    throw new Error(`Could not load recording note: ${result.error.message}`);
  }
  return parseNoteMarkdown(String(result.data.data));
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
  schedule?: <T>(call: () => Promise<T>) => Promise<T>;
  checkpoint?: () => void;
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

/** The saved file's extension from the recording's container: WebM and Ogg from a browser, MP4/AAC (the phones) otherwise. */
export function audioFileExtension(mimeType: string): string {
  const base = mimeType.split(";")[0]!.trim().toLowerCase();
  if (base === "audio/webm" || base === "video/webm") return "webm";
  if (base === "audio/ogg") return "ogg";
  return "m4a";
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
      fileName: `${id}.${audioFileExtension(source.mimeType)}`,
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

/** A commit record is authoritative; metadata is read only in legacy format. */
export function voiceNoteTranscriptState(metadata: unknown, commit?: TranscriptCommit | null): VoiceNoteTranscriptState {
  if (commit) return { status: commit.outcome, preview: commit.preview };
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
  if (m.transcription_outcome === "transcribed") {
    const text = typeof m.transcript_text === "string" ? m.transcript_text.trim() : "";
    return { status: "transcribed", preview: text
      ? text.length > TRANSCRIPT_PREVIEW_CHARS ? `${text.slice(0, TRANSCRIPT_PREVIEW_CHARS).trimEnd()}…` : text
      : null };
  }
  if (typeof m.transcript_text === "string" && m.transcript_text.trim().length > 0) {
    const text = m.transcript_text.trim();
    return {
      status: "transcribed",
      preview: text.length > TRANSCRIPT_PREVIEW_CHARS ? `${text.slice(0, TRANSCRIPT_PREVIEW_CHARS).trimEnd()}…` : text,
    };
  }
  return { status: "none", preview: null };
}

export async function readVoiceNoteTranscriptState(tcw: TinyCloudWeb, sourceId: string): Promise<VoiceNoteTranscriptState> {
  const commit = await readTranscriptCommit(tcw, sourceId);
  if (commit) return voiceNoteTranscriptState(null, commit);
  const legacy = await readLegacyTranscriptWinner(tcw, sourceId);
  return voiceNoteTranscriptState(legacyTranscriptMetadata(legacy));
}

/**
 * Establish the identity row, put the empty legacy key, then upload audio and
 * patch only the audio fields. A failure leaves the recording on the phone;
 * retries resume parts and resolve the same indexed row.
 */
export async function saveVoiceNote(
  tcw: TinyCloudWeb,
  recording: VoiceNoteRecording,
  source: VoiceNoteAudioSource,
  platform: string,
  opts: StoreAudioOptions = {},
): Promise<StoreResult<UpsertMeetingOutcome & { noteSyncError?: NoteSyncErrorCode }>> {
  try {
    opts.checkpoint?.();
    const before = await ensureVoiceNoteIdentity(tcw, opts.checkpoint);
    if (before.status !== "established") return { ok: false, error: { code: before.status, message: before.reason ?? before.status } };
    opts.checkpoint?.();
    const row = await createVoiceNoteRow(tcw, recording, voiceNoteTitle(recording.startedAt), opts.checkpoint);
    opts.checkpoint?.();
    const empty = await runOnSpaceLane(() => { opts.checkpoint?.(); return tcw.kv.put(transcriptKvKey(VOICE_NOTE_SOURCE, recording.id), "[]",
      { ifNoneMatch: "*", contentType: "application/json" }); });
    if (!empty.ok && !/PRECONDITION|412/i.test(`${empty.error.code} ${empty.error.message}`))
      return { ok: false, error: { code: empty.error.code ?? "STORE_ERROR", message: empty.error.message } };
    opts.checkpoint?.();
    const audio = await putVoiceNoteAudio(tcw, recording.id, source, { ...opts, schedule: (job) =>
      (opts.schedule ?? runOnSpaceLane)(() => { opts.checkpoint?.(); return job(); }) });
    if (!audio.ok) return audio;
    const base = voiceNoteAudioKvKey(recording.id);
    opts.checkpoint?.();
    await patchVoiceNoteAudio(tcw, recording, platform, { base, mimeType: audio.data.mimeType,
      size: audio.data.size, parts: audio.data.parts.length }, opts.checkpoint);
    // Audio has landed. A Markdown failure is separate; the row's absent/stale
    // note_edited_at keeps it eligible for the next reconciliation or edit.
    let noteSyncError: NoteSyncErrorCode | undefined;
    try { await syncRecordingNote(tcw, recording.id, opts.checkpoint); }
    catch (caught) {
      opts.checkpoint?.(); // Cancellation and discard still stop this save.
      noteSyncError = "sync_failed";
      console.warn("[VoiceNotes] Audio saved, but its Markdown did not sync", caught);
    }
    return { ok: true, data: { id: row.id, inserted: row.inserted, createdAt: row.createdAt, noteSyncError } };
  } catch (caught) {
    return { ok: false, error: { code: (caught as { code?: string }).code ?? "STORE_ERROR",
      message: caught instanceof Error ? caught.message : String(caught) } };
  }
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
  // The partial UNIQUE index enforces one live row per recording id.
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
      transcript: await readVoiceNoteTranscriptState(tcw, sourceId),
    });
  }
  return { ok: true, data: notes };
}

/** One note's row as transcription needs it; `null` when the note does not exist. */
export interface VoiceNoteForTranscription {
  transcript: VoiceNoteTranscriptState;
  /** From the row (or its capture metadata); null when neither says. */
  durationSeconds: number | null;
  /** A v2 choice is durable in the space row even after native deletes its sidecar. */
  captureVersion: number | null;
  captureTranscriber: string | null;
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
  let captureVersion: number | null = null;
  let captureTranscriber: string | null = null;
  try {
    const metadata = typeof row[1] === "string" ? JSON.parse(row[1]) as unknown : row[1];
    const capture = metadata && typeof metadata === "object" ? (metadata as { capture?: unknown }).capture : null;
    if (capture && typeof capture === "object") {
      const saved = capture as { duration_ms?: unknown; version?: unknown; options?: { transcriber?: unknown } };
      if (durationSeconds === null && typeof saved.duration_ms === "number") durationSeconds = saved.duration_ms / 1000;
      if (typeof saved.version === "number") captureVersion = saved.version;
      if (typeof saved.options?.transcriber === "string") captureTranscriber = saved.options.transcriber;
    }
  } catch {
    // Legacy metadata may be malformed; the audio's size is checked before decoding.
  }
  return { ok: true, data: { transcript: await readVoiceNoteTranscriptState(tcw, sourceId),
    durationSeconds, captureVersion, captureTranscriber } };
}

/** What a transcription adds to a note: the sentences for its transcript key and row metadata. */
export interface VoiceNoteTranscriptSave {
  rev: number;
  /** Empty when no speech was found: the transcript key stays `[]`. */
  sentences: FirefliesSentence[];
  /** Merged into the row's metadata (engine, provider, model, transcript_text, ...). */
  metadata: Record<string, unknown>;
  /** Speakers named in the sentences, as the row's participants. */
  speakers: string[];
}

/**
 * Commit a transcript to an existing note. The immutable body lands first,
 * then a CAS upsert publishes it in `voice_note_transcript`. The old row and
 * fixed key are mirrors only.
 */
export async function saveVoiceNoteTranscript(
  tcw: TinyCloudWeb,
  sourceId: string,
  transcript: VoiceNoteTranscriptSave,
): Promise<StoreResult<UpsertMeetingOutcome>> {
  if (!Number.isSafeInteger(transcript.rev) || transcript.rev < 1)
    return { ok: false, error: { code: "VOICE_NOTE_REV_REQUIRED", message: "The note's transcript revision is missing" } };
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
  try {
    const m = transcript.metadata;
    await commitVoiceNoteTranscript(tcw, sourceId, {
      rev: transcript.rev, sentences: transcript.sentences,
      outcome: m.transcription_outcome === "no_speech" ? "no_speech" : "transcribed",
      text: typeof m.transcript_text === "string" ? m.transcript_text : null,
      engine: typeof m.transcription_engine === "string" ? m.transcription_engine : null,
      provider: typeof m.transcript_provider === "string" ? m.transcript_provider : null,
      model: typeof m.model === "string" ? m.model : null,
      language: typeof m.language === "string" ? m.language : null,
      speakerLabels: m.speaker_labels == null ? null
        : ["diarized", "channels", "channel-you-others"].includes(String(m.speaker_labels)),
      participants: transcript.speakers,
      transcribedAt: typeof m.transcribed_at === "string" ? m.transcribed_at : null, metadata: m,
    });
    return { ok: true, data: { id: String(existing.data.rows[0]?.[0]), inserted: false,
      createdAt: new Date().toISOString() } };
  } catch (caught) {
    return { ok: false, error: { code: (caught as { code?: string }).code ?? "STORE_ERROR",
      message: caught instanceof Error ? caught.message : String(caught) } };
  }
}

/** T22's on-device lane sends this directly to the commit-table writer. */
export function localTranscriptToSave(local: LocalTranscript): VoiceNoteTranscriptSave {
  // local.segments' start/end are milliseconds (the native sidecar's canonical-JSON writer only
  // accepts integers); start_time/end_time follow every other transcript source's seconds.
  const sentences: FirefliesSentence[] = local.segments.map((segment, index) => ({
    index, text: segment.text, start_time: segment.start / 1000, end_time: segment.end / 1000, speaker_name: segment.speaker ?? "You",
  }));
  return { rev: local.rev, sentences, speakers: [...new Set(local.segments.map((s) => s.speaker ?? "You"))],
    metadata: { transcription_outcome: local.outcome, transcript_text: local.outcome === "transcribed"
      ? local.segments.map((s) => s.text).join("\n") : null, transcription_engine: local.engine,
      transcript_provider: local.engine, model: local.model, language: local.language,
      speaker_labels: local.diarized, transcribed_at: local.createdAt } };
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
