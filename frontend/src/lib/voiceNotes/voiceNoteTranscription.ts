// Private cloud transcription for Exo mobile voice notes.
//
// The same path the desktop's "Private cloud" engine uses (plan §4.4,
// lib/privateCloud.ts, desktop/src-tauri/src/cloud), with the webview doing
// what the desktop's native code does:
//
//   1. capabilities: the backend answers 200 only while the relay is armed and
//      this account is in its cohort (404 otherwise = hidden). Like the
//      desktop, the engine is also hidden unless this BUILD has a PTX upload
//      origin (VITE_EXO_PTX_UPLOAD_ORIGIN, privateCloud.ts); the backend never names one.
//   2. the note's audio is converted to 16 kHz mono WAV (voiceNoteAudio.ts),
//      hashed, and a job is created at the backend (bearer, Idempotency-Key);
//   3. ONE PUT of the bytes straight to `<PTX origin>/uploads/trn_…` with the
//      job capability, through Capacitor's native HTTP (PTX sends no CORS
//      headers, and TinyChat never sees audio);
//   4. the job is polled through the backend, the transcript is fetched,
//      saved onto the note (voiceNoteStore.saveVoiceNoteTranscript), and the
//      job is deleted at PTX.
//
// A job in flight is remembered per note (localStorage), so a relaunch or a
// Retry re-joins it: an idempotent create replay hands out a fresh upload
// capability while the upload is missing, and a job past its upload is just
// polled. Jobs run one at a time (PTX allows one active job per account).

import { CapacitorHttp } from "@capacitor/core";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import type { FirefliesSentence } from "../connectors/firefliesClient";
import { MAX_TURN_SECONDS } from "../localTranscriptTurns";
import {
  buildPtxUploadOrigin,
  createPrivateCloudApi,
  createPrivateCloudJob,
  interpretUploadResponse,
  ptxUploadUrl,
  isTransientCloudError,
  PrivateCloudError,
  privateCloudMessage,
  VOICE_NOTE_CHANNEL_LABELS,
  type PrivateCloudApi,
  type PrivateCloudCapabilities,
  type PrivateCloudCreateBody,
  type PrivateCloudCreated,
  type PrivateCloudJob,
  type PrivateCloudTranscript,
  type PtxPutResponse,
} from "../privateCloud";
import { nativeHttpFileUploadSupported } from "./nativeVoiceNotes";
import {
  MAX_ENCODED_BYTES_PER_SECOND,
  prepareTranscriptionAudio,
  VOICE_NOTE_TRANSCRIPTION_MAX_SECONDS,
  VoiceNoteAudioError,
  type AudioDecoder,
} from "./voiceNoteAudio";
import {
  loadVoiceNoteAudio,
  readVoiceNoteForTranscription,
  saveVoiceNoteTranscript,
  VOICE_NOTE_AUDIO_TOO_LARGE,
  type VoiceNoteAudio,
  type VoiceNoteTranscriptSave,
} from "./voiceNoteStore";

// ── Upload ─────────────────────────────────────────────────────────────

export interface PtxPutRequest {
  url: string;
  capability: string;
  contentType: string;
  base64: string;
  correlationId: string;
}

/** One PUT of the recording; rejects only when no HTTP answer arrived. */
export type PtxPut = (request: PtxPutRequest) => Promise<PtxPutResponse>;

/**
 * Capacitor's native HTTP stack (OkHttp-backed HttpURLConnection / URLSession):
 * no CORS, an exact Content-Length from the decoded bytes, redirects refused.
 * The bytes cross the bridge as base64 (`dataType: "file"`).
 */
export const capacitorPtxPut: PtxPut = async (request) => {
  let response: { status: number; data: unknown };
  try {
    response = await CapacitorHttp.request({
      method: "PUT",
      url: request.url,
      headers: {
        Authorization: `Bearer ${request.capability}`,
        "Content-Type": request.contentType,
        "X-Correlation-Id": request.correlationId,
      },
      data: request.base64,
      dataType: "file",
      disableRedirects: true,
      // iOS applies the first of these as its idle timeout; Android uses both.
      connectTimeout: 60_000,
      // PTX hashes and probes the whole recording before it answers.
      readTimeout: 180_000,
      responseType: "text",
    });
  } catch {
    throw new PrivateCloudError("upload_outcome_unknown", "The upload connection failed", { correlationId: request.correlationId });
  }
  let body = response.data;
  if (typeof body === "string") {
    try {
      body = body ? (JSON.parse(body) as unknown) : null;
    } catch {
      body = null;
    }
  }
  return { status: response.status, body };
};

// ── Jobs in flight (per note), and consent: per account ────────────────
//
// Both live in this device's localStorage under keys that end with the
// account's DID, so a second account signed in on the same phone neither
// inherits the first one's consent nor resumes its jobs.

export const VOICE_NOTE_PENDING_JOBS_KEY = "exo.voiceNotes.privateCloudJobs";
/** The one-time "Use private cloud" for voice notes (its own key: the disclosure differs from the desktop's). */
export const VOICE_NOTE_CONSENT_KEY = "exo.voiceNotes.privateCloudConsent";

export function accountStorageKey(base: string, accountDid: string): string {
  return `${base}:${accountDid}`;
}

type KeyValueStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export interface PendingVoiceNoteJob {
  /** The create call's Idempotency-Key: the same key re-joins the same job. */
  attemptId: string;
  transcriptionId: string | null;
}

