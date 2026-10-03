// Private cloud transcription for Exo mobile voice notes.
//
// The same path the desktop's "Private cloud" engine uses (plan §4.4,
// lib/privateCloud.ts, desktop/src-tauri/src/cloud), with the webview doing
// what the desktop's native code does:
//
//   1. capabilities: the backend answers 200 only while the relay is armed and
//      this account is in its cohort (404 otherwise = hidden). Like the
//      desktop, the engine is also hidden unless this BUILD has a PTX upload
//      origin (VITE_EXO_PTX_UPLOAD_ORIGIN); the backend never names one.
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
  createPrivateCloudApi,
  createPrivateCloudJob,
  isTransientCloudError,
  PrivateCloudError,
  privateCloudMessage,
  UPLOAD_PATH_RE,
  type PrivateCloudApi,
  type PrivateCloudCapabilities,
  type PrivateCloudCreateBody,
  type PrivateCloudCreated,
  type PrivateCloudJob,
  type PrivateCloudTranscript,
} from "../privateCloud";
import {
  prepareTranscriptionAudio,
  VOICE_NOTE_TRANSCRIPTION_MAX_SECONDS,
  VoiceNoteAudioError,
  type AudioDecoder,
} from "./voiceNoteAudio";
import {
  loadVoiceNoteAudio,
  saveVoiceNoteTranscript,
  type VoiceNoteAudio,
  type VoiceNoteTranscriptSave,
} from "./voiceNoteStore";

// ── Build configuration ────────────────────────────────────────────────

/**
 * The PTX origin audio may be uploaded to, or null (the engine is hidden).
 * A bare origin only: https, or http to a loopback port in dev builds.
 */
export function parsePtxUploadOrigin(raw: string | null | undefined, allowLoopbackHttp: boolean): string | null {
  const value = raw?.trim() ?? "";
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && allowLoopbackHttp && loopback && url.port !== "")) return null;
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") return null;
  if (value.replace(/\/$/, "") !== url.origin) return null;
  return url.origin;
}

/** This build's PTX upload origin (unset in every build today: the engine stays hidden). */
export function buildPtxUploadOrigin(): string | null {
  return parsePtxUploadOrigin(import.meta.env.VITE_EXO_PTX_UPLOAD_ORIGIN, import.meta.env.DEV === true);
}

/** Joins a backend-issued upload path to the build's origin; anything but `/uploads/trn_…` is refused. */
export function ptxUploadUrl(origin: string, path: string): string {
  if (!UPLOAD_PATH_RE.test(path)) throw new PrivateCloudError("upstream_bad_response", "The upload path is not a PTX upload path");
  const url = new URL(path, origin);
  if (url.origin !== origin || url.pathname !== path) {
    throw new PrivateCloudError("upstream_bad_response", "The upload path leaves the PTX origin");
  }
  return url.toString();
}

// ── Upload ─────────────────────────────────────────────────────────────

export interface PtxPutRequest {
  url: string;
  capability: string;
  contentType: string;
  base64: string;
  correlationId: string;
}

