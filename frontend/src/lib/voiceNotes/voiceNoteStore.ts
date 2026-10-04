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
// minutes). The layout (parts + manifest under one base key) is the one TC-593's
// audio store uses for uploaded audio, so either reader can play either.
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
  return `${voiceNoteAudioKvKey(id)}/p/${String(index).padStart(6, "0")}`;
}

export function voiceNoteAudioManifestKey(id: string): string {
  return `${voiceNoteAudioKvKey(id)}/manifest`;
}

/**
 * Bytes per stored part: the largest request body the production node's
 * ingress accepts. The node allows 1 GB per KV put (tinycloud-node-server
 * routes/mod.rs, `d.open(1u8.gigabytes())`), but nginx in front of
 * tee.node.tinycloud.xyz answers 413 (without CORS headers, so a webview sees
 * only "Failed to fetch") for any body over 1,048,576 bytes. A part is sent as
 * the raw request body, so a part of this size is exactly at that limit.
 */
export const VOICE_NOTE_AUDIO_PART_BYTES = 1024 * 1024;

/** Waits before each retry of a transient storage failure; its length bounds the retries. */
const RETRY_DELAYS_MS: readonly number[] = [1_000, 3_000];

/** Stored after every part, last: a manifest means the whole file is stored. Same shape as TC-593's. */
export interface VoiceNoteAudioManifest {
  v: 1;
  mimeType: string;
  fileName: string;
  size: number;
  partSize: number;
  /** `etag` is null for a part kept from an interrupted attempt. */
  parts: { size: number; etag: string | null }[];
  sha256: string | null;
  createdAt: string;
}

/**
 * The audio to store, read one part at a time (on the phone, from the native
 * recorder through readAudioChunk), so the whole file never sits in one string.
 * `read` must return exactly `length` bytes.
 */
export interface VoiceNoteAudioSource {
  mimeType: string;
  size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

/** A source over audio already in memory as base64. */
export function voiceNoteAudioSourceFromBase64(audio: VoiceNoteAudio): VoiceNoteAudioSource {
  const bytes = base64ToBytes(audio.base64);
  return {
    mimeType: audio.mimeType,
    size: bytes.byteLength,
    read: async (offset, length) => bytes.slice(offset, offset + length),
  };
}

export interface StoreAudioOptions {
  partSize?: number;
  onProgress?: (storedBytes: number, totalBytes: number) => void;
  /** Injected in tests. */
  retryDelaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
}

/** Storage error codes this module adds to the SDK's. */
export const VOICE_NOTE_STORAGE_FULL = "STORAGE_QUOTA_EXCEEDED";
export const VOICE_NOTE_AUDIO_TOO_LARGE = "VOICE_NOTE_AUDIO_TOO_LARGE";
export const VOICE_NOTE_AUDIO_CORRUPT = "STORE_CORRUPT_AUDIO";

type KvError = { code?: string; message?: string; meta?: unknown };
type KvResult<T> = { ok: true; data: T } | { ok: false; error: KvError };

function httpStatus(error: KvError): number | undefined {
  const value = (error.meta as { status?: unknown } | undefined)?.status;
  return typeof value === "number" ? value : undefined;
}

function isTransient(error: KvError): boolean {
  if (error.code === "NETWORK_ERROR" || error.code === "TIMEOUT") return true;
  const status = httpStatus(error);
  return status !== undefined && (status >= 500 || status === 408 || status === 429);
}

function isQuota(error: KvError): boolean {
  const status = httpStatus(error);
  return error.code === VOICE_NOTE_STORAGE_FULL || error.code === "STORAGE_LIMIT_REACHED" || status === 402 || status === 413;
}

function storeFail(op: string, error: KvError): { ok: false; error: { code: string; message: string } } {
  if (isQuota(error)) {
    return { ok: false, error: { code: VOICE_NOTE_STORAGE_FULL, message: `${op}: your TinyCloud storage is full` } };
  }
  return { ok: false, error: { code: error.code ?? "STORE_ERROR", message: `${op}: ${error.message ?? "unknown error"}` } };
}

/** One KV call, retrying transient failures (network, timeout, 5xx/408/429) with bounded backoff. */
async function withRetry<T>(
  call: () => Promise<KvResult<T>>,
  opts: Pick<StoreAudioOptions, "retryDelaysMs" | "sleep">,
): Promise<KvResult<T>> {
  const delays = opts.retryDelaysMs ?? RETRY_DELAYS_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; ; attempt++) {
    const res = await call();
    if (res.ok || attempt >= delays.length || !isTransient(res.error)) return res;
    await sleep(delays[attempt]!);
  }
}