export interface VoiceNotePendingStore {
  read(sourceId: string): PendingVoiceNoteJob | null;
  write(sourceId: string, job: PendingVoiceNoteJob): void;
  clear(sourceId: string): void;
  sourceIds(): string[];
}

/** Best-effort: without it a relaunch uploads a note again instead of re-joining its job. */
export function localStorageVoiceNotePendingStore(
  accountDid: string,
  storage: Pick<KeyValueStorage, "getItem" | "setItem"> | undefined = globalThis.localStorage,
): VoiceNotePendingStore {
  const key = accountStorageKey(VOICE_NOTE_PENDING_JOBS_KEY, accountDid);
  const readAll = (): Record<string, PendingVoiceNoteJob> => {
    try {
      const raw = storage?.getItem(key);
      const parsed = raw ? (JSON.parse(raw) as unknown) : null;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      const out: Record<string, PendingVoiceNoteJob> = {};
      for (const [sourceId, value] of Object.entries(parsed as Record<string, unknown>)) {
        const v = value as Partial<PendingVoiceNoteJob> | null;
        if (!v || typeof v.attemptId !== "string") continue;
        out[sourceId] = { attemptId: v.attemptId, transcriptionId: typeof v.transcriptionId === "string" ? v.transcriptionId : null };
      }
      return out;
    } catch {
      return {};
    }
  };
  const writeAll = (all: Record<string, PendingVoiceNoteJob>) => {
    try {
      storage?.setItem(key, JSON.stringify(all));
    } catch {
      // Best-effort.
    }
  };
  return {
    read: (sourceId) => readAll()[sourceId] ?? null,
    write: (sourceId, job) => writeAll({ ...readAll(), [sourceId]: job }),
    clear: (sourceId) => {
      const all = readAll();
      if (!(sourceId in all)) return;
      delete all[sourceId];
      writeAll(all);
    },
    sourceIds: () => Object.keys(readAll()),
  };
}

export interface VoiceNoteConsentStore {
  get(): boolean;
  set(consented: boolean): void;
}

export function localStorageVoiceNoteConsentStore(
  accountDid: string,
  storage: KeyValueStorage | undefined = globalThis.localStorage,
): VoiceNoteConsentStore {
  const key = accountStorageKey(VOICE_NOTE_CONSENT_KEY, accountDid);
  return {
    get: () => {
      try {
        return storage?.getItem(key) === "1";
      } catch {
        return false;
      }
    },
    set: (consented) => {
      try {
        if (consented) storage?.setItem(key, "1");
        else storage?.removeItem(key);
      } catch {
        // Best-effort: the choice then lasts for this session only.
      }
    },
  };
}

// ── Transcript → note ──────────────────────────────────────────────────

/** A voice note has one speaker: whoever held the phone. Same label as Exo Local's mic channel. */
export const VOICE_NOTE_SPEAKER = "You";

/**
 * PTX segments (one speech region each, ≤ 30 s) as readable sentences: in
 * time order, consecutive regions merged into turns of at most
 * MAX_TURN_SECONDS (the readable-transcripts rule Exo Local uses, which keeps
 * each sentence under meeting chat's excerpt span).
 */
export function voiceNoteSentences(transcript: Pick<PrivateCloudTranscript, "segments">): FirefliesSentence[] {
  const segments = transcript.segments
    .map((seg) => ({ start: seg.start, end: seg.end, text: typeof seg.text === "string" ? seg.text.trim() : "" }))
    .filter((seg) => seg.text.length > 0 && Number.isFinite(seg.start) && Number.isFinite(seg.end))
    .sort((a, b) => a.start - b.start);
  const turns: { start: number; end: number; texts: string[] }[] = [];
  for (const seg of segments) {
    const last = turns[turns.length - 1];
    if (last !== undefined && Math.max(last.end, seg.end) - last.start <= MAX_TURN_SECONDS) {
      last.texts.push(seg.text);
      last.end = Math.max(last.end, seg.end);
      continue;
    }
    turns.push({ start: seg.start, end: seg.end, texts: [seg.text] });
  }
  return turns.map((turn, index) => ({
    index,
    speaker_name: VOICE_NOTE_SPEAKER,
    text: turn.texts.join(" "),
    start_time: turn.start,
    end_time: turn.end,
  }));
}

/** Engine metadata, as the desktop's private cloud transcripts record it. */
function engineMetadata(transcribedAt: string) {
  return {
    transcription_engine: "private-cloud",
    transcript_provider: "tinycloud-private-transcription",
    transcribed_at: transcribedAt,
  };
}

/** The transcript as it is saved onto the note. No sentences = the no-speech outcome. */
export function prepareVoiceNoteTranscript(transcript: PrivateCloudTranscript, transcribedAt: string): VoiceNoteTranscriptSave {
  const sentences = voiceNoteSentences(transcript);
  if (sentences.length === 0) return noSpeechTranscript(transcribedAt);
  return {
    sentences,
    speakers: [VOICE_NOTE_SPEAKER],
    metadata: {
      ...engineMetadata(transcribedAt),
      inference_provider: transcript.provider ?? "tinfoil",
      model: transcript.model ?? null,
      language: transcript.language ?? null,
      transcript_text: sentences.map((s) => s.text).join("\n"),
      transcription_outcome: "transcribed",
      // One speaker, one sentence per merged run of speech regions.
      speaker_labels: "single-speaker",
    },
  };
}

