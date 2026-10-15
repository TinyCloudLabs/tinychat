import { logPipeline, logPipelineCount, logPipelineError } from "@/lib/debugLog";
import { readableError } from "@/lib/readableError";
// Private transcription for Exo voice notes. The backend creates and tracks
// jobs; this device uploads a local file directly to PTX when it has one.
//
// A job in flight is remembered per note (localStorage), so a relaunch or a
// Retry re-joins it: an idempotent create replay hands out a fresh upload
// capability while the upload is missing, and a job past its upload is just
// polled. Jobs run one at a time (PTX allows one active job per account).

import { Capacitor, CapacitorHttp } from "@capacitor/core";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { TRANSCRIBER_NAME } from "@/capture/recorder/final/finalCopy";
import { createHostedVoiceNoteTrack } from "./hostedVoiceNotes";
import type { FirefliesSentence } from "../connectors/firefliesClient";
import { splitLongTimedSegment } from "./timedSegments";
import {
  buildPtxUploadOrigin,
  cloudStatusIntervalMs,
  jitteredCloudIntervalMs,
  createPrivateCloudApi,
  createPrivateCloudJob,
  interpretUploadResponse,
  jitteredRateLimitWaitMs,
  MAX_RATE_LIMIT_WAIT_MS,
  ptxUploadUrl,
  isTransientCloudError,
  PrivateCloudError,
  privateCloudMessage,
  VOICE_NOTE_CHANNEL_LABELS,
  ME_THEM_CHANNEL_LABELS,
  type CloudPolling,
  type PrivateCloudApi,
  type PrivateCloudCapabilities,
  type PrivateCloudCreateBody,
  type PrivateCloudCreated,
  type PrivateCloudJob,
  type PrivateCloudTranscript,
  type PrivateCloudTranscriptionStats,
  type PtxPutResponse,
} from "../privateCloud";
import { captureCapabilities, captureEngineKind, NativeFileUploadStatusError, resolveNativeFileUploadCapability } from "./captureEngine";
import { currentAccountGeneration, isAccountContextCurrent, isAccountWorkAllowed, StaleAccountContext, subscribeAccountGeneration } from "./accountContext";
import { nativeRecordingSource, VoiceNotes, type VoiceNoteRecording } from "./nativeVoiceNotes";
import { OnDeviceStt } from "./onDeviceStt";
import { getDesktopWhisperQueue } from "./desktop/desktopWhisper";
import { readTranscriptCommit, requireVoiceNoteTranscriptCommit, type TranscriptCommit } from "./voiceNoteCommits";
import { preserveVoiceNoteTranscriptHistory } from "./voiceNoteTranscriptHistory";
import { pendingStore } from "./recorderSaves";
import { voiceNoteCallDeadlineMs, withVoiceNoteSaveDeadline } from "./saveDeadline";
import { isStorageFullError, reportStorageError, storageScopeFor, STORAGE_FULL_SAVE_MESSAGE } from "../storageStatus";
import { TRANSCRIPT_STORAGE_FULL_CODE, transcriptionErrorCopy, voiceNoteTranscriptionFailureForCode } from "./transcriptionErrors";
import { privatePartsDone } from "./notePipelineCopy";
import type { VoiceNoteTranscriptionFailure } from "./transcriptionErrors";
export type { VoiceNoteTranscriptionFailure } from "./transcriptionErrors";

import {
  bareMimeType,
  base64ToBytes,
  bytesToBase64,
  prepareTranscriptionAudio,
  VoiceNoteAudioError,
  type AudioDecoder,
  type PreparedTranscriptionAudio,
} from "./voiceNoteAudio";
import {
  loadVoiceNoteAudio,
  patchVoiceNoteTranscriptionFailure,
  readVoiceNoteForTranscription,
  saveVoiceNoteTranscript,
  VOICE_NOTE_AUDIO_TOO_LARGE,
  type VoiceNoteAudio,
  type VoiceNoteTranscriptSave,
  type VoiceNoteTranscriptAccount,
} from "./voiceNoteStore";
import { accountStorageKey, beginPrivateChoiceIntent, clearChoicePinMetadata, setLimitBlockedChoice,
  VOICE_NOTE_PENDING_JOBS_KEY, VOICE_NOTE_PRIVATE_CHOICES_KEY, retainSource, withSourceLease } from "./sourcePins";
import { isAutomaticRetryableCode } from "./retryableVoiceNoteErrors";
import { transcriptHash, type VoiceNoteTranscriptionStatsMetadata } from "./voiceNoteRows";
import { createHeldResultStore, type HeldResult, type HeldResultInput, type HeldResultStore } from "./heldResults";

// ── Upload ─────────────────────────────────────────────────────────────

export interface PtxPutRequest {
  url: string;
  capability: string;
  contentType: string;
  base64: string;
  nativeFileId?: string;
  contentLength?: number;
  onProgress?: (loaded: number, total: number) => void;
  canStart?: () => boolean;
  correlationId: string;
}

/** One PUT of the recording; rejects only when no HTTP answer arrived. */
export type PtxPut = (request: PtxPutRequest) => Promise<PtxPutResponse>;

/**
 * Local mobile and Mac notes use their engine's native file transport.
 */