/** Every stored key under `prefix` (following list cursors); an empty set when listing fails. */
async function listedKeys(tcw: TinyCloudWeb, prefix: string): Promise<Set<string>> {
  const keys = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 1_000; page++) {
    let res: KvResult<{ keys: string[]; truncated?: boolean; nextCursor?: string }>;
    try {
      res = await tcw.kv.list({ path: prefix, ...(cursor === undefined ? {} : { cursor }) }) as typeof res;
    } catch {
      return keys;
    }
    if (!res.ok) return keys;
    for (const key of res.data.keys ?? []) if (typeof key === "string" && key.startsWith(prefix)) keys.add(key);
    if (!res.data.truncated || !res.data.nextCursor || res.data.nextCursor === cursor) return keys;
    cursor = res.data.nextCursor;
  }
  return keys;
}

/**
 * Store a note's audio as raw parts, then its manifest (last, so a manifest
 * always means a complete file). Parts go one at a time (TinyCloud handles one
 * request per space at a time best), each read from `source` just before it is
 * sent, so memory holds one part.
 *
 * Retry after any failure: parts already stored (listed under `${base}/p/`; a
 * KV put is all-or-nothing, so a listed part is whole) are not read or sent
 * again, and every key is fixed by the note id and part index, so a retry never
 * duplicates anything. Until the manifest is written the note reads as having
 * no audio.
 */