/** PTX found no speech: recorded on the note so it is not offered again. */
export function noSpeechTranscript(transcribedAt: string): VoiceNoteTranscriptSave {
  return {
    sentences: [],
    speakers: [],
    metadata: { ...engineMetadata(transcribedAt), transcript_text: null, transcription_outcome: "no_speech" },
  };
}

// ── The engine ─────────────────────────────────────────────────────────

/** Progress of one note's transcription. */
export type VoiceNoteTranscriptionStatus =
  | { kind: "waiting" }
  | { kind: "preparing" }
  | { kind: "uploading" }
  | { kind: "queued"; position: number | null }
  | { kind: "processing"; completed: number | null; total: number | null }
  | { kind: "saving" };

export interface CloudPollingOptions {
  intervalMs: number;
  slowIntervalMs: number;
  slowAfterMs: number;
  giveUpAfterMs: number;
}

/** The desktop's polling (plan §4.7): 5 s ± 20 %, 30 s after a minute of transient failures, give up after 10. */
const DEFAULT_POLLING: CloudPollingOptions = {
  intervalMs: 5_000,
  slowIntervalMs: 30_000,
  slowAfterMs: 60_000,
  giveUpAfterMs: 10 * 60_000,
};

export interface CloudClock {
  now(): number;
  sleep(ms: number): Promise<void>;
  random(): number;
}

const REAL_CLOCK: CloudClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: () => Math.random(),
};

/**
 * Failures after which PTX has ended the note's job (or it is gone): it is
 * forgotten, so Retry (if any) starts a new one.
 */
const JOB_ENDED_CODES: ReadonlySet<string> = new Set([
  "failed",
  "cancelled",
  "upload_expired",
  "upload_integrity_failed",
  "invalid_audio",
  "recording_too_long",
  "no_speech",
  "provider_unavailable",
  "provider_outcome_unknown",
  "processing_timeout",
  "processing_failed",
  "transcription_failed",
  "transcript_expired",
  "transcription_not_found",
]);

/**
 * Failures after which the note's job is of no use, though it may still be
 * waiting for an upload (and so hold the account's one active slot until its
 * 2 h deadline): it is cancelled at PTX and forgotten.
 */
const RELEASE_CODES: ReadonlySet<string> = new Set([
  "recording_too_large",
  "unsupported_recording",
  "service_misconfigured",
  "recording_too_long_for_phone",
  "decode_failed",
  "decode_unavailable",
  "feature_unavailable",
  "invalid_argument",
  "idempotency_conflict",
  "voice_note_not_found",
  "transcription_off",
]);

/** Failures Retry cannot fix for this note. */
const NOT_RETRYABLE_CODES: ReadonlySet<string> = new Set([
  "recording_too_large",
  "recording_too_long",
  "recording_too_long_for_phone",
  "unsupported_recording",
  "invalid_audio",
  "no_speech",
  "decode_failed",
  "decode_unavailable",
  "feature_unavailable",
  "service_misconfigured",
  "invalid_argument",
  "voice_note_not_found",
  "transcription_off",
]);

export function voiceNoteErrorCode(err: unknown): string {
  return err instanceof PrivateCloudError || err instanceof VoiceNoteAudioError ? err.code : "transcription_error";
}

/** The user turned transcription off while this note was on its way. */
export function transcriptionOffError(): PrivateCloudError {
  return new PrivateCloudError("transcription_off", "Transcription was turned off.");
}

/** Contract field: the formats PTX takes, from capabilities (the relay's three when absent). */
export function acceptedContentTypes(capabilities: PrivateCloudCapabilities): string[] {
  const listed = capabilities.content_types;
  return Array.isArray(listed) && listed.every((t) => typeof t === "string")
    ? (listed as string[])
    : ["audio/mpeg", "audio/wav", "audio/ogg"];
}

/** The longest note offered: this app's v1 limit, or PTX's when lower. */
export function maxTranscriptionSeconds(capabilities: PrivateCloudCapabilities | null): number {
  const ptx = capabilities?.max_duration_seconds;
  return typeof ptx === "number" && ptx > 0 ? Math.min(ptx, VOICE_NOTE_TRANSCRIPTION_MAX_SECONDS) : VOICE_NOTE_TRANSCRIPTION_MAX_SECONDS;
}

export interface VoiceNoteCloudDeps {
  api: PrivateCloudApi;
  create: (request: { attemptId: string; correlationId: string; body: PrivateCloudCreateBody }) => Promise<PrivateCloudCreated>;
  put: PtxPut;
  origin: string;
  pending: VoiceNotePendingStore;
  /** Whether this device's native HTTP can send the upload (Android below 8.0 cannot). */
  uploadSupported?: () => Promise<boolean>;
  clock?: CloudClock;
  polling?: Partial<CloudPollingOptions>;
  newId?: () => string;
  decode?: AudioDecoder;
  /** Sent with every job (PTX requires one to label the result). The desktop sends "en" too. */
  language?: string;
}

export interface VoiceNoteTranscribeInput {
  sourceId: string;
  capabilities: PrivateCloudCapabilities;
  loadAudio: () => Promise<VoiceNoteAudio>;
  /** The note's length from its row, checked before any audio is read or decoded. */
  durationSeconds?: number | null;
  /** Still allowed to send audio? Asked before the job is created and again right before the upload. */
  allowed?: () => boolean;
}