export const capacitorPtxPut: PtxPut = async (request) => {
  if (request.nativeFileId) {
    if (!VoiceNotes.uploadAudio) throw new PrivateCloudError("feature_unavailable", "Native audio upload is unavailable");
    if (!Number.isSafeInteger(request.contentLength) || (request.contentLength ?? 0) < 1)
      throw new PrivateCloudError("invalid_argument", "The recording size is invalid");
    const uploadId = request.correlationId;
    const upload = { uploadId, generation: currentAccountGeneration(), cancelled: false, nativeStarted: false };
    activeNativeUpload = upload;
    const progress = await (VoiceNotes.addListener as unknown as (event: string, listener: (event: { uploadId: string; loaded: number; total: number }) => void) => Promise<{ remove(): Promise<void> }>) ("audioUploadProgress", (event) => {
      if (event.uploadId === uploadId) request.onProgress?.(event.loaded, event.total);
    });
    if (upload.cancelled || !(request.canStart?.() ?? true)) {
      activeNativeUpload = null;
      await progress.remove();
      throw new PrivateCloudError("transcription_off", "The private upload was cancelled before it started", { correlationId: request.correlationId });
    }
    try {
      upload.nativeStarted = true;
      return await VoiceNotes.uploadAudio({ id: request.nativeFileId, uploadId, url: request.url,
        capability: request.capability, contentType: request.contentType, contentLength: request.contentLength!, correlationId: request.correlationId });
    } catch (cause) {
      logPipelineError("[VoiceNotes] Native audio upload failed", cause);
      if (cause instanceof PrivateCloudError || cause instanceof VoiceNoteAudioError) throw cause;
      if (localAudioUnavailable(cause)) throw new VoiceNoteAudioError("audio_read_failed", "Could not read this note's local audio");
      throw new PrivateCloudError("upload_outcome_unknown", "The upload connection failed", { correlationId: request.correlationId });
    } finally { if (activeNativeUpload === upload) activeNativeUpload = null; await progress.remove(); }
  }
  // Notes from another device have no native file.
  if (Capacitor.isNativePlatform() || captureEngineKind() === "tauri") return createFetchPtxPut()(request);
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

let activeNativeUpload: { uploadId: string; generation: number; cancelled: boolean; nativeStarted: boolean } | null = null;
subscribeAccountGeneration((generation) => {
  if (activeNativeUpload && activeNativeUpload.generation !== generation) {
    void cancelActiveNativeUpload().catch((cause) => logPipelineError("Cancelling the superseded account's native upload failed", cause));
  }
});
async function cancelActiveNativeUpload(): Promise<void> {
  const upload = activeNativeUpload;
  if (!upload) return;
  upload.cancelled = true;
  activeNativeUpload = null;
  if (upload.nativeStarted && VoiceNotes.cancelAudioUpload) await VoiceNotes.cancelAudioUpload({ uploadId: upload.uploadId });
}

/** The browser has no native HTTP stack; PTX's CORS allows only Authorization and Content-Type, so no X-Correlation-Id here. */
const FETCH_PUT_TIMEOUT_MS = 240_000;

/**
 * The web engine's transport: the same PUT as `capacitorPtxPut` over fetch. A redirect is refused
 * (not followed), any failure to get an HTTP answer is `upload_outcome_unknown`, and a body that is
 * not JSON is null, exactly as on the phone.
 */
export function createFetchPtxPut(
  fetchImpl: typeof fetch = fetch,
  timeoutMs = FETCH_PUT_TIMEOUT_MS,
): PtxPut {
  return async (request) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
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

/** Versioned consent for Private transcription. Older consent must be confirmed once more. */
export const VOICE_NOTE_CONSENT_KEY = "exo.voiceNotes.privateCloudConsent";
export const VOICE_NOTE_CONSENT_VERSION = "2";
export const VOICE_NOTE_HELD_KEY = "exo.voiceNotes.heldFromTranscription";


type KeyValueStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type VoiceNoteRerunBase = Pick<TranscriptCommit, "rev" | "hash">;
export interface PendingVoiceNoteJob {
  /** The create call's Idempotency-Key: the same key re-joins the same job. */
  attemptId: string;
  transcriptionId: string | null;
  /** Prepared result kept locally until its transcript commit is durable. */
  held?: VoiceNoteTranscriptSave;
  /** Device-local terminal failure: prevents recovery from silently restarting after relaunch. */
  failure?: string;
  /** An explicit replacement run is never restarted automatically after a relaunch. */
  explicitRerun?: boolean;
  /** The committed revision an explicit rerun is replacing. */
  rerunBase?: VoiceNoteRerunBase;
}
export interface VoiceNotePendingStore {
  read(sourceId: string): PendingVoiceNoteJob | null;
  write(sourceId: string, job: PendingVoiceNoteJob): void;
  clear(sourceId: string, options?: { held?: "verified_commit" | "note_gone" }): void;
  clearExplicitReruns?(): void;
  sourceIds(): string[];
  legacyHeld?(sourceId: string): unknown;
  stripLegacyHeld?(sourceId: string, rev: number, hash: string): Promise<void>;
}

function isHeldTranscript(value: unknown): value is VoiceNoteTranscriptSave {
  if (!value || typeof value !== "object") return false;
  const held = value as Partial<VoiceNoteTranscriptSave>;
  return Number.isSafeInteger(held.rev) && Array.isArray(held.sentences) && Array.isArray(held.speakers)
    && !!held.metadata && typeof held.metadata === "object" && !Array.isArray(held.metadata);
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
        out[sourceId] = {
          ...v,
          attemptId: v.attemptId,
          transcriptionId: typeof v.transcriptionId === "string" ? v.transcriptionId : null,
        };
      }
      return out;
    } catch {
      return {};
    }
  };
  const writeAll = (all: Record<string, PendingVoiceNoteJob>): boolean => {
    try {
      if (!storage) return false;
      const serialized = JSON.stringify(all);
      storage.setItem(key, serialized);
      return storage.getItem(key) === serialized;
    } catch {
      return false;
    }
  };
  return {
    read: (sourceId) => readAll()[sourceId] ?? null,
    write: (sourceId, job) => {
      const all = readAll();
      const old = all[sourceId];
      const next = { ...all, [sourceId]: {
        ...job, held: job.held ?? old?.held,
        explicitRerun: job.explicitRerun ?? old?.explicitRerun,
        rerunBase: job.rerunBase ?? old?.rerunBase,
      } };
      if (!writeAll(next) && next[sourceId]?.held !== undefined)
        throw new PrivateCloudError("held_result_persistence_failed", "The completed transcript could not be kept in this device's pending store.");
    },
    clear: (sourceId, options) => {
      const all = readAll();
      const old = all[sourceId];
      if (!old) return;
      if (old.held !== undefined && options?.held === undefined) {
        all[sourceId] = { attemptId: old.attemptId, transcriptionId: null, held: old.held };
      } else {
        delete all[sourceId];
      }
      writeAll(all);
    },
    legacyHeld: (sourceId) => readAll()[sourceId]?.held,
    async stripLegacyHeld(sourceId, rev, hash) {
      const original = readAll()[sourceId]?.held;
      if (!isHeldTranscript(original) || original.rev !== rev
        || await transcriptHash(original.sentences) !== hash) return;
      const payload = JSON.stringify(original);
      const all = readAll();
      const current = all[sourceId];
      if (!current || !isHeldTranscript(current.held) || current.held.rev !== rev
        || JSON.stringify(current.held) !== payload) return;
      const { held: _held, ...rest } = current;
      if (Object.keys(rest).some((field) => field !== "attemptId" && field !== "transcriptionId")) {
        all[sourceId] = rest;
      } else {
        delete all[sourceId];
      }
      // Mutations merge synchronously against the latest map; never write the pre-hash snapshot.
      writeAll(all);
    },
    clearExplicitReruns: () => {
      const all = readAll();
      let changed = false;
      for (const [sourceId, job] of Object.entries(all)) {
        if (!job.explicitRerun || job.held !== undefined || job.failure !== undefined) continue;
        delete all[sourceId];
        changed = true;
      }
      if (changed) writeAll(all);
    },
    sourceIds: () => Object.keys(readAll()),
  };
}


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
      if (!beginPrivateChoiceIntent(accountDid, id, storage as Storage | undefined)) return;
      if (!ids.includes(id)) write([...ids, id]);
    },
    remove: (id) => {
      clearChoicePinMetadata(accountDid, id, storage as Storage | undefined);
      write(read().filter((other) => other !== id));
    },
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
        return storage?.getItem(key) === VOICE_NOTE_CONSENT_VERSION;
      } catch {
        return false;
      }
    },
    set: (consented) => {
      try {
        if (consented) storage?.setItem(key, VOICE_NOTE_CONSENT_VERSION);
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

/** Keep PTX's speech regions and speaker/channel identity in the saved body. */
export function voiceNoteSentences(transcript: Pick<PrivateCloudTranscript, "segments" | "diarized" | "speakers" | "channels">): FirefliesSentence[] {
  const speakerNames = new Map(transcript.speakers?.map((speaker) => [speaker.id, speaker.name]));
  const segments = transcript.segments
    .map((seg) => ({ start: seg.start, end: seg.end, text: typeof seg.text === "string" ? seg.text.trim() : "",
      channel: seg.channel === 0 || seg.channel === 1 ? seg.channel as 0 | 1 : undefined,
      speakerId: transcript.diarized ? seg.speaker_id ?? null : null,
      speaker: transcript.channels === 2 ? (seg.channel === 0 ? "Me" : "Them")
        : transcript.diarized && seg.speaker_id
        ? speakerNames.get(seg.speaker_id) ?? (seg.speaker_id.match(/^speaker_(\d+)$/)
          ? `Speaker ${Number(seg.speaker_id.slice(8)) + 1}` : seg.speaker_id)
        : null }))
    .filter((seg) => seg.text.length > 0 && Number.isFinite(seg.start) && Number.isFinite(seg.end))
    .flatMap((seg) => splitLongTimedSegment({ ...seg, timing: "engine" as const }, 30))
    .sort((a, b) => a.start - b.start || (a.channel ?? -1) - (b.channel ?? -1) || a.end - b.end);
  return segments.map((turn, index) => ({
    index,
    speaker_name: turn.speaker,
    text: turn.text,
    start_time: turn.start,
    end_time: turn.end,
    ...(turn.channel === undefined ? {} : { channel: turn.channel }),
    ...(turn.speakerId === null ? {} : { speaker_id: turn.speakerId }),
    timing: turn.timing,
  }));
}

export const MIN_INCOMPLETE_TRANSCRIPT_DURATION_SECONDS = 600;
export const MIN_INCOMPLETE_TRANSCRIPT_COVERAGE_RATIO = 0.35;
export const VAD_DROP_REJECT_PCT = 10;

/** Older PTX or backend versions may not return the VAD-drop metric. */
function shouldRejectIncompleteTranscript(stats: PrivateCloudTranscriptionStats | null | undefined,
  metadata: VoiceNoteTranscriptionStatsMetadata): boolean {
  const dropped = stats?.dropped_above_floor_pct;
  const exceedsDropThreshold = typeof dropped === "number" && Number.isFinite(dropped) && dropped > VAD_DROP_REJECT_PCT;
  return exceedsDropThreshold || rejectsForIncompleteCoverage(metadata);
}

function transcriptStatsMetadata(transcript: PrivateCloudTranscript): VoiceNoteTranscriptionStatsMetadata {
  const metadata: VoiceNoteTranscriptionStatsMetadata = {};
  const duration = transcript.duration_seconds;
  const audio = transcript.stats?.tinfoil_audio_seconds;
  if (typeof duration === "number" && Number.isFinite(duration) && duration >= 0
    && typeof audio === "number" && Number.isFinite(audio) && audio >= 0) {
    metadata.transcription_duration_seconds = duration;
    metadata.transcription_audio_seconds = audio;
  }
  const voiced = transcript.stats?.voiced_seconds;
  if (typeof voiced === "number" && Number.isFinite(voiced) && voiced >= 0)
    metadata.transcription_voiced_seconds = voiced;
  const dropped = transcript.stats?.dropped_above_floor_pct;
  if (typeof dropped === "number" && Number.isFinite(dropped) && dropped >= 0 && dropped <= 100)
    metadata.transcription_vad_dropped_above_floor_pct = dropped;
  if (typeof transcript.stats?.vad_fallback === "boolean")
    metadata.transcription_vad_fallback = transcript.stats.vad_fallback;
  const mode = transcript.stats?.vad_mode;
  if (mode === "primary" || mode === "fallback" || mode === "quiet")
    metadata.transcription_vad_mode = mode;
  const noiseFloor = transcript.stats?.noise_floor_dbfs;
  if (typeof noiseFloor === "number" && Number.isFinite(noiseFloor))
    metadata.transcription_noise_floor_dbfs = noiseFloor;
  const median = transcript.stats?.median_dbfs;
  if (typeof median === "number" && Number.isFinite(median))
    metadata.transcription_median_dbfs = median;
  const p99 = transcript.stats?.p99_dbfs;
  if (typeof p99 === "number" && Number.isFinite(p99))
    metadata.transcription_p99_dbfs = p99;
  const speechPeak = transcript.stats?.speech_peak_s;
  if (typeof speechPeak === "number" && Number.isFinite(speechPeak) && speechPeak >= 0)
    metadata.transcription_speech_peak_s = speechPeak;
  const droppedAboveNoise = transcript.stats?.dropped_above_noise_pct;
  if (typeof droppedAboveNoise === "number" && Number.isFinite(droppedAboveNoise) && droppedAboveNoise >= 0 && droppedAboveNoise <= 100)
    metadata.transcription_vad_dropped_above_noise_pct = droppedAboveNoise;
  return metadata;
}

function rejectsForIncompleteCoverage(metadata: VoiceNoteTranscriptionStatsMetadata): boolean {
  const duration = metadata.transcription_duration_seconds;
  const audio = metadata.transcription_audio_seconds;
  return duration !== undefined && duration >= MIN_INCOMPLETE_TRANSCRIPT_DURATION_SECONDS
    && audio !== undefined && audio / duration < MIN_INCOMPLETE_TRANSCRIPT_COVERAGE_RATIO;
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
export function prepareVoiceNoteTranscript(transcript: PrivateCloudTranscript, transcribedAt: string, rev: number,
  statsMetadata: VoiceNoteTranscriptionStatsMetadata = transcriptStatsMetadata(transcript)): VoiceNoteTranscriptSave {
  const sentences = voiceNoteSentences(transcript);
  if (sentences.length === 0) return noSpeechTranscript(transcribedAt, rev, statsMetadata);
  return {
    rev,
    sentences,
    speakers: [...new Set(sentences.map((sentence) => sentence.speaker_name).filter((name): name is string => name !== null))],
    metadata: {
      ...engineMetadata(transcribedAt),
      inference_provider: transcript.provider ?? "tinfoil",
      model: transcript.model ?? null,
      language: transcript.language ?? null,
      transcript_text: sentences.map((s) => s.text).join("\n"),
      transcription_outcome: "transcribed",
      speaker_labels: transcript.channels === 2 ? "channels" : transcript.diarized ? "diarized" : "single-speaker",
      ...statsMetadata,
    },
  };
}

/** PTX found no speech: recorded on the note so it is not offered again. */
export function noSpeechTranscript(transcribedAt: string, rev: number,
  statsMetadata: VoiceNoteTranscriptionStatsMetadata = {}): VoiceNoteTranscriptSave {
  return {
    rev,
    sentences: [],
    speakers: [],
    metadata: { ...engineMetadata(transcribedAt), transcript_text: null, transcription_outcome: "no_speech",
      speaker_labels: "none", ...statsMetadata },
  };
}

// ── The engine ─────────────────────────────────────────────────────────

/** Progress of one note's transcription. */
export type VoiceNoteTranscriptionStatus =
  /** `position`: 1-based place among the notes waiting to start (1 = next); the running note is not counted. */
  | { kind: "waiting"; position: number }
  | { kind: "preparing" }
  | { kind: "uploading"; progress?: number }
  | { kind: "queued"; position: number | null }
  | { kind: "processing"; completed: number | null; total: number | null }
  | { kind: "saving" };

export type CloudPollingOptions = CloudPolling;

/** The desktop's polling: 5 s for 30 s, then duration-scaled 30–60 s, with jitter. */
const DEFAULT_POLLING: CloudPollingOptions = {
  intervalMs: 5_000,
  slowIntervalMs: 30_000,
  slowAfterMs: 60_000,
  giveUpAfterMs: 10 * 60_000,
  fastPhaseMs: 30_000,
  maxIntervalMs: 60_000,
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
  "provider_unavailable",
  "provider_outcome_unknown",
  "processing_timeout",
  "processing_failed",
  "transcription_failed",
  "transcript_expired",
  "transcription_not_found",
]);



function isAutomaticRetryableError(error: unknown): boolean {
  return isAutomaticRetryableCode(voiceNoteErrorCode(error));
}

const MANUAL_ONLY_RETRY_CODES: ReadonlySet<string> = new Set(["quota_exceeded"]);

const RELEASE_CODES: ReadonlySet<string> = new Set([
  "recording_too_large",
  "unsupported_recording",
  "service_misconfigured",
  "audio_size_mismatch",
  "recording_too_long_for_phone",
  "decode_failed",
  "decode_unavailable",
  "feature_unavailable",
  "invalid_argument",
  "idempotency_conflict",
  "voice_note_not_found",
  "transcription_off",
]);

const NOTE_INTRINSIC_FAILURE_CODES: ReadonlySet<string> = new Set([
  "transcript_incomplete",
  "recording_too_long",
  "recording_too_large",
  "unsupported_recording",
  "invalid_audio",
]);

class DeviceLocalVoiceNoteAudioError extends VoiceNoteAudioError {}

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
    ? (listed as string[]).map(bareMimeType)
    : ["audio/mpeg", "audio/wav", "audio/ogg"];
}

/** The limit fields PTX's /capabilities may carry; each is optional on the wire. */
export type PrivateCloudLimitFields = Partial<Pick<PrivateCloudCapabilities, "max_duration_seconds" | "accepted_max_duration_seconds" | "max_bytes" | "duration_grace_seconds">>;

/**
 * Seconds PTX's measured container duration can exceed the decoded one by (an MP3 that decodes to 10 s measures
 * 10.031 s). A note is admitted only if it still fits under PTX's inclusive ceiling with this margin added.
 */
export const PRIVATE_DURATION_MARGIN_SECONDS = 0.25;

/**
 * PTX's limits from /capabilities. Null when it advertises no maximum duration: no Private limit is ever assumed.
 * `maxSeconds` is PTX's inclusive ceiling on measured duration, before the client margin.
 */
export interface PrivateCloudLimits {
  maxSeconds: number;
  /** PTX's byte cap (`max_bytes`), or null when absent. */
  maxBytes: number | null;
}

export type PrivateCloudRefusal =
  | { kind: "unknown" }
  | { kind: "duration"; limitSeconds: number; durationSeconds: number }
  | { kind: "bytes"; limitBytes: number; sizeBytes: number };

/** What a Private start returns to its caller when refused: a state, or the duration limit a note breaks. */
export type PrivateStartRefusal = TranscriptionAdmissionRefusal | Extract<PrivateCloudRefusal, { kind: "duration" | "bytes" }>;

/** Thrown before any PTX job exists when a note is not admissible under the limits as they are now. */
export class PrivateCloudRefusedError extends Error {
  readonly refusal: PrivateCloudRefusal;
  constructor(refusal: PrivateCloudRefusal) {
    super(`Private transcription refused: ${refusal.kind}`);
    this.name = "PrivateCloudRefusedError";
    this.refusal = refusal;
  }
}

/**
 * The limits a Private job is held to. `accepted_max_duration_seconds` is already the inclusive ceiling, so grace is
 * never added to it. Without it, `max_duration_seconds` plus the optional `duration_grace_seconds` (absent = 0).
 */
export function privateCloudLimits(capabilities: PrivateCloudLimitFields | null): PrivateCloudLimits | null {
  const accepted = capabilities?.accepted_max_duration_seconds;
  const advertised = capabilities?.max_duration_seconds;
  const grace = capabilities?.duration_grace_seconds;
  const bytes = capabilities?.max_bytes;
  const graceSeconds = typeof grace === "number" && Number.isFinite(grace) && grace > 0 ? grace : 0;
  const seconds = typeof accepted === "number" && Number.isFinite(accepted) && accepted > 0 ? accepted
    : typeof advertised === "number" && Number.isFinite(advertised) && advertised > 0 ? advertised + graceSeconds : null;
  const validBytes = typeof bytes === "number" && Number.isSafeInteger(bytes) && bytes > 0 ? bytes : null;
  if (seconds === null || validBytes === null) return null;
  return { maxSeconds: seconds, maxBytes: validBytes };
}

/**
 * The first limit a note breaks, or null. Unknown limits refuse every note. The server measures the raw duration,
 * so seconds are compared unrounded, with the margin added: a duration is eligible iff duration + margin ≤ ceiling.
 * A null duration or size is not checked. Shared by route controls, note actions and `run`.
 */
export function privateCloudRefusal(durationSecs: number | null, sizeBytes: number | null, limits: PrivateCloudLimits | null): PrivateCloudRefusal | null {
  if (limits === null) return { kind: "unknown" };
  if (durationSecs !== null && (!Number.isFinite(durationSecs) || durationSecs < 0 || durationSecs + PRIVATE_DURATION_MARGIN_SECONDS > limits.maxSeconds)) {
    return { kind: "duration", limitSeconds: limits.maxSeconds, durationSeconds: durationSecs };
  }
  if (sizeBytes !== null && limits.maxBytes !== null && sizeBytes > limits.maxBytes) {
    return { kind: "bytes", limitBytes: limits.maxBytes, sizeBytes };
  }
  return null;
}

/** Whether a recording fits the limits PTX advertises. Unknown limits accept nothing. Shared by route controls and note actions. */
export function privateCloudAccepts(
  durationSecs: number | null,
  capabilities: PrivateCloudLimitFields | null,
  sizeBytes: number | null = null,
): boolean {
  return privateCloudRefusal(durationSecs, sizeBytes, privateCloudLimits(capabilities)) === null;
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
  /** Mark this in-flight job as explicit-only: it must not be resumed after relaunch. */
  explicitRerun?: boolean;
  /** The committed revision this explicit rerun replaces; persisted with the job/result. */
  rerunBase?: VoiceNoteRerunBase;
  sourceId: string;
  capabilities: PrivateCloudCapabilities;
  /** PTX's limits as they are now, read again right before a job is created. A limit that moved while the audio loaded refuses there. */
  currentCapabilities?: () => PrivateCloudCapabilities | null;
  identifySpeakers?: boolean;
  /** Stereo Mac notes use channel labels instead of PTX diarization. */
  channelCount?: 1 | 2;
  loadAudio: () => Promise<VoiceNoteAudio & { nativeFileId?: string; loadSpaceCopy?: () => Promise<VoiceNoteAudio> }>;
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
  /** Service capabilities. An upload or service failure rejects with a typed code. */
  capabilities(): Promise<PrivateCloudCapabilities>;
  /** Notes with a job in flight (to resume after a relaunch). */
  pendingSourceIds(): string[];
  /** Whether a PTX job ID, rather than only an unsent create attempt, is stored. */
  hasRemoteJob(sourceId: string): boolean;
  /** A non-retryable attempt failure stored on this device, never in the shared row. */
  terminalFailure?(sourceId: string): string | null;
  rerunBase?(sourceId: string): VoiceNoteRerunBase | null;
  rememberTerminalFailure?(sourceId: string, code: string): void;
  clearTerminalFailure?(sourceId: string): void;
  clearExplicitReruns?(): void;
  /** Upload (or re-join) the note's job and wait for its transcript. */
  transcribe(
    input: VoiceNoteTranscribeInput,
    report: (status: VoiceNoteTranscriptionStatus) => void,
  ): Promise<{ transcriptionId: string; transcript: PrivateCloudTranscript }>;
  /** Call only after a verified commit or deliberate terminal discard. */
  finish(sourceId: string, transcriptionId?: string | null): Promise<void>;
  holdTranscript(sourceId: string, transcript: VoiceNoteTranscriptSave, rerunBase?: VoiceNoteRerunBase | null): void;
  /** The prepared transcript whose save is still owed, if any. */
  heldTranscript(sourceId: string): VoiceNoteTranscriptSave | null;
  stripLegacyHeld?(sourceId: string, rev: number, hash: string): Promise<void>;
  clearLegacyHeld?(sourceId: string, reason: "note_gone"): void;
  /** Cancel and forget jobs still waiting for upload; completed jobs are preserved. */
  releaseUnsent(sourceId?: string): Promise<void>;
}
/**
 * PTX result is not settled until its transcript commit is durable. Store a
 * best-effort copy beside the job, but still save this in-memory result if
 * that pending-store write fails.
 */
export async function commitPreparedVoiceNoteTranscript(args: {
  tcw: TinyCloudWeb;
  cloud: VoiceNoteCloud;
  sourceId: string;
  transcript: VoiceNoteTranscriptSave;
  rerunBase?: VoiceNoteRerunBase | null;
  heldRerunResult?: boolean;
  held?: HeldResultStore;
  heldRecord?: HeldResult | null;
  holdInput?: HeldResultInput;
  mode?: "automatic" | "explicit";
  save: () => Promise<void>;
  finish: () => Promise<void>;
  stillCurrent: () => boolean;
}): Promise<TranscriptCommit | null> {
  let holdFailed = false;
  let row = args.heldRecord ?? null;
  if (args.held) {
    try {
      if (!row && args.holdInput) await args.held.hold(args.holdInput);
      row ??= await args.held.readHeld(args.sourceId);
    } catch {
      holdFailed = true;
    }
    if (row) {
      const outcome = await args.held.saveHeldFirst(args.tcw, args.sourceId, {
        save: () => args.save(),
        afterCommit: async (committed) => {
          await args.cloud.stripLegacyHeld?.(args.sourceId, committed.transcript.rev, committed.hash);
          try {
            await args.cloud.finish(args.sourceId,
              committed.provider && "transcriptionId" in committed.provider ? committed.provider.transcriptionId : null);
          } catch (error) {
            logPipelineError("Deleting a finished private cloud job failed; PTX deletes it on its own schedule", error);
          }
        },
        stillCurrent: args.stillCurrent,
      }, args.mode ?? "automatic");
      if (outcome === "conflict") {
        const conflict = (await args.held.readHeld(args.sourceId))?.conflict ?? "rerun_lost";
        throw new PrivateCloudError(conflict, "Held transcript commit conflict.");
      }
      if (outcome === "lock_busy") throw new PrivateCloudError("held_result_lock_busy", "The held transcript is being committed in another tab.");
      if (outcome === "discarded_superseded") return await readTranscriptCommit(args.tcw, args.sourceId);
      return await readTranscriptCommit(args.tcw, args.sourceId);
    }
  } else {
    try {
      args.cloud.holdTranscript(args.sourceId, args.transcript, args.rerunBase);
    } catch {
      holdFailed = true;
    }
  }
  if (!args.stillCurrent()) throw accountChangedError();
  const existing = await readTranscriptCommit(args.tcw, args.sourceId);
  if (existing !== null && existing.rev >= args.transcript.rev) {
    if (args.rerunBase && (existing.rev !== args.rerunBase.rev || existing.hash !== args.rerunBase.hash)) {
      if (args.heldRerunResult) {
        await args.finish();
        return existing;
      }
      throw new PrivateCloudError("transcript_save_failed", "A different transcript revision won this rerun. Try again.");
    }
    if (!args.rerunBase) {
      await args.finish();
      return existing;
    }
  }
  try {
    await args.save();
  } catch (err) {
    if (voiceNoteErrorCode(err) === "voice_note_not_found" && args.stillCurrent()) {
      await args.finish();
      args.cloud.clearLegacyHeld?.(args.sourceId, "note_gone");
    }
    if (holdFailed && voiceNoteErrorCode(err) !== ACCOUNT_CHANGED)
      throw new PrivateCloudError("held_result_persistence_failed", "The finished transcript could not be kept on this device; retry now.");
    throw err;
  }
  if (!args.stillCurrent()) throw accountChangedError();
  const committed = await readTranscriptCommit(args.tcw, args.sourceId);
  if (committed === null || committed.rev < args.transcript.rev)
    throw new PrivateCloudError("transcript_save_failed", "The transcript commit could not be verified");
  await args.finish();
  return committed;
}

/** Commit an already-held Private result when no PTX client is available. */
export async function drainHeldVoiceNote(
  tcw: TinyCloudWeb,
  held: HeldResultStore,
  sourceId: string,
  stillCurrent: () => boolean,
  afterCommit: (row: HeldResult) => Promise<void> = async () => undefined,
): Promise<"committed" | "already_committed" | "discarded_superseded" | "conflict" | "lock_busy" | null> {
  const row = await held.readHeld(sourceId);
  if (!row) return null;
  const note = await readVoiceNoteForTranscription(tcw, sourceId);
  if (!note.ok) throw new PrivateCloudError("note_unreadable", note.error.message);
  if (note.data === null) {
    await held.discard(tcw, sourceId, row.holdId, "note_gone");
    return null;
  }
  const account = { generation: currentAccountGeneration(), did: tcw.did };
  return held.saveHeldFirst(tcw, sourceId, {
    save: async () => {
      if (!stillCurrent()) throw accountChangedError();
      const saved = await saveVoiceNoteTranscript(tcw, sourceId, row.transcript, account,
        () => {
          if (!stillCurrent()) throw accountChangedError();
        });
      if (!saved.ok) {
        if (saved.error.code === "VOICE_NOTE_NOT_FOUND")
          throw new PrivateCloudError("voice_note_not_found", saved.error.message);
        throw new PrivateCloudError("transcript_save_failed", saved.error.message);
      }
    },
    afterCommit: async (committed) => {
      await afterCommit(committed);
    },
    stillCurrent,
  }, "automatic");
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
  const writePending = (sourceId: string, job: Omit<PendingVoiceNoteJob, "explicitRerun">, explicitRerun = false) => {
    const current = pending.read(sourceId);
    const staysExplicit = explicitRerun || current?.explicitRerun === true;
    const rerunBase = job.rerunBase ?? current?.rerunBase;
    pending.write(sourceId, {
      ...job,
      ...(staysExplicit ? { explicitRerun: true } : {}),
      ...(rerunBase ? { rerunBase } : {}),
    });
  };
  const language = deps.language ?? "en";
  const sleep = (baseMs: number) => clock.sleep(Math.round(baseMs * (0.8 + 0.4 * clock.random())));

  /** Best-effort: a job that cannot be cancelled now expires at its upload deadline. */
  const cancelQuietly = async (transcriptionId: string) => {
    try {
      await deps.api.cancel(transcriptionId);
    } catch (err) {
      logPipelineError("Cancelling an unused private cloud job failed; it expires on its own", err);
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

  /** Rides out transient failures; shared throttled time pauses each active operation budget. */
  const transientTolerance = (wait: (ms: number) => Promise<void>, throttledTime: () => number = () => 0) => {
    let failingSince: number | null = null;
    let throttledAtFailure = 0;
    return {
      reset: () => { failingSince = null; throttledAtFailure = throttledTime(); },
      pause: async (ms: number, waitFor?: (delay: number) => Promise<void>) => {
        const before = clock.now();
        try {
          await (waitFor ?? wait)(ms);
        } finally {
          if (failingSince !== null) failingSince += Math.max(0, clock.now() - before);
        }
      },
      rideOut: async (err: unknown) => {
        if (!isTransientCloudError(err)) throw err;
        const now = clock.now();
        if (failingSince === null) {
          failingSince = now;
          throttledAtFailure = throttledTime();
        }
        const failingFor = Math.max(0, now - failingSince - (throttledTime() - throttledAtFailure));
        if (failingFor >= polling.giveUpAfterMs) {
          throw new PrivateCloudError(
            "connection_lost",
            "Lost contact with private cloud transcription. The job may still be running.",
          );
        }
        await wait(failingFor >= polling.slowAfterMs ? polling.slowIntervalMs : polling.intervalMs);
      },
    };
  };

  /** Before every request for a note's job: its account must still be the signed-in one (the session's token is shared). */
  type Guard = () => void;

  const readJob = async (id: string, guard: Guard): Promise<PrivateCloudJob> => {
    const tolerance = transientTolerance((ms) => sleep(ms));
    for (;;) {
      guard();
      try {
        const job = await deps.api.get(id);
        guard();
        tolerance.reset();
        return job;
      } catch (err) {
        guard();
        if (err instanceof PrivateCloudError && err.statusCode === 429) {
          const delay = jitteredRateLimitWaitMs(err.retryAfterSeconds, polling.slowIntervalMs, clock.random);
          await tolerance.pause(delay, (ms) => clock.sleep(ms));
          continue;
        }
        await tolerance.rideOut(err);
      }
    }
  };

  const poll = async (
    id: string,
    report: (s: VoiceNoteTranscriptionStatus) => void,
    guard: Guard,
    expectedDurationSeconds: number | null | undefined,
  ): Promise<PrivateCloudTranscript> => {
    const startedAt = clock.now();
    let durationSeconds = expectedDurationSeconds ?? null;
    let throttledMs = 0;
    const throttledTime = () => throttledMs;
    const waitThrottled = async (ms: number): Promise<void> => {
      const before = clock.now();
      try {
        await clock.sleep(ms);
      } finally {
        throttledMs += Math.max(0, clock.now() - before);
      }
    };
    const statusTolerance = transientTolerance((ms) => sleep(ms), throttledTime);
    const resultTolerance = transientTolerance((ms) => sleep(ms), throttledTime);
    report({ kind: "queued", position: null });
    for (;;) {
      let job: PrivateCloudJob;
      guard();
      try {
        job = await deps.api.get(id);
        guard();
        statusTolerance.reset();
      } catch (err) {
        guard();
        if (err instanceof PrivateCloudError && err.statusCode === 429) {
          await waitThrottled(jitteredRateLimitWaitMs(err.retryAfterSeconds, polling.slowIntervalMs, clock.random));
          continue;
        }
        await statusTolerance.rideOut(err);
        continue;
      }
      if (typeof job.duration_seconds === "number" && Number.isFinite(job.duration_seconds) && job.duration_seconds > 0) {
        durationSeconds = job.duration_seconds;
      }
      if (job.status === "completed") {
        let result: Awaited<ReturnType<PrivateCloudApi["result"]>>;
        try {
          result = await deps.api.result(id);
          guard();
          resultTolerance.reset();
        } catch (err) {
          guard();
          if (err instanceof PrivateCloudError && err.statusCode === 429) {
            await waitThrottled(jitteredRateLimitWaitMs(err.retryAfterSeconds, polling.slowIntervalMs, clock.random));
            continue;
          }
          await resultTolerance.rideOut(err);
          continue;
        }
        if (result.status === "completed") return result.transcript;
        if (result.status !== "pending") throw result.error;
      } else {
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
      const elapsed = clock.now() - startedAt;
      const interval = cloudStatusIntervalMs(durationSeconds, elapsed, polling);
      await clock.sleep(elapsed < polling.fastPhaseMs ? interval : jitteredCloudIntervalMs(interval, clock.random));
      guard();
    }
  };

  const createJob = async (sourceId: string, job: PendingVoiceNoteJob, body: PrivateCloudCreateBody, guard: Guard, revalidate: () => void) => {
    let current = job;
    for (let fresh = 0; ; fresh++) {
      guard();
      revalidate();
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
        current = { ...current, attemptId: newId(), transcriptionId: null };
        writePending(sourceId, current);
      }
    }
  };

  const run = async (
    { sourceId, capabilities, loadAudio, durationSeconds, identifySpeakers = false, channelCount = 1, allowed = () => true,
      explicitRerun = false, rerunBase, currentCapabilities = () => capabilities }: VoiceNoteTranscribeInput,
    report: (status: VoiceNoteTranscriptionStatus) => void,
  ) => {
    const guard: Guard = () => {
      if (!allowed("account")) throw accountChangedError();
    };
    guard();
    let job = pending.read(sourceId);
    if (job && explicitRerun) {
      job = { ...job, ...(rerunBase ? { rerunBase } : {}) };
      writePending(sourceId, job, true);
    }
    if (job === null && rerunBase !== undefined) {
      job = { attemptId: newId(), transcriptionId: null, rerunBase };
      writePending(sourceId, job, explicitRerun);
    }
    // Re-join a job this note already has: ask before uploading again.
    if (job?.transcriptionId) {
      let current: PrivateCloudJob | null = null;
      try {
        current = await readJob(job.transcriptionId, guard);
      } catch (err) {
        if (!(err instanceof PrivateCloudError && err.code === "transcription_not_found")) throw err;
        if (job.failure) throw err;
        job = null;
        pending.clear(sourceId);
      }
      if (current !== null) {
        if (current.status === "failed" || current.status === "cancelled") throw jobFailure(current);
        if (current.status !== "awaiting_upload") return { transcriptionId: current.id, transcript: await poll(current.id, report, guard, durationSeconds) };
      }
    }

    // Everything up to the upload happens with no job waiting on it, or releases the one that is.
    const limits = privateCloudLimits(currentCapabilities());
    let audio: PreparedTranscriptionAudio & { nativeFileId?: string; loadSpaceCopy?: () => Promise<VoiceNoteAudio> };
    let effectiveDuration = durationSeconds ?? null;
    try {
      // Unknown limits and a note too long for them are refused before any audio is read or any job is created.
      if (limits === null) throw new PrivateCloudRefusedError({ kind: "unknown" });
      const early = privateCloudRefusal(durationSeconds ?? null, null, limits);
      if (early !== null) throw new PrivateCloudRefusedError(early);
      // The prepared WAV is checked against the latest ceiling after decoding; this cap only bounds pre-decode work.
      const maxSeconds = limits.maxSeconds;
      guard();
      if (!allowed()) throw transcriptionOffError();
      report({ kind: "preparing" });
      const source = await loadAudio();
      if (source.nativeFileId) {
        if (!VoiceNotes.audioMetadata) throw new VoiceNoteAudioError("audio_read_failed", "Native audio metadata is unavailable");
        try {
          const meta = await VoiceNotes.audioMetadata({ id: source.nativeFileId });
          if (!acceptedContentTypes(capabilities).includes(meta.mimeType))
            throw new DeviceLocalVoiceNoteAudioError("unsupported_recording", "Private cloud transcription does not accept this recording's format.");
          audio = { contentType: meta.mimeType, base64: "", byteSize: meta.size, sha256: meta.sha256, durationSeconds: null, nativeFileId: source.nativeFileId };
        } catch (cause) {
          if (!localAudioUnavailable(cause)) throw cause;
          logPipelineError("[VoiceNotes] Native audio disappeared while reading its metadata; using the committed space copy", cause);
          const fallback = await source.loadSpaceCopy!();
          audio = await prepareTranscriptionAudio(fallback, {
            acceptedContentTypes: acceptedContentTypes(capabilities), maxBytes: capabilities.max_bytes,
            maxSeconds, decode: deps.decode,
          });
        }
      } else audio = await prepareTranscriptionAudio(source, {
        acceptedContentTypes: acceptedContentTypes(capabilities),
        maxBytes: capabilities.max_bytes,
        maxSeconds,
        decode: deps.decode,
      });
      guard();
      if (!allowed()) throw transcriptionOffError();
      // Last check, against the limits as they are now: a limit that moved while the audio loaded refuses here, before a job exists.
      const latest = privateCloudLimits(currentCapabilities());
      if (latest === null) throw new PrivateCloudRefusedError({ kind: "unknown" });
      const preparedDuration = audio.durationSeconds;
      const clientDuration = durationSeconds ?? null;
      effectiveDuration = preparedDuration === null ? clientDuration
        : clientDuration === null ? preparedDuration : Math.max(clientDuration, preparedDuration);
      const latestRefusal = privateCloudRefusal(effectiveDuration, audio.byteSize, latest);
      if (latestRefusal !== null) throw new PrivateCloudRefusedError(latestRefusal);
    } catch (err) {
      let failure: unknown = err;
      if (err instanceof VoiceNoteAudioError) {
        const latest = privateCloudLimits(currentCapabilities());
        if (err.durationSeconds !== undefined) {
          const measured = Math.max(durationSeconds ?? 0, err.durationSeconds);
          const refusal = privateCloudRefusal(measured, null, latest);
          if (refusal !== null) failure = new PrivateCloudRefusedError(refusal);
        } else if (err.sizeBytes !== undefined) {
          const refusal = privateCloudRefusal(durationSeconds ?? null, err.sizeBytes, latest);
          if (refusal?.kind === "bytes") failure = new PrivateCloudRefusedError(refusal);
        }
      }
      // An account that left keeps its job whatever this failure was (nothing is sent for it now).
      guard();
      await release(sourceId, guard);
      throw failure;
    }
    if (job === null) {
      job = { attemptId: newId(), transcriptionId: null, ...(rerunBase ? { rerunBase } : {}) };
      writePending(sourceId, job, explicitRerun);
    }
    const body: PrivateCloudCreateBody = {
      content_type: audio.contentType,
      byte_size: audio.byteSize,
      sha256: audio.sha256,
      language,
      channel_mode: channelCount === 2 ? "separate" : "mixed",
      channel_labels: [...(channelCount === 2 ? ME_THEM_CHANNEL_LABELS : VOICE_NOTE_CHANNEL_LABELS)],
      ...(identifySpeakers && channelCount === 1 && capabilities.diarization === true ? { diarize: true } : {}),
    };
    const revalidate = () => {
      const latest = privateCloudLimits(currentCapabilities());
      const refusal = privateCloudRefusal(effectiveDuration, audio.byteSize, latest);
      if (refusal !== null) throw new PrivateCloudRefusedError(refusal);
    };
    const createdJob = await createJob(sourceId, job, body, guard, revalidate);
    job = { ...createdJob.job, transcriptionId: createdJob.created.id };
    writePending(sourceId, job, explicitRerun);
    const created = createdJob.created;

    if (created.upload !== null) {
      // The last moment to stop: nothing has been sent yet.
      guard();
      if (!allowed()) throw transcriptionOffError();
      try {
        revalidate();
      } catch (err) {
        // The new PTX job is still awaiting bytes, so release this reservation without touching uploaded jobs.
        await release(sourceId, guard);
        throw err;
      }
      report({ kind: "uploading" });
      const correlationId = newId();
      try {
        const url = ptxUploadUrl(deps.origin, created.upload.path);
        interpretUploadResponse(
          await deps.put({ url, capability: created.upload.capability, contentType: audio.contentType, base64: audio.base64,
            ...(audio.nativeFileId ? { nativeFileId: audio.nativeFileId, contentLength: audio.byteSize,
              canStart: () => allowed(),
              onProgress: (loaded, total) => report({ kind: "uploading", progress: total > 0 ? loaded / total : 0 }) } : {}), correlationId }),
          correlationId,
        );
        logPipeline("transcription_audio_upload", sourceId, "done", { engine: "private-cloud", bodyBytes: audio.byteSize });
      } catch (err) {
        logPipelineError("transcription_audio_upload", err, sourceId);
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
    return { transcriptionId: created.id, transcript: await poll(created.id, report, guard, durationSeconds) };
  };

  return {
    async capabilities() {
      if (deps.uploadSupported && !(await deps.uploadSupported()))
        throw new PrivateCloudError("feature_unavailable", "This device cannot upload a recording for private transcription");
      return deps.api.capabilities();
    },

    pendingSourceIds: () => pending.sourceIds().filter((sourceId) => {
      const job = pending.read(sourceId);
      return !job?.explicitRerun || job.held !== undefined || job.failure !== undefined;
    }),
    hasRemoteJob: (sourceId) => {
      const job = pending.read(sourceId);
      return job !== null && job.transcriptionId !== null;
    },
    terminalFailure: (sourceId) => pending.read(sourceId)?.failure ?? null,
    rerunBase: (sourceId) => pending.read(sourceId)?.rerunBase ?? null,
    rememberTerminalFailure: (sourceId, code) => {
      const current = pending.read(sourceId);
      pending.write(sourceId, {
        attemptId: current?.attemptId ?? newId(),
        transcriptionId: current?.transcriptionId ?? null,
        ...(current?.held ? { held: current.held } : {}),
        ...(current?.explicitRerun ? { explicitRerun: true } : {}),
        ...(current?.rerunBase ? { rerunBase: current.rerunBase } : {}),
        failure: code,
      });
    },
    clearTerminalFailure: (sourceId) => {
      const current = pending.read(sourceId);
      if (!current?.failure) return;
      if (current.transcriptionId === null && current.held === undefined && !current.explicitRerun) {
        pending.clear(sourceId);
        return;
      }
      const { failure: _failure, ...job } = current;
      pending.write(sourceId, job);
    },
    clearExplicitReruns: () => pending.clearExplicitReruns?.(),

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
        if (RELEASE_CODES.has(code)) {
          await release(input.sourceId, guard);
          if (input.explicitRerun && input.rerunBase)
            writePending(input.sourceId, { attemptId: newId(), transcriptionId: null, rerunBase: input.rerunBase }, true);
        } else if (JOB_ENDED_CODES.has(code) && pending.read(input.sourceId)?.failure === undefined) {
          pending.clear(input.sourceId);
          if (input.explicitRerun && input.rerunBase)
            writePending(input.sourceId, { attemptId: newId(), transcriptionId: null, rerunBase: input.rerunBase }, true);
        }
        throw err;
      }
    },

    async finish(sourceId, transcriptionId) {
      const id = transcriptionId === undefined ? (pending.read(sourceId)?.transcriptionId ?? null) : transcriptionId;
      pending.clear(sourceId);
      if (id !== null) await deps.api.remove(id);
    },
    holdTranscript(sourceId, transcript, rerunBase) {
      const current = pending.read(sourceId);
      pending.write(sourceId, {
        attemptId: current?.attemptId ?? newId(),
        transcriptionId: current?.transcriptionId ?? null,
        ...(current?.explicitRerun ? { explicitRerun: true } : {}),
        ...((rerunBase ?? current?.rerunBase) ? { rerunBase: rerunBase ?? current?.rerunBase } : {}),
        held: transcript,
      });
    },
    heldTranscript: (sourceId) => pending.read(sourceId)?.held ?? null,
    stripLegacyHeld: (sourceId, rev, hash) => pending.stripLegacyHeld?.(sourceId, rev, hash) ?? Promise.resolve(),
    clearLegacyHeld: (sourceId, reason) => pending.clear(sourceId, { held: reason }),



    async releaseUnsent(onlySourceId) {
      for (const sourceId of pending.sourceIds()) {
        if (onlySourceId !== undefined && sourceId !== onlySourceId) continue;
        const stored = pending.read(sourceId);
        if (stored?.held || stored?.failure) continue;
        const transcriptionId = stored?.transcriptionId ?? null;
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

/** A native status error is a retryable Private availability cause. */
export async function devicePtxUploadSupported(): Promise<boolean> {
  try { return await resolveNativeFileUploadCapability(); }
  catch (cause) {
    if (cause instanceof NativeFileUploadStatusError)
      throw new PrivateCloudError(cause.code, cause.message);
    throw cause;
  }
}

/** The real engine, or null when this build has no PTX origin. */
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
    uploadSupported: () => web ? Promise.resolve(true) : devicePtxUploadSupported(),
  });
}

// ── One note, end to end ───────────────────────────────────────────────

export function voiceNoteTranscriptionFailure(err: unknown): VoiceNoteTranscriptionFailure {
  const code = voiceNoteErrorCode(err);
  const failure = voiceNoteTranscriptionFailureForCode(code);
  return {
    ...failure,
    message: transcriptionErrorCopy(code)
      ?? (err instanceof PrivateCloudError ? privateCloudMessage(err) : failure.message),
    reference: err instanceof PrivateCloudError ? err.correlationId : null,
  };
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
  held?: HeldResultStore;
  capabilities: PrivateCloudCapabilities;
  currentCapabilities?: () => PrivateCloudCapabilities | null;
  sourceId: string;
  audio?: VoiceNoteAudio;
  allowed?: (scope?: "account") => boolean;
  /** The user chose private cloud for a note committed to another mode: skip the committed-mode checks. */
  overrideCommitted?: boolean;
  /** The user asked for this note to be transcribed. Without it, only a note recorded in the app goes. */
  explicit?: boolean;
  /** Confirmed user request to replace a committed transcript with a higher revision. */
  explicitRerun?: boolean;
  /** Native platform override for JS-boundary tests; production detects Capacitor's platform. */
  report: (status: VoiceNoteTranscriptionStatus) => void;
  now?: () => Date;
  account?: VoiceNoteTranscriptAccount;
  /** Per-note audio readiness bounds; production uses a 90-second stall window. */
  audioReadyStallMs?: number;
  audioReadyPollMs?: number;
}): Promise<"transcribed" | "no_speech"> {
  if (args.explicitRerun && !args.explicit)
    throw new PrivateCloudError("transcription_off", "A transcript rerun requires an explicit user action");
  const { tcw, cloud, sourceId } = args;
  const storageScope = storageScopeFor(tcw);
  logPipeline("transcription", sourceId, "start", { engine: "private-cloud" });
  const report = (status: VoiceNoteTranscriptionStatus) => {
    logPipeline(status.kind === "uploading" ? "transcription_audio_upload" : "transcription",
      sourceId, status.kind === "uploading" && status.progress != null ? "progress" : status.kind,
      { engine: "private-cloud", ...(status.kind === "uploading" && status.progress != null
        ? { progressPct: Math.round(status.progress * 100) } : {}) });
    args.report(status);
  };
  const account = args.account ?? { generation: currentAccountGeneration() };
  const accountContext = { did: account.did ?? tcw.did, spaceId: tcw.spaceId ?? "", generation: account.generation };
  const stillCurrent = () => args.allowed
    ? args.allowed("account") && isAccountContextCurrent(accountContext, tcw) && isAccountWorkAllowed(tcw)
    : isAccountContextCurrent(accountContext, tcw) && isAccountWorkAllowed(tcw);
  const accountCheckpoint = () => {
    if (!stillCurrent()) throw new StaleAccountContext();
  };
  const persistFailure = async (error: unknown, statsMetadata: VoiceNoteTranscriptionStatsMetadata = {}) => {
    const code = voiceNoteErrorCode(error);
    const firstRunStorageFull = code === TRANSCRIPT_STORAGE_FULL_CODE && !args.explicitRerun;
    if (!stillCurrent() || (code === TRANSCRIPT_STORAGE_FULL_CODE && args.explicitRerun)
      || (!firstRunStorageFull && (error instanceof DeviceLocalVoiceNoteAudioError
        || !NOTE_INTRINSIC_FAILURE_CODES.has(code) || isAutomaticRetryableError(error)
        || (args.held?.heldHint(sourceId) ?? false) || cloud.heldTranscript(sourceId) !== null))) return;
    try { await patchVoiceNoteTranscriptionFailure(tcw, sourceId, code, accountCheckpoint, statsMetadata); }
    catch (persistError) { logPipelineError("[VoiceNotes] Could not persist the transcription failure", persistError); }
  };
  /** The job is done with: forget it, then delete it at PTX (best-effort: PTX deletes it within 24 h). */
  const finish = async (transcriptionId?: string | null) => {
    // Not for an account that left: the delete would go out with the new account's token, and the
    // job is kept so this account's next run finds the saved transcript and deletes it then.
    if (!stillCurrent()) return;
    try {
      await cloud.finish(sourceId, transcriptionId);
    } catch (err) {
      logPipelineError("Deleting a finished private cloud job failed; PTX deletes it on its own schedule", err);
    }
    try {
      const committed = await readTranscriptCommit(tcw, sourceId);
      if (committed) await cloud.stripLegacyHeld?.(sourceId, committed.rev, committed.hash);
    } catch {
      // The space commit is already verified; a failed compare-strip leaves the legacy copy intact.
    }
  };
  let expectedRerunBase: VoiceNoteRerunBase | null = null;
  let heldRerunResult = false;
  const save = async (prepared: VoiceNoteTranscriptSave) => {
    if (!stillCurrent()) throw accountChangedError();
    report({ kind: "saving" });
    if (!stillCurrent()) throw accountChangedError();
    const rerunCommit = expectedRerunBase !== null && commit?.rev === expectedRerunBase.rev
      && commit.hash === expectedRerunBase.hash ? commit : null;
    if (expectedRerunBase !== null) {
      if (rerunCommit === null)
        throw new PrivateCloudError("transcript_save_failed", "The committed transcript changed before this rerun could be saved");
      try { await preserveVoiceNoteTranscriptHistory(tcw, rerunCommit, accountCheckpoint); }
      catch (cause) {
        if (isStorageFullError(cause)) {
          reportStorageError(cause, storageScope);
          throw new PrivateCloudError(TRANSCRIPT_STORAGE_FULL_CODE, STORAGE_FULL_SAVE_MESSAGE);
        }
        throw new PrivateCloudError("transcript_save_failed", "Could not preserve the current transcript revision");
      }
    }
    const saved = await saveVoiceNoteTranscript(tcw, sourceId, prepared, account, accountCheckpoint);
    if (!saved.ok) {
      if (isStorageFullError(saved.error)) {
        reportStorageError(saved.error, storageScope);
        throw new PrivateCloudError(TRANSCRIPT_STORAGE_FULL_CODE, STORAGE_FULL_SAVE_MESSAGE);
      }
      if (saved.error.code === "VOICE_NOTE_NOT_FOUND") throw new PrivateCloudError("voice_note_not_found", saved.error.message);
      throw new PrivateCloudError("transcript_save_failed", saved.error.message);
    }
    if (expectedRerunBase !== null) {
      const current = await readTranscriptCommit(tcw, sourceId);
      if (current?.rev !== prepared.rev || current.hash !== await transcriptHash(prepared.sentences))
        throw new PrivateCloudError("transcript_save_failed", "A different transcript revision won this rerun. Try again.");
    }
  };
  let heldStore = args.held;
  const commitPrepared = (prepared: VoiceNoteTranscriptSave, transcriptionId?: string | null,
    existingHeld?: HeldResult | null) => commitPreparedVoiceNoteTranscript({
      tcw, cloud, sourceId, transcript: prepared, rerunBase: expectedRerunBase, heldRerunResult,
      held: heldStore, heldRecord: existingHeld,
      ...(heldStore && !existingHeld ? { holdInput: {
        version: 1, did: tcw.did, spaceId: tcw.spaceId ?? "", sourceId, engine: "private-cloud",
        transcript: prepared, provider: transcriptionId ? { transcriptionId } : null,
        intent: expectedRerunBase ? { kind: "rerun", base: expectedRerunBase } : { kind: "unknown" },
        ...(args.overrideCommitted ? { overrideCommitted: true } : {}),
      } } : {}),
      mode: args.explicit ? "explicit" : "automatic",
      save: () => save(prepared), finish: () => finish(transcriptionId), stillCurrent,
    });

  const note = await readVoiceNoteForTranscription(tcw, sourceId);
  if (!note.ok) throw new PrivateCloudError("note_unreadable", note.error.message);
  const legacyHeld = cloud.heldTranscript(sourceId);
  let heldRecord: HeldResult | null = null;
  if (heldStore) {
    try { heldRecord = await heldStore.readHeld(sourceId); }
    catch (error) {
      const reason = error && typeof error === "object" && "reason" in error
        ? String((error as { reason: unknown }).reason) : "";
      if (legacyHeld === null || reason !== "unavailable" || note.data === null) throw error;
      if (!stillCurrent()) throw accountChangedError();
      heldStore = undefined;
    }
  }

  if (note.data === null) {
    if (heldRecord && args.held) await args.held.discard(tcw, sourceId, heldRecord.holdId, "note_gone");
    await finish();
    cloud.clearLegacyHeld?.(sourceId, "note_gone");
    throw new PrivateCloudError("voice_note_not_found", "The voice note no longer exists");
  }

  const noteData = note.data;
  const currentCommit = await readTranscriptCommit(tcw, sourceId);
  const commit = args.explicitRerun ? requireVoiceNoteTranscriptCommit(currentCommit) : currentCommit;
  expectedRerunBase = args.explicitRerun ? commit
    : heldRecord ? (heldRecord.intent.kind === "rerun" ? heldRecord.intent.base : null)
      : cloud.rerunBase?.(sourceId) ?? null;
  heldRerunResult = (heldRecord !== null || legacyHeld !== null) && expectedRerunBase !== null;
  const authorizedConflictRerun = args.explicit && args.explicitRerun && heldRecord?.conflict !== undefined;
  if (heldRecord?.conflict && !authorizedConflictRerun)
    throw new PrivateCloudError(heldRecord.conflict, "Held transcript commit conflict.");
  if ((heldRecord && !authorizedConflictRerun) || legacyHeld !== null) {
    const held = heldRecord?.transcript ?? legacyHeld!;
    const providerId = heldRecord?.provider && "transcriptionId" in heldRecord.provider
      ? heldRecord.provider.transcriptionId : undefined;
    const committed = await commitPrepared(held, providerId, heldRecord);
    return committed?.outcome ?? "no_speech";
  }
  const nativeNote = (await VoiceNotes.listPending()).recordings.find((recording) => recording.id === sourceId);

  if (nativeNote?.owner && nativeNote.owner !== tcw.did)
    throw new PrivateCloudError("voice_note_account_mismatch", "This voice note is not owned by the current account");
  const local = nativeNote ? (await VoiceNotes.getTranscript({ id: sourceId })).transcript : null;

  const ledgerRev = nativeNote?.ledger?.transcriptSync.rev ?? 0;
  const localRev = local?.rev ?? 0;
  if (![commit?.rev ?? 0, ledgerRev, localRev].every((value) => Number.isSafeInteger(value) && value >= 0))
    throw new PrivateCloudError("transcript_save_failed", "The voice note has an invalid transcript revision");
  const hasPendingJob = cloud.hasRemoteJob(sourceId);
  const hasStoredRerun = (cloud.rerunBase?.(sourceId) ?? null) !== null;
  if (!args.explicitRerun && !hasStoredRerun
    && (note.data.transcript.status === "transcribed" || note.data.transcript.status === "no_speech")) {
    if (!hasPendingJob) return note.data.transcript.status;
    if (commit !== null && commit.rev >= Math.max(ledgerRev, localRev)) {
      await finish();
      return note.data.transcript.status;
    }
  }
  const modeOff = !args.overrideCommitted && (
    note.data.captureVersion === 2 && note.data.captureTranscriber !== "private-cloud"
    || nativeNote?.options !== undefined && nativeNote.options.transcriber !== "private-cloud"
  );
  if (modeOff && !hasPendingJob)
    throw new PrivateCloudError("transcription_off", "This note was not recorded for private-cloud transcription");
  const rev = Math.max(commit?.rev ?? 0, ledgerRev, localRev) + 1;
  if (!Number.isSafeInteger(rev))
    throw new PrivateCloudError("transcript_save_failed", "The voice note has no remaining transcript revisions");
  // T22 writes the committed rev and hash back to native transcriptSync after this cloud save.

  // Without a pending job, a note that did not begin in the app waits for the user's own Transcribe.
  if (!args.explicit && !args.overrideCommitted && !modeOff && note.data.captureSource !== "in_app")
    throw new PrivateCloudError("note_held", "This note did not begin in the app, so it waits for the user to transcribe it");

  let localAudioRecording: VoiceNoteRecording | undefined = nativeNote;
  const loadSpaceAudio = async (): Promise<VoiceNoteAudio> => {
    // Wait only for this note's ledger. Other notes may continue saving independently.
    if (localAudioRecording?.ledger?.audio?.state === "pending") {
      const stallMs = args.audioReadyStallMs ?? voiceNoteCallDeadlineMs();
      const pollMs = args.audioReadyPollMs ?? 250;
      let lastProgressAt = Date.now();
      let lastProgress = "";
      try {
        while (true) {
          const progress = pendingStore.snapshot().notes?.find((note) => note.id === sourceId)?.upload;
          const progressKey = progress ? `${progress.state}:${progress.bytes}:${progress.total}` : "";
          if (progressKey !== lastProgress) {
            lastProgress = progressKey;
            lastProgressAt = Date.now();
          }
          const remaining = stallMs - (Date.now() - lastProgressAt);
          if (remaining <= 0) throw new Error("This note's audio save stalled");
          const recordings = await withVoiceNoteSaveDeadline(
            `checking whether ${sourceId} audio is saved`,
            () => VoiceNotes.listPending().then((result) => result.recordings),
            remaining,
          );
          localAudioRecording = recordings.find((recording) => recording.id === sourceId);
          if (!localAudioRecording || localAudioRecording.ledger?.audio?.state === "saved") break;
          await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, remaining)));
        }
      } catch (cause) {
        logPipelineError("[VoiceNotes] Could not confirm the audio save before transcription", cause);
        throw new VoiceNoteAudioError("audio_read_failed", "Could not confirm this note's audio save");
      }
    }
    const res = await loadVoiceNoteAudio(tcw, sourceId, { maxBytes: args.capabilities.max_bytes });
    if (!res.ok) {
      if (res.error.code === VOICE_NOTE_AUDIO_TOO_LARGE) {
        throw new VoiceNoteAudioError("recording_too_large", "This recording exceeds the private cloud upload limit.", undefined, res.error.sizeBytes);
      }
      logPipelineError("[VoiceNotes] Could not read note audio from the space", res.error);
      throw new VoiceNoteAudioError(res.error.code === "VOICE_NOTE_AUDIO_CORRUPT" ? res.error.code : "audio_read_failed",
        "Could not read this note's audio from your space");
    }
    return res.data;
  };
  const loadAudio = async (): Promise<VoiceNoteAudio & { nativeFileId?: string; loadSpaceCopy?: () => Promise<VoiceNoteAudio> }> => {
    if (args.audio) return args.audio;
    try {
      localAudioRecording = (await VoiceNotes.listPending()).recordings.find((recording) => recording.id === sourceId);
    } catch (cause) {
      logPipelineError("[VoiceNotes] Could not check for local audio before transcription", cause);
      throw new VoiceNoteAudioError("audio_read_failed", "Could not check this device for local audio");
    }
    if (localAudioRecording) {
      try {
        if (captureCapabilities().nativeFileUpload)
          return { mimeType: localAudioRecording.mimeType, base64: "", nativeFileId: sourceId, loadSpaceCopy: loadSpaceAudio };
        const source = nativeRecordingSource(localAudioRecording);
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
          logPipelineError("[VoiceNotes] Could not read local audio before transcription", cause);
          throw new VoiceNoteAudioError("audio_read_failed", "Could not read this note's local audio");
        }
      }
    }
    return loadSpaceAudio();
  };
  const transcribedAt = () => (args.now ?? (() => new Date()))().toISOString();


  let transcriptionId: string;
  let transcript: PrivateCloudTranscript;
  try {
    ({ transcriptionId, transcript } = await withSourceLease(accountContext.did, sourceId, () => cloud.transcribe(
      { sourceId, capabilities: args.capabilities, currentCapabilities: args.currentCapabilities,
        loadAudio: modeOff ? async () => { throw transcriptionOffError(); } : loadAudio,
        durationSeconds: noteData.durationSeconds,
        explicitRerun: args.explicitRerun,
        rerunBase: expectedRerunBase ?? undefined,
        identifySpeakers: nativeNote?.options?.identifySpeakers === true,
        channelCount: noteData.channels === 2 ? 2 : nativeNote?.channels === 2 ? 2 : 1,
        allowed: args.allowed },
      report,
    )));
  } catch (err) {
    // A limit refusal came before any job existed: it is not this note's transcription failure.
    if (err instanceof PrivateCloudRefusedError) throw err;
    if (voiceNoteErrorCode(err) !== "no_speech") {
      await persistFailure(err);
      throw err;
    }
    // Silence is an outcome: record it only after the history guard and commit succeed.
    const prepared = noSpeechTranscript(transcribedAt(), rev, { transcription_stats_missing: true });
    try {
      await commitPrepared(prepared, err instanceof PrivateCloudError ? err.transcriptionId : null);
    } catch (saveError) {
      await persistFailure(saveError);
      throw saveError;
    }
    logPipelineCount("transcription_stats_missing", "committed");
    logPipeline("transcription", sourceId, "done", { engine: "private-cloud" });
    return "no_speech";
  }
  const statsMetadata = transcriptStatsMetadata(transcript);
  if (shouldRejectIncompleteTranscript(transcript.stats, statsMetadata)) {
    const incomplete = new PrivateCloudError(
      "transcript_incomplete",
      "Private Transcription returned a transcript that may be incomplete. Try again later.",
      { transcriptionId },
    );
    await persistFailure(incomplete, statsMetadata);
    await finish(transcriptionId);
    throw incomplete;
  }
  const statsMissing = statsMetadata.transcription_duration_seconds === undefined;
  const commitStatsMetadata: VoiceNoteTranscriptionStatsMetadata = {
    ...statsMetadata,
    transcription_stats_missing: statsMissing ? true : null,
  };
  const prepared = prepareVoiceNoteTranscript(transcript, transcribedAt(), rev, commitStatsMetadata);
  try {
    await commitPrepared(prepared, transcriptionId);
  } catch (err) {
    await persistFailure(err, statsMetadata);
    // Failed saves keep the PTX result for Retry/recovery; never delete an uncommitted result.
    throw err;
  }
  if (statsMissing) logPipelineCount("transcription_stats_missing", "committed");
  if (transcript.stats?.vad_fallback === true) logPipelineCount("transcription_vad_fallback", "committed");
  logPipeline("transcription", sourceId, "done", { engine: "private-cloud" });
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
export type TranscriptionBlockedReason = "checking" | "unavailable" | "check-failed" | "no-consent" | "limits-unknown" | "limits-exceeded";
export type TranscriptionAdmissionRefusal = TranscriptionBlockedReason | "account-changed";