export async function putVoiceNoteAudio(
  tcw: TinyCloudWeb,
  id: string,
  source: VoiceNoteAudioSource,
  opts: StoreAudioOptions = {},
): Promise<StoreResult<VoiceNoteAudioManifest>> {
  const partSize = opts.partSize ?? VOICE_NOTE_AUDIO_PART_BYTES;
  if (!Number.isSafeInteger(partSize) || partSize <= 0 || partSize > VOICE_NOTE_AUDIO_PART_BYTES) {
    return { ok: false, error: { code: "STORE_INVALID_PART_SIZE", message: `putVoiceNoteAudio: part size must be 1..${VOICE_NOTE_AUDIO_PART_BYTES}` } };
  }
  const total = source.size;
  if (!Number.isSafeInteger(total) || total < 0) {
    return { ok: false, error: { code: "STORE_INVALID_AUDIO", message: "putVoiceNoteAudio: the recording's size is unknown" } };
  }
  const existing = await listedKeys(tcw, `${voiceNoteAudioKvKey(id)}/p/`);
  const parts: VoiceNoteAudioManifest["parts"] = [];
  let stored = 0;
  for (let index = 0, offset = 0; offset < total; index++, offset += partSize) {
    const key = voiceNoteAudioPartKey(id, index);
    const length = Math.min(partSize, total - offset);
    let etag: string | null = null;
    if (!existing.has(key)) {
      let bytes: Uint8Array;
      try {
        bytes = await source.read(offset, length);
      } catch (err) {
        return { ok: false, error: { code: "VOICE_NOTE_SOURCE_READ_FAILED", message: `putVoiceNoteAudio(read part ${index}): ${err instanceof Error ? err.message : String(err)}` } };
      }
      if (bytes.byteLength !== length) {
        return { ok: false, error: { code: "VOICE_NOTE_SOURCE_READ_FAILED", message: `putVoiceNoteAudio(read part ${index}): got ${bytes.byteLength} of ${length} bytes` } };
      }
      const put = await withRetry(
        () => tcw.kv.put(key, bytes, { contentType: "application/octet-stream" }) as Promise<KvResult<{ headers?: { etag?: string } }>>,
        opts,
      );
      if (!put.ok) return storeFail(`saveVoiceNote(audio part ${index})`, put.error);
      etag = put.data?.headers?.etag ?? null;
    }
    parts.push({ size: length, etag });
    stored += length;
    opts.onProgress?.(stored, total);
  }
  const manifest: VoiceNoteAudioManifest = {
    v: 1,
    mimeType: source.mimeType,
    fileName: `${id}.m4a`,
    size: total,
    partSize,
    parts,
    sha256: null,
    createdAt: new Date().toISOString(),
  };
  const written = await withRetry(
    () => tcw.kv.put(voiceNoteAudioManifestKey(id), JSON.stringify(manifest), { contentType: "application/json" }) as Promise<KvResult<unknown>>,
    opts,
  );
  if (!written.ok) return storeFail("saveVoiceNote(audio manifest)", written.error);
  return { ok: true, data: manifest };
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** A stored manifest, or null when it is not one (wrong version, sizes that do not add up). */
export function parseVoiceNoteAudioManifest(raw: unknown): VoiceNoteAudioManifest | null {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object") return null;
  const m = value as Record<string, unknown>;
  if (
    m.v !== 1
    || typeof m.mimeType !== "string"
    || typeof m.fileName !== "string"
    || !isNonNegativeInteger(m.size)
    || !isNonNegativeInteger(m.partSize)
    || (m.sha256 !== null && typeof m.sha256 !== "string")
    || typeof m.createdAt !== "string"
    || !Array.isArray(m.parts)
  ) {
    return null;
  }
  const parts: VoiceNoteAudioManifest["parts"] = [];
  let sum = 0;
  for (const part of m.parts as unknown[]) {
    if (!part || typeof part !== "object") return null;
    const { size, etag } = part as Record<string, unknown>;
    if (!isNonNegativeInteger(size) || (etag !== null && typeof etag !== "string")) return null;
    parts.push({ size, etag });
    sum += size;
  }
  if (sum !== m.size) return null;
  return {
    v: 1,
    mimeType: m.mimeType,
    fileName: m.fileName,
    size: m.size,
    partSize: m.partSize,
    parts,
    sha256: m.sha256 as string | null,
    createdAt: m.createdAt,
  };
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
  /** Injected in tests. */
  retryDelaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
}

/** The note's manifest; null when it has none (a note saved before TC-517, or no audio at all). */
async function readManifest(tcw: TinyCloudWeb, sourceId: string, opts: LoadAudioOptions): Promise<StoreResult<VoiceNoteAudioManifest | null>> {
  const res = await withRetry(() => tcw.kv.get(voiceNoteAudioManifestKey(sourceId)) as Promise<KvResult<{ data: unknown }>>, opts);
  if (!res.ok) {
    if (res.error.code === "KV_NOT_FOUND") return { ok: true, data: null };
    return storeFail("loadVoiceNoteAudio(manifest)", res.error);
  }
  const manifest = parseVoiceNoteAudioManifest(res.data.data);
  if (!manifest) return { ok: false, error: { code: VOICE_NOTE_AUDIO_CORRUPT, message: "loadVoiceNoteAudio: the stored audio manifest is malformed" } };
  return { ok: true, data: manifest };
}

/** A note saved before TC-517: its whole audio as one JSON value at the base key. */
async function readLegacyAudio(tcw: TinyCloudWeb, sourceId: string, opts: LoadAudioOptions): Promise<StoreResult<VoiceNoteAudio>> {
  const res = await withRetry(() => tcw.kv.get(voiceNoteAudioKvKey(sourceId)) as Promise<KvResult<{ data: unknown }>>, opts);
  if (!res.ok) return storeFail("loadVoiceNoteAudio", res.error);
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

function tooLarge(size: number, maxBytes: number | undefined): { ok: false; error: { code: string; message: string } } | null {
  return maxBytes !== undefined && size > maxBytes
    ? { ok: false, error: { code: VOICE_NOTE_AUDIO_TOO_LARGE, message: `loadVoiceNoteAudio: the note's audio is ${size} bytes, over ${maxBytes}` } }
    : null;
}

/** Every part, in order, each checked against the manifest (a mismatched part never plays as the wrong audio). */
async function readParts(
  tcw: TinyCloudWeb,
  sourceId: string,
  manifest: VoiceNoteAudioManifest,
  opts: LoadAudioOptions,
  onPart: (bytes: Uint8Array) => void,
): Promise<StoreResult<void>> {
  let loaded = 0;
  for (let index = 0; index < manifest.parts.length; index++) {
    const expected = manifest.parts[index]!.size;
    const key = voiceNoteAudioPartKey(sourceId, index);
    const res = await withRetry(
      () => tcw.kv.get(key, { binary: true, ...(expected > 0 ? { maxResponseBytes: expected } : {}) }) as Promise<KvResult<{ data: unknown }>>,
      opts,
    );
    if (!res.ok) return storeFail(`loadVoiceNoteAudio(part ${index})`, res.error);
    const bytes = res.data.data;
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== expected) {
      return { ok: false, error: { code: VOICE_NOTE_AUDIO_CORRUPT, message: `loadVoiceNoteAudio: stored part ${index} does not match its manifest` } };
    }
    onPart(bytes);
    loaded += expected;
    opts.onProgress?.(loaded, manifest.size);
  }
  return { ok: true, data: undefined };
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
  const manifest = await readManifest(tcw, sourceId, opts);
  if (!manifest.ok) return manifest;
  if (manifest.data === null) {
    const legacy = await readLegacyAudio(tcw, sourceId, opts);
    if (!legacy.ok) return legacy;
    const bytes = base64ToBytes(legacy.data.base64);
    const refused = tooLarge(bytes.byteLength, opts.maxBytes);
    if (refused) return refused;
    opts.onProgress?.(bytes.byteLength, bytes.byteLength);
    return { ok: true, data: new Blob([bytes as Uint8Array<ArrayBuffer>], { type: legacy.data.mimeType }) };
  }
  const refused = tooLarge(manifest.data.size, opts.maxBytes);
  if (refused) return refused;
  // One Blob per part lets the webview keep the bytes outside the JS heap.
  const chunks: Blob[] = [];
  const read = await readParts(tcw, sourceId, manifest.data, opts, (bytes) => chunks.push(new Blob([bytes as Uint8Array<ArrayBuffer>])));
  if (!read.ok) return read;
  return { ok: true, data: new Blob(chunks, { type: manifest.data.mimeType }) };
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
  const manifest = await readManifest(tcw, sourceId, opts);
  if (!manifest.ok) return manifest;
  if (manifest.data === null) {
    const legacy = await readLegacyAudio(tcw, sourceId, opts);
    if (!legacy.ok) return legacy;
    const refused = tooLarge(Math.floor((legacy.data.base64.length * 3) / 4), opts.maxBytes);
    return refused ?? legacy;
  }
  const refused = tooLarge(manifest.data.size, opts.maxBytes);
  if (refused) return refused;
  const all = new Uint8Array(manifest.data.size);
  let at = 0;
  const read = await readParts(tcw, sourceId, manifest.data, opts, (bytes) => {
    all.set(bytes, at);
    at += bytes.byteLength;
  });
  if (!read.ok) return read;
  return { ok: true, data: { mimeType: manifest.data.mimeType, base64: bytesToBase64(all) } };
}