export interface VoiceNoteCloud {
  /** Null when this device cannot upload, or the relay is dark / the account is not in the cohort (404). */
  capabilities(): Promise<PrivateCloudCapabilities | null>;
  /** Notes with a job in flight (to resume after a relaunch). */
  pendingSourceIds(): string[];
  /** Upload (or re-join) the note's job and wait for its transcript. */
  transcribe(
    input: VoiceNoteTranscribeInput,
    report: (status: VoiceNoteTranscriptionStatus) => void,
  ): Promise<{ transcriptionId: string; transcript: PrivateCloudTranscript }>;
  /**
   * The note's transcript is saved (or it needs none): forget its job, then
   * delete it at PTX. Forgotten first, so a failed delete never makes a later
   * run upload the note again; PTX deletes it on its own 24 h schedule.
   */
  finish(sourceId: string, transcriptionId?: string | null): Promise<void>;
  /** Transcription was turned off: cancel and forget every job still waiting for its upload. */
  releaseUnsent(): Promise<void>;
}

function jobFailure(job: PrivateCloudJob, extra: { correlationId?: string | null } = {}): PrivateCloudError {
  return new PrivateCloudError(job.error?.code ?? job.status, job.error?.message ?? `The transcription ${job.status}`, {
    transcriptionId: job.id,
    correlationId: extra.correlationId ?? null,
  });
}