export type TranscriptionAvailability = "checking" | "available" | "failed";

export interface VoiceNoteTranscriberSnapshot {
  availability: TranscriptionAvailability;
  capabilities: PrivateCloudCapabilities | null;
  consented: boolean;
  jobs: ReadonlyMap<string, NoteTranscriptionState>;
  heldDurability?: "persistent" | "best-effort" | "unavailable";
  powerfulAvailable?: boolean;
  powerfulConsented?: boolean;
  /** The error of the last availability check when it failed (`availability` "failed"). */
  checkError?: string;
  /** Stable public cause for a failed availability check. */
  checkErrorCode?: string;
}

function requestHeldResultPersistence(): void {
  try {
    if (typeof navigator !== "undefined" && navigator.storage?.persist) void navigator.storage.persist().catch(() => {});
  } catch {
    // Persistence is best-effort; the held store reports the actual durability state.
  }
}

/** `saved`: a note's outcome was written to the space (refresh the list). */
export type VoiceNoteTranscriberEvent = { kind: "changed" } | { kind: "saved"; sourceId: string };

export interface VoiceNoteCheckOptions {
  current?: () => boolean;
  automatic?: boolean;
}

export type VoiceNoteRerunEngine = "on-device" | "private-cloud" | "assemblyai";

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
  /** The one-time Private disclosure. Resumes notes a previous run left in flight. */
  consent(): void;
  consentPowerful?(): void;
  /** Stops sending: waiting notes are dropped, the running one stops before its upload, unsent jobs are cancelled. */
  turnOff(): Promise<void>;
  /** Transcribe / Retry for one note. Only while available and consented. */
  transcribe(sourceId: string, audio?: VoiceNoteAudio): void;
  /**
   * The user's "Use Private instead" for a note committed to another mode (its on-device job is
   * cancelled by the caller first). Runs like `transcribe`, and its Retry keeps the choice.
   * Known duration and byte refusals are returned synchronously, with the choice kept; the queue
   * re-checks the current limits when the note starts.
   */
  transcribePrivately(sourceId: string, durationSecs: number | null, sizeBytes?: number | null): PrivateStartRefusal | null;
  /** Starts only after the detail's explicit confirmation; reruns are never added to resume choices. */
  transcribeAgain?(sourceId: string, engine: VoiceNoteRerunEngine): Promise<string | null>;
  /**
   * Use the committed native options. A note that did not begin in the app (a shortcut, intent or widget start, or a
   * source this app does not know) is never sent from here, whatever the defaults say: it is held, and only
   * `transcribe` for that note releases it.
   */
  noteSaved(recording: Pick<VoiceNoteRecording, "id" | "durationMs" | "options" | "source">, audio?: VoiceNoteAudio): void;
}
export function recheckVoiceNoteAvailabilityAutomatically(
  transcriber: Pick<VoiceNoteTranscriber, "check">,
  current?: () => boolean,
): Promise<void> {
  return transcriber.check({ automatic: true, ...(current ? { current } : {}) });
}


