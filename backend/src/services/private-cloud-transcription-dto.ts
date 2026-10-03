/**
 * Response DTOs for the private cloud transcription relay. The contract is the TinyCloud Private
 * Transcription batch API (`ptx-batch`, PTX `SPEC.md` "Batch transcription", `src/uploads/`).
 *
 * Every public response is REBUILT here field by field from the PTX body: nothing PTX sends is
 * relayed by reference, so a serializer regression upstream (a `tenant_ref`, a storage path,
 * capability material, provider diagnostics) can never reach the caller. Fields outside the
 * contract are dropped; a contract field that is missing, mistyped or carries an unknown value
 * (status, job error code, admission mode, provider, ...) makes the whole response invalid, which
 * the router answers as `upstream_bad_response`. Upstream error MESSAGES are never relayed: a job
 * error is rebuilt as `{ code, message }` with our own message for that code.
 */

export const MAX_RECORDING_BYTES = 120_960_000;
export const TRANSCRIPTION_ID_RE = /^trn_[0-9A-HJKMNP-TV-Z]{26}$/;
export const UPLOAD_PATH_RE = /^\/uploads\/trn_[0-9A-HJKMNP-TV-Z]{26}$/;
export const CAPABILITY_RE = /^tcu_[A-Za-z0-9_-]{16,256}$/;
/** The audio containers PTX accepts; the upload's Content-Type must equal the create's. */
export const CONTENT_TYPES: readonly string[] = ["audio/mpeg", "audio/wav", "audio/ogg", "audio/mp4", "audio/webm", "audio/flac"];
/** PTX's BCP-47 subset (`en`, `pt-BR`, `zh-Hant-TW`), at most 35 characters. */
export const LANGUAGE_RE = /^(?=.{2,35}$)[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/;

export const TRANSCRIPTION_STATUSES = [
  "awaiting_upload",
  "queued",
  "processing",
  "completed",
  "failed",
  "cancelled",
] as const;
export type TranscriptionStatus = (typeof TRANSCRIPTION_STATUSES)[number];
const ACTIVE_STATUSES: readonly TranscriptionStatus[] = ["awaiting_upload", "queued", "processing"];
const TERMINAL_STATUSES: readonly TranscriptionStatus[] = ["completed", "failed", "cancelled"];

/** Why a job failed or ended (PTX job `error.code`). Our messages; PTX's text is never relayed. */
export const JOB_ERRORS = {
  upload_expired: "The upload window closed before the recording arrived.",
  upload_integrity_failed: "The uploaded recording did not match its checksum.",
  invalid_audio: "The recording could not be read as audio.",
  recording_too_long: "The recording is longer than the private cloud limit.",
  unsupported_recording: "This recording format is not supported.",
  no_speech: "No speech was found in the recording.",
  provider_unavailable: "The speech-to-text provider was unavailable.",
  provider_outcome_unknown: "The speech-to-text result was lost; retrying transcribes the recording again.",
  processing_timeout: "Transcription took too long and was stopped.",
  processing_failed: "Processing was interrupted and could not finish.",
  transcription_failed: "Transcription failed.",
  cancelled: "The transcription was cancelled.",
} as const;
export type JobErrorCode = keyof typeof JOB_ERRORS;

export const ADMISSION_MODES = ["open", "drain", "closed"] as const;
export const CHANNEL_MODES = ["separate", "mixed"] as const;
/** PTX reports `not_received` while a job still awaits its upload (SPEC.md, batch `<job>`). */
export const AUDIO_RETENTION_STATES = ["not_received", "stored", "deletion_pending", "deleted"] as const;

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const STAGE_RE = /^[a-z][a-z0-9_]{0,31}$/;
const MODEL_RE = /^[A-Za-z0-9._:/-]{1,64}$/;
const SEGMENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const CHANNEL_SPEAKER_ID_RE = /^channel_[01]$/;
/** Diarized speakers: `speaker_0` … `speaker_31`. */
const DIARIZED_SPEAKER_ID_RE = /^speaker_(?:[0-9]|[12][0-9]|3[01])$/;
const MAX_DIARIZED_SPEAKERS = 32;
const MAX_LABEL_LENGTH = 64;

class Invalid extends Error {}

function check(condition: boolean): asserts condition {
  if (!condition) throw new Invalid();
}

type JsonObject = Record<string, unknown>;

function obj(value: unknown): JsonObject {
  check(typeof value === "object" && value !== null && !Array.isArray(value));
  return value as JsonObject;
}

function int(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): number {
  check(typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max);
  return value as number;
}

function num(value: unknown, min = 0): number {
  check(typeof value === "number" && Number.isFinite(value) && value >= min);
  return value as number;
}

function str(value: unknown, re: RegExp): string {
  check(typeof value === "string" && re.test(value));
  return value as string;
}

function text(value: unknown, maxLength: number): string {
  check(typeof value === "string" && value.length <= maxLength);
  return value as string;
}

function iso(value: unknown): string {
  check(typeof value === "string" && ISO_RE.test(value) && !Number.isNaN(Date.parse(value)));
  return value as string;
}

function bool(value: unknown): boolean {
  check(typeof value === "boolean");
  return value as boolean;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T {
  check(typeof value === "string" && (allowed as readonly string[]).includes(value));
  return value as T;
}

/** A contract field that may be absent or null (normalized to null). */
function nullable<T>(value: unknown, parse: (value: unknown) => T): T | null {
  return value === undefined || value === null ? null : parse(value);
}

function parseOrNull<T>(parse: () => T): T | null {
  try {
    return parse();
  } catch (error) {
    if (error instanceof Invalid) return null;
    throw error;
  }
}

// ── Pieces ───────────────────────────────────────────────────────────

export interface JobError {
  code: JobErrorCode;
  message: string;
}

function jobError(value: unknown): JobError {
  const code = oneOf(obj(value).code, Object.keys(JOB_ERRORS) as JobErrorCode[]);
  return { code, message: JOB_ERRORS[code] };
}

/** `failed` carries its reason; `cancelled` may carry PTX's `cancelled` marker; nothing else carries one. */
function statusError(status: TranscriptionStatus, raw: unknown): JobError | null {
  const error = nullable(raw, jobError);
  if (status === "failed") check(error !== null && error.code !== "cancelled");
  else if (status === "cancelled") check(error === null || error.code === "cancelled");
  else check(error === null);
  return error;
}

function progress(value: unknown) {
  const o = obj(value);
  const regionsTotal = int(o.regions_total, 0);
  return {
    stage: str(o.stage, STAGE_RE),
    queue_position: nullable(o.queue_position, (v) => int(v, 0)),
    regions_completed: int(o.regions_completed, 0, regionsTotal),
    regions_total: regionsTotal,
  };
}

function retention(value: unknown) {
  const o = obj(value);
  return {
    audio: oneOf(o.audio, AUDIO_RETENTION_STATES),
    audio_deleted_at: nullable(o.audio_deleted_at, iso),
    transcript_expires_at: nullable(o.transcript_expires_at, iso),
  };
}

/**
 * The caller's own create choices, echoed by PTX on every job. Relayed because they are how a
 * client tells its jobs from another client's on the same account (Exo desktop's tenant-list
 * recovery must not adopt an Exo mobile voice note's job): the desktop labels its two channels
 * "Speaker 1"/"Speaker 2", voice notes send one "Exo voice note" label. Same rules as create.
 */
function channelLabels(value: unknown): string[] {
  check(Array.isArray(value) && value.length >= 1 && value.length <= 2);
  return (value as unknown[]).map((label) => {
    const name = text(label, MAX_LABEL_LENGTH);
    check(name.trim().length > 0);
    return name;
  });
}

/** PTX's lifecycle timestamps, in the order a job reaches them. */
const LIFECYCLE_TIMESTAMPS = ["uploaded_at", "processing_started_at", "finished_at"] as const;

/**
 * When the job last changed. PTX has no `updated_at`: it reports lifecycle timestamps
 * (`created_at`, then `uploaded_at`, `processing_started_at`, `finished_at` as they happen), so the
 * latest of those present is the job's last change. An `updated_at`, if PTX ever adds one, counts too.
 * Every value present must be a timestamp.
 */
function lastChanged(o: JsonObject): string {
  let latest = iso(o.created_at);
  for (const key of [...LIFECYCLE_TIMESTAMPS, "updated_at"] as const) {
    const at = nullable(o[key], iso);
    if (at !== null && Date.parse(at) > Date.parse(latest)) latest = at;
  }
  return latest;
}

function job(value: unknown, expectedId?: string) {
  const o = obj(value);
  const id = str(o.id, TRANSCRIPTION_ID_RE);
  check(expectedId === undefined || id === expectedId);
  const status = oneOf(o.status, TRANSCRIPTION_STATUSES);
  return {
    id,
    status,
    byte_size: int(o.byte_size, 1, MAX_RECORDING_BYTES),
    channel_mode: nullable(o.channel_mode, (v) => oneOf(v, CHANNEL_MODES)),
    channel_labels: nullable(o.channel_labels, channelLabels),
    duration_seconds: nullable(o.duration_seconds, (v) => num(v)),
    channels: nullable(o.channels, (v) => int(v, 1, 2)),
    progress: nullable(o.progress, progress),
    retention: retention(o.retention),
    error: statusError(status, o.error),
    created_at: iso(o.created_at),
    updated_at: lastChanged(o),
  };
}

// ── Public responses ─────────────────────────────────────────────────

export type PublicJob = ReturnType<typeof job>;

export function parseCapabilities(body: unknown) {
  return parseOrNull(() => {
    const o = obj(body);
    check(Array.isArray(o.content_types) && o.content_types.length > 0);
    const contentTypes = (o.content_types as unknown[]).map((v) => oneOf(v, CONTENT_TYPES));
    check(new Set(contentTypes).size === contentTypes.length);
    return {
      max_bytes: int(o.max_bytes, 1, MAX_RECORDING_BYTES),
      max_duration_seconds: int(o.max_duration_seconds, 1),
      max_channels: int(o.max_channels, 1, 2),
      content_types: contentTypes,
      transcript_ttl_seconds: int(o.transcript_ttl_seconds, 1),
      admission: oneOf(o.admission, ADMISSION_MODES),
      // Absent on a PTX without the diarization stage: it cannot diarize.
      diarization: o.diarization === undefined ? false : bool(o.diarization),
    };
  });
}

/** Create (201) or idempotent replay (200). `upload` exists exactly while awaiting the upload. */
export function parseCreated(body: unknown, requestedBytes: number) {
  return parseOrNull(() => {
    const o = obj(body);
    const id = str(o.id, TRANSCRIPTION_ID_RE);
    const status = oneOf(o.status, TRANSCRIPTION_STATUSES);
    check(int(o.byte_size, 1) === requestedBytes);
    check((status === "awaiting_upload") === (o.upload !== undefined));
    if (o.upload === undefined) return { id, status, byte_size: requestedBytes };
    const upload = obj(o.upload);
    const path = str(upload.path, UPLOAD_PATH_RE);
    check(path === `/uploads/${id}`);
    return {
      id,
      status,
      byte_size: requestedBytes,
      upload: { path, capability: str(upload.capability, CAPABILITY_RE), expires_at: iso(upload.expires_at) },
    };
  });
}

export function parseJob(body: unknown, expectedId: string): PublicJob | null {
  return parseOrNull(() => job(body, expectedId));
}

/** PTX answers a list as `{ object: "list", data: [<job>…] }` (SPEC.md); the relay answers `{ transcriptions }`. */
export function parseJobList(body: unknown, limit: number) {
  return parseOrNull(() => {
    const list = obj(body).data;
    check(Array.isArray(list) && list.length <= limit);
    return { transcriptions: (list as unknown[]).map((item) => job(item)) };
  });
}

/** Cancel settles the job: the answer is its (terminal) status. */
export function parseCancelled(body: unknown, expectedId: string) {
  return parseOrNull(() => {
    const o = obj(body);
    check(str(o.id, TRANSCRIPTION_ID_RE) === expectedId);
    return { id: expectedId, status: oneOf(o.status, TERMINAL_STATUSES) };
  });
}

/** 202 while the job is still active. */
export function parseResultPending(body: unknown, expectedId: string) {
  return parseOrNull(() => {
    const o = obj(body);
    check(str(o.id, TRANSCRIPTION_ID_RE) === expectedId);
    return { id: expectedId, status: oneOf(o.status, ACTIVE_STATUSES) };
  });
}

/**
 * The speakers of a completed result. Diarized: `speaker_<n>` (n 0-31) voices of the mono downmix,
 * all on channel 0. Otherwise one speaker per transcribed channel, `channel_<n>` on channel n.
 */
function resultSpeakers(raw: unknown, channels: number, diarized: boolean) {
  check(Array.isArray(raw) && raw.length >= 1 && raw.length <= (diarized ? MAX_DIARIZED_SPEAKERS : channels));
  const speakers = (raw as unknown[]).map((value) => {
    const s = obj(value);
    const channel = int(s.channel, 0, channels - 1);
    const id = str(s.id, diarized ? DIARIZED_SPEAKER_ID_RE : CHANNEL_SPEAKER_ID_RE);
    check(diarized ? channel === 0 : id === `channel_${channel}`);
    const name = text(s.name, MAX_LABEL_LENGTH);
    check(name.trim().length > 0);
    return { id, name, channel };
  });
  check(new Set(speakers.map((s) => s.id)).size === speakers.length);
  return speakers;
}

/** 200: the transcript, or the failed/cancelled outcome. */
export function parseResult(body: unknown, expectedId: string) {
  return parseOrNull(() => {
    const o = obj(body);
    check(str(o.id, TRANSCRIPTION_ID_RE) === expectedId);
    if (o.status === "failed" || o.status === "cancelled") {
      const status = o.status as TranscriptionStatus;
      return { id: expectedId, status, error: statusError(status, o.error) };
    }
    check(o.status === "completed");
    const channels = int(o.channels, 1, 2);
    // Results stored before diarization existed carry no `diarized`: they are channel-labelled.
    const diarized = o.diarized === undefined ? false : bool(o.diarized);
    const speakers = resultSpeakers(o.speakers, channels, diarized);
    const byId = new Map(speakers.map((speaker) => [speaker.id, speaker]));
    check(Array.isArray(o.segments));
    const segments = (o.segments as unknown[]).map((raw) => {
      const s = obj(raw);
      const speaker = typeof s.speaker_id === "string" ? byId.get(s.speaker_id) : undefined;
      check(speaker !== undefined);
      const start = num(s.start);
      const end = num(s.end, start);
      check(int(s.channel, 0, channels - 1) === speaker!.channel);
      return {
        id: str(s.id, SEGMENT_ID_RE),
        speaker_id: speaker!.id,
        channel: speaker!.channel,
        start,
        end,
        text: text(s.text, 100_000),
      };
    });
    const stats = obj(o.stats);
    return {
      id: expectedId,
      status: "completed" as const,
      // The language the job was created with; null when none was given.
      language: nullable(o.language, (v) => str(v, LANGUAGE_RE)),
      duration_seconds: num(o.duration_seconds),
      provider: oneOf(o.provider, ["tinfoil"] as const),
      model: str(o.model, MODEL_RE),
      channels,
      diarized,
      speakers,
      segments,
      text: text(o.text, 4_000_000),
      stats: { tinfoil_calls: int(stats.tinfoil_calls, 0), tinfoil_audio_seconds: num(stats.tinfoil_audio_seconds) },
    };
  });
}