export function createVoiceNoteCloud(deps: VoiceNoteCloudDeps): VoiceNoteCloud {
  const clock = deps.clock ?? REAL_CLOCK;
  const polling: CloudPollingOptions = { ...DEFAULT_POLLING, ...deps.polling };
  const pending = deps.pending;
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const language = deps.language ?? "en";
  const sleep = (baseMs: number) => clock.sleep(Math.round(baseMs * (0.8 + 0.4 * clock.random())));

  /** Best-effort: a job that cannot be cancelled now expires at its upload deadline. */
  const cancelQuietly = async (transcriptionId: string) => {
    try {
      await deps.api.cancel(transcriptionId);
    } catch (err) {
      console.warn("Cancelling an unused private cloud job failed; it expires on its own", err);
    }
  };

  /** Stop using the note's job: cancel it (if it exists) and forget it. */
  const release = async (sourceId: string) => {
    const transcriptionId = pending.read(sourceId)?.transcriptionId ?? null;
    pending.clear(sourceId);
    if (transcriptionId !== null) await cancelQuietly(transcriptionId);
  };

  /** Rides out transient failures for up to 10 minutes, then "connection lost". */
  const transientTolerance = () => {
    let failingSince: number | null = null;
    return {
      reset: () => {
        failingSince = null;
      },
      rideOut: async (err: unknown) => {
        if (!isTransientCloudError(err)) throw err;
        const now = clock.now();
        failingSince ??= now;
        const failingFor = now - failingSince;
        if (failingFor >= polling.giveUpAfterMs) {
          throw new PrivateCloudError(
            "connection_lost",
            "Lost contact with private cloud transcription for 10 minutes. The job may still be running.",
          );
        }
        await sleep(failingFor >= polling.slowAfterMs ? polling.slowIntervalMs : polling.intervalMs);
      },
    };
  };

  const readJob = async (id: string): Promise<PrivateCloudJob> => {
    const tolerance = transientTolerance();
    for (;;) {
      try {
        return await deps.api.get(id);
      } catch (err) {
        await tolerance.rideOut(err);
      }
    }
  };

  const poll = async (id: string, report: (s: VoiceNoteTranscriptionStatus) => void): Promise<PrivateCloudTranscript> => {
    const tolerance = transientTolerance();
    report({ kind: "queued", position: null });
    for (;;) {
      let job: PrivateCloudJob;
      try {
        job = await deps.api.get(id);
      } catch (err) {
        await tolerance.rideOut(err);
        continue;
      }
      if (job.status === "completed") {
        let result: Awaited<ReturnType<PrivateCloudApi["result"]>>;
        try {
          result = await deps.api.result(id);
        } catch (err) {
          await tolerance.rideOut(err);
          continue;
        }
        tolerance.reset();
        if (result.status === "completed") return result.transcript;
        if (result.status !== "pending") throw result.error;
      } else {
        tolerance.reset();
        if (job.status === "failed" || job.status === "cancelled") throw jobFailure(job);
        if (job.status === "awaiting_upload") {
          throw new PrivateCloudError("upload_interrupted", "PTX has not received the recording", { transcriptionId: id });
        }
        report(
          job.status === "queued"
            ? { kind: "queued", position: job.progress?.queue_position ?? null }
            : { kind: "processing", completed: job.progress?.regions_completed ?? null, total: job.progress?.regions_total ?? null },
        );
      }
      await sleep(polling.intervalMs);
    }
  };

  const createJob = async (sourceId: string, job: PendingVoiceNoteJob, body: PrivateCloudCreateBody) => {
    let current = job;
    for (let fresh = 0; ; fresh++) {
      try {
        const created = await deps.create({ attemptId: current.attemptId, correlationId: newId(), body });
        return { job: current, created };
      } catch (err) {
        // This key was used for different bytes, or its job is gone: start a new job, once. A job
        // the old key made that still waits for its upload is cancelled first (it holds the slot).
        const code = err instanceof PrivateCloudError ? err.code : null;
        if (fresh > 0 || (code !== "idempotency_conflict" && code !== "transcription_not_found")) throw err;
        if (current.transcriptionId !== null) await cancelQuietly(current.transcriptionId);
        current = { attemptId: newId(), transcriptionId: null };
        pending.write(sourceId, current);
      }
    }
  };

  const run = async (
    { sourceId, capabilities, loadAudio, durationSeconds, allowed = () => true }: VoiceNoteTranscribeInput,
    report: (status: VoiceNoteTranscriptionStatus) => void,
  ) => {
    let job = pending.read(sourceId);

    // Re-join a job this note already has: ask before uploading again.
    if (job?.transcriptionId) {
      let current: PrivateCloudJob | null = null;
      try {
        current = await readJob(job.transcriptionId);
      } catch (err) {
        if (!(err instanceof PrivateCloudError && err.code === "transcription_not_found")) throw err;
        job = null;
        pending.clear(sourceId);
      }
      if (current !== null) {
        if (current.status === "failed" || current.status === "cancelled") throw jobFailure(current);
        if (current.status !== "awaiting_upload") return { transcriptionId: current.id, transcript: await poll(current.id, report) };
      }
    }

    // Everything up to the upload happens with no job waiting on it, or releases the one that is.
    const maxSeconds = maxTranscriptionSeconds(capabilities);
    let audio: Awaited<ReturnType<typeof prepareTranscriptionAudio>>;
    try {
      if (typeof durationSeconds === "number" && durationSeconds > maxSeconds) {
        throw new VoiceNoteAudioError("recording_too_long_for_phone", "This note is too long to transcribe from the phone.");
      }
      if (!allowed()) throw transcriptionOffError();
      report({ kind: "preparing" });
      audio = await prepareTranscriptionAudio(await loadAudio(), {
        acceptedContentTypes: acceptedContentTypes(capabilities),
        maxBytes: capabilities.max_bytes,
        maxSeconds,
        decode: deps.decode,
      });
      if (!allowed()) throw transcriptionOffError();
    } catch (err) {
      await release(sourceId);
      throw err;
    }
    if (job === null) {
      job = { attemptId: newId(), transcriptionId: null };
      pending.write(sourceId, job);
    }
    const body: PrivateCloudCreateBody = {
      content_type: audio.contentType,
      byte_size: audio.byteSize,
      sha256: audio.sha256,
      language,
      // Mono, and labelled so no other client on this account adopts the job (privateCloudJobClient).
      channel_mode: "mixed",
      channel_labels: [...VOICE_NOTE_CHANNEL_LABELS],
    };
    const createdJob = await createJob(sourceId, job, body);
    job = { ...createdJob.job, transcriptionId: createdJob.created.id };
    pending.write(sourceId, job);
    const created = createdJob.created;

    if (created.upload !== null) {
      // The last moment to stop: nothing has been sent yet.
      if (!allowed()) throw transcriptionOffError();
      report({ kind: "uploading" });
      const correlationId = newId();
      try {
        const url = ptxUploadUrl(deps.origin, created.upload.path);
        interpretUploadResponse(
          await deps.put({ url, capability: created.upload.capability, contentType: audio.contentType, base64: audio.base64, correlationId }),
          correlationId,
        );
      } catch (err) {
        if (!(err instanceof PrivateCloudError)) throw err;
        // Only the job's status says whether the bytes landed.
        const current = await readJob(created.id);
        if (current.status === "awaiting_upload") throw err; // Retry re-uploads (same job, fresh capability)
        if (current.status === "failed" || current.status === "cancelled") {
          throw jobFailure(current, { correlationId: err.correlationId });
        }
        // Accepted despite the error: carry on as if the 201 had arrived.
      }
    }
    return { transcriptionId: created.id, transcript: await poll(created.id, report) };
  };

  return {
    async capabilities() {
      if (deps.uploadSupported && !(await deps.uploadSupported())) return null;
      return deps.api.capabilities();
    },

    pendingSourceIds: () => pending.sourceIds(),

    async transcribe(input, report) {
      try {
        return await run(input, report);
      } catch (err) {
        const code = voiceNoteErrorCode(err);
        if (RELEASE_CODES.has(code)) await release(input.sourceId);
        else if (JOB_ENDED_CODES.has(code)) pending.clear(input.sourceId);
        throw err;
      }
    },

    async finish(sourceId, transcriptionId) {
      const id = transcriptionId === undefined ? (pending.read(sourceId)?.transcriptionId ?? null) : transcriptionId;
      pending.clear(sourceId);
      if (id !== null) await deps.api.remove(id);
    },

    async releaseUnsent() {
      for (const sourceId of pending.sourceIds()) {
        const transcriptionId = pending.read(sourceId)?.transcriptionId ?? null;
        if (transcriptionId === null) {
          pending.clear(sourceId);
          continue;
        }
        let job: PrivateCloudJob;
        try {
          job = await deps.api.get(transcriptionId);
        } catch (err) {
          if (err instanceof PrivateCloudError && err.code === "transcription_not_found") pending.clear(sourceId);
          // Unknown right now: it is checked again (and released) by the next run or turn-off.
          continue;
        }
        if (job.status === "awaiting_upload") await release(sourceId);
        else if (job.status === "failed" || job.status === "cancelled") pending.clear(sourceId);
        // queued / processing / completed: the audio was already sent; its transcript is still saved.
      }
    },
  };
}