export interface PtxPutResponse {
  status: number;
  body: unknown;
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

/** Codes PTX's upload answers may carry as themselves (desktop client.rs RELAYED_CODES). */
const RELAYED_UPLOAD_CODES: ReadonlySet<string> = new Set([
  "recording_too_large",
  "recording_too_long",
  "unsupported_recording",
  "invalid_audio",
  "no_speech",
  "quota_exceeded",
  "service_busy",
  "service_paused",
  "service_unavailable",
  "upload_expired",
  "upload_integrity_failed",
]);

/**
 * A PUT answer (desktop `upload_result`): 201 is the only success. Every other
 * answer is a stable code; except for the decisive ones, the job's status
 * decides what happened (PTX answers a replayed PUT of an accepted upload 401).
 */
export function interpretUploadResponse(response: PtxPutResponse, correlationId: string): void {
  if (response.status === 201) return;
  const body = (response.body && typeof response.body === "object" ? response.body : {}) as { error?: Record<string, unknown> };
  const e = body.error && typeof body.error === "object" ? body.error : {};
  const code = typeof e.code === "string" ? e.code : null;
  const jobError = e.job_error as { code?: unknown } | undefined;
  const jobErrorCode = typeof jobError?.code === "string" ? jobError.code : null;
  const fail = (failure: string, message: string) =>
    new PrivateCloudError(failure, message, {
      correlationId: typeof e.correlation_id === "string" ? e.correlation_id : correlationId,
      retryAfterSeconds: typeof e.retry_after_seconds === "number" ? e.retry_after_seconds : null,
    });
  const status = response.status;
  if (status >= 300 && status < 400) throw fail("service_misconfigured", "PTX answered with a redirect; it was not followed");
  if (status === 401) throw fail("upload_outcome_unknown", "PTX no longer accepts this upload; its status decides");
  if (status === 409 && code === "upload_in_progress") throw fail("upload_outcome_unknown", "Another upload of this recording is in progress");
  if (status === 400 || status === 408) throw fail("upload_interrupted", "PTX did not receive the whole recording");
  if (status === 410) throw fail("upload_capability_expired", "The upload permission expired");
  if (status === 413) throw fail("recording_too_large", "The recording is larger than the private cloud limit");
  if (status === 415) throw fail("unsupported_recording", "This recording format is not supported");
  if (status === 422) {
    throw jobErrorCode !== null && RELAYED_UPLOAD_CODES.has(jobErrorCode)
      ? fail(jobErrorCode, "PTX rejected the recording")
      : fail("upstream_bad_response", "PTX rejected the recording");
  }
  if ((status === 429 || status === 503) && code !== null && RELAYED_UPLOAD_CODES.has(code)) {
    throw fail(code, "PTX cannot take the upload right now");
  }
  throw fail("upload_outcome_unknown", "PTX's answer to the upload was unclear");
}

// ── Jobs in flight (per note) ──────────────────────────────────────────

export const VOICE_NOTE_PENDING_JOBS_KEY = "exo.voiceNotes.privateCloudJobs";

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
export function localStorageVoiceNotePendingStore(storage: Pick<Storage, "getItem" | "setItem"> | undefined = globalThis.localStorage): VoiceNotePendingStore {
  const readAll = (): Record<string, PendingVoiceNoteJob> => {
    try {
      const raw = storage?.getItem(VOICE_NOTE_PENDING_JOBS_KEY);
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
      storage?.setItem(VOICE_NOTE_PENDING_JOBS_KEY, JSON.stringify(all));
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

// ── Consent ────────────────────────────────────────────────────────────

/** The one-time "Use private cloud" for voice notes (its own key: the disclosure differs from the desktop's). */
export const VOICE_NOTE_CONSENT_KEY = "exo.voiceNotes.privateCloudConsent";

export function hasVoiceNoteTranscriptionConsent(): boolean {
  try {
    return globalThis.localStorage?.getItem(VOICE_NOTE_CONSENT_KEY) === "1";
  } catch {
    return false;
  }
}

export function setVoiceNoteTranscriptionConsent(consented: boolean): void {
  try {
    if (consented) globalThis.localStorage?.setItem(VOICE_NOTE_CONSENT_KEY, "1");
    else globalThis.localStorage?.removeItem(VOICE_NOTE_CONSENT_KEY);
  } catch {
    // Best-effort: the choice then lasts for this session only.
  }
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

/** Failures after which the note's job is over: Retry (if any) starts a new one. */
const JOB_ENDED_CODES: ReadonlySet<string> = new Set([
  "failed",
  "cancelled",
  "upload_expired",
  "upload_integrity_failed",
  "invalid_audio",
  "recording_too_long",
  "unsupported_recording",
  "no_speech",
  "provider_unavailable",
  "provider_outcome_unknown",
  "processing_timeout",
  "processing_failed",
  "transcription_failed",
  "transcript_expired",
  "transcription_not_found",
  "idempotency_conflict",
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
]);

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
  pending?: VoiceNotePendingStore;
  clock?: CloudClock;
  polling?: Partial<CloudPollingOptions>;
  newId?: () => string;
  decode?: AudioDecoder;
  /** Sent with every job (PTX requires one to label the result). The desktop sends "en" too. */
  language?: string;
}

export interface VoiceNoteCloud {
  /** Null when dark or not in the cohort (404). */
  capabilities(): Promise<PrivateCloudCapabilities | null>;
  /** Notes with a job in flight (to resume after a relaunch). */
  pendingSourceIds(): string[];
  /** Upload (or re-join) the note's job and wait for its transcript. */
  transcribe(
    input: { sourceId: string; capabilities: PrivateCloudCapabilities; loadAudio: () => Promise<VoiceNoteAudio> },
    report: (status: VoiceNoteTranscriptionStatus) => void,
  ): Promise<{ transcriptionId: string; transcript: PrivateCloudTranscript }>;
  /** After the transcript is saved: delete the job at PTX, then forget it. */
  finish(sourceId: string, transcriptionId: string | null): Promise<void>;
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
  const pending = deps.pending ?? localStorageVoiceNotePendingStore();
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const language = deps.language ?? "en";
  const sleep = (baseMs: number) => clock.sleep(Math.round(baseMs * (0.8 + 0.4 * clock.random())));

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
        // This key's job is gone, or the key was used for different bytes: start a new job, once.
        const code = err instanceof PrivateCloudError ? err.code : null;
        if (fresh > 0 || (code !== "idempotency_conflict" && code !== "transcription_not_found")) throw err;
        current = { attemptId: newId(), transcriptionId: null };
        pending.write(sourceId, current);
      }
    }
  };

  const run: VoiceNoteCloud["transcribe"] = async ({ sourceId, capabilities, loadAudio }, report) => {
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

    report({ kind: "preparing" });
    const audio = await prepareTranscriptionAudio(await loadAudio(), {
      acceptedContentTypes: acceptedContentTypes(capabilities),
      maxBytes: capabilities.max_bytes,
      maxSeconds: maxTranscriptionSeconds(capabilities),
      decode: deps.decode,
    });
    if (job === null) {
      job = { attemptId: newId(), transcriptionId: null };
      pending.write(sourceId, job);
    }
    const body: PrivateCloudCreateBody = {
      content_type: audio.contentType,
      byte_size: audio.byteSize,
      sha256: audio.sha256,
      language,
    };
    const createdJob = await createJob(sourceId, job, body);
    job = { ...createdJob.job, transcriptionId: createdJob.created.id };
    pending.write(sourceId, job);
    const created = createdJob.created;

    if (created.upload !== null) {
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
    capabilities: () => deps.api.capabilities(),
    pendingSourceIds: () => pending.sourceIds(),

    async transcribe(input, report) {
      try {
        return await run(input, report);
      } catch (err) {
        // A job that ended (or vanished) is forgotten, so Retry starts a new one.
        if (err instanceof PrivateCloudError && JOB_ENDED_CODES.has(err.code)) pending.clear(input.sourceId);
        // This note's audio cannot be sent: release a job still waiting for it
        // (it would hold the account's one active slot until it expires).
        if (err instanceof VoiceNoteAudioError) {
          const waiting = pending.read(input.sourceId)?.transcriptionId;
          if (waiting) await deps.api.cancel(waiting).catch(() => {});
          pending.clear(input.sourceId);
        }
        throw err;
      }
    },

    async finish(sourceId, transcriptionId) {
      // Forgotten only once PTX deleted it: until then Retry/relaunch re-joins
      // the job and (idempotently) saves its transcript again.
      if (transcriptionId !== null) await deps.api.remove(transcriptionId);
      pending.clear(sourceId);
    },
  };
}

/** The real engine, or null when this build has no PTX origin (hidden). */
export function createVoiceNoteCloudForBuild(backendUrl: string, sessionStore: SessionStore): VoiceNoteCloud | null {
  const origin = buildPtxUploadOrigin();
  if (origin === null) return null;
  return createVoiceNoteCloud({
    api: createPrivateCloudApi(backendUrl, { sessionStore }),
    create: (request) => createPrivateCloudJob(backendUrl, { sessionStore }, request),
    put: capacitorPtxPut,
    origin,
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
  const code =
    err instanceof PrivateCloudError || err instanceof VoiceNoteAudioError
      ? err.code
      : "transcription_error";
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
 * recorded); otherwise it is read back from the space. Resolves with what was
 * saved; rejects with the failure to show.
 */
export async function transcribeVoiceNote(args: {
  tcw: TinyCloudWeb;
  cloud: VoiceNoteCloud;
  capabilities: PrivateCloudCapabilities;
  sourceId: string;
  audio?: VoiceNoteAudio;
  report: (status: VoiceNoteTranscriptionStatus) => void;
  now?: () => Date;
}): Promise<"transcribed" | "no_speech"> {
  const { tcw, cloud, sourceId, report } = args;
  const transcribedAt = () => (args.now?.() ?? new Date()).toISOString();
  const loadAudio = async (): Promise<VoiceNoteAudio> => {
    if (args.audio) return args.audio;
    const res = await loadVoiceNoteAudio(tcw, sourceId);
    if (!res.ok) throw new Error(`Could not read the note's audio: ${res.error.message}`);
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
  /** The job is done with: delete it at PTX. A failed delete leaves it to PTX's 24 h schedule. */
  const finish = async (transcriptionId: string | null) => {
    try {
      await cloud.finish(sourceId, transcriptionId);
    } catch (err) {
      console.warn("Deleting a finished private cloud job failed; PTX deletes it on its own schedule", err);
    }
  };

  let transcriptionId: string;
  let transcript: PrivateCloudTranscript;
  try {
    ({ transcriptionId, transcript } = await cloud.transcribe({ sourceId, capabilities: args.capabilities, loadAudio }, report));
  } catch (err) {
    const code = err instanceof PrivateCloudError || err instanceof VoiceNoteAudioError ? err.code : null;
    if (code !== "no_speech") throw err;
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

// ── One at a time ──────────────────────────────────────────────────────

export type NoteTranscriptionState =
  | { kind: "active"; status: VoiceNoteTranscriptionStatus }
  | ({ kind: "failed" } & VoiceNoteTranscriptionFailure);

export type TranscriptionQueueEvent = { sourceId: string; outcome: "progress" | "saved" | "failed" };

export interface TranscriptionQueue {
  states(): ReadonlyMap<string, NoteTranscriptionState>;
  /** A note queued or running is not queued twice; a failed one is queued again. */
  enqueue(sourceId: string, task: (report: (status: VoiceNoteTranscriptionStatus) => void) => Promise<unknown>): void;
  subscribe(listener: (event: TranscriptionQueueEvent) => void): () => void;
}

/** Serial: PTX allows one active job per account, so notes wait their turn. */
export function createTranscriptionQueue(): TranscriptionQueue {
  const states = new Map<string, NoteTranscriptionState>();
  const listeners = new Set<(event: TranscriptionQueueEvent) => void>();
  let chain: Promise<void> = Promise.resolve();
  const emit = (event: TranscriptionQueueEvent) => {
    for (const listener of listeners) listener(event);
  };
  return {
    states: () => states,
    enqueue(sourceId, task) {
      if (states.get(sourceId)?.kind === "active") return;
      states.set(sourceId, { kind: "active", status: { kind: "waiting" } });
      emit({ sourceId, outcome: "progress" });
      chain = chain.then(async () => {
        try {
          await task((status) => {
            states.set(sourceId, { kind: "active", status });
            emit({ sourceId, outcome: "progress" });
          });
          states.delete(sourceId);
          emit({ sourceId, outcome: "saved" });
        } catch (err) {
          states.set(sourceId, { kind: "failed", ...voiceNoteTranscriptionFailure(err) });
          emit({ sourceId, outcome: "failed" });
        }
      });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
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