export interface VoiceNoteTranscriberTimer {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

export interface VoiceNoteTranscriberDeps {
  /** Null when this build lacks its required PTX origin. */
  cloud: VoiceNoteCloud | null;
  consent: VoiceNoteConsentStore;
  /** The user's "Transcribe privately instead" choices; in memory when omitted. */
  choices?: VoiceNotePrivateChoiceStore;
  /** Which notes were held back from transcription, kept across launches. */
  holds: VoiceNoteHoldStore;
  /** Durable held-result store for the current DID. */
  held?: HeldResultStore;
  /** Legacy migration plus the held-store summary/index restore. */
  ready?: Promise<void>;
  /** Strip the matching legacy fallback after a held commit is verified. */
  heldAfterCommit?: (row: HeldResult) => Promise<void>;
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
  /** Delay before another recovery scan after transient local re-read failure. */
  recoveryBackoffMs?: readonly number[];
  now?: () => number;
  timer?: VoiceNoteTranscriberTimer;
}

export function createVoiceNoteTranscriber(deps: VoiceNoteTranscriberDeps): VoiceNoteTranscriber {
  const runNote = deps.runNote ?? transcribeVoiceNote;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const checkRetryMs = deps.checkRetryMs ?? [2_000, 5_000];
  const freshMs = deps.freshMs ?? 5 * 60_000;
  const failedBackoffMs = deps.failedBackoffMs ?? [15_000, 60_000, 5 * 60_000];
  const now = deps.now ?? Date.now;
  const timer = deps.timer ?? {
    schedule: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
    cancel: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  const cloud = deps.cloud;
  const hasHeldHint = (sourceId: string) => (deps.held?.heldHint(sourceId) ?? false)
    || (cloud?.heldTranscript?.(sourceId) ?? null) !== null;
  const listeners = new Set<(event: VoiceNoteTranscriberEvent) => void>();
  const jobs = new Map<string, NoteTranscriptionState>();
  const holdStates = new Map<string, VoiceNoteHoldState>();
  try {
    for (const sourceId of cloud?.pendingSourceIds() ?? []) {
      const code = cloud?.terminalFailure?.(sourceId);
      if (code) jobs.set(sourceId, { kind: "failed", ...voiceNoteTranscriptionFailureForCode(code) });
    }
  } catch (err) {
    logPipelineError("[VoiceNotes] Could not restore device-local transcription failures", err);
  }
  try {
    for (const [sourceId, holdState] of Object.entries(deps.holds.read())) {
      holdStates.set(sourceId, holdState);
      if (holdState === "held") jobs.set(sourceId, { kind: "held", message: HELD_NOTE_MESSAGE });
    }
  } catch (err) {
    // Unreadable: no note counts as released, so the saved source decides each one (see transcribeVoiceNote).
    logPipelineError("[VoiceNotes] Could not read which notes are held back from transcription; only notes recorded in the app will be resumed", err);
  }
  const isHeld = (sourceId: string) => holdStates.get(sourceId) === "held";
  const saveHolds = () => {
    try {
      deps.holds.write(Object.fromEntries(holdStates));
    } catch (err) {
      logPipelineError("[VoiceNotes] Could not keep which notes are held back from transcription; they stay held until the app closes", err);
    }
  };
  /** Notes queued but not started; turning off empties it, and a dropped note never starts. */
  const waiting = new Set<string>();
  const sourceRetains = new Map<string, () => void>();
  const retainSourceFor = (sourceId: string, owner: string) => {
    if (!sourceRetains.has(sourceId)) sourceRetains.set(sourceId, retainSource(owner, sourceId));
  };
  const releaseSourceFor = (sourceId: string) => {
    sourceRetains.get(sourceId)?.();
    sourceRetains.delete(sourceId);
  };
  let recoveryRescanRequested = false;
  let state: Omit<VoiceNoteTranscriberSnapshot, "jobs"> = {
    availability: cloud === null ? "failed" : "checking",
    checkError: cloud === null ? "Private transcription is not configured in this build" : undefined,
    capabilities: null,
    consented: deps.consent.get(),
  };
  let snapshot: VoiceNoteTranscriberSnapshot = { ...state, jobs: new Map(jobs) };
  let chain: Promise<void> = Promise.resolve();
  let recoveryNeeded = false;
  let checking: Promise<void> | null = null;
  /** The newest caller's "this account is still signed in"; none until a hook-managed check names one. */
  let accountCurrent: (() => boolean) | null = null;
  let settledAt: number | null = null;
  let failedChecks = 0;
  let recoveryFailures = 0;
  const automaticRetryFailures = new Map<string, number>();
  const automaticRetryDeadlines = new Map<string, number>();
  const automaticRetryServerDeadlines = new Map<string, number>();
  const automaticRetryTimers = new Map<string, unknown>();
  let nextRecoveryAt = 0;
  let recoveryTimer: unknown;
  const clearRecoveryTimer = () => {
    if (recoveryTimer === undefined) return;
    timer.cancel(recoveryTimer);
    recoveryTimer = undefined;
  };
  let strandedRecovery: Promise<void> | null = null;
  let triggerAutomaticRecheck: () => void = () => undefined;
  const hasAdmissionRecoveryWork = () => {
    if (recoveryNeeded || automaticRetryDeadlines.size > 0) return true;
    for (const job of jobs.values()) if (job.kind === "blocked") return true;
    try {
      if (choices.ids().length > 0) return true;
      if (cloud === null) return false;
      return cloud.pendingSourceIds().some((sourceId) =>
        cloud.hasRemoteJob(sourceId)
        || hasHeldHint(sourceId)
        || cloud.terminalFailure?.(sourceId) == null,
      );
    } catch {
      return true;
    }
  };
  const scheduleClosedAdmissionCheck = () => {
    const schedule = () => {
      if (recoveryTimer !== undefined || state.availability !== "available"
        || state.capabilities?.admission === "open" || !hasAdmissionRecoveryWork()) return;
      const delay = failedBackoffMs[0] ?? 15_000;
      recoveryTimer = timer.schedule(() => {
        recoveryTimer = undefined;
        if (state.availability !== "available" || state.capabilities?.admission === "open"
          || !hasAdmissionRecoveryWork()) return;
        recoveryNeeded = true;
        nextRecoveryAt = now();
        settledAt = null;
        triggerAutomaticRecheck();
      }, delay);
    };
    if (strandedRecovery === null) schedule();
    else void strandedRecovery.then(schedule, schedule);
  };


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
  const on = () => identityCurrent() && state.availability === "available" && state.consented && privateCloudLimits(state.capabilities) !== null;
  const blockedReason = (): TranscriptionBlockedReason => {
    if (cloud === null) return "check-failed";
    switch (state.availability) {
      case "checking":
        return "checking";
      case "failed":
        return "check-failed";
      case "available":
        if (!state.consented) return "no-consent";
        return privateCloudLimits(state.capabilities) === null ? "limits-unknown" : "unavailable";
    }
  };
  const listHeldForRecovery = async () => {
    if (!deps.held) return [];
    try { return await deps.held.listHeld(); }
    catch (error) {
      logPipelineError("[VoiceNotes] Could not list held results for recovery", error);
      return null;
    }
  };
  let drainingHeld: Promise<void> | null = null;
  const drainHeldOnly = (): Promise<void> => {
    if (!deps.held || !state.consented || !identityCurrent()) return Promise.resolve();
    if (drainingHeld) return drainingHeld;
    drainingHeld = (async () => {
      await deps.ready;
      if (!state.consented || !identityCurrent()) return;
      const rows = await listHeldForRecovery();
      if (rows === null) return;
      for (const summary of rows) {
        if (summary.engine !== "private-cloud" || !state.consented || !identityCurrent()) continue;
        jobs.set(summary.sourceId, { kind: "active", status: { kind: "saving" } });
        emit();
        try {
          const finishAfterCommit = async (row: HeldResult) => {
            try { await deps.heldAfterCommit?.(row); }
            finally {
              const transcriptionId = row.provider && "transcriptionId" in row.provider
                ? row.provider.transcriptionId : null;
              try { await cloud?.finish(summary.sourceId, transcriptionId); }
              catch (error) {
                logPipelineError("Deleting a finished private cloud job failed; PTX deletes it on its own schedule", error);
              }
            }
          };
          const outcome = await drainHeldVoiceNote(deps.tcw(), deps.held!, summary.sourceId,
            () => state.consented && identityCurrent(), finishAfterCommit);
          if (outcome === "lock_busy") {
            timer.schedule(() => { void drainHeldOnly(); }, failedBackoffMs[0] ?? 15_000);
            jobs.delete(summary.sourceId);
          } else if (outcome === "conflict") {
            const row = await deps.held!.readHeld(summary.sourceId);
            const code = row?.conflict ?? "rerun_lost";
            jobs.set(summary.sourceId, { kind: "failed", ...voiceNoteTranscriptionFailureForCode(code) });
          } else if (outcome === null || outcome === "discarded_superseded") {
            jobs.delete(summary.sourceId);
          } else {
            jobs.set(summary.sourceId, { kind: "done", outcome: "transcribed" });
            emit({ kind: "saved", sourceId: summary.sourceId });
          }
        } catch (err) {
          jobs.set(summary.sourceId, { kind: "failed", ...voiceNoteTranscriptionFailure(err) });
        }
        emit();
      }
    })().finally(() => { drainingHeld = null; });
    return drainingHeld;
  };
  /** A blocked note remains a recovery candidate when service state or caps change. */
  const refreshBlocked = () => {
    for (const [sourceId, job] of jobs) {
      if (job.kind !== "blocked") continue;
      if (!on() && job.reason !== blockedReason()) jobs.set(sourceId, { kind: "blocked", reason: blockedReason() });
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
  // A saved in-app Private note may have been waiting for the new disclosure when
  // the app closed. Restore its blocker before the first pipeline snapshot.
  if (!state.consented) {
    for (const sourceId of choices.ids()) {
      if (!jobs.has(sourceId)) jobs.set(sourceId, { kind: "blocked", reason: "no-consent" });
    }
    snapshot = { ...state, jobs: new Map(jobs) };
  }
  /** Keep the in-memory choice during same-session retries and persist it while a job remains. */
  const chosenPrivate = new Set<string>();
  const isChosen = (sourceId: string) => chosenPrivate.has(sourceId) || choices.has(sourceId);
  /** Drop persisted intent only after the pending job is gone, except deliberate user-mode cleanup. */
  const settleChoice = (sourceId: string, force = false) => {
    const terminalFailure = cloud?.terminalFailure?.(sourceId);
    const terminal = terminalFailure !== null && terminalFailure !== undefined
      && !cloud?.hasRemoteJob(sourceId)
      && !hasHeldHint(sourceId);
    if (force || terminal || cloud !== null && !cloud.pendingSourceIds().includes(sourceId)) choices.remove(sourceId);
  };

  const publishTerminalFailure = (sourceId: string, code: string) => {
    const current = jobs.get(sourceId);
    if (current?.kind === "active" || current?.kind === "done"
      || current?.kind === "failed" && current.code === code) return;
    jobs.set(sourceId, { kind: "failed", ...voiceNoteTranscriptionFailureForCode(code) });
    emit();
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
  const hasDueAutomaticRetry = () => {
    const current = now();
    for (const deadline of automaticRetryDeadlines.values()) if (deadline <= current) return true;
    return false;
  };
  const clearAutomaticRetry = (sourceId: string, succeeded = false) => {
    const handle = automaticRetryTimers.get(sourceId);
    if (handle !== undefined) timer.cancel(handle);
    automaticRetryTimers.delete(sourceId);
    automaticRetryDeadlines.delete(sourceId);
    automaticRetryServerDeadlines.delete(sourceId);
    if (succeeded) automaticRetryFailures.delete(sourceId);
  };
  const armAutomaticRetry = (sourceId: string) => {
    if (automaticRetryTimers.has(sourceId)) return;
    const deadline = automaticRetryDeadlines.get(sourceId);
    if (deadline === undefined) return;
    const handle = timer.schedule(() => {
      if (automaticRetryTimers.get(sourceId) !== handle) return;
      automaticRetryTimers.delete(sourceId);
      const remaining = deadline - now();
      if (remaining > 0) {
        armAutomaticRetry(sourceId);
        return;
      }
      if (!on()) return;
      automaticRetryServerDeadlines.delete(sourceId);
      recoveryNeeded = true;
      nextRecoveryAt = now();
      settledAt = null;
      triggerAutomaticRecheck();
    }, Math.max(0, deadline - now()));
    automaticRetryTimers.set(sourceId, handle);
  };
  const scheduleAutomaticRetry = (sourceId: string, retryAfterSeconds = 0) => {
    retainSourceFor(sourceId, deps.tcw().did);
    const failures = automaticRetryFailures.get(sourceId) ?? 0;
    const baseDelay = failedBackoffMs[Math.min(failures, failedBackoffMs.length - 1)] ?? 15_000;
    const serverDelay = Math.min(MAX_RATE_LIMIT_WAIT_MS, Math.max(0, Math.ceil(retryAfterSeconds * 1_000)));
    const serverDeadline = retryAfterSeconds > 0 ? now() + serverDelay : 0;
    if (serverDeadline > 0)
      automaticRetryServerDeadlines.set(sourceId, Math.max(automaticRetryServerDeadlines.get(sourceId) ?? 0, serverDeadline));
    const deadline = Math.max(automaticRetryDeadlines.get(sourceId) ?? 0, now() + baseDelay,
      automaticRetryServerDeadlines.get(sourceId) ?? 0);
    automaticRetryDeadlines.set(sourceId, deadline);
    automaticRetryFailures.set(sourceId, failures + 1);
    const previous = automaticRetryTimers.get(sourceId);
    if (previous !== undefined) timer.cancel(previous);
    automaticRetryTimers.delete(sourceId);
    recoveryNeeded = true;
    armAutomaticRetry(sourceId);
  };
  const deferClosedAdmission = (sourceId: string, explicit: boolean): boolean => {
    if (explicit || cloud === null || state.capabilities?.admission === "open" || (cloud.hasRemoteJob?.(sourceId) ?? false)) return false;
    const failure = voiceNoteTranscriptionFailure(new PrivateCloudError("service_paused", "Private transcription is not accepting new jobs right now."));
    jobs.set(sourceId, { kind: "failed", ...failure });
    scheduleAutomaticRetry(sourceId);
    emit();
    return true;
  };

  let explicitRerunsCleared = false;
  /** Every job, new or resumed, starts here. Only `explicit` (the user's Transcribe on this note) may pass a held note. */
  const enqueue = (sourceId: string, audio: VoiceNoteAudio | undefined, explicit: boolean,
    explicitRerun = false): TranscriptionAdmissionRefusal | null => {
    if (!on() || cloud === null) {
      const reason = identityCurrent() ? blockedReason() : "account-changed";
      if (explicit || !isHeld(sourceId)) block(sourceId);
      return reason;
    }
    if (!explicit && isHeld(sourceId) && !hasHeldHint(sourceId)) return null;
    if (!explicit) {
      if (!hasHeldHint(sourceId)) {
        const deadline = automaticRetryDeadlines.get(sourceId);
        if (deadline !== undefined && now() < deadline) return null;
        if (deadline !== undefined) automaticRetryDeadlines.delete(sourceId);
        const terminalFailure = cloud.terminalFailure?.(sourceId);
        if (terminalFailure && !(cloud.hasRemoteJob?.(sourceId) ?? false)) {
          jobs.set(sourceId, { kind: "failed", ...voiceNoteTranscriptionFailureForCode(terminalFailure) });
          emit();
          return null;
        }
      }
    }
    if (deferClosedAdmission(sourceId, explicit)) return null;
    const current = jobs.get(sourceId);
    // Queued, running, or just saved (the list may not show it yet): never a second job.
    if (current?.kind === "active" || (current?.kind === "done" && !explicitRerun)) return null;
    if (!explicit && current?.kind === "failed" && !isAutomaticRetryableCode(current.code)
      && !hasHeldHint(sourceId) && !(cloud.hasRemoteJob?.(sourceId) ?? false)) return null;
    const account = { generation: currentAccountGeneration(), did: deps.tcw().did };
    retainSourceFor(sourceId, account.did);
    waiting.add(sourceId);
    jobs.set(sourceId, { kind: "active", status: { kind: "waiting", position: waiting.size } });
    emit();
    chain = chain.then(async () => {
      // Dropped by turn-off while it waited, or turned off since: never starts.
      if (!waiting.delete(sourceId)) {
        releaseSourceFor(sourceId);
        return;
      }
      // Leaving the line, starting, and the others moving up are one change: no snapshot shows the starting note as waiting.
      if (jobs.get(sourceId)?.kind === "active") jobs.set(sourceId, { kind: "active", status: { kind: "preparing" } });
      emit();
      if (!on() || state.capabilities === null) {
        if (identityCurrent() && state.consented) {
          // Stopped by the limits or the service, not by the user: keep the intent, shown as blocked, and admit it again when they return.
          jobs.set(sourceId, { kind: "blocked", reason: blockedReason() });
          recoveryNeeded = true;
          if (nextRecoveryAt === Number.POSITIVE_INFINITY) nextRecoveryAt = now();
        } else {
          jobs.delete(sourceId);
        }
        if (!identityCurrent()) {
          recoveryNeeded = true;
          nextRecoveryAt = now();
          console.warn("[Transcription] Not starting a private cloud job: its account is no longer the signed-in one", sourceId);
        }
        emit();
        releaseSourceFor(sourceId);
        return;
      }
      if (deferClosedAdmission(sourceId, explicit)) return;
      try {
        const outcome = await runNote({
          tcw: deps.tcw(),
          cloud,
          held: deps.held,
          capabilities: state.capabilities,
          currentCapabilities: () => state.capabilities,
          sourceId,
          audio,
          account,
          allowed: (scope) => identityCurrent() && (scope === "account" || state.consented),
          overrideCommitted: isChosen(sourceId),
          explicit: explicit || holdStates.get(sourceId) === "released",
          explicitRerun,
          report: (status) => {
            if (jobs.get(sourceId)?.kind !== "active") return;
            jobs.set(sourceId, { kind: "active", status });
            emit();
          },
        });
        clearAutomaticRetry(sourceId, true);
        settleChoice(sourceId);
        jobs.set(sourceId, { kind: "done", outcome });
        releaseSourceFor(sourceId);
        emit({ kind: "saved", sourceId });
      } catch (err) {
        if (err instanceof PrivateCloudRefusedError) {
          // A cap can change after CREATE too; keep the intent blocked for a later recovery scan.
          jobs.set(sourceId, { kind: "blocked", reason: err.refusal.kind === "unknown" ? blockedReason() : "limits-exceeded" });
          recoveryNeeded = true;
          nextRecoveryAt = now();
          emit();
          releaseSourceFor(sourceId);
          return;
        }
        if (voiceNoteErrorCode(err) === "note_held") {
          console.warn("[VoiceNotes] Held a note back from private-cloud transcription: it did not begin in the app", { id: sourceId });
          hold(sourceId);
          releaseSourceFor(sourceId);
          return;
        }
        // Whatever stopped a note after the user turned transcription off is not a failure to show.
        if (!identityCurrent()) {
          recoveryNeeded = true;
          nextRecoveryAt = now();
          jobs.delete(sourceId);
          console.warn("[Transcription] Stopped a private cloud job: its account is no longer the signed-in one", sourceId);
        } else if (!state.consented || voiceNoteErrorCode(err) === "transcription_off") {
          jobs.delete(sourceId);
          settleChoice(sourceId);
        } else {
          const code = voiceNoteErrorCode(err);
          const terminalFailure = cloud?.terminalFailure?.(sourceId);
          const failure = terminalFailure
            ? voiceNoteTranscriptionFailureForCode(terminalFailure)
            : voiceNoteTranscriptionFailure(err);
          jobs.set(sourceId, { kind: "failed", ...failure });
          if (!terminalFailure && !isAutomaticRetryableError(err)
            && (JOB_ENDED_CODES.has(code) || NOTE_INTRINSIC_FAILURE_CODES.has(code)
              || MANUAL_ONLY_RETRY_CODES.has(code) || err instanceof DeviceLocalVoiceNoteAudioError)
            && !["account_changed", "voice_note_account_mismatch", "voice_note_not_found", "transcription_off"].includes(code))
            cloud?.rememberTerminalFailure?.(sourceId, failure.code);
          if (isAutomaticRetryableError(err)) {
            const retryAfterSeconds = err instanceof PrivateCloudError ? err.retryAfterSeconds ?? 0 : 0;
            settleChoice(sourceId);
            scheduleAutomaticRetry(sourceId, retryAfterSeconds);
          } else {
            clearAutomaticRetry(sourceId);
            settleChoice(sourceId);
          }
        }
        if (!automaticRetryDeadlines.has(sourceId)) releaseSourceFor(sourceId);
        emit();
      }
    });
    return null;
  };

  /** Re-read opted-in recovery candidates before re-offering them, including their transcript commit. */
  const stillPendingInSpace = async (sourceId: string, requirePrivateCommit = false): Promise<boolean | null> => {
    if (!identityCurrent()) return false;
    try {
      const tcw = deps.tcw();
      const result = await readVoiceNoteForTranscription(tcw, sourceId);
      if (!identityCurrent()) return false;
      if (!result.ok) return null;
      if (result.data === null) return false;
      const note = result.data;
      const explicitRetry = chosenPrivate.has(sourceId);
      const retryableFailure = note.transcript.status === "failed" && isAutomaticRetryableCode(note.transcriptionErrorCode);
      if (note.transcript.status !== "pending" && !retryableFailure
        && !(note.transcript.status === "failed" && explicitRetry)) return false;
      const commit = await readTranscriptCommit(tcw, sourceId);
      if (!identityCurrent()) return false;
      if (commit !== null) {
        if (!cloud?.hasRemoteJob(sourceId) && !hasHeldHint(sourceId)) choices.remove(sourceId);
        return false;
      }
      if (note.captureSource !== "in_app" && holdStates.get(sourceId) !== "released") {
        hold(sourceId);
        return false;
      }
      // A duration/byte refusal or unknown limits keeps the intent for a later capability refresh.
      if (privateCloudRefusal(note.durationSeconds, null, privateCloudLimits(state.capabilities)) !== null) return false;
      return !requirePrivateCommit || (note.captureSource === "in_app" && note.captureTranscriber === "private-cloud");
    } catch (err) {
      logPipelineError("[VoiceNotes] Could not re-check a saved Private note before recovery", err, sourceId);
      return null;
    }
  };

  const resume = (force = false) => {
    void drainHeldOnly();
    if (cloud === null) return;
    if (!on()) return;
    if (strandedRecovery !== null) {
      if (force || recoveryNeeded) recoveryRescanRequested = true;
      return;
    }
    if (!explicitRerunsCleared) {
      cloud.clearExplicitReruns?.();
      explicitRerunsCleared = true;
    }
    if (!force && (!recoveryNeeded || now() < nextRecoveryAt && !hasDueAutomaticRetry())) return;
    recoveryNeeded = false;
    let retry = false;
    strandedRecovery = Promise.resolve().then(async () => {
      try {
        let cloudPending: Set<string>;
        try {
          cloudPending = new Set(cloud.pendingSourceIds());
        } catch (err) {
          logPipelineError("[VoiceNotes] Could not list pending Private jobs for recovery", err);
          retry = true;
          return;
        }
        const heldRows = await listHeldForRecovery();
        if (heldRows === null) retry = true;
        const heldIds = (heldRows ?? []).map((row) => row.sourceId);
        const ids = new Set([...cloudPending, ...heldIds, ...choices.ids(), ...[...jobs].flatMap(([id, job]) => job.kind === "blocked" ? [id] : [])]);
        for (const sourceId of ids) {
          if (!identityCurrent() || !on()) {
            retry = true;
            return;
          }
          const current = jobs.get(sourceId);
          const held = hasHeldHint(sourceId);
          const hasRemoteJob = cloud.hasRemoteJob?.(sourceId) ?? false;
          const terminalFailure = cloud.terminalFailure?.(sourceId);
          if (terminalFailure && !held && !hasRemoteJob) {
            publishTerminalFailure(sourceId, terminalFailure);
            continue;
          }
          if (held) {
            enqueue(sourceId, undefined, false);
            continue;
          }
          if (current?.kind === "active" || current?.kind === "done"
            || current?.kind === "failed" && !isAutomaticRetryableCode(current.code) && !hasRemoteJob
            || isHeld(sourceId)) continue;

          const pendingInSpace = await stillPendingInSpace(sourceId);
          if (pendingInSpace === false) {
            if (hasRemoteJob) {
              if (!identityCurrent()) {
                retry = true;
                return;
              }
              enqueue(sourceId, undefined, false);
            }
            continue;
          }
          if (pendingInSpace === null) {
            retry = true;
            if (!hasRemoteJob) continue;
          }
          if (!identityCurrent()) {
            retry = true;
            return;
          }
          enqueue(sourceId, undefined, chosenPrivate.has(sourceId));
        }

        let recordings: VoiceNoteRecording[];
        try {
          recordings = (await VoiceNotes.listPending()).recordings;
        } catch (err) {
          logPipelineError("[VoiceNotes] Could not scan this device's saved Private notes for recovery", err);
          retry = true;
          return;
        }
        for (const recording of recordings) {
          if (!identityCurrent() || !on()) {
            retry = true;
            return;
          }
          if (recording.source !== "in_app" || recording.options?.transcriber !== "private-cloud"
            || recording.stt?.rerunRev != null
            || recording.ledger?.audio.state !== "saved"
            || recording.ledger.transcript.state !== "pending"
            || !privateCloudAccepts(recording.durationMs / 1000, state.capabilities)) continue;
          const current = jobs.get(recording.id);
          const held = hasHeldHint(recording.id);
          const hasRemoteJob = cloud.hasRemoteJob?.(recording.id) ?? false;
          const terminalFailure = cloud.terminalFailure?.(recording.id);
          if (terminalFailure && !held && !hasRemoteJob) {
            publishTerminalFailure(recording.id, terminalFailure);
            continue;
          }
          if (held || current?.kind === "active" || current?.kind === "done"
            || current?.kind === "failed" && !isAutomaticRetryableCode(current.code) && !hasRemoteJob
            || hasRemoteJob || choices.has(recording.id) || isHeld(recording.id)) continue;
          const stillPending = await stillPendingInSpace(recording.id, true);
          if (stillPending === null) {
            retry = true;
            continue;
          }
          if (stillPending) {
            if (!identityCurrent()) {
              retry = true;
              return;
            }
            enqueue(recording.id, undefined, false);
          }
        }
      } catch (err) {
        logPipelineError("[VoiceNotes] Private recovery scan failed", err);
        retry = true;
      } finally {
        strandedRecovery = null;
        if (recoveryRescanRequested) {
          recoveryRescanRequested = false;
          recoveryNeeded = true;
          nextRecoveryAt = now();
          queueMicrotask(() => resume(true));
        } else if (retry) {
          recoveryNeeded = true;
          const delays = deps.recoveryBackoffMs ?? failedBackoffMs;
          const delay = delays[Math.min(recoveryFailures, delays.length - 1)] ?? 0;
          recoveryFailures++;
          nextRecoveryAt = now() + delay;
        } else {
          recoveryNeeded = false;
          recoveryFailures = 0;
          nextRecoveryAt = Number.POSITIVE_INFINITY;
        }
      }
    });
  };

  const transcriber: VoiceNoteTranscriber = {
    snapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    check(options = {}) {
      if (options.current) accountCurrent = options.current;
      if (cloud === null) return drainHeldOnly();
      if (checking !== null) return checking;
      if (options.automatic && settledAt !== null && state.availability !== "checking") {
        const wait = state.availability === "failed" ? failedBackoffMs[Math.min(failedChecks, failedBackoffMs.length) - 1] ?? 0 : freshMs;
        if (now() - settledAt < wait) {
          if (recoveryNeeded && (now() >= nextRecoveryAt || hasDueAutomaticRetry())) resume();
          return Promise.resolve();
        }
      }
      // A re-check (every mount) keeps an answer it already has, so the card does not flicker.
      if (state.availability !== "available") {
        state = { ...state, availability: "checking" };
        emit();
      }
      const attempt = async () => {
        if (deps.ready) await deps.ready;
        if (!identityCurrent()) return { availability: "stale" } as const;
        try {
          const caps = await cloud.capabilities();
          return { availability: "available", caps } as const;
        } catch (err) {
          logPipelineError("Checking private cloud transcription failed", err);
          return { availability: "failed", error: readableError(err),
            code: err instanceof PrivateCloudError ? err.code : "transcription_error" } as const;
        }
      };
      const stale = () => {
        recoveryNeeded = true;
        nextRecoveryAt = now();
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
        const availabilityChanged = state.availability !== result.availability;
        const admissionChanged = result.availability === "available"
          && state.capabilities?.admission !== result.caps.admission;
        if (admissionChanged && result.availability === "available" && result.caps.admission === "open") {
          for (const [sourceId, deadline] of automaticRetryDeadlines) {
            if ((automaticRetryServerDeadlines.get(sourceId) ?? 0) > now()) continue;
            automaticRetryDeadlines.delete(sourceId);
            const handle = automaticRetryTimers.get(sourceId);
            if (handle !== undefined) timer.cancel(handle);
            automaticRetryTimers.delete(sourceId);
            if (deadline <= now()) automaticRetryServerDeadlines.delete(sourceId);
          }
          recoveryNeeded = true;
          nextRecoveryAt = now();
        }
        const limitsBefore = JSON.stringify(privateCloudLimits(state.capabilities));
        failedChecks = result.availability === "failed" ? failedChecks + 1 : 0;
        settledAt = now();
        state = {
          ...state,
          availability: result.availability,
          capabilities: result.availability === "available" ? result.caps : null,
          checkError: result.availability === "failed" ? result.error : undefined,
          checkErrorCode: result.availability === "failed" ? result.code : undefined,
        };
        const limitsChanged = limitsBefore !== JSON.stringify(privateCloudLimits(state.capabilities));
        if (result.availability === "failed") {
          recoveryNeeded = true;
          nextRecoveryAt = now();
        }
        emit();
        void drainHeldOnly();
        if (result.availability === "available"
          && (availabilityChanged || admissionChanged || limitsChanged || recoveryNeeded && (now() >= nextRecoveryAt || hasDueAutomaticRetry())))
          resume(availabilityChanged || admissionChanged || limitsChanged);
        if (result.availability === "available" && result.caps.admission !== "open") {
          scheduleClosedAdmissionCheck();
        } else if (result.availability === "failed" && failedBackoffMs.length > 0) {
          clearRecoveryTimer();
          const delay = failedBackoffMs[Math.min(failedChecks - 1, failedBackoffMs.length - 1)] ?? 0;
          recoveryTimer = timer.schedule(() => {
            recoveryTimer = undefined;
            triggerAutomaticRecheck();
          }, delay);
        } else {
          clearRecoveryTimer();
        }
      })().finally(() => {
        checking = null;
      });
      return checking;
    },

    consent() {
      deps.consent.set(true);
      state = { ...state, consented: true };
      recoveryNeeded = true;
      nextRecoveryAt = now();
      emit();
      resume(true);
    },

    async turnOff() {
      deps.consent.set(false);
      state = { ...state, consented: false };
      for (const sourceId of waiting) jobs.delete(sourceId);
      waiting.clear();
      for (const sourceId of [...sourceRetains.keys()]) releaseSourceFor(sourceId);
      // A failure shown with Retry is no longer actionable once off.
      for (const [sourceId, job] of jobs) if (job.kind === "failed") jobs.delete(sourceId);
      recoveryNeeded = false;
      nextRecoveryAt = Number.POSITIVE_INFINITY;
      // Keep the committed mode override while a PTX job/result still needs reconciliation.
      chosenPrivate.clear();
      const pending = new Set(cloud?.pendingSourceIds() ?? []);
      for (const sourceId of choices.ids())
        if (!pending.has(sourceId) && !hasHeldHint(sourceId)) choices.remove(sourceId);
      emit();
      try { await cancelActiveNativeUpload(); } catch (err) { logPipelineError("Cancelling the native upload failed", err); }
      try {
        await cloud?.releaseUnsent();
      } catch (err) {
        logPipelineError("Releasing unsent private cloud jobs failed; they expire on their own", err);
      }
      const pendingAfterRelease = new Set(cloud?.pendingSourceIds() ?? []);
      for (const sourceId of choices.ids())
        if (!pendingAfterRelease.has(sourceId) && !hasHeldHint(sourceId)) choices.remove(sourceId);
    },

    transcribe(sourceId, audio) {
      requestHeldResultPersistence();
      const rerunBase = cloud?.rerunBase?.(sourceId) ?? null;
      cloud?.clearTerminalFailure?.(sourceId);
      enqueue(sourceId, audio, true, rerunBase !== null);
      release(sourceId);
    },

    transcribePrivately(sourceId, durationSecs, sizeBytes = null) {
      requestHeldResultPersistence();
      cloud?.clearTerminalFailure?.(sourceId);
      const limit = privateCloudRefusal(durationSecs, sizeBytes, privateCloudLimits(state.capabilities));
      if (on() && limit !== null && limit.kind !== "unknown") {
        choices.add(sourceId);
        setLimitBlockedChoice(deps.tcw().did, sourceId, true);
        chosenPrivate.add(sourceId);
        jobs.set(sourceId, { kind: "blocked", reason: "limits-exceeded" });
        emit();
        return limit;
      }
      const alreadyChosen = choices.has(sourceId);
      choices.add(sourceId);
      chosenPrivate.add(sourceId);
      const refusal = enqueue(sourceId, undefined, true);
      if (refusal !== null) {
        chosenPrivate.delete(sourceId);
        // Limits or availability may return: keep the intent; withdrawn consent and account changes are not kept.
        if (refusal === "no-consent" || refusal === "account-changed") {
          if (!alreadyChosen) choices.remove(sourceId);
        }
        return refusal;
      }
      release(sourceId);
      return null;
    },
    async transcribeAgain(sourceId, engine) {
      if (engine !== "private-cloud") return "unavailable";
      requestHeldResultPersistence();
      cloud?.clearTerminalFailure?.(sourceId);
      chosenPrivate.add(sourceId);
      return enqueue(sourceId, undefined, true, true);
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
      const current = jobs.get(recording.id);
      if (current?.kind === "active" || current?.kind === "done" || current?.kind === "failed") return;
      const refusal = privateCloudRefusal(recording.durationMs / 1000, null, privateCloudLimits(state.capabilities));
      // A known limit refusal on a usable service drops the save; unknown limits keep the intent until they return.
      if (state.availability === "available" && refusal !== null && refusal.kind !== "unknown") return;
      choices.add(recording.id);
      if (!on()) {
        recoveryNeeded = true;
        if (nextRecoveryAt === Number.POSITIVE_INFINITY) nextRecoveryAt = now();
        block(recording.id);
        return;
      }
      enqueue(recording.id, audio, false);
    },
  };
  triggerAutomaticRecheck = () => {
    void recheckVoiceNoteAvailabilityAutomatically(transcriber, accountCurrent ?? undefined);
  };
  return transcriber;
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
    (caught: unknown) => logPipelineError("[VoiceNotes] The private transcription check threw; this note was not handed to transcription", caught),
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
  let heldDurability: "persistent" | "best-effort" | "unavailable" = "best-effort";
  const held = createHeldResultStore(did);
  const legacyPending = localStorageVoiceNotePendingStore(did);
  const migrateLegacyHeld = async () => {
    for (const sourceId of legacyPending.sourceIds()) {
      const legacy = legacyPending.legacyHeld?.(sourceId);
      if (!isHeldTranscript(legacy)) continue;
      const job = legacyPending.read(sourceId);
      const candidateBase = job?.rerunBase;
      const intent = job?.explicitRerun && candidateBase && Number.isSafeInteger(candidateBase.rev)
        && candidateBase.rev >= 0 && typeof candidateBase.hash === "string" && candidateBase.hash.length > 0
        ? { kind: "rerun" as const, base: { rev: candidateBase.rev, hash: candidateBase.hash } }
        : { kind: "unknown" as const };
      try {
        await held.hold({
          version: 1, did, spaceId: ref.current.spaceId ?? "", sourceId, engine: "private-cloud",
          transcript: legacy, provider: job?.transcriptionId ? { transcriptionId: job.transcriptionId } : null, intent,
        });
        const saved = await held.readHeld(sourceId);
        if (saved) await legacyPending.stripLegacyHeld?.(sourceId, saved.transcript.rev, saved.hash);
      } catch {
        // The legacy copy remains available until the durable destination acknowledges it.
      }
    }
    try { await held.listHeld(); } catch { /* Readiness still permits the legacy fallback. */ }
  };
  const ready = migrateLegacyHeld().then(async () => { heldDurability = await held.durability(); });
  if (typeof window !== "undefined") {
    const onStorage = (event: StorageEvent) => {
      if (event.key === accountStorageKey(VOICE_NOTE_PENDING_JOBS_KEY, did)) void migrateLegacyHeld();
    };
    window.addEventListener("storage", onStorage);
  }
  const privateTranscriber = createVoiceNoteTranscriber({
    cloud: createVoiceNoteCloudForBuild(backendUrl, sessionStore, did),
    consent: localStorageVoiceNoteConsentStore(did),
    choices: localStorageVoiceNotePrivateChoiceStore(did),
    holds: localStorageVoiceNoteHoldStore(did),
    held,
    ready,
    heldAfterCommit: async (row) => {
      await legacyPending.stripLegacyHeld?.(row.sourceId, row.transcript.rev, row.hash);
    },
    tcw: () => ref.current,
  });
  const hosted = createHostedVoiceNoteTrack(() => ref.current, backendUrl, sessionStore, did);
  let powerfulAvailable = false;
  const listeners = new Set<(event: VoiceNoteTranscriberEvent) => void>();
  const makeSnapshot = (): VoiceNoteTranscriberSnapshot => ({
    ...privateTranscriber.snapshot(), heldDurability, powerfulAvailable, powerfulConsented: hosted.consented(),
    jobs: new Map([...privateTranscriber.snapshot().jobs, ...hosted.jobs]),
  });
  let combinedSnapshot = makeSnapshot();
  const emit = (event: VoiceNoteTranscriberEvent = { kind: "changed" }) => {
    combinedSnapshot = makeSnapshot();
    for (const listener of listeners) listener(event);
  };
  void ready.then(() => emit());
  privateTranscriber.subscribe(emit);
  hosted.subscribe(() => emit());
  const transcriber: VoiceNoteTranscriber = {
    ...privateTranscriber,
    snapshot: () => combinedSnapshot,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async check(options) {
      await Promise.all([privateTranscriber.check(options), hosted.check().then((available) => {
        powerfulAvailable = available; emit();
        if (available && hosted.consented()) void hosted.resume();
      }, () => { powerfulAvailable = false; emit(); })]);
    },
    consentPowerful() {
      hosted.consent();
      void hosted.resume();
    },
    transcribe(sourceId, audio) {
      void VoiceNotes.listPending().then(({ recordings }) => {
        const recording = recordings.find((item) => item.id === sourceId);
        if (recording?.options?.transcriber === "assemblyai") void hosted.run(recording);
        else if (recording) privateTranscriber.transcribe(sourceId, audio);
        else void hosted.runSpaceOnly(sourceId).then((used) => {
          if (!used) privateTranscriber.transcribe(sourceId, audio);
        });
      });
    },
    async transcribeAgain(sourceId, engine) {
      if (engine !== "private-cloud" && privateTranscriber.snapshot().jobs.get(sourceId)?.kind === "active")
        return "Wait for Private transcription to stop before choosing another engine.";
      if (engine !== "assemblyai" && hosted.jobs.get(sourceId)?.kind === "active")
        return "Wait for Powerful transcription to stop before choosing another engine.";
      if (engine === "private-cloud")
        return await privateTranscriber.transcribeAgain?.(sourceId, engine) ?? "unavailable";
      if (engine === "assemblyai") {
        if (!powerfulAvailable) return "unavailable";
        if (!hosted.consented()) return "no-consent";
        const { recordings } = await VoiceNotes.listPending();
        const recording = recordings.find((item) => item.id === sourceId);
        if (recording) { await hosted.run(recording, true); return null; }
        return await hosted.runSpaceOnly(sourceId, true) ? null : "unavailable";
      }
      const account = ref.current;
      const generation = currentAccountGeneration();
      const stillAllowed = () => {
        const current = ref.current;
        return generation === currentAccountGeneration() && current.did === did && isAccountWorkAllowed(current);
      };
      const capabilities = captureCapabilities();
      if ((!capabilities.localTranscription && !capabilities.desktopWhisper) || account.did !== did || !stillAllowed()) return "unavailable";
      const { recordings } = await VoiceNotes.listPending();
      if (!stillAllowed()) return "account-changed";
      const recording = recordings.find((item) => item.id === sourceId);
      if (!recording) return "unavailable";
      if (recording.owner && recording.owner !== did) return "account-changed";
      const [currentCommit, local] = await Promise.all([
        readTranscriptCommit(account, sourceId),
        VoiceNotes.getTranscript({ id: sourceId }),
      ]);
      if (!stillAllowed()) return "account-changed";
      let commit: TranscriptCommit;
      try { commit = requireVoiceNoteTranscriptCommit(currentCommit); }
      catch (error) { return readableError(error); }
      const ledgerRev = recording.ledger?.transcriptSync.rev ?? 0;
      const localRev = local.transcript?.rev ?? 0;
      if (![commit.rev, ledgerRev, localRev].every((value) => Number.isSafeInteger(value) && value >= 0))
        return "unavailable";
      const rev = Math.max(commit.rev, ledgerRev, localRev) + 1;
      if (!Number.isSafeInteger(rev)) return "unavailable";
      if (!stillAllowed()) return "account-changed";
      if (capabilities.localTranscription) {
        try { await OnDeviceStt.enqueueAgain({ id: sourceId, rev, baseRev: commit.rev, baseHash: commit.hash }); }
        catch (error) { return `Could not start the on-device transcription: ${readableError(error)}`; }
        return null;
      }
      const desktopQueue = getDesktopWhisperQueue();
      if (!desktopQueue) return "unavailable";
      try { await desktopQueue.rerun({ id: sourceId, rev, baseRev: commit.rev, baseHash: commit.hash }); }
      catch (error) { return `Could not start Whisper transcription: ${readableError(error)}`; }
      return null;
    },
    noteSaved(recording, audio) {
      if (recording.options?.transcriber === "assemblyai") {
        if (hosted.consented()) void VoiceNotes.listPending().then(({ recordings }) => {
          const full = recordings.find((item) => item.id === recording.id);
          if (full) void hosted.run(full);
        });
      } else privateTranscriber.noteSaved(recording, audio);
    },
  };
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
      return status.progress === undefined ? "Sending audio to Private transcription…" : `Sending audio to Private transcription · ${Math.round(Math.min(1, Math.max(0, status.progress)) * 100)}%`;
    case "queued":
      return status.position !== null && status.position > 0 ? `Queued (position ${status.position})…` : "Queued…";
    case "processing": {
      const partsDone = privatePartsDone(status.completed, status.total);
      return partsDone === null ? "Transcribing in private cloud…" : `Transcribing in private cloud… ${partsDone}`;
    }
    case "saving":
      return "Saving the transcript…";
  }
}