/** The real engine, or null when this build has no PTX origin (hidden). */
export function createVoiceNoteCloudForBuild(
  backendUrl: string,
  sessionStore: SessionStore,
  accountDid: string,
): VoiceNoteCloud | null {
  const origin = buildPtxUploadOrigin();
  if (origin === null) return null;
  return createVoiceNoteCloud({
    api: createPrivateCloudApi(backendUrl, { sessionStore }),
    create: (request) => createPrivateCloudJob(backendUrl, { sessionStore }, request),
    put: capacitorPtxPut,
    origin,
    pending: localStorageVoiceNotePendingStore(accountDid),
    uploadSupported: () => nativeHttpFileUploadSupported(),
  });
}

// ── One note, end to end ───────────────────────────────────────────────

/** A failure as the card shows it. */
export interface VoiceNoteTranscriptionFailure {
  code: string;
  message: string;
  retryable: boolean;
  /** Correlation id, shown as a reference. */
  reference: string | null;
}

export function voiceNoteTranscriptionFailure(err: unknown): VoiceNoteTranscriptionFailure {
  const code = voiceNoteErrorCode(err);
  const reference = err instanceof PrivateCloudError ? err.correlationId : null;
  const minutes = Math.round(VOICE_NOTE_TRANSCRIPTION_MAX_SECONDS / 60);
  let message: string;
  switch (code) {
    case "recording_too_long_for_phone":
    case "recording_too_long":
    case "recording_too_large":
      message = `Notes up to ${minutes} minutes can be transcribed from the phone.`;
      break;
    case "decode_failed":
    case "decode_unavailable":
      message = "This phone could not read the recording to transcribe it.";
      break;
    case "no_speech":
      message = "No speech was found in this note.";
      break;
    case "active_transcription_exists":
      message =
        "Another private cloud transcription for your account hasn't finished (an unfinished upload expires within 2 hours). Try again later.";
      break;
    case "connection_lost":
      message = "Lost contact with private cloud transcription. The job may still be running; Retry checks on it.";
      break;
    case "feature_unavailable":
      message = "Private cloud transcription is not available for this account.";
      break;
    case "voice_note_not_found":
      message = "This voice note no longer exists.";
      break;
    case "transcript_save_failed":
      message = "The transcript could not be saved to your space. Retry saves it again.";
      break;
    case "note_unreadable":
      message = "Could not read this note from your space just now. Retry tries again.";
      break;
    case "transcription_off":
      message = "Transcription was turned off.";
      break;
    default:
      message =
        err instanceof PrivateCloudError
          ? privateCloudMessage(err)
          : `Transcription failed: ${err instanceof Error ? err.message : String(err)}`;
  }
  return { code, message, retryable: !NOT_RETRYABLE_CODES.has(code), reference };
}

/**
 * Transcribe one saved note and write the transcript onto it, then delete the
 * PTX job. `audio` is the note's audio when the caller still has it (just
 * recorded); otherwise it is read back from the space. A note whose row
 * already records an outcome is not transcribed again (its leftover job, if
 * any, is forgotten and deleted). `allowed` is asked before anything is sent.
 * Resolves with what the note now records; rejects with the failure to show.
 */
export async function transcribeVoiceNote(args: {
  tcw: TinyCloudWeb;
  cloud: VoiceNoteCloud;
  capabilities: PrivateCloudCapabilities;
  sourceId: string;
  audio?: VoiceNoteAudio;
  allowed?: () => boolean;
  report: (status: VoiceNoteTranscriptionStatus) => void;
  now?: () => Date;
}): Promise<"transcribed" | "no_speech"> {
  const { tcw, cloud, sourceId, report } = args;
  const transcribedAt = () => (args.now?.() ?? new Date()).toISOString();
  /** The job is done with: forget it, then delete it at PTX (best-effort: PTX deletes it within 24 h). */
  const finish = async (transcriptionId?: string | null) => {
    try {
      await cloud.finish(sourceId, transcriptionId);
    } catch (err) {
      console.warn("Deleting a finished private cloud job failed; PTX deletes it on its own schedule", err);
    }
  };

  const note = await readVoiceNoteForTranscription(tcw, sourceId);
  if (!note.ok) throw new PrivateCloudError("note_unreadable", note.error.message);
  if (note.data === null) {
    await finish();
    throw new PrivateCloudError("voice_note_not_found", "The voice note no longer exists");
  }
  if (note.data.transcript.status !== "none") {
    await finish();
    return note.data.transcript.status;
  }

  const loadAudio = async (): Promise<VoiceNoteAudio> => {
    if (args.audio) return args.audio;
    // Bounded like the decode: a note over the phone's limit is refused from its manifest, unread.
    const res = await loadVoiceNoteAudio(tcw, sourceId, { maxBytes: VOICE_NOTE_TRANSCRIPTION_MAX_SECONDS * MAX_ENCODED_BYTES_PER_SECOND });
    if (!res.ok) {
      if (res.error.code === VOICE_NOTE_AUDIO_TOO_LARGE) {
        throw new VoiceNoteAudioError("recording_too_long_for_phone", "This note is too long to transcribe from the phone.");
      }
      throw new Error(`Could not read the note's audio: ${res.error.message}`);
    }
    return res.data;
  };
  const save = async (prepared: VoiceNoteTranscriptSave) => {
    report({ kind: "saving" });
    const saved = await saveVoiceNoteTranscript(tcw, sourceId, prepared);
    if (!saved.ok) {
      if (saved.error.code === "VOICE_NOTE_NOT_FOUND") throw new PrivateCloudError("voice_note_not_found", saved.error.message);
      throw new PrivateCloudError("transcript_save_failed", saved.error.message);
    }
  };

  let transcriptionId: string;
  let transcript: PrivateCloudTranscript;
  try {
    ({ transcriptionId, transcript } = await cloud.transcribe(
      { sourceId, capabilities: args.capabilities, loadAudio, durationSeconds: note.data.durationSeconds, allowed: args.allowed },
      report,
    ));
  } catch (err) {
    if (voiceNoteErrorCode(err) !== "no_speech") throw err;
    // Silence is an outcome, not a failure: recorded so the note is not offered again.
    await save(noSpeechTranscript(transcribedAt()));
    await finish(err instanceof PrivateCloudError ? err.transcriptionId : null);
    return "no_speech";
  }
  const prepared = prepareVoiceNoteTranscript(transcript, transcribedAt());
  try {
    await save(prepared);
  } catch (err) {
    if (err instanceof PrivateCloudError && err.code === "voice_note_not_found") await finish(transcriptionId);
    // Otherwise the job keeps its transcript: Retry re-joins it and saves again.
    throw err;
  }
  await finish(transcriptionId);
  return prepared.sentences.length > 0 ? "transcribed" : "no_speech";
}

