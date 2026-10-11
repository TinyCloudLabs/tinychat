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

import { TRANSCRIBER_NAME } from "@/capture/recorder/final/finalCopy";
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
import { captureEngineKind } from "./captureEngine";
import { nativeHttpFileUploadSupported, nativeRecordingSource, VoiceNotes, type VoiceNoteRecording } from "./nativeVoiceNotes";
import { readTranscriptCommit } from "./voiceNoteCommits";
import { whenVoiceNoteSavesIdle } from "./recorderSaves";
import {
  base64ToBytes,
  bytesToBase64,
  prepareTranscriptionAudio,
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

/** The browser has no native HTTP stack; PTX's CORS allows only Authorization and Content-Type, so no X-Correlation-Id here. */
const FETCH_PUT_TIMEOUT_MS = 240_000;

/**
 * The web engine's transport: the same PUT as `capacitorPtxPut` over fetch. A redirect is refused
 * (not followed), any failure to get an HTTP answer is `upload_outcome_unknown`, and a body that is
 * not JSON is null, exactly as on the phone.
 */
export function createFetchPtxPut(fetchImpl: typeof fetch = (input, init) => fetch(input, init)): PtxPut {
  return async (request) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_PUT_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetchImpl(request.url, {
        method: "PUT",
        headers: { Authorization: `Bearer ${request.capability}`, "Content-Type": request.contentType },
        body: base64ToBytes(request.base64) as Uint8Array<ArrayBuffer>,
        redirect: "manual",
        signal: controller.signal,
      });
    } catch {
      throw new PrivateCloudError("upload_outcome_unknown", "The upload connection failed", { correlationId: request.correlationId });
    } finally {
      clearTimeout(timer);
    }
    if (response.type === "opaqueredirect") {
      throw new PrivateCloudError("service_misconfigured", "PTX answered with a redirect; it was not followed", { correlationId: request.correlationId });
    }
    let body: unknown;
    try {
      const text = await response.text();
      body = text ? (JSON.parse(text) as unknown) : null;
    } catch {
      body = null;
    }
    return { status: response.status, body };
  };
}

// ── Jobs in flight (per note), and consent: per account ────────────────
//
// Both live in this device's localStorage under keys that end with the
// account's DID, so a second account signed in on the same phone neither
// inherits the first one's consent nor resumes its jobs.

export const VOICE_NOTE_PENDING_JOBS_KEY = "exo.voiceNotes.privateCloudJobs";
/** The one-time "Use private cloud" for voice notes (its own key: the disclosure differs from the desktop's). */
export const VOICE_NOTE_CONSENT_KEY = "exo.voiceNotes.privateCloudConsent";
export const VOICE_NOTE_HELD_KEY = "exo.voiceNotes.heldFromTranscription";

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

export const VOICE_NOTE_PRIVATE_CHOICES_KEY = "exo.voiceNotes.privateChoices";

/** Notes the user explicitly moved to private cloud from another committed mode (per account). */
export interface VoiceNotePrivateChoiceStore {
  has(sourceId: string): boolean;
  add(sourceId: string): void;
  remove(sourceId: string): void;
  ids(): string[];
}

export function memoryVoiceNotePrivateChoiceStore(): VoiceNotePrivateChoiceStore {
  const set = new Set<string>();
  return { has: (id) => set.has(id), add: (id) => void set.add(id), remove: (id) => void set.delete(id), ids: () => [...set] };
}