// ── The card's transcription state, one per account ────────────────────

/**
 * One note's transcription as the card shows it. `done` stays until the
 * refreshed list shows the saved outcome, so a stale row never offers
 * Transcribe for a note that was just transcribed.
 */
export type NoteTranscriptionState =
  | { kind: "active"; status: VoiceNoteTranscriptionStatus }
  | { kind: "done"; outcome: "transcribed" | "no_speech" }
  | ({ kind: "failed" } & VoiceNoteTranscriptionFailure);

export type TranscriptionAvailability = "checking" | "available" | "hidden" | "failed";

export interface VoiceNoteTranscriberSnapshot {
  availability: TranscriptionAvailability;
  capabilities: PrivateCloudCapabilities | null;
  consented: boolean;
  jobs: ReadonlyMap<string, NoteTranscriptionState>;
}

/** `saved`: a note's outcome was written to the space (refresh the list). */
export type VoiceNoteTranscriberEvent = { kind: "changed" } | { kind: "saved"; sourceId: string };

export interface VoiceNoteTranscriber {
  snapshot(): VoiceNoteTranscriberSnapshot;
  subscribe(listener: (event: VoiceNoteTranscriberEvent) => void): () => void;
  /** Whether private cloud can be offered (bounded retries when the check itself fails). */
  check(): Promise<void>;
  /** The one-time "Use private cloud". Resumes notes a previous run left in flight. */
  consent(): void;
  /** Stops sending: waiting notes are dropped, the running one stops before its upload, unsent jobs are cancelled. */
  turnOff(): Promise<void>;
  /** Transcribe / Retry for one note. Only while available and consented. */
  transcribe(sourceId: string, audio?: VoiceNoteAudio): void;
  /** A recording was just saved: transcribed when on and within the limit. */
  noteSaved(recording: { id: string; durationMs: number }, audio?: VoiceNoteAudio): void;
}

export interface VoiceNoteTranscriberDeps {
  /** Null when this build cannot transcribe (no PTX origin): always hidden. */
  cloud: VoiceNoteCloud | null;
  consent: VoiceNoteConsentStore;
  /** The current session's space client. */
  tcw: () => TinyCloudWeb;
  /** Injected in tests. */
  runNote?: typeof transcribeVoiceNote;
  sleep?: (ms: number) => Promise<void>;
  /** Waits between availability checks after one fails (plus the first try), as on the desktop. */
  checkRetryMs?: readonly number[];
}

export function createVoiceNoteTranscriber(deps: VoiceNoteTranscriberDeps): VoiceNoteTranscriber {
  const runNote = deps.runNote ?? transcribeVoiceNote;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const checkRetryMs = deps.checkRetryMs ?? [2_000, 5_000];
  const cloud = deps.cloud;
  const listeners = new Set<(event: VoiceNoteTranscriberEvent) => void>();
  const jobs = new Map<string, NoteTranscriptionState>();
  /** Notes queued but not started; turning off empties it, and a dropped note never starts. */
  const waiting = new Set<string>();
  let state: Omit<VoiceNoteTranscriberSnapshot, "jobs"> = {
    availability: cloud === null ? "hidden" : "checking",
    capabilities: null,
    consented: deps.consent.get(),
  };
  let snapshot: VoiceNoteTranscriberSnapshot = { ...state, jobs: new Map(jobs) };
  let chain: Promise<void> = Promise.resolve();
  let resumed = false;
  let checking: Promise<void> | null = null;

  const emit = (event: VoiceNoteTranscriberEvent = { kind: "changed" }) => {
    snapshot = { ...state, jobs: new Map(jobs) };
    for (const listener of listeners) listener(event);
  };
  const on = () => state.availability === "available" && state.consented && state.capabilities !== null;

  const enqueue = (sourceId: string, audio?: VoiceNoteAudio) => {
    if (!on() || cloud === null) return;
    // Queued, running, or just saved (the list may not show it yet): never a second job.
    const current = jobs.get(sourceId);
    if (current?.kind === "active" || current?.kind === "done") return;
    jobs.set(sourceId, { kind: "active", status: { kind: "waiting" } });
    waiting.add(sourceId);
    emit();
    chain = chain.then(async () => {
      // Dropped by turn-off while it waited, or turned off since: never starts.
      if (!waiting.delete(sourceId)) return;
      if (!on() || state.capabilities === null) {
        jobs.delete(sourceId);
        emit();
        return;
      }
      try {
        const outcome = await runNote({
          tcw: deps.tcw(),
          cloud,
          capabilities: state.capabilities,
          sourceId,
          audio,
          allowed: () => state.consented,
          report: (status) => {
            if (jobs.get(sourceId)?.kind !== "active") return;
            jobs.set(sourceId, { kind: "active", status });
            emit();
          },
        });
        jobs.set(sourceId, { kind: "done", outcome });
        emit({ kind: "saved", sourceId });
      } catch (err) {
        // Whatever stopped a note after the user turned transcription off is not a failure to show.
        if (!state.consented || voiceNoteErrorCode(err) === "transcription_off") jobs.delete(sourceId);
        else jobs.set(sourceId, { kind: "failed", ...voiceNoteTranscriptionFailure(err) });
        emit();
      }
    });
  };

  /** Notes a previous run left in flight, first (one active job per account). Once per transcriber. */
  const resume = () => {
    if (resumed || !on() || cloud === null) return;
    resumed = true;
    for (const sourceId of cloud.pendingSourceIds()) enqueue(sourceId);
  };

  return {
    snapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    check() {
      if (cloud === null) return Promise.resolve();
      if (checking !== null) return checking;
      // A re-check (every mount) keeps an answer it already has, so the card does not flicker.
      if (state.availability !== "available") {
        state = { ...state, availability: "checking" };
        emit();
      }
      const attempt = async () => {
        try {
          const caps = await cloud.capabilities();
          return caps === null ? ({ availability: "hidden" } as const) : ({ availability: "available", caps } as const);
        } catch (err) {
          console.warn("Checking private cloud transcription failed", err);
          return { availability: "failed" } as const;
        }
      };
      checking = (async () => {
        let result = await attempt();
        for (const waitMs of checkRetryMs) {
          if (result.availability !== "failed") break;
          await sleep(waitMs);
          result = await attempt();
        }
        state = {
          ...state,
          availability: result.availability,
          capabilities: result.availability === "available" ? result.caps : null,
        };
        emit();
        resume();
      })().finally(() => {
        checking = null;
      });
      return checking;
    },

    consent() {
      deps.consent.set(true);
      state = { ...state, consented: true };
      emit();
      resume();
    },

    async turnOff() {
      deps.consent.set(false);
      state = { ...state, consented: false };
      for (const sourceId of waiting) jobs.delete(sourceId);
      waiting.clear();
      // A failure shown with Retry is no longer actionable once off.
      for (const [sourceId, job] of jobs) if (job.kind === "failed") jobs.delete(sourceId);
      resumed = false;
      emit();
      try {
        await cloud?.releaseUnsent();
      } catch (err) {
        console.warn("Releasing unsent private cloud jobs failed; they expire on their own", err);
      }
    },

    transcribe(sourceId, audio) {
      enqueue(sourceId, audio);
    },

    noteSaved(recording, audio) {
      if (!on()) return;
      if (recording.durationMs / 1000 > maxTranscriptionSeconds(state.capabilities)) return; // the card says why
      enqueue(recording.id, audio);
    },
  };
}

/** One transcriber per signed-in account, kept across mounts (StrictMode, tab switches). */
const transcribers = new Map<string, { transcriber: VoiceNoteTranscriber; tcw: { current: TinyCloudWeb } }>();

/** The account's transcriber; null without an account DID (nothing is offered then). */
export function voiceNoteTranscriberFor(
  tcw: TinyCloudWeb,
  backendUrl: string,
  sessionStore: SessionStore,
): VoiceNoteTranscriber | null {
  const did = (tcw as { did?: unknown }).did;
  if (typeof did !== "string" || did.length === 0) return null;
  const existing = transcribers.get(did);
  if (existing) {
    existing.tcw.current = tcw;
    return existing.transcriber;
  }
  const ref = { current: tcw };
  const transcriber = createVoiceNoteTranscriber({
    cloud: createVoiceNoteCloudForBuild(backendUrl, sessionStore, did),
    consent: localStorageVoiceNoteConsentStore(did),
    tcw: () => ref.current,
  });
  transcribers.set(did, { transcriber, tcw: ref });
  return transcriber;
}

/** Progress copy for the card. */
export function transcriptionStatusText(status: VoiceNoteTranscriptionStatus): string {
  switch (status.kind) {
    case "waiting":
      return "Waiting to transcribe…";
    case "preparing":
      return "Preparing the audio…";
    case "uploading":
      return "Uploading to private cloud…";
    case "queued":
      return status.position !== null && status.position > 0 ? `Queued (position ${status.position})…` : "Queued…";
    case "processing":
      return status.total !== null && status.total > 0
        ? `Transcribing in private cloud… ${status.completed ?? 0}/${status.total}`
        : "Transcribing in private cloud…";
    case "saving":
      return "Saving the transcript…";
  }
}