/** Without it a relaunch would treat the user's choice as an unauthorized leftover and delete its job. */
export function localStorageVoiceNotePrivateChoiceStore(
  accountDid: string,
  storage: KeyValueStorage | undefined = globalThis.localStorage,
): VoiceNotePrivateChoiceStore {
  const key = accountStorageKey(VOICE_NOTE_PRIVATE_CHOICES_KEY, accountDid);
  const read = (): string[] => {
    try {
      const parsed = JSON.parse(storage?.getItem(key) ?? "null") as unknown;
      return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
    } catch {
      return [];
    }
  };
  const write = (ids: string[]) => {
    try {
      if (ids.length === 0) storage?.removeItem(key);
      else storage?.setItem(key, JSON.stringify(ids));
    } catch {
      // Best-effort: the choice then lasts for this session only.
    }
  };
  return {
    has: (id) => read().includes(id),
    add: (id) => {
      const ids = read();
      if (!ids.includes(id)) write([...ids, id]);
    },
    remove: (id) => write(read().filter((other) => other !== id)),
    ids: read,
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

/** Said on a note that began outside the app and has not been sent. */
export const HELD_NOTE_MESSAGE = `This note was started from a shortcut, so it was not sent for transcription. Transcribe with ${TRANSCRIBER_NAME["private-cloud"]} to send it.`;

/** `held`: not sent, until the user's Transcribe on that note. `released`: the user asked for it, so a later launch may resume it. */
export type VoiceNoteHoldState = "held" | "released";

/** What the user has decided about each note that began outside the app, per account. */
export interface VoiceNoteHoldStore {
  read(): Record<string, VoiceNoteHoldState>;
  write(holds: Record<string, VoiceNoteHoldState>): void;
}

export function localStorageVoiceNoteHoldStore(
  accountDid: string,
  storage: KeyValueStorage | undefined = globalThis.localStorage,
): VoiceNoteHoldStore {
  const key = accountStorageKey(VOICE_NOTE_HELD_KEY, accountDid);
  return {
    read: () => {
      const raw = storage?.getItem(key);
      if (raw === null || raw === undefined) return {};
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
        || Object.values(parsed).some((value) => value !== "held" && value !== "released"))
        throw new Error("The held-notes list is not a map of note ids to held or released");
      return parsed as Record<string, VoiceNoteHoldState>;
    },
    write: (holds) => {
      if (!storage) throw new Error("No storage to keep the held notes in");
      if (Object.keys(holds).length === 0) storage.removeItem(key);
      else storage.setItem(key, JSON.stringify(holds));
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
export function prepareVoiceNoteTranscript(transcript: PrivateCloudTranscript, transcribedAt: string, rev: number): VoiceNoteTranscriptSave {
  const sentences = voiceNoteSentences(transcript);
  if (sentences.length === 0) return noSpeechTranscript(transcribedAt, rev);
  return {
    rev,
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
export function noSpeechTranscript(transcribedAt: string, rev: number): VoiceNoteTranscriptSave {
  return {
    rev,
    sentences: [],
    speakers: [],
    metadata: { ...engineMetadata(transcribedAt), transcript_text: null, transcription_outcome: "no_speech",
      speaker_labels: "none" },
  };
}

// ── The engine ─────────────────────────────────────────────────────────

/** Progress of one note's transcription. */
export type VoiceNoteTranscriptionStatus =
  /** `position`: 1-based place among the notes waiting to start (1 = next); the running note is not counted. */
  | { kind: "waiting"; position: number }
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
  "VOICE_NOTE_AUDIO_CORRUPT",
  "invalid_argument",
  "voice_note_not_found",
  "transcription_off",
]);

export function voiceNoteErrorCode(err: unknown): string {
  return err instanceof PrivateCloudError || err instanceof VoiceNoteAudioError ? err.code : "transcription_error";
}

function localAudioUnavailable(err: unknown): boolean {
  const code = err && typeof err === "object" && "code" in err ? String(err.code) : "";
  return code === "not_found" || code === "tombstoned" || code === "recording_changed"
    || /(?:java\.io\.)?FileNotFoundException/.test(code);
}

/** The user turned transcription off while this note was on its way. */
export function transcriptionOffError(): PrivateCloudError {
  return new PrivateCloudError("transcription_off", "Transcription was turned off.");
}

/**
 * The signed-in account changed while this note was on its way. Nothing more is sent for it and
 * its job is kept (unlike turning transcription off, which releases jobs), so the account's next
 * run picks it up again.
 */
export const ACCOUNT_CHANGED = "account_changed";

export function accountChangedError(): PrivateCloudError {
  return new PrivateCloudError(ACCOUNT_CHANGED, "The account changed while this note was being transcribed.");
}

/** Contract field: the formats PTX takes, from capabilities (the relay's three when absent). */
export function acceptedContentTypes(capabilities: PrivateCloudCapabilities): string[] {
  const listed = capabilities.content_types;
  return Array.isArray(listed) && listed.every((t) => typeof t === "string")
    ? (listed as string[])
    : ["audio/mpeg", "audio/wav", "audio/ogg"];
}

/** The duration capability reported by PTX for this account. */
export function maxTranscriptionSeconds(capabilities: PrivateCloudCapabilities | null): number {
  const ptx = capabilities?.max_duration_seconds;
  return typeof ptx === "number" && ptx > 0 ? ptx : Number.POSITIVE_INFINITY;
}

/** Whether a recording fits the duration limit advertised by PTX. Shared by route controls and note actions. */
export function privateCloudAccepts(
  durationSecs: number | null,
  capabilities: Pick<PrivateCloudCapabilities, "max_duration_seconds"> | null,
): boolean {
  if (capabilities === null) return false;
  if (durationSecs === null) return true;
  return Number.isFinite(durationSecs) && durationSecs >= 0 && durationSecs <= capabilities.max_duration_seconds;
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
  /**
   * Still allowed to send audio? Asked before the job is created and again right before the upload.
   * Asked with "account", it says only whether this note's account is still the signed-in one,
   * which every request for its job needs, not just the upload.
   */
  allowed?: (scope?: "account") => boolean;
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

  /**
   * Stop using the note's job: cancel it (if it exists) and forget it. For an account that has left
   * it does neither: the cancel would carry the new account's token, and the job stays for its owner.
   */
  const release = async (sourceId: string, guard: () => void = () => {}) => {
    guard();
    const transcriptionId = pending.read(sourceId)?.transcriptionId ?? null;
    pending.clear(sourceId);
    if (transcriptionId !== null) await cancelQuietly(transcriptionId);
  };

  /** Rides out transient failures for a bounded period, then reports "connection lost". */
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
            "Lost contact with private cloud transcription. The job may still be running.",
          );
        }
        await sleep(failingFor >= polling.slowAfterMs ? polling.slowIntervalMs : polling.intervalMs);
      },
    };
  };

  /** Before every request for a note's job: its account must still be the signed-in one (the session's token is shared). */
  type Guard = () => void;

  const readJob = async (id: string, guard: Guard): Promise<PrivateCloudJob> => {
    const tolerance = transientTolerance();
    for (;;) {
      guard();
      try {
        const job = await deps.api.get(id);
        guard();
        return job;
      } catch (err) {
        guard();
        await tolerance.rideOut(err);
      }
    }
  };

  const poll = async (id: string, report: (s: VoiceNoteTranscriptionStatus) => void, guard: Guard): Promise<PrivateCloudTranscript> => {
    const tolerance = transientTolerance();
    report({ kind: "queued", position: null });
    for (;;) {
      let job: PrivateCloudJob;
      guard();
      try {
        job = await deps.api.get(id);
      } catch (err) {
        guard();
        await tolerance.rideOut(err);
        continue;
      }
      guard();
      if (job.status === "completed") {
        let result: Awaited<ReturnType<PrivateCloudApi["result"]>>;
        try {
          result = await deps.api.result(id);
        } catch (err) {
          guard();
          await tolerance.rideOut(err);
          continue;
        }
        guard();
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
      guard();
    }
  };

  const createJob = async (sourceId: string, job: PendingVoiceNoteJob, body: PrivateCloudCreateBody, guard: Guard) => {
    let current = job;
    for (let fresh = 0; ; fresh++) {
      guard();
      try {
        const created = await deps.create({ attemptId: current.attemptId, correlationId: newId(), body });
        return { job: current, created };
      } catch (err) {
        guard();
        // This key was used for different bytes, or its job is gone: start a new job, once. A job
        // the old key made that still waits for its upload is cancelled first (it holds the slot).
        const code = err instanceof PrivateCloudError ? err.code : null;
        if (fresh > 0 || (code !== "idempotency_conflict" && code !== "transcription_not_found")) throw err;
        if (current.transcriptionId !== null) await cancelQuietly(current.transcriptionId);
        guard();
        current = { attemptId: newId(), transcriptionId: null };
        pending.write(sourceId, current);
      }
    }
  };

  const run = async (
    { sourceId, capabilities, loadAudio, durationSeconds, allowed = () => true }: VoiceNoteTranscribeInput,
    report: (status: VoiceNoteTranscriptionStatus) => void,
  ) => {
    const guard: Guard = () => {
      if (!allowed("account")) throw accountChangedError();
    };
    guard();
    let job = pending.read(sourceId);

    // Re-join a job this note already has: ask before uploading again.
    if (job?.transcriptionId) {
      let current: PrivateCloudJob | null = null;
      try {
        current = await readJob(job.transcriptionId, guard);
      } catch (err) {
        if (!(err instanceof PrivateCloudError && err.code === "transcription_not_found")) throw err;
        job = null;
        pending.clear(sourceId);
      }
      if (current !== null) {
        if (current.status === "failed" || current.status === "cancelled") throw jobFailure(current);
        if (current.status !== "awaiting_upload") return { transcriptionId: current.id, transcript: await poll(current.id, report, guard) };
      }
    }

    // Everything up to the upload happens with no job waiting on it, or releases the one that is.
    const maxSeconds = maxTranscriptionSeconds(capabilities);
    let audio: Awaited<ReturnType<typeof prepareTranscriptionAudio>>;
    try {
      if (typeof durationSeconds === "number" && durationSeconds > maxSeconds) {
        throw new VoiceNoteAudioError("recording_too_long", "This recording exceeds the private cloud duration limit.");
      }
      guard();
      if (!allowed()) throw transcriptionOffError();
      report({ kind: "preparing" });
      audio = await prepareTranscriptionAudio(await loadAudio(), {
        acceptedContentTypes: acceptedContentTypes(capabilities),
        maxBytes: capabilities.max_bytes,
        maxSeconds,
        decode: deps.decode,
      });
      guard();
      if (!allowed()) throw transcriptionOffError();
    } catch (err) {
      // An account that left keeps its job whatever this failure was (nothing is sent for it now).
      guard();
      await release(sourceId, guard);
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
    const createdJob = await createJob(sourceId, job, body, guard);
    job = { ...createdJob.job, transcriptionId: createdJob.created.id };
    pending.write(sourceId, job);
    const created = createdJob.created;

    if (created.upload !== null) {
      // The last moment to stop: nothing has been sent yet.
      guard();
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
        guard();
        // Only the job's status says whether the bytes landed.
        const current = await readJob(created.id, guard);
        if (current.status === "awaiting_upload") throw err; // Retry re-uploads (same job, fresh capability)
        if (current.status === "failed" || current.status === "cancelled") {
          throw jobFailure(current, { correlationId: err.correlationId });
        }
        // Accepted despite the error: carry on as if the 201 had arrived.
      }
    }
    return { transcriptionId: created.id, transcript: await poll(created.id, report, guard) };
  };

  return {
    async capabilities() {
      if (deps.uploadSupported && !(await deps.uploadSupported())) return null;
      return deps.api.capabilities();
    },

    pendingSourceIds: () => pending.sourceIds(),

    async transcribe(input, report) {
      const guard = () => {
        if (!(input.allowed?.("account") ?? true)) throw accountChangedError();
      };
      try {
        return await run(input, report);
      } catch (err) {
        // No cleanup for an account that left, whatever the error: its job stays for it.
        guard();
        const code = voiceNoteErrorCode(err);
        if (RELEASE_CODES.has(code)) await release(input.sourceId, guard);
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
  const web = captureEngineKind() === "web";
  return createVoiceNoteCloud({
    api: createPrivateCloudApi(backendUrl, { sessionStore }),
    create: (request) => createPrivateCloudJob(backendUrl, { sessionStore }, request),
    put: web ? createFetchPtxPut() : capacitorPtxPut,
    origin,
    pending: localStorageVoiceNotePendingStore(accountDid),
    uploadSupported: web ? () => Promise.resolve(true) : () => nativeHttpFileUploadSupported(),
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
  let message: string;
  switch (code) {
    case "recording_too_long_for_phone":
    case "recording_too_long":
    case "recording_too_large":
      message = "Private cloud can't transcribe a recording this long or large.";
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
    case "audio_read_failed":
      message = "Could not read this note's audio from this device or your space. Retry tries again.";
      break;
    case "audio_upload_pending":
      message = "This note's audio is still being saved to your space. Try again when the upload finishes.";
      break;
    case "VOICE_NOTE_AUDIO_CORRUPT":
      message = "This note's audio is damaged and can't be transcribed.";
      break;
    case "transcription_off":
      message = "Transcription was turned off.";
      break;
    default:
      message =
        err instanceof PrivateCloudError
          ? privateCloudMessage(err)
          : "Transcription failed. Try again.";
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
  allowed?: (scope?: "account") => boolean;
  /** The user chose private cloud for a note committed to another mode: skip the committed-mode checks. */
  overrideCommitted?: boolean;
  /** The user asked for this note to be transcribed. Without it, only a note recorded in the app goes. */
  explicit?: boolean;
  report: (status: VoiceNoteTranscriptionStatus) => void;
  now?: () => Date;
}): Promise<"transcribed" | "no_speech"> {
  const { tcw, cloud, sourceId, report } = args;
  const transcribedAt = () => (args.now?.() ?? new Date()).toISOString();
  const stillCurrent = () => args.allowed?.("account") ?? true;
  /** The job is done with: forget it, then delete it at PTX (best-effort: PTX deletes it within 24 h). */
  const finish = async (transcriptionId?: string | null) => {
    // Not for an account that left: the delete would go out with the new account's token, and the
    // job is kept so this account's next run finds the saved transcript and deletes it then.
    if (!stillCurrent()) return;
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
  if (!args.overrideCommitted && note.data.captureVersion === 2 && note.data.captureTranscriber !== "private-cloud") {
    await finish();
    throw new PrivateCloudError("transcription_off", "This note was not recorded for private-cloud transcription");
  }
  if (note.data.transcript.status !== "none") {
    await finish();
    return note.data.transcript.status;
  }
  const nativeNote = (await VoiceNotes.listPending()).recordings.find((recording) => recording.id === sourceId);
  // A manual Retry must obey the committed choice too. V1 notes have no options and retain
  // their historical, consent-gated private-cloud behaviour.
  if (!args.overrideCommitted && nativeNote?.options && nativeNote.options.transcriber !== "private-cloud") {
    await finish();
    throw new PrivateCloudError("transcription_off", "This note was not recorded for private-cloud transcription");
  }
  if (nativeNote?.owner && nativeNote.owner !== tcw.did)
    throw new PrivateCloudError("transcript_save_failed", "This voice note is not owned by the current account");
  const local = nativeNote ? (await VoiceNotes.getTranscript({ id: sourceId })).transcript : null;
  const commit = await readTranscriptCommit(tcw, sourceId);
  const ledgerRev = nativeNote?.ledger?.transcriptSync.rev ?? 0;
  const localRev = local?.rev ?? 0;
  if (![commit?.rev ?? 0, ledgerRev, localRev].every((value) => Number.isSafeInteger(value) && value >= 0))
    throw new PrivateCloudError("transcript_save_failed", "The voice note has an invalid transcript revision");
  const rev = Math.max(commit?.rev ?? 0, ledgerRev, localRev) + 1;
  if (!Number.isSafeInteger(rev))
    throw new PrivateCloudError("transcript_save_failed", "The voice note has no remaining transcript revisions");
  // T22 writes the committed rev and hash back to native transcriptSync after this cloud save.

  // Cleanups above only delete; from here a job is created or resumed, so a note that did not begin in the app
  // (or whose source the row does not say) waits for the user's own Transcribe.
  if (!args.explicit && note.data.captureSource !== "in_app")
    throw new PrivateCloudError("note_held", "This note did not begin in the app, so it waits for the user to transcribe it");

  const loadAudio = async (): Promise<VoiceNoteAudio> => {
    if (args.audio) return args.audio;
    let local: VoiceNoteRecording | undefined;
    try {
      local = (await VoiceNotes.listPending()).recordings.find((recording) => recording.id === sourceId);
    } catch (cause) {
      console.error("[VoiceNotes] Could not check for local audio before transcription", { sourceId, cause });
      throw new VoiceNoteAudioError("audio_read_failed", "Could not check this device for local audio");
    }
    if (local) {
      try {
        const source = nativeRecordingSource(local);
        const bytes = new Uint8Array(source.size);
        for (let offset = 0; offset < source.size; offset += 1024 * 1024) {
          const part = await source.readPart(offset, Math.min(1024 * 1024, source.size - offset));
          bytes.set(part, offset);
        }
        return { mimeType: source.mimeType, base64: bytesToBase64(bytes) };
      } catch (cause) {
        if (localAudioUnavailable(cause)) {
          console.warn("[VoiceNotes] The local recording is no longer available; reading its space copy", { sourceId });
        } else {
          console.error("[VoiceNotes] Could not read local audio before transcription", { sourceId, cause });
          throw new VoiceNoteAudioError("audio_read_failed", "Could not read this note's local audio");
        }
      }
    }
    // A row can exist before its audio, and a recording can disappear from the native
    // listing during a save. Wait for queued save-now/reconcile work before consulting
    // the space copy; when a native ledger exists, it must confirm the audio commit.
    if (!local || (local.ledger?.audio && local.ledger.audio.state !== "saved")) {
      await whenVoiceNoteSavesIdle();
      try {
        local = (await VoiceNotes.listPending()).recordings.find((recording) => recording.id === sourceId);
      } catch (cause) {
        console.error("[VoiceNotes] Could not confirm the audio save before transcription", { sourceId, cause });
        throw new VoiceNoteAudioError("audio_read_failed", "Could not confirm this note's audio save");
      }
      if (local?.ledger?.audio && local.ledger.audio.state !== "saved") {
        throw new VoiceNoteAudioError("audio_upload_pending", "This note's audio is still being saved to your space");
      }
    }
    // Refuse a file larger than PTX accepts from its manifest, before reading its parts.
    const res = await loadVoiceNoteAudio(tcw, sourceId, { maxBytes: args.capabilities.max_bytes });
    if (!res.ok) {
      if (res.error.code === VOICE_NOTE_AUDIO_TOO_LARGE) {
        throw new VoiceNoteAudioError("recording_too_large", "This recording exceeds the private cloud upload limit.");
      }
      console.error("[VoiceNotes] Could not read note audio from the space", { sourceId, error: res.error });
      throw new VoiceNoteAudioError(res.error.code === "VOICE_NOTE_AUDIO_CORRUPT" ? res.error.code : "audio_read_failed",
        "Could not read this note's audio from your space");
    }
    return res.data;
  };
  const save = async (prepared: VoiceNoteTranscriptSave) => {
    if (!stillCurrent()) throw accountChangedError();
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
    await save(noSpeechTranscript(transcribedAt(), rev));
    await finish(err instanceof PrivateCloudError ? err.transcriptionId : null);
    return "no_speech";
  }
  const prepared = prepareVoiceNoteTranscript(transcript, transcribedAt(), rev);
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
  | ({ kind: "failed" } & VoiceNoteTranscriptionFailure)
  /** Not sent: the note began outside the app. Only the user's Transcribe on this note sends it. */
  | { kind: "held"; message: string }
  /** Private cloud could not take this note when it was saved. Exposed state only: it does not start later on its own. */
  | { kind: "blocked"; reason: TranscriptionBlockedReason };

/** Why private cloud was not on when a note was offered to it. */
export type TranscriptionBlockedReason = "checking" | "unavailable" | "check-failed" | "no-consent" | "hidden";

export type TranscriptionAvailability = "checking" | "available" | "hidden" | "failed";

export interface VoiceNoteTranscriberSnapshot {
  availability: TranscriptionAvailability;
  capabilities: PrivateCloudCapabilities | null;
  consented: boolean;
  jobs: ReadonlyMap<string, NoteTranscriptionState>;
  /** The error of the last availability check when it failed (`availability` "failed"). */
  checkError?: string;
}

/** `saved`: a note's outcome was written to the space (refresh the list). */
export type VoiceNoteTranscriberEvent = { kind: "changed" } | { kind: "saved"; sourceId: string };

export interface VoiceNoteCheckOptions {
  current?: () => boolean;
  automatic?: boolean;
}

export interface VoiceNoteTranscriber {
  snapshot(): VoiceNoteTranscriberSnapshot;
  subscribe(listener: (event: VoiceNoteTranscriberEvent) => void): () => void;
  /**
   * Whether private cloud can be offered (bounded retries when the check itself fails).
   * `current` says this caller's account is still the signed-in one: once it is false the
   * check stops, retries and resumes nothing, and sends nothing for this account.
   * `automatic` (mount, foreground) reuses a fresh answer and backs off after a failure;
   * a user's "Check again" leaves it out and always asks.
   */
  check(options?: VoiceNoteCheckOptions): Promise<void>;
  /** The one-time "Use private cloud". Resumes notes a previous run left in flight. */
  consent(): void;
  /** Stops sending: waiting notes are dropped, the running one stops before its upload, unsent jobs are cancelled. */
  turnOff(): Promise<void>;
  /** Transcribe / Retry for one note. Only while available and consented. */
  transcribe(sourceId: string, audio?: VoiceNoteAudio): void;
  /**
   * The user's "Use Private instead" for a note committed to another mode (its on-device job is
   * cancelled by the caller first). Runs like `transcribe`, and its Retry keeps the choice.
   */
  transcribePrivately(sourceId: string): void;
  /**
   * Use the committed native options. A note that did not begin in the app (a shortcut, intent or widget start, or a
   * source this app does not know) is never sent from here, whatever the defaults say: it is held, and only
   * `transcribe` for that note releases it.
   */
  noteSaved(recording: Pick<VoiceNoteRecording, "id" | "durationMs" | "options" | "source">, audio?: VoiceNoteAudio): void;
}

export interface VoiceNoteTranscriberDeps {
  /** Null when this build cannot transcribe (no PTX origin): always hidden. */
  cloud: VoiceNoteCloud | null;
  consent: VoiceNoteConsentStore;
  /** The user's "Transcribe privately instead" choices; in memory when omitted. */
  choices?: VoiceNotePrivateChoiceStore;
  /** Which notes were held back from transcription, kept across launches. */
  holds: VoiceNoteHoldStore;
  /** The current session's space client. */
  tcw: () => TinyCloudWeb;
  /** Injected in tests. */
  runNote?: typeof transcribeVoiceNote;
  sleep?: (ms: number) => Promise<void>;
  /** Waits between availability checks after one fails (plus the first try), as on the desktop. */
  checkRetryMs?: readonly number[];
  /** How long an automatic check reuses an answered (available / off) result. */
  freshMs?: number;
  /** Waits before an automatic check may try again after the 1st, 2nd, ... failed check; the last repeats. */
  failedBackoffMs?: readonly number[];
  now?: () => number;
}

export function createVoiceNoteTranscriber(deps: VoiceNoteTranscriberDeps): VoiceNoteTranscriber {
  const runNote = deps.runNote ?? transcribeVoiceNote;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const checkRetryMs = deps.checkRetryMs ?? [2_000, 5_000];
  const freshMs = deps.freshMs ?? 5 * 60_000;
  const failedBackoffMs = deps.failedBackoffMs ?? [15_000, 60_000, 5 * 60_000];
  const now = deps.now ?? Date.now;
  const cloud = deps.cloud;
  const listeners = new Set<(event: VoiceNoteTranscriberEvent) => void>();
  const jobs = new Map<string, NoteTranscriptionState>();
  const holdStates = new Map<string, VoiceNoteHoldState>();
  try {
    for (const [sourceId, holdState] of Object.entries(deps.holds.read())) {
      holdStates.set(sourceId, holdState);
      if (holdState === "held") jobs.set(sourceId, { kind: "held", message: HELD_NOTE_MESSAGE });
    }
  } catch (err) {
    // Unreadable: no note counts as released, so the saved source decides each one (see transcribeVoiceNote).
    console.error("[VoiceNotes] Could not read which notes are held back from transcription; only notes recorded in the app will be resumed", err);
  }
  const isHeld = (sourceId: string) => holdStates.get(sourceId) === "held";
  const saveHolds = () => {
    try {
      deps.holds.write(Object.fromEntries(holdStates));
    } catch (err) {
      console.error("[VoiceNotes] Could not keep which notes are held back from transcription; they stay held until the app closes", err);
    }
  };
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
  /** The newest caller's "this account is still signed in"; none until a hook-managed check names one. */
  let accountCurrent: (() => boolean) | null = null;
  let settledAt: number | null = null;
  let failedChecks = 0;

  const emit = (event: VoiceNoteTranscriberEvent = { kind: "changed" }) => {
    refreshBlocked();
    let position = 0;
    for (const sourceId of waiting) {
      position += 1;
      const job = jobs.get(sourceId);
      if (job?.kind === "active" && job.status.kind === "waiting" && job.status.position !== position) {
        jobs.set(sourceId, { kind: "active", status: { kind: "waiting", position } });
      }
    }
    snapshot = { ...state, jobs: new Map(jobs) };
    for (const listener of listeners) listener(event);
  };
  const identityCurrent = () => accountCurrent === null || accountCurrent();
  const on = () => identityCurrent() && state.availability === "available" && state.consented && state.capabilities !== null;
  const blockedReason = (): TranscriptionBlockedReason => {
    if (cloud === null) return "hidden";
    switch (state.availability) {
      case "checking":
        return "checking";
      case "failed":
        return "check-failed";
      case "hidden":
        return "hidden";
      case "available":
        return state.consented ? "unavailable" : "no-consent";
    }
  };
  /** A blocked note shows why private cloud is off now; once it is on, the note either started (resume) or is not ours to start. */
  const refreshBlocked = () => {
    for (const [sourceId, job] of jobs) {
      if (job.kind !== "blocked") continue;
      if (on()) jobs.delete(sourceId);
      else if (job.reason !== blockedReason()) jobs.set(sourceId, { kind: "blocked", reason: blockedReason() });
    }
  };
  /** Records why an offered note is not going to private cloud. Never replaces a held, running, failed or finished job. */
  const block = (sourceId: string) => {
    const current = jobs.get(sourceId);
    if (current !== undefined && current.kind !== "blocked") return;
    jobs.set(sourceId, { kind: "blocked", reason: blockedReason() });
    emit();
  };

  /** Notes the user moved to private cloud from another committed mode. */
  const choices = deps.choices ?? memoryVoiceNotePrivateChoiceStore();
  /** This session's choices, so a Retry after a released failure keeps the choice. */
  const chosenPrivate = new Set<string>();
  const isChosen = (sourceId: string) => chosenPrivate.has(sourceId) || choices.has(sourceId);
  /** The persisted choice goes once the note is done or its job can no longer be retried; a pending job keeps it. */
  const settleChoice = (sourceId: string) => {
    if (cloud !== null && !cloud.pendingSourceIds().includes(sourceId)) choices.remove(sourceId);
  };

  /** A note that did not begin in the app: kept from every automatic job until the user's own Transcribe on it. */
  const hold = (sourceId: string) => {
    if (!isHeld(sourceId)) {
      holdStates.set(sourceId, "held");
      saveHolds();
    }
    jobs.set(sourceId, { kind: "held", message: HELD_NOTE_MESSAGE });
    emit();
  };

  /** The user's own start on a note lifts its hold, so a relaunch resumes it. */
  const release = (sourceId: string) => {
    if (jobs.get(sourceId)?.kind === "active" && holdStates.get(sourceId) !== "released") {
      holdStates.set(sourceId, "released");
      saveHolds();
    }
  };

  /** Every job, new or resumed, starts here. Only `explicit` (the user's Transcribe on this note) may pass a held note. */
  const enqueue = (sourceId: string, audio: VoiceNoteAudio | undefined, explicit: boolean) => {
    if (!on() || cloud === null) {
      if (explicit || !isHeld(sourceId)) block(sourceId);
      return;
    }
    if (!explicit && isHeld(sourceId)) return;
    // Queued, running, or just saved (the list may not show it yet): never a second job.
    const current = jobs.get(sourceId);
    if (current?.kind === "active" || current?.kind === "done") return;
    // A failure waits for the user's Retry; no automatic hand-off or resume restarts it.
    if (!explicit && current?.kind === "failed") return;
    waiting.add(sourceId);
    jobs.set(sourceId, { kind: "active", status: { kind: "waiting", position: waiting.size } });
    emit();
    chain = chain.then(async () => {
      // Dropped by turn-off while it waited, or turned off since: never starts.
      if (!waiting.delete(sourceId)) return;
      // Leaving the line, starting, and the others moving up are one change: no snapshot shows the starting note as waiting.
      if (jobs.get(sourceId)?.kind === "active") jobs.set(sourceId, { kind: "active", status: { kind: "preparing" } });
      emit();
      if (!on() || state.capabilities === null) {
        jobs.delete(sourceId);
        if (!identityCurrent()) {
          resumed = false;
          console.warn("[Transcription] Not starting a private cloud job: its account is no longer the signed-in one", sourceId);
        }
        emit();
        return;
      }
      const authorised = explicit || holdStates.get(sourceId) === "released";
      try {
        const outcome = await runNote({
          tcw: deps.tcw(),
          cloud,
          capabilities: state.capabilities,
          sourceId,
          audio,
          allowed: (scope) => identityCurrent() && (scope === "account" || state.consented),
          overrideCommitted: isChosen(sourceId),
          explicit: authorised,
          report: (status) => {
            if (jobs.get(sourceId)?.kind !== "active") return;
            jobs.set(sourceId, { kind: "active", status });
            emit();
          },
        });
        jobs.set(sourceId, { kind: "done", outcome });
        settleChoice(sourceId);
        emit({ kind: "saved", sourceId });
      } catch (err) {
        if (voiceNoteErrorCode(err) === "note_held") {
          console.warn("[VoiceNotes] Held a note back from private-cloud transcription: it did not begin in the app", { id: sourceId });
          hold(sourceId);
          return;
        }
        // Whatever stopped a note after the user turned transcription off is not a failure to show.
        if (!identityCurrent()) {
          resumed = false;
          jobs.delete(sourceId);
          console.warn("[Transcription] Stopped a private cloud job: its account is no longer the signed-in one", sourceId);
        } else if (!state.consented || voiceNoteErrorCode(err) === "transcription_off") {
          jobs.delete(sourceId);
          settleChoice(sourceId);
        } else {
          if (voiceNoteErrorCode(err) === "transcription_error")
            console.error("[VoiceNotes] Private transcription failed with an unexpected error", { sourceId, error: err });
          const failure = voiceNoteTranscriptionFailure(err);
          jobs.set(sourceId, { kind: "failed", ...failure });
          // A failure Retry can fix keeps the choice, so a relaunch does not turn it back into Local.
          if (!failure.retryable) settleChoice(sourceId);
        }
        emit();
      }
    });
  };

  /** Notes a previous run left in flight, first (one active job per account). Once per transcriber. */
  const resume = () => {
    if (resumed || !on() || cloud === null) return;
    resumed = true;
    for (const sourceId of new Set([...cloud.pendingSourceIds(), ...choices.ids()])) enqueue(sourceId, undefined, false);
  };

  return {
    snapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    check(options = {}) {
      if (cloud === null) return Promise.resolve();
      if (options.current) accountCurrent = options.current;
      if (checking !== null) return checking;
      if (options.automatic && settledAt !== null && state.availability !== "checking") {
        const wait = state.availability === "failed" ? failedBackoffMs[Math.min(failedChecks, failedBackoffMs.length) - 1] ?? 0 : freshMs;
        if (now() - settledAt < wait) {
          // Reusing the answer still reactivates this account's work an earlier departure paused.
          resume();
          return Promise.resolve();
        }
      }
      // A re-check (every mount) keeps an answer it already has, so the card does not flicker.
      if (state.availability !== "available") {
        state = { ...state, availability: "checking" };
        emit();
      }
      const attempt = async () => {
        if (!identityCurrent()) return { availability: "stale" } as const;
        try {
          const caps = await cloud.capabilities();
          return caps === null ? ({ availability: "hidden" } as const) : ({ availability: "available", caps } as const);
        } catch (err) {
          console.warn("Checking private cloud transcription failed", err);
          return { availability: "failed", error: err instanceof Error ? err.message : String(err) } as const;
        }
      };
      const stale = () => {
        resumed = false;
        console.warn("[Transcription] Dropped a private cloud check: its account is no longer the signed-in one");
      };
      checking = (async () => {
        let result = await attempt();
        for (const waitMs of checkRetryMs) {
          if (result.availability !== "failed") break;
          await sleep(waitMs);
          result = await attempt();
        }
        if (result.availability === "stale" || !identityCurrent()) return stale();
        failedChecks = result.availability === "failed" ? failedChecks + 1 : 0;
        settledAt = now();
        state = {
          ...state,
          availability: result.availability,
          capabilities: result.availability === "available" ? result.caps : null,
          checkError: result.availability === "failed" ? result.error : undefined,
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
      // Turning private cloud off revokes the choices too.
      chosenPrivate.clear();
      for (const sourceId of choices.ids()) choices.remove(sourceId);
      emit();
      try {
        await cloud?.releaseUnsent();
      } catch (err) {
        console.warn("Releasing unsent private cloud jobs failed; they expire on their own", err);
      }
    },

    transcribe(sourceId, audio) {
      enqueue(sourceId, audio, true);
      release(sourceId);
    },

    transcribePrivately(sourceId) {
      chosenPrivate.add(sourceId);
      choices.add(sourceId);
      enqueue(sourceId, undefined, true);
      release(sourceId);
    },

    noteSaved(recording, audio) {
      if (recording.options && recording.options.transcriber !== "private-cloud") return;
      if (recording.source !== "in_app") {
        if (cloud === null || holdStates.get(recording.id) === "released") return;
        const current = jobs.get(recording.id);
        if (current?.kind === "active" || current?.kind === "done" || current?.kind === "failed") return;
        console.warn("[VoiceNotes] Held a note back from private-cloud transcription: it did not begin in the app", { id: recording.id, source: recording.source });
        hold(recording.id);
        return;
      }
      if (!on()) {
        block(recording.id);
        return;
      }
      if (!privateCloudAccepts(recording.durationMs / 1000, state.capabilities)) return;
      enqueue(recording.id, audio, false);
    },
  };
}

/**
 * Hand a note that was saved to the space to transcription (Stop, or later: a relaunch, the sign-in claim, Save
 * now). The account's availability answer must be in before `noteSaved`. `isCurrent` says the note's account and
 * generation are still the signed-in ones; it guards the check itself (so a superseded account resumes nothing) and
 * the hand-off after it.
 */
export function transcribeSavedNote(
  transcriber: Pick<VoiceNoteTranscriber, "check" | "noteSaved">,
  recording: Parameters<VoiceNoteTranscriber["noteSaved"]>[0],
  isCurrent: () => boolean,
  audio?: VoiceNoteAudio,
): void {
  if (!isCurrent()) return;
  transcriber.check({ automatic: true, current: isCurrent }).then(
    () => { if (isCurrent()) transcriber.noteSaved(recording, audio); },
    (caught: unknown) => console.error("[VoiceNotes] The private transcription check threw; this note was not handed to transcription", { id: recording.id, caught }),
  );
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
    choices: localStorageVoiceNotePrivateChoiceStore(did),
    holds: localStorageVoiceNoteHoldStore(did),
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
