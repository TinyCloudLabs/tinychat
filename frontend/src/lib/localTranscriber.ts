// Local (this Mac) transcription — the desktop-only counterpart to the meeting bot.
//
// Architecture: the Tauri shell runs three anarlog MIT plugins (transcription,
// local-stt, settings) behind the `transcription` Cargo feature. In the webview,
// this module is the ONLY importer of the vendored plugin bindings
// (src/lib/anarlog/*.gen.ts), and it loads them lazily so the web bundle never
// touches `@tauri-apps/api`.
//
// Whisper at the pinned anarlog rev is BATCH-ONLY: capture records audio to the
// vault's sessions dir, and transcription runs after Stop via an in-process
// whisper.cpp server (`start_server` → `start_transcription(provider:
// "whispercpp")`). There is no live transcript while recording.
//
// Speaker labels: batch results carry a `channel` per word (0 = mic,
// 1 = system audio in the recorded stereo file, confirmed on a real capture),
// so sentences are labeled "You" and "Others". Mic echo of system audio is
// dropped and same-speaker segments merge into turns (localTranscriptTurns.ts).

import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import {
  upsertMeeting,
  type NormalizedMeeting,
  type StoreResult,
  type UpsertMeetingOutcome,
} from "./connectors/connectorStore";
import type { FirefliesSentence } from "./connectors/firefliesClient";
import { localChannelLabel, localTranscriptTurns, type LocalWord } from "./localTranscriptTurns";
// Type-only imports: erased at build time, so the web bundle never pulls the
// vendored bindings (or @tauri-apps/api) in. Runtime access goes through the
// lazy dynamic import in loadBridge().
import type {
  BatchResponse,
  CaptureLifecycleEvent,
  CaptureStatusEvent,
  TranscriptionEvent,
} from "./anarlog/transcription.gen";
import type { DownloadProgressPayload } from "./anarlog/localStt.gen";
import {
  createCloudJobPoller,
  loadPrivateCloudNative,
  localStoragePendingCloudStore,
  localStorageRecordStore,
  privateCloudJobClient,
  privateCloudMessage,
  PrivateCloudError,
  REAL_CLOCK,
  toPrivateCloudError,
  type CaptureReadyEvent,
  type CloudClock,
  type CloudPolling,
  type PendingCloudStore,
  type PrivateCloudApi,
  type PrivateCloudAvailability,
  type PrivateCloudJob,
  type PrivateCloudNative,
  type PrivateCloudTranscript,
  type RecordStore,
  type TranscriptionEngine,
} from "./privateCloud";
import { accountStorageKey } from "./voiceNotes/voiceNoteTranscription";

export type { TranscriptionEngine } from "./privateCloud";

/** The Transcriber card's surfaces: the meeting bot, Local recording (desktop only) and Upload audio. */
export type TranscriberKind = "meeting-bot" | "local" | "upload";

/** `connector_meeting.source` for local recordings. Distinct from the bot's
 *  `tinycloud-transcriber` so Meetings and meeting chat can tell them apart;
 *  registered in EXPLORER_MEETING_SOURCES and SUPPORTED_MEETING_SOURCES. */
export const LOCAL_MEETING_SOURCE = "exo-local";

/** Human label for the explorer chip. */
export const LOCAL_MEETING_SOURCE_LABEL = "Exo Local";

export const LOCAL_KIND_STORAGE_KEY = "exo.transcriber.kind";
export const LOCAL_MODEL_STORAGE_KEY = "exo.transcriber.localModel";
/** The stopped on-device recording not yet transcribed and saved, so a relaunch
 *  offers it again. Suffixed with the account's DID (accountStorageKey). */
export const LOCAL_KEPT_RECORDING_KEY = "exo.transcriber.localKeptRecording";

/** True only inside the Tauri webview. Everything below must stay behind this gate. */
export function isDesktopLocalTranscriptionAvailable(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export type WhisperModel =
  | "QuantizedTinyEn"
  | "QuantizedTiny"
  | "QuantizedBaseEn"
  | "QuantizedBase"
  | "QuantizedSmallEn"
  | "QuantizedSmall"
  | "QuantizedLargeTurbo";

export interface LocalWhisperModel {
  id: WhisperModel;
  label: string;
  /** English-only ggml models transcribe English better than their multilingual twin. */
  englishOnly: boolean;
  /** Approximate on-disk size; shown so the download isn't a surprise. */
  approxSizeMb: number;
}

/** Quantized whisper.cpp models exposed at the pinned rev. Sizes are anarlog's
 *  `WhisperModel::model_size_bytes` (crates/whisper-local-model) in decimal MB. */
export const LOCAL_WHISPER_MODELS: readonly LocalWhisperModel[] = [
  { id: "QuantizedTinyEn", label: "Whisper Tiny (English)", englishOnly: true, approxSizeMb: 44 },
  { id: "QuantizedTiny", label: "Whisper Tiny (multilingual)", englishOnly: false, approxSizeMb: 44 },
  { id: "QuantizedBaseEn", label: "Whisper Base (English)", englishOnly: true, approxSizeMb: 82 },
  { id: "QuantizedBase", label: "Whisper Base (multilingual)", englishOnly: false, approxSizeMb: 82 },
  { id: "QuantizedSmallEn", label: "Whisper Small (English)", englishOnly: true, approxSizeMb: 264 },
  { id: "QuantizedSmall", label: "Whisper Small (multilingual)", englishOnly: false, approxSizeMb: 264 },
  { id: "QuantizedLargeTurbo", label: "Whisper Large Turbo", englishOnly: false, approxSizeMb: 874 },
];

export const DEFAULT_LOCAL_MODEL: WhisperModel = "QuantizedTinyEn";

// ── Kept recording (relaunch) ──────────────────────────────────────────

/** What Transcribe needs to re-run Whisper on a recording after a relaunch. */
export interface KeptLocalRecording {
  sessionId: string;
  startedAt: string;
  audioPath: string;
  model: WhisperModel;
  language: string;
}

export type KeptRecordingStore = RecordStore<KeptLocalRecording>;

/** This Mac's kept recording for one account (keyed by DID, like uploads and
 *  voice notes), so another account never sees, resumes, overwrites or clears it. */
export function localStorageKeptRecordingStore(accountDid: string): KeptRecordingStore {
  return localStorageRecordStore(accountStorageKey(LOCAL_KEPT_RECORDING_KEY, accountDid), (v) => {
    if (typeof v.sessionId !== "string" || typeof v.startedAt !== "string") return null;
    if (typeof v.audioPath !== "string" || v.audioPath === "") return null;
    return {
      sessionId: v.sessionId,
      startedAt: v.startedAt,
      audioPath: v.audioPath,
      model: LOCAL_WHISPER_MODELS.some((m) => m.id === v.model) ? (v.model as WhisperModel) : DEFAULT_LOCAL_MODEL,
      language: typeof v.language === "string" ? v.language : "en",
    };
  });
}

// ── Plugin bridge ──────────────────────────────────────────────────────

type Result<T> = { status: "ok"; data: T } | { status: "error"; error: string };

type Unlisten = () => void;

interface CaptureParamsWire {
  session_id: string;
  languages: string[];
  onboarding: boolean;
  model: string;
  base_url: string;
  api_key: string;
  keywords: string[];
  mic_device?: string | null;
  transcription_mode?: "live" | "batch" | null;
}

interface TranscriptionParamsWire {
  session_id: string;
  provider: "whispercpp";
  file_path: string;
  model?: string | null;
  base_url: string;
  api_key: string;
  languages?: string[];
  keywords?: string[];
}

/** The slices of the two vendored plugins this module uses. Kept narrow on
 *  purpose: an injected fake of this interface is what the unit tests drive. */
export interface LocalTranscriberBridge {
  transcription: {
    listMicrophoneDevices(): Promise<Result<string[]>>;
    startCapture(params: CaptureParamsWire): Promise<Result<null>>;
    stopCapture(): Promise<Result<null>>;
    getCaptureState(): Promise<Result<"active" | "finalizing" | "inactive">>;
    startTranscription(params: TranscriptionParamsWire): Promise<Result<null>>;
    events: {
      captureLifecycleEvent: {
        listen(cb: (e: { payload: CaptureLifecycleEvent }) => void): Promise<Unlisten>;
      };
      captureStatusEvent: {
        listen(cb: (e: { payload: CaptureStatusEvent }) => void): Promise<Unlisten>;
      };
      transcriptionEvent: {
        listen(cb: (e: { payload: TranscriptionEvent }) => void): Promise<Unlisten>;
      };
    };
  };
  localStt: {
    isModelDownloaded(model: WhisperModel): Promise<Result<boolean>>;
    downloadModel(model: WhisperModel): Promise<Result<null>>;
    startServer(model: WhisperModel): Promise<Result<string>>;
    events: {
      downloadProgressPayload: {
        listen(cb: (e: { payload: DownloadProgressPayload }) => void): Promise<Unlisten>;
      };
    };
  };
}

/**
 * Loads the vendored bindings. Dynamic on purpose: the gen files import
 * `@tauri-apps/api`, which doesn't exist outside the desktop webview — a static
 * import would break the web bundle. All callers are gated behind
 * `isDesktopLocalTranscriptionAvailable()` or an injected bridge.
 */
async function loadBridge(): Promise<LocalTranscriberBridge> {
  const [transcription, localStt] = await Promise.all([
    import("./anarlog/transcription.gen"),
    import("./anarlog/localStt.gen"),
  ]);
  return {
    transcription: {
      listMicrophoneDevices: () => transcription.commands.listMicrophoneDevices(),
      startCapture: (params) => transcription.commands.startCapture(params),
      stopCapture: () => transcription.commands.stopCapture(),
      getCaptureState: () => transcription.commands.getCaptureState(),
      startTranscription: (params) => transcription.commands.startTranscription(params),
      events: transcription.events,
    },
    localStt: {
      isModelDownloaded: (model) => localStt.commands.isModelDownloaded(model),
      downloadModel: (model) => localStt.commands.downloadModel(model),
      startServer: (model) => localStt.commands.startServer(model),
      events: localStt.events,
    },
  };
}

// ── Public interface ───────────────────────────────────────────────────

/** A transcript made on this Mac by whisper.cpp. */
export interface OnDeviceTranscriptResult {
  engine?: "on-device";
  sessionId: string;
  /** ISO timestamp captured at start(), used for the meeting's startedAt. */
  startedAt: string;
  model: WhisperModel;
  language: string;
  /** Raw whisper.cpp batch response (channels → alternatives → words). */
  response: BatchResponse;
}

/** A transcript made by TinyCloud Private Transcription from the uploaded recording. */
export interface CloudTranscriptResult {
  engine: "private-cloud";
  sessionId: string;
  startedAt: string;
  language: string;
  /** The PTX job, deleted once the transcript is saved (finishCloudTranscript). */
  transcriptionId: string;
  transcript: PrivateCloudTranscript;
  /** Native's opaque upload handle, released by finishCloudTranscript; null after a relaunch. */
  captureHandle: string | null;
}

export type LocalTranscriptResult = OnDeviceTranscriptResult | CloudTranscriptResult;

export type LocalTranscriberStatus =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "recording" }
  | { kind: "stopping" }
  | { kind: "transcribing"; progress: number | null }
  /** Private cloud: sending the recording (percent of bytes). */
  | { kind: "uploading"; pct: number | null }
  /** Private cloud: the job is waiting or being transcribed. */
  | {
      kind: "cloud-processing";
      stage: "queued" | "processing";
      queuePosition: number | null;
      regionsCompleted: number | null;
      regionsTotal: number | null;
    }
  /** Private cloud: finishing an earlier job of this account (its transcript is saved on its own). */
  | { kind: "cloud-recovering" }
  | { kind: "done" }
  | { kind: "error"; message: string };

/** A capture no open view owns that native capture has not confirmed stopped. */
export interface PreviousRecording {
  /** Its native capture session. */
  sessionId: string;
  /** Why it is unconfirmed and what native capture reports now. */
  message: string;
}

export interface LocalTranscriber {
  /** True when the model file is already on disk. */
  isModelDownloaded(model: WhisperModel): Promise<boolean>;
  /** Download the model if needed; `onProgress` receives 0–100. */
  ensureModel(model: WhisperModel, onProgress?: (pct: number) => void): Promise<void>;
  /** Mic device names for an optional picker. */
  listMicrophoneDevices(): Promise<string[]>;
  /** Start the local Whisper server (idempotent) and begin capturing mic+system audio.
   *  First waits for a closed view's capture to confirm it stopped, and rejects
   *  with PreviousCaptureUnconfirmedError while a previous recording is not
   *  confirmed stopped. A start_capture that times out may still start, so it
   *  becomes such a previous recording rather than being assumed not started.
   *  Also refuses while a recording is being, or waiting to be, transcribed. */
  start(opts: {
    model: WhisperModel;
    language: string;
    micDevice?: string;
    /** Default on-device. Private cloud records the same way but never starts Whisper. */
    engine?: TranscriptionEngine;
  }): Promise<{ sessionId: string }>;
  /** Stop capture, batch-transcribe the recording, return the raw response.
   *  Rejects with CaptureStopUnconfirmedError, keeping the session so stop()
   *  can be retried, when native capture does not confirm it stopped. Rejects
   *  with TranscriptionFailedError, keeping the stopped recording for
   *  retryTranscription(), when transcribing its audio file fails, and with
   *  PartialRecordingError, keeping it untranscribed, when capture failed but
   *  left an audio file. If this view closes first, the transcription is
   *  handed to the next view (adoptTranscription) and this rejects. */
  stop(): Promise<LocalTranscriptResult>;
  /** Transcribe the kept recording: same audio file, session, model and
   *  language, after starting the local Whisper server again. Rejects with
   *  TranscriptionFailedError, still keeping the recording, if it fails again. */
  retryTranscription(opts?: {
    /** Explicitly move a private cloud recording to on-device Whisper with this model. */
    onDevice?: { model: WhisperModel };
  }): Promise<LocalTranscriptResult>;
  /** Give up on the kept recording without transcribing it, and forget it
   *  (a relaunch no longer offers it). Its audio file stays on disk. */
  discardRecording(): void;
  /** Take over a transcription whose view closed: the one still running, or
   *  the outcome it left. Resolves with the transcript (exactly once, to this
   *  view) or rejects like stop(), keeping a failed or partial recording for
   *  this view's retryTranscription()/discardRecording(). Null when there is
   *  none to take over. */
  adoptTranscription(): Promise<LocalTranscriptResult> | null;
  /** A capture that no open view owns and native capture has not confirmed
   *  stopped (a closed view's stop, or a start_capture, timed out or failed),
   *  or null. Waits (bounded) for a closed view's in-flight stop first,
   *  calling `onWaiting` when it has to. */
  previousRecording(onWaiting?: () => void): Promise<PreviousRecording | null>;
  /** Stop the previous recording: stop_capture, wait (bounded) for that
   *  session's `stopped` event, then confirm native capture is inactive.
   *  Rejects with PreviousCaptureUnconfirmedError, keeping it to try again,
   *  when that is not confirmed. */
  stopPreviousRecording(): Promise<void>;
  /** Called when the view is removed. Hands a transcription this view owns to
   *  the next view, and stops an unfinished native capture: resolves only
   *  once native capture confirms it stopped; otherwise rejects and leaves it
   *  as the previous recording for the next view to stop. */
  stopCaptureOnUnmount(): Promise<void>;
  /** Subscribe to capture/transcription status; returns unsubscribe. */
  onStatus(cb: (s: LocalTranscriberStatus) => void): () => void;
  /** This account's on-device recording that stopped but never had its
   *  transcript saved (Exo quit or crashed, or its view closed), kept for this
   *  view like a failed transcription: rejects with KeptRecordingError for
   *  retryTranscription() or discardRecording(). Null when there is none, a job
   *  already runs, or its transcript is being saved right now. */
  resumeKeptRecording(): Promise<LocalTranscriptResult> | null;
  /** While `saving` runs, the on-device transcript's recording is being saved,
   *  so it is not offered as kept (e.g. to a view that opens meanwhile). */
  savingOnDeviceTranscript(result: OnDeviceTranscriptResult, saving: Promise<unknown>): void;
  /** The save of this account's kept recording running right now (it is not
   *  offered meanwhile), settling when that save does; null when none runs. */
  keptRecordingSave(): Promise<void> | null;
  /** After an on-device transcript is saved (or had no speech to save):
   *  forget its kept recording, so a relaunch no longer offers it. */
  finishOnDeviceTranscript(result: OnDeviceTranscriptResult): void;
  /** Private cloud is offered only when this build can upload (native) and the
   *  backend admits this account (capabilities 200). A clean 404 also forgets
   *  a pending job, which can no longer be finished here. */
  privateCloudAvailability(): Promise<PrivateCloudAvailability>;
  /** True when any Whisper model is on disk (decides the default engine). */
  anyModelDownloaded(): Promise<boolean>;
  /** A private cloud job left by a previous launch, finished in this view like
   *  adoptTranscription(); null when there is none. Resolves null (and forgets
   *  it) when that job no longer exists. Call only while the engine is available. */
  resumeCloudTranscription(): Promise<LocalTranscriptResult | null> | null;
  /** Tenant-list recovery: finishes this account's jobs no view on this Mac
   *  knows about (a lost pending record, a relaunch), handing each transcript
   *  to `saveRecovered`. Resolves with how many were finished. */
  recoverCloudTranscripts(): Promise<number>;
  /** After a private cloud transcript is saved: delete it from PTX and release
   *  the recording's upload handle. Rejects if the deletion fails (PTX then
   *  deletes it on its 24 h schedule; a relaunch retries). */
  finishCloudTranscript(result: CloudTranscriptResult): Promise<void>;
}

/** Bounds on every wait for the native plugins. A timeout is surfaced like
 *  any other failure, with its recovery action. */
export interface LocalTranscriberTimeouts {
  /** Loading the plugin bindings, and registering the capture event listeners. */
  listenMs: number;
  /** Quick native reads: is_model_downloaded, list_microphone_devices, get_capture_state. */
  queryMs: number;
  /** start_server: starting whisper.cpp and loading the model. */
  serverStartMs: number;
  /** start_capture: starting the session and opening the mic and system audio. */
  captureStartMs: number;
  /** stop_capture plus the session's `stopped` event. */
  captureStopMs: number;
  /** start_transcription plus its terminal event. */
  transcribeMs: number;
  /** download_model plus its terminal event. */
  modelDownloadMs: number;
  /** Private cloud: native's capture handle after the `stopped` event. */
  captureReadyMs: number;
}

const DEFAULT_TIMEOUTS: LocalTranscriberTimeouts = {
  listenMs: 10_000,
  queryMs: 15_000,
  // Loads the chosen model into whisper.cpp; Large Turbo is ~874 MB.
  serverStartMs: 2 * 60_000,
  captureStartMs: 60_000,
  captureStopMs: 2 * 60_000,
  transcribeMs: 30 * 60_000,
  modelDownloadMs: 30 * 60_000,
  captureReadyMs: 10_000,
};

/** What the private cloud engine needs; absent means the engine is never offered. */
export interface PrivateCloudDeps {
  api: PrivateCloudApi;
  /** Injected in tests; the real one is loaded lazily. */
  native?: PrivateCloudNative;
  pending?: PendingCloudStore;
  clock?: CloudClock;
  polling?: Partial<CloudPolling>;
  newAttemptId?: () => string;
  /** Saves a transcript recovered from a job no recording on this Mac owns
   *  (tenant-list recovery) as its own Exo Local meeting, then deletes it. */
  saveRecovered?: (result: CloudTranscriptResult) => Promise<void>;
}

/**
 * Native capture did not confirm it stopped: stop_capture failed or never
 * returned, or its matching `stopped` event did not arrive in time. The
 * recording may still be running, so the session is kept for a retried stop().
 */
export class CaptureStopUnconfirmedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaptureStopUnconfirmedError";
  }
}

/**
 * Native capture stopped with an audio file, but transcribing it failed
 * (start_server or start_transcription error, a failed event, or a timeout).
 * The recording is kept until retryTranscription() succeeds or it is discarded.
 */
export class TranscriptionFailedError extends Error {
  /** False when Retry cannot help (the recording is gone, too long, …): only Discard. */
  readonly retryable: boolean;
  /** Private cloud: the stable error code and the reference shown to the user. */
  readonly code: string | null;
  readonly correlationId: string | null;
  /** Private cloud: this recording can be transcribed on this Mac instead. */
  readonly offerOnDevice: boolean;
  constructor(
    message: string,
    extra: { retryable?: boolean; code?: string | null; correlationId?: string | null; offerOnDevice?: boolean } = {},
  ) {
    super(message);
    this.name = "TranscriptionFailedError";
    this.retryable = extra.retryable ?? true;
    this.code = extra.code ?? null;
    this.correlationId = extra.correlationId ?? null;
    this.offerOnDevice = extra.offerOnDevice ?? false;
  }
}

/**
 * Private cloud: polling failed transiently for 10 minutes. The job may still
 * be running; Retry ("Keep waiting") resumes polling the same job.
 */
export class CloudConnectionLostError extends TranscriptionFailedError {
  constructor(message: string) {
    super(message);
    this.name = "CloudConnectionLostError";
  }
}

/**
 * A capture this app started is not confirmed stopped and no open view owns
 * it: a closed view's stop was not confirmed, or start_capture timed out and
 * may yet start. Nothing new starts until stopPreviousRecording() confirms
 * native capture is inactive.
 */
export class PreviousCaptureUnconfirmedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreviousCaptureUnconfirmedError";
  }
}

/**
 * Native capture ended with an error but left an audio file (e.g. an input
 * that failed near the end). The partial recording is kept, untranscribed,
 * for retryTranscription() or discardRecording().
 */
export class PartialRecordingError extends TranscriptionFailedError {
  constructor(message: string) {
    super(message);
    this.name = "PartialRecordingError";
  }
}

/**
 * An on-device recording that stopped but never had its transcript saved: Exo
 * quit or crashed, or its view closed first. Transcribe runs
 * retryTranscription(); its audio file may be gone, which fails without Retry.
 */
export class KeptRecordingError extends TranscriptionFailedError {
  constructor(message: string) {
    super(message);
    this.name = "KeptRecordingError";
  }
}

/** A bounded wait on a native command or event ran out. */
class LocalTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalTimeoutError";
  }
}

type CaptureStoppedEvent = Extract<CaptureLifecycleEvent, { type: "stopped" }>;

type NativeCaptureState = "active" | "finalizing" | "inactive";

/** A stopped recording's audio file plus what its transcription and save need. */
interface StoppedRecording {
  sessionId: string;
  startedAt: string;
  /** Empty for a private cloud job resumed after a relaunch (only its PTX id is known). */
  audioPath: string;
  model: WhisperModel;
  language: string;
  engine: TranscriptionEngine;
}

/** Where a private cloud recording's job stands, and what Retry does next. */
interface CloudJobState {
  /** Native's opaque handle for the recording; null until `exo://capture-ready`. */
  captureHandle: string | null;
  /** True for a job resumed after a relaunch: native no longer holds the recording. */
  handleLost: boolean;
  /** Idempotency-Key of the current PTX job; a new one creates a new job. */
  attemptId: string;
  transcriptionId: string | null;
  /** submit: (re)upload with attemptId · resolve: ask status first · poll: wait for the transcript. */
  next: "submit" | "resolve" | "poll";
}

const VIEW_CLOSED_MESSAGE = "Recording stopped because the Local recording view closed";

const ignore = () => {};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Rejects with LocalTimeoutError when `work` has not settled within `timeoutMs`. */
function withTimeout<T>(work: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new LocalTimeoutError(`Timed out waiting for ${label}`)), timeoutMs);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Registers the listener, then runs the command and waits for its matching
 * terminal event. One timer covers all three, so neither a registration nor a
 * command that never returns can outlive the timeout.
 */
async function invokeAndWaitForEvent<T>(
  subscribe: (cb: (e: { payload: T }) => void) => Promise<Unlisten>,
  match: (payload: T) => boolean,
  timeoutMs: number,
  label: string,
  invoke: () => Promise<void>,
  onEvent?: (payload: T) => void,
): Promise<T> {
  let resolveEvent!: (payload: T) => void;
  const event = new Promise<T>((resolve) => {
    resolveEvent = resolve;
  });
  const subscription = subscribe((e) => {
    onEvent?.(e.payload);
    if (match(e.payload)) resolveEvent(e.payload);
  });
  let abandoned = false;
  const run = async () => {
    // Await registration before invoking: a native command may emit its
    // terminal event before its own promise resolves.
    await subscription;
    if (abandoned) throw new Error(`Abandoned ${label}`);
    const [, payload] = await Promise.all([invoke(), event]);
    return payload;
  };
  try {
    return await withTimeout(run(), timeoutMs, label);
  } finally {
    abandoned = true;
    // Also releases a registration that lands after the timeout.
    void subscription.then((unlisten) => unlisten(), ignore);
  }
}

/** stop_capture, then wait for `session`'s terminal `stopped` event.
 *  stop_capture returns once the stop is dispatched, so its success proves nothing. */
async function stopNativeSession(
  b: LocalTranscriberBridge,
  session: string,
  timeoutMs: number,
  label: string,
): Promise<CaptureStoppedEvent> {
  const p = await invokeAndWaitForEvent<CaptureLifecycleEvent>(
    (cb) => b.transcription.events.captureLifecycleEvent.listen(cb),
    (e) => e.type === "stopped" && e.session_id === session,
    timeoutMs,
    label,
    async () => {
      const r = await b.transcription.stopCapture();
      if (r.status === "error") throw new Error(`stop_capture: ${r.error}`);
    },
  );
  if (p.type !== "stopped") throw new Error("Unexpected capture lifecycle state");
  return p;
}

async function readCaptureState(b: LocalTranscriberBridge, timeoutMs: number): Promise<NativeCaptureState> {
  const r = await withTimeout(b.transcription.getCaptureState(), timeoutMs, "get_capture_state");
  if (r.status === "error") throw new Error(`get_capture_state: ${r.error}`);
  return r.data;
}

/**
 * Registers every listener or none: when one fails or registration times out,
 * the ones that did register (now or late) are released before rejecting.
 */
async function registerListeners(
  registrations: readonly (() => Promise<Unlisten>)[],
  timeoutMs: number,
): Promise<Unlisten[]> {
  const pending = registrations.map((register) => register());
  let results: PromiseSettledResult<Unlisten>[];
  try {
    results = await withTimeout(Promise.allSettled(pending), timeoutMs, "capture event listeners to register");
  } catch (err) {
    for (const p of pending) void p.then((unlisten) => unlisten(), ignore);
    throw err;
  }
  const registered = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed !== undefined) {
    for (const unlisten of registered) unlisten();
    throw new Error(`Registering capture event listeners failed: ${errorMessage(failed.reason)}`);
  }
  return registered;
}

/** Identity of the real native listener, which is process-wide. An injected
 *  (test) bridge is its own identity. */
const NATIVE_CAPTURE = {};

/**
 * Close-time stops still in flight, keyed by native identity. A remounted view
 * gets a new transcriber, so this is how its start() learns that the previous
 * view's capture could still be live.
 */
const closingCaptures = new WeakMap<object, Promise<void>>();

/**
 * A capture this app may have started that no open view owns: a closed view's
 * stop was not confirmed, or start_capture timed out. Kept process-wide, with
 * what it takes to stop it, until native capture confirms it is inactive.
 */
interface OrphanedCapture {
  sessionId: string;
  /** Why it is not confirmed stopped; shown with the recovery action. */
  reason: string;
  /** A timed-out start_capture that may still start this session; null once it returns. */
  pendingStart: Promise<unknown> | null;
  /** stop_capture, then wait (bounded) for this session's `stopped` event. */
  stop: (timeoutMs: number) => Promise<unknown>;
  /** The one recovery in flight, shared by every caller. */
  recovering: Promise<void> | null;
}

const orphanedCaptures = new WeakMap<object, OrphanedCapture>();

function adoptOrphan(
  nativeKey: object,
  bridge: () => Promise<LocalTranscriberBridge>,
  sessionId: string,
  reason: string,
  pendingStart: Promise<unknown> | null,
): OrphanedCapture {
  const orphan: OrphanedCapture = {
    sessionId,
    reason,
    pendingStart,
    stop: async (timeoutMs) =>
      stopNativeSession(await bridge(), sessionId, timeoutMs, "the previous recording to confirm it stopped"),
    recovering: null,
  };
  const started = () => {
    orphan.pendingStart = null;
  };
  pendingStart?.then(started, started);
  orphanedCaptures.set(nativeKey, orphan);
  return orphan;
}

function orphanMessage(orphan: OrphanedCapture, nativeState: string): string {
  const starting =
    orphan.pendingStart === null
      ? ""
      : " Its start_capture has not returned yet; if that persists, quit and reopen Exo.";
  return `${orphan.reason} Native capture is ${nativeState}.${starting} Stop it before starting a new recording.`;
}

/** Nothing can still be recording for this orphan: native capture is inactive
 *  and no timed-out start_capture can still start it. */
function orphanSettled(orphan: OrphanedCapture, nativeState: NativeCaptureState): boolean {
  return orphan.pendingStart === null && nativeState === "inactive";
}

/**
 * Waits (bounded) for a closed view's in-flight stop, then reports a previous
 * recording that native capture has not confirmed stopped. One it confirms
 * inactive is cleared.
 */
async function unconfirmedPreviousCapture(
  nativeKey: object,
  bridge: () => Promise<LocalTranscriberBridge>,
  queryMs: number,
  onWaiting?: () => void,
): Promise<PreviousRecording | null> {
  const closing = closingCaptures.get(nativeKey);
  const recovering = orphanedCaptures.get(nativeKey)?.recovering ?? null;
  if (closing !== undefined || recovering !== null) {
    onWaiting?.();
    // Bounded by the closed view's own start and stop timeouts, or by the
    // recovery's; a failure leaves the orphan record read below.
    await closing?.then(ignore, ignore);
    await recovering?.then(ignore, ignore);
  }
  const orphan = orphanedCaptures.get(nativeKey);
  if (orphan === undefined) return null;
  const nativeState = await readCaptureState(await bridge(), queryMs);
  if (orphanSettled(orphan, nativeState)) {
    if (orphanedCaptures.get(nativeKey) === orphan) orphanedCaptures.delete(nativeKey);
    return null;
  }
  return { sessionId: orphan.sessionId, message: orphanMessage(orphan, nativeState) };
}

/** Stops the previous recording and confirms native capture is inactive. */
function recoverPreviousCapture(
  nativeKey: object,
  bridge: () => Promise<LocalTranscriberBridge>,
  timeouts: LocalTranscriberTimeouts,
): Promise<void> {
  const orphan = orphanedCaptures.get(nativeKey);
  if (orphan === undefined) return Promise.resolve();
  orphan.recovering ??= (async () => {
    try {
      const b = await bridge();
      let nativeState = await readCaptureState(b, timeouts.queryMs);
      if (!orphanSettled(orphan, nativeState)) {
        try {
          await orphan.stop(timeouts.captureStopMs);
        } catch (err) {
          orphan.reason = `Stopping the previous recording was not confirmed (${errorMessage(err)}).`;
        }
        nativeState = await readCaptureState(b, timeouts.queryMs);
        if (!orphanSettled(orphan, nativeState)) {
          throw new PreviousCaptureUnconfirmedError(orphanMessage(orphan, nativeState));
        }
      }
      if (orphanedCaptures.get(nativeKey) === orphan) orphanedCaptures.delete(nativeKey);
    } finally {
      orphan.recovering = null;
    }
  })();
  return orphan.recovering;
}

type TranscriptionOutcome =
  | { ok: true; result: LocalTranscriptResult }
  | { ok: false; error: TranscriptionFailedError };

/**
 * A stopped recording handed to on-device transcription, kept process-wide:
 * native start_transcription returns once the batch job is spawned and the
 * local Whisper server runs one job at a time, so the job outlives the view
 * that started it. It lasts until its transcript is taken or a failed or
 * partial recording is discarded, and no capture starts meanwhile.
 */
interface TranscriptionJob {
  recording: StoppedRecording;
  /** Identity of the transcriber whose view takes the outcome; null while no open view owns it. */
  owner: object | null;
  /** The owning view's status sink (progress of an attempt that outlives its view). */
  report: ((s: LocalTranscriberStatus) => void) | null;
  /** Private cloud state; null for on-device recordings. */
  cloud: CloudJobState | null;
  /** DID of the account whose recording this is (null: no account given). */
  account: string | null;
  /** The latest attempt's outcome; never rejects. */
  attempt: Promise<TranscriptionOutcome>;
  /** True while an attempt runs. */
  running: boolean;
}

const transcriptionJobs = new WeakMap<object, TranscriptionJob>();

/** On-device transcripts being saved (session → settles with the save), per native identity. */
const savingTranscripts = new WeakMap<object, Map<string, Promise<void>>>();

/** A new job's attempt until runAttempt() replaces it, in the same tick. */
const NOT_ATTEMPTED: Promise<TranscriptionOutcome> = new Promise(() => {});

const HANDED_OFF_MESSAGE = "The Local recording view closed; the next one takes over this transcription";

/**
 * The job's latest outcome, for `owner` only. A transcript is taken exactly
 * once, ending the job; a failure keeps the recording for Retry or Discard.
 * If the owner's view closed meanwhile, the outcome waits for the next view.
 */
async function takeTranscription(
  nativeKey: object,
  job: TranscriptionJob,
  owner: object,
): Promise<LocalTranscriptResult> {
  const outcome = await job.attempt;
  if (job.owner !== owner || transcriptionJobs.get(nativeKey) !== job) throw new Error(HANDED_OFF_MESSAGE);
  if (!outcome.ok) throw outcome.error;
  transcriptionJobs.delete(nativeKey);
  return outcome.result;
}

/**
 * The latest `exo://capture-ready` per session. Process-wide like the capture:
 * its listener is registered once and never removed, so a view closing between
 * Stop and the event cannot lose the recording's upload handle.
 */
interface CaptureReadyStore {
  ready: Map<string, CaptureReadyEvent>;
  waiters: Map<string, Set<(e: CaptureReadyEvent) => void>>;
  registering: Promise<void> | null;
}

const captureReadyStores = new WeakMap<object, CaptureReadyStore>();

/** Session ids of cloud-bound captures; native opens only these (registry.rs). */
export const CLOUD_SESSION_PREFIX = "cloud-";

/** Recoveries of other jobs in flight, per native identity and job id, so two
 *  paths (a submit blocked by the job, relaunch recovery) finish it once. */
const cloudRecoveries = new WeakMap<object, Map<string, Promise<CloudRecoveryOutcome>>>();

/** finished: its transcript went to saveRecovered · ended: nothing to save ·
 *  unfinishable: it awaits an upload only its own recording can make. */
type CloudRecoveryOutcome = "finished" | "ended" | "unfinishable";
const MAX_READY_EVENTS = 16;

function captureReadyStore(key: object): CaptureReadyStore {
  let store = captureReadyStores.get(key);
  if (store === undefined) {
    store = { ready: new Map(), waiters: new Map(), registering: null };
    captureReadyStores.set(key, store);
  }
  return store;
}

function listenCaptureReady(store: CaptureReadyStore, native: PrivateCloudNative, timeoutMs: number): Promise<void> {
  if (store.registering === null) {
    const registering = withTimeout(
      native.onCaptureReady((e) => {
        store.ready.set(e.sessionId, e);
        while (store.ready.size > MAX_READY_EVENTS) {
          const oldest = store.ready.keys().next().value;
          if (oldest === undefined) break;
          store.ready.delete(oldest);
        }
        const waiting = store.waiters.get(e.sessionId);
        store.waiters.delete(e.sessionId);
        waiting?.forEach((resolve) => resolve(e));
      }),
      timeoutMs,
      "the private cloud capture listener to register",
    ).then(ignore);
    store.registering = registering;
    registering.catch(() => {
      if (store.registering === registering) store.registering = null;
    });
  }
  return store.registering;
}

/** The session's capture-ready event, waiting up to `timeoutMs` after Stop. */
function waitCaptureReady(store: CaptureReadyStore, sessionId: string, timeoutMs: number): Promise<CaptureReadyEvent> {
  const ready = store.ready.get(sessionId);
  if (ready !== undefined) return Promise.resolve(ready);
  return new Promise((resolve, reject) => {
    const waiting = store.waiters.get(sessionId) ?? new Set();
    store.waiters.set(sessionId, waiting);
    const timer = setTimeout(() => {
      waiting.delete(done);
      reject(new PrivateCloudError("capture_not_available", "Exo did not hand over the recording for upload"));
    }, timeoutMs);
    function done(e: CaptureReadyEvent) {
      clearTimeout(timer);
      resolve(e);
    }
    waiting.add(done);
  });
}

/** Failures after which Retry starts a new PTX job (a new Idempotency-Key):
 *  the old job is terminal (or gone), so it no longer holds the account's one
 *  active slot. */
const NEW_CLOUD_JOB_CODES: ReadonlySet<string> = new Set([
  "failed",
  "cancelled",
  "upload_expired",
  "upload_integrity_failed",
  "provider_unavailable",
  "provider_outcome_unknown",
  "processing_timeout",
  "processing_failed",
  "transcription_failed",
  "transcript_expired",
  "transcription_not_found",
  "idempotency_conflict",
]);

/** Failures Retry cannot fix: only Discard (or Transcribe on this Mac). */
const NOT_RETRYABLE_CLOUD_CODES: ReadonlySet<string> = new Set([
  "file_changed",
  "capture_not_available",
  "upload_interrupted_by_quit",
  "recording_too_long_for_cloud",
  "recording_too_large",
  "recording_too_long",
  "unsupported_recording",
  "invalid_audio",
  "no_speech",
  "origin_not_configured",
  "backend_origin_mismatch",
  "service_misconfigured",
  "feature_unavailable",
  "invalid_argument",
]);

/** Failures where on-device Whisper may still work, if a model is downloaded. */
const ON_DEVICE_ALTERNATIVE_CODES: ReadonlySet<string> = new Set([
  "active_transcription_exists",
  "recording_too_long_for_cloud",
  "recording_too_large",
  "recording_too_long",
  "unsupported_recording",
  "invalid_audio",
  "no_speech",
]);

export function createLocalTranscriber(
  injected?: LocalTranscriberBridge,
  options: {
    timeouts?: Partial<LocalTranscriberTimeouts>;
    cloud?: PrivateCloudDeps;
    /** The signed-in account's DID. Scopes the kept recording and a closed
     *  view's job to it; without one, no recording is kept across a relaunch. */
    account?: () => string | null;
    /** An account's kept-recording store; injected in tests, localStorage otherwise. */
    kept?: (accountDid: string) => KeptRecordingStore;
  } = {},
): LocalTranscriber {
  const timeouts: LocalTranscriberTimeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
  let bridgePromise: Promise<LocalTranscriberBridge> | null = injected
    ? Promise.resolve(injected)
    : null;
  /** The plugin bridge, loaded once; a failed load is retried by the next call. */
  const bridge = (): Promise<LocalTranscriberBridge> => {
    if (bridgePromise === null) {
      const loading = loadBridge();
      bridgePromise = loading;
      loading.catch(() => {
        if (bridgePromise === loading) bridgePromise = null;
      });
    }
    return withTimeout(bridgePromise, timeouts.listenMs, "the local transcription plugins to load");
  };
  const nativeKey: object = injected ?? NATIVE_CAPTURE;
  /** This transcriber's identity as the owner of a transcription job. */
  const ownerId: object = {};

  // Private cloud engine (absent → never offered).
  const cloud = options.cloud ?? null;
  const cloudClock = cloud?.clock ?? REAL_CLOCK;
  const cloudPoller =
    cloud === null
      ? null
      : createCloudJobPoller(cloud.api, {
          clock: cloudClock,
          polling: cloud.polling,
          connectionLost: () =>
            new CloudConnectionLostError(
              "Lost contact with private cloud transcription for 10 minutes. The job may still be running; the recording is kept on this Mac.",
            ),
        });
  const pendingStore = cloud?.pending ?? localStoragePendingCloudStore;
  const account = options.account ?? (() => null);
  const keptFor = options.kept ?? localStorageKeptRecordingStore;
  const keptStore = (did: string | null): KeptRecordingStore | null => (did === null ? null : keptFor(did));
  /** Persist an on-device recording before it is transcribed, so a quit or crash cannot lose it. */
  const keepRecording = (recording: StoppedRecording, did: string | null) => {
    if (recording.engine !== "on-device") return;
    keptStore(did)?.write({
      sessionId: recording.sessionId,
      startedAt: recording.startedAt,
      audioPath: recording.audioPath,
      model: recording.model,
      language: recording.language,
    });
  };
  const forgetRecording = (id: string, did: string | null) => {
    const store = keptStore(did);
    if (store?.read()?.sessionId === id) store.clear();
  };
  /** An idle job of another account (signed out since) neither blocks nor is
   *  shown to this one. An on-device recording stays kept under that account,
   *  which is offered it again; a private cloud job is left as it is (not
   *  cancelled), for that account's relaunch resume or tenant-list recovery. */
  const setAsideOtherAccountJob = () => {
    const job = transcriptionJobs.get(nativeKey);
    if (job === undefined || job.account === null || job.account === account() || job.running) return;
    transcriptionJobs.delete(nativeKey);
  };
  const newAttemptId = cloud?.newAttemptId ?? (() => crypto.randomUUID());
  /** Closing the view never loses an on-device recording (complete or partial):
   *  it is kept for the next view or launch (resumeKeptRecording). */
  const keepOnClose = (session: string, at: string | null, stopped: CaptureStoppedEvent) => {
    if (sessionEngine !== "on-device" || !stopped.audio_path || at === null) return;
    keepRecording(
      { sessionId: session, startedAt: at, audioPath: stopped.audio_path, model, language, engine: "on-device" },
      account(),
    );
  };
  const readyStore = captureReadyStore(nativeKey);
  let cloudNativePromise: Promise<PrivateCloudNative> | null = cloud?.native ? Promise.resolve(cloud.native) : null;
  /** Native cloud commands, loaded once; a failed load is retried by the next call. */
  const cloudNative = (): Promise<PrivateCloudNative> => {
    if (cloudNativePromise === null) {
      const loading = loadPrivateCloudNative();
      cloudNativePromise = loading;
      loading.catch(() => {
        if (cloudNativePromise === loading) cloudNativePromise = null;
      });
    }
    return withTimeout(cloudNativePromise, timeouts.listenMs, "the private cloud commands to load");
  };
  const requireCloud = (): PrivateCloudDeps => {
    if (cloud === null) throw new Error("Private cloud transcription is not available");
    return cloud;
  };

  let sessionId: string | null = null;
  let sessionEngine: TranscriptionEngine = "on-device";
  let model: WhisperModel = DEFAULT_LOCAL_MODEL;
  let language = "en";
  let baseUrl: string | null = null;
  let startedAt: string | null = null;
  /** True from a successful start_capture until this session's `stopped` event. */
  let captureActive = false;
  /** This session's terminal `stopped` event, once native capture has sent it. */
  let captureStopped: CaptureStoppedEvent | null = null;
  /** The one in-flight stop_capture + terminal wait, shared by stop() and unmount. */
  let captureStop: Promise<CaptureStoppedEvent> | null = null;
  let starting: Promise<unknown> | null = null;
  let stopping = false;
  let lifecycleGeneration = 0;
  const statusCbs = new Set<(s: LocalTranscriberStatus) => void>();
  let status: LocalTranscriberStatus = { kind: "idle" };

  const emit = (s: LocalTranscriberStatus) => {
    status = s;
    for (const cb of statusCbs) cb(s);
  };

  // Only the session's terminal event ends a capture. stop_capture returns once
  // the stop is dispatched, so its success proves nothing.
  const markCaptureStopped = (p: CaptureStoppedEvent) => {
    if (p.session_id !== sessionId) return;
    captureActive = false;
    captureStopped = p;
  };

  const releaseSession = () => {
    sessionId = null;
    startedAt = null;
    captureStopped = null;
  };

  // Event listeners live for the transcriber's lifetime; they are subscribed
  // lazily so nothing touches the bridge before it's needed, and all-or-nothing
  // so a failed registration leaks no handle and the next start() retries it.
  let listeners: Promise<Unlisten[]> | null = null;
  const ensureListeners = (b: LocalTranscriberBridge): Promise<Unlisten[]> => {
    if (listeners === null) {
      const registering = registerListeners(
        [
          () =>
            b.transcription.events.captureLifecycleEvent.listen((e) => {
              if (e.payload.session_id !== sessionId) return;
              if (e.payload.type === "started") emit({ kind: "recording" });
              if (e.payload.type === "finalizing") emit({ kind: "stopping" });
              // Also records a capture that ended on its own (e.g. a failed audio
              // actor) before Stop, so stop() uses it instead of waiting on a no-op.
              if (e.payload.type === "stopped") markCaptureStopped(e.payload);
            }),
          () =>
            b.transcription.events.captureStatusEvent.listen((e) => {
              if (e.payload.session_id !== sessionId) return;
              if (e.payload.type === "audio_error" && e.payload.is_fatal) {
                emit({ kind: "error", message: e.payload.error });
              }
              if (e.payload.type === "connection_error") {
                emit({ kind: "error", message: e.payload.error });
              }
            }),
          () =>
            b.transcription.events.transcriptionEvent.listen((e) => {
              if (e.payload.session_id !== sessionId) return;
              if (e.payload.type === "progress" && e.payload.event.type === "progress") {
                emit({ kind: "transcribing", progress: Math.round(e.payload.event.percentage * 100) });
              }
            }),
        ],
        timeouts.listenMs,
      );
      listeners = registering;
      registering.catch(() => {
        if (listeners === registering) listeners = null;
      });
    }
    return listeners;
  };

  /** Ask native capture to stop, then wait for this session's `stopped` event. */
  const confirmCaptureStopped = (b: LocalTranscriberBridge): Promise<CaptureStoppedEvent> => {
    if (captureStopped !== null) return Promise.resolve(captureStopped);
    if (captureStop !== null) return captureStop;
    const session = sessionId;
    if (session === null) return Promise.reject(new Error("No local recording is active"));
    captureStop = stopNativeSession(b, session, timeouts.captureStopMs, "native capture to confirm it stopped")
      .then((p) => {
        markCaptureStopped(p);
        return p;
      })
      .finally(() => {
        captureStop = null;
      });
    return captureStop;
  };

  const modelDownloaded = async (b: LocalTranscriberBridge, m: WhisperModel): Promise<boolean> => {
    const r = await withTimeout(b.localStt.isModelDownloaded(m), timeouts.queryMs, "is_model_downloaded");
    if (r.status === "error") throw new Error(`is_model_downloaded: ${r.error}`);
    return r.data;
  };

  /** Start (or reuse) the in-process Whisper server; returns its base URL. */
  const startWhisperServer = async (b: LocalTranscriberBridge, m: WhisperModel): Promise<string> => {
    const server = await withTimeout(b.localStt.startServer(m), timeouts.serverStartMs, "the local Whisper server to start");
    if (server.status === "error") throw new Error(`start_server: ${server.error}`);
    return server.data;
  };

  /** Batch-transcribe a stopped recording's audio file and wait for its terminal event. */
  const transcribe = async (
    b: LocalTranscriberBridge,
    recording: StoppedRecording,
    serverUrl: string,
  ): Promise<OnDeviceTranscriptResult> => {
    const done = await invokeAndWaitForEvent<TranscriptionEvent>(
      (cb) => b.transcription.events.transcriptionEvent.listen(cb),
      (p) => p.session_id === recording.sessionId && (p.type === "completed" || p.type === "failed"),
      timeouts.transcribeMs,
      "on-device transcription",
      async () => {
        const r = await b.transcription.startTranscription({
          session_id: recording.sessionId,
          provider: "whispercpp",
          file_path: recording.audioPath,
          model: recording.model,
          base_url: serverUrl,
          api_key: "",
          languages: [recording.language],
          keywords: [],
        });
        if (r.status === "error") throw new Error(`start_transcription: ${r.error}`);
      },
    );
    if (done.type === "failed") {
      // The audio file is missing (moved or deleted) or unreadable: transcribing it again cannot help.
      throw new TranscriptionFailedError(`Transcription failed (${done.code}): ${done.error}`, {
        retryable: done.code !== "audio_metadata_read_failed",
      });
    }
    if (done.type !== "completed") {
      throw new Error(`Transcription ended unexpectedly (${done.type})`);
    }
    return {
      sessionId: recording.sessionId,
      startedAt: recording.startedAt,
      model: recording.model,
      language: recording.language,
      response: done.response,
    };
  };

  // ── Private cloud attempt ──────────────────────────────────────────

  const persistPending = (job: TranscriptionJob) => {
    const c = job.cloud;
    if (c === null) return;
    pendingStore.write({
      attemptId: c.attemptId,
      transcriptionId: c.transcriptionId,
      sessionId: job.recording.sessionId,
      startedAt: job.recording.startedAt,
      language: job.recording.language,
    });
  };

  const requirePoller = () => {
    requireCloud();
    return cloudPoller!;
  };

  /** The job's status, riding out transient failures. */
  const readCloudJob = (id: string): Promise<PrivateCloudJob> => requirePoller().readJob(id);

  /** Poll a PTX job to its transcript (plan §4.7): transient failures are
   *  ridden out for 10 minutes, then the job is "connection lost", not failed. */
  const pollCloudJob = (id: string, report: (s: LocalTranscriberStatus) => void): Promise<PrivateCloudTranscript> =>
    requirePoller().pollTranscript(id, (p) => report({ kind: "cloud-processing", ...p }));

  /** When a recovered job's recording started: its upload time minus its length. */
  const recoveredStartedAt = (job: PrivateCloudJob): string => {
    const created = job.created_at ? Date.parse(job.created_at) : Number.NaN;
    if (Number.isNaN(created)) return new Date(cloudClock.now()).toISOString();
    const duration = typeof job.duration_seconds === "number" ? job.duration_seconds : 0;
    return new Date(created - duration * 1000).toISOString();
  };

  /**
   * Finish another job of this account and hand its transcript to
   * saveRecovered. Shared per job id, so concurrent callers finish it once.
   * A save that fails is logged and left for the next recovery (the job keeps
   * its transcript until PTX's 24 h schedule).
   */
  const recoverCloudJob = (id: string, report?: (s: LocalTranscriberStatus) => void): Promise<CloudRecoveryOutcome> => {
    let inflight = cloudRecoveries.get(nativeKey);
    if (inflight === undefined) {
      inflight = new Map();
      cloudRecoveries.set(nativeKey, inflight);
    }
    const running = inflight.get(id);
    if (running !== undefined) return running;
    const deps = requireCloud();
    const recovering = (async (): Promise<CloudRecoveryOutcome> => {
      let first: PrivateCloudJob;
      try {
        first = await readCloudJob(id);
      } catch (err) {
        if (err instanceof PrivateCloudError && err.code === "transcription_not_found") return "ended";
        throw err;
      }
      // Another client's job on this account (an Exo mobile voice note): its own app finishes and
      // deletes it. Adopting it here would save it as an Exo Local recording and delete it at PTX.
      if (privateCloudJobClient(first) !== "exo-desktop") return "unfinishable";
      if (first.status === "awaiting_upload") return "unfinishable";
      if (first.status === "failed" || first.status === "cancelled") return "ended";
      report?.({ kind: "cloud-recovering" });
      let transcript: PrivateCloudTranscript;
      try {
        transcript = await pollCloudJob(id, () => report?.({ kind: "cloud-recovering" }));
      } catch (err) {
        // The job ended without a transcript, or vanished: nothing to save.
        if (err instanceof PrivateCloudError && (err.transcriptionId === id || err.code === "transcription_not_found")) {
          return "ended";
        }
        throw err;
      }
      const result: CloudTranscriptResult = {
        engine: "private-cloud",
        sessionId: id,
        startedAt: recoveredStartedAt(first),
        language: transcript.language ?? "en",
        transcriptionId: id,
        transcript,
        captureHandle: null,
      };
      try {
        await deps.saveRecovered?.(result);
      } catch (err) {
        console.error("Saving a recovered private cloud transcript failed; it is retried on the next launch", err);
      }
      return "finished";
    })();
    inflight.set(id, recovering);
    const forget = () => {
      if (inflight.get(id) === recovering) inflight.delete(id);
    };
    recovering.then(forget, forget);
    return recovering;
  };

  /** Upload (or re-join) the recording's PTX job and wait for its transcript. */
  const cloudTranscribe = async (job: TranscriptionJob): Promise<CloudTranscriptResult> => {
    const deps = requireCloud();
    const c = job.cloud;
    if (c === null) throw new Error("Not a private cloud recording");
    const rec = job.recording;
    const report = (s: LocalTranscriberStatus) => job.report?.(s);

    if (c.next === "resolve") {
      if (c.transcriptionId === null) {
        c.next = "submit";
      } else {
        // Ask before re-uploading: an upload whose answer was lost may have landed.
        const current = await readCloudJob(c.transcriptionId);
        if (current.status === "awaiting_upload") c.next = "submit";
        else if (current.status === "failed" || current.status === "cancelled") {
          throw new PrivateCloudError(current.error?.code ?? current.status, current.error?.message ?? `The transcription ${current.status}`, {
            transcriptionId: c.transcriptionId,
          });
        } else c.next = "poll";
      }
    }

    if (c.next === "submit") {
      if (c.handleLost) {
        throw new PrivateCloudError(
          "upload_interrupted_by_quit",
          "The upload was interrupted when Exo quit. The recording is kept on this Mac.",
        );
      }
      if (c.captureHandle === null) {
        const ready = await waitCaptureReady(readyStore, rec.sessionId, timeouts.captureReadyMs);
        if (ready.error) throw new PrivateCloudError(ready.error.code, ready.error.message);
        if (!ready.captureHandle) throw new PrivateCloudError("capture_not_available", "No upload handle for this recording");
        c.captureHandle = ready.captureHandle;
      }
      const bearer = deps.api.bearer();
      if (bearer === null) throw new PrivateCloudError("unauthenticated", "Not signed in");
      persistPending(job);
      const native = await cloudNative();
      const handle = c.captureHandle;
      for (let recovered = 0; ; ) {
        report({ kind: "uploading", pct: 0 });
        const unlisten = await withTimeout(
          native.onUploadProgress((e) => {
            if (e.captureHandle !== handle || e.totalBytes <= 0) return;
            report({ kind: "uploading", pct: Math.min(100, Math.floor((e.sentBytes * 100) / e.totalBytes)) });
          }),
          timeouts.listenMs,
          "upload progress to register",
        );
        try {
          const submitted = await native.submit({
            captureHandle: handle,
            attemptId: c.attemptId,
            backendUrl: deps.api.backendUrl,
            bearer,
            language: rec.language,
          });
          c.transcriptionId = submitted.transcriptionId;
          break;
        } catch (err) {
          const e = toPrivateCloudError(err);
          if (e.code === "active_transcription_exists") {
            // The account's one active job is another recording's (the backend
            // scopes it to this account): a previous launch's whose record was
            // lost, or another Mac's. Finish it and save its transcript as its
            // own meeting, then upload this recording.
            if (e.transcriptionId === null || e.transcriptionId === c.transcriptionId || recovered >= 2) throw err;
            recovered++;
            const outcome = await recoverCloudJob(e.transcriptionId, report);
            if (outcome === "unfinishable") throw err;
            continue;
          }
          // After the job exists, only its status says whether the upload
          // landed: PTX answers a replayed or duplicate PUT with 401, and a
          // lost 201 looks like any transport failure.
          if (e.transcriptionId === null) throw err;
          c.transcriptionId = e.transcriptionId;
          c.next = "resolve";
          persistPending(job);
          const current = await readCloudJob(e.transcriptionId);
          if (current.status === "awaiting_upload") throw err; // Retry re-uploads (same job)
          if (current.status === "failed" || current.status === "cancelled") {
            throw new PrivateCloudError(current.error?.code ?? current.status, current.error?.message ?? `The transcription ${current.status}`, {
              transcriptionId: e.transcriptionId,
              correlationId: e.correlationId,
            });
          }
          // Accepted despite the error: carry on as if the 201 had arrived.
          break;
        } finally {
          unlisten();
        }
      }
      persistPending(job);
      c.next = "poll";
    }

    const transcriptionId = c.transcriptionId;
    if (transcriptionId === null) throw new Error("The private cloud job has no id");
    report({ kind: "cloud-processing", stage: "queued", queuePosition: null, regionsCompleted: null, regionsTotal: null });
    const transcript = await pollCloudJob(transcriptionId, report);
    return {
      engine: "private-cloud",
      sessionId: rec.sessionId,
      startedAt: rec.startedAt,
      language: rec.language,
      transcriptionId,
      transcript,
      captureHandle: c.captureHandle,
    };
  };

  /** A failed cloud attempt as a kept-recording failure, and what Retry does next. */
  const cloudFailure = (err: unknown, job: TranscriptionJob): TranscriptionFailedError => {
    const c = job.cloud;
    if (err instanceof CloudConnectionLostError) {
      // Only poll a job this recording owns. A connection lost before it exists (e.g. while
      // recovering another job during submit) re-enters submit, where the idempotency key
      // re-joins or re-creates this recording's job.
      if (c !== null && c.transcriptionId !== null) c.next = "poll";
      return err;
    }
    const e = toPrivateCloudError(err);
    if (c === null) return new TranscriptionFailedError(privateCloudMessage(e), { code: e.code });
    // Native names the job it created; active_transcription_exists names someone else's.
    if (e.transcriptionId !== null && e.code !== "active_transcription_exists" && c.transcriptionId === null) {
      c.transcriptionId = e.transcriptionId;
      persistPending(job);
    }
    if (NEW_CLOUD_JOB_CODES.has(e.code)) {
      c.attemptId = newAttemptId();
      c.transcriptionId = null;
      c.next = "submit";
      persistPending(job);
    } else if (c.next === "submit" && c.transcriptionId !== null) {
      c.next = "resolve";
    }
    return new TranscriptionFailedError(privateCloudMessage(e), {
      retryable: !NOT_RETRYABLE_CLOUD_CODES.has(e.code),
      code: e.code,
      correlationId: e.correlationId,
      offerOnDevice: ON_DEVICE_ALTERNATIVE_CODES.has(e.code) && job.recording.audioPath !== "",
    });
  };

  /** Stops using the cloud for this job: releases the upload handle, deletes
   *  the PTX job, and forgets it. The recording stays on disk. */
  const releaseCloud = (job: TranscriptionJob) => {
    const c = job.cloud;
    if (c === null) return;
    const pending = pendingStore.read();
    if (pending === null || pending.sessionId === job.recording.sessionId) pendingStore.clear();
    const handle = c.captureHandle;
    const id = c.transcriptionId;
    void (async () => {
      if (handle !== null) await (await cloudNative()).cancel(handle);
      if (id !== null) {
        const api = requireCloud().api;
        try {
          await api.cancel(id);
        } catch (err) {
          console.warn("Cancelling the private cloud job failed (it may already be finished)", err);
        }
        await api.remove(id);
      }
    })().catch((err) => {
      console.error("Releasing the private cloud job failed; PTX deletes it on its own schedule", err);
    });
  };

  /** Run one transcription attempt for `job`. Every failure becomes an outcome
   *  that keeps the recording for Retry or Discard. */
  const runAttempt = (job: TranscriptionJob, serverUrl: string | null): void => {
    job.running = true;
    job.attempt = (async (): Promise<TranscriptionOutcome> => {
      try {
        if (job.recording.engine === "private-cloud") return { ok: true, result: await cloudTranscribe(job) };
        const b = await bridge();
        // A retry never assumes the server from the recording is still up.
        const url = serverUrl ?? (await startWhisperServer(b, job.recording.model));
        return { ok: true, result: await transcribe(b, job.recording, url) };
      } catch (err) {
        if (job.recording.engine === "private-cloud") return { ok: false, error: cloudFailure(err, job) };
        return { ok: false, error: err instanceof TranscriptionFailedError ? err : new TranscriptionFailedError(errorMessage(err)) };
      } finally {
        job.running = false;
      }
    })();
  };

  return {
    async isModelDownloaded(m) {
      return modelDownloaded(await bridge(), m);
    },

    async ensureModel(m, onProgress) {
      const b = await bridge();
      if (await modelDownloaded(b, m)) {
        onProgress?.(100);
        return;
      }
      // download_model returns as soon as the task is spawned. Wait for its
      // terminal event, with the listener registered before the command runs.
      const done = await invokeAndWaitForEvent<DownloadProgressPayload>(
        (cb) => b.localStt.events.downloadProgressPayload.listen(cb),
        (p) => p.model === m && (p.status === "completed" || (typeof p.status === "object" && "failed" in p.status)),
        timeouts.modelDownloadMs,
        "model download",
        async () => {
          const r = await b.localStt.downloadModel(m);
          if (r.status === "error") throw new Error(`download_model: ${r.error}`);
        },
        (p) => {
          if (p.model !== m) return;
          if (typeof p.status === "object" && "downloading" in p.status) onProgress?.(p.status.downloading);
          if (p.status === "completed") onProgress?.(100);
        },
      );
      if (typeof done.status === "object" && "failed" in done.status) {
        throw new Error(`Model download failed: ${done.status.failed}`);
      }
    },

    async listMicrophoneDevices() {
      const b = await bridge();
      const r = await withTimeout(b.transcription.listMicrophoneDevices(), timeouts.queryMs, "list_microphone_devices");
      if (r.status === "error") throw new Error(`list_microphone_devices: ${r.error}`);
      return r.data;
    },

    async start(opts) {
      if (sessionId !== null || starting !== null) throw new Error("A local recording is already active");
      setAsideOtherAccountJob();
      // The local Whisper server runs one job at a time, and a kept recording
      // must be transcribed or discarded before another replaces it.
      const job = transcriptionJobs.get(nativeKey);
      if (job !== undefined) {
        throw new Error(
          job.running
            ? "A previous recording is still being transcribed; wait for it to finish"
            : "A stopped recording is waiting to be transcribed or saved; finish or discard it first",
        );
      }
      // Nor one a previous launch kept (resumeKeptRecording offers it), or whose save is still running.
      if (keptStore(account())?.read() != null) {
        throw new Error("A stopped recording is waiting to be transcribed or saved; finish or discard it first");
      }
      const engine = opts.engine ?? "on-device";
      if (engine === "private-cloud" && cloud === null) throw new Error("Private cloud transcription is not available");
      const generation = lifecycleGeneration;
      model = opts.model;
      language = opts.language;
      sessionEngine = engine;
      emit({ kind: "starting" });
      const run = (async () => {
        const b = await bridge();
        // Never start over a capture that is not confirmed stopped.
        const previous = await unconfirmedPreviousCapture(nativeKey, bridge, timeouts.queryMs);
        if (previous !== null) throw new PreviousCaptureUnconfirmedError(previous.message);
        if (generation !== lifecycleGeneration) throw new Error(VIEW_CLOSED_MESSAGE);
        await ensureListeners(b);
        if (engine === "private-cloud") {
          // Batch capture never contacts a transcription server; the recording
          // is uploaded after Stop through native's capture handle, whose
          // event must be listened for before the capture can stop.
          await listenCaptureReady(readyStore, await cloudNative(), timeouts.listenMs);
          baseUrl = "";
        } else {
          baseUrl = await startWhisperServer(b, model);
        }
        if (generation !== lifecycleGeneration) throw new Error(VIEW_CLOSED_MESSAGE);
        // Native opens (and hands a capture handle for) cloud-bound sessions only.
        const session = engine === "private-cloud" ? `${CLOUD_SESSION_PREFIX}${crypto.randomUUID()}` : crypto.randomUUID();
        sessionId = session;
        startedAt = new Date().toISOString();
        const capture = b.transcription.startCapture({
          session_id: session,
          languages: [language],
          onboarding: false,
          model: engine === "private-cloud" ? "" : model,
          base_url: baseUrl,
          api_key: "",
          keywords: [],
          mic_device: opts.micDevice ?? null,
          transcription_mode: "batch",
        });
        let r: Result<null>;
        try {
          r = await withTimeout(capture, timeouts.captureStartMs, "start_capture");
        } catch (err) {
          if (!(err instanceof LocalTimeoutError)) throw err;
          // start_capture may have started this session, or still may. No view
          // owns it as a recording: leave it as the previous recording, which
          // must be stopped and confirmed inactive before anything else starts.
          releaseSession();
          const orphan = adoptOrphan(
            nativeKey,
            bridge,
            session,
            `Starting the recording was not confirmed (${err.message}); it may be recording.`,
            capture,
          );
          let nativeState: string;
          try {
            nativeState = await readCaptureState(b, timeouts.queryMs);
          } catch (stateErr) {
            nativeState = `unknown (${errorMessage(stateErr)})`;
          }
          throw new PreviousCaptureUnconfirmedError(orphanMessage(orphan, nativeState));
        }
        if (r.status === "error") throw new Error(`start_capture: ${r.error}`);
        captureActive = true;
        // The view closed while capture was starting: its close-time teardown
        // (stopCaptureOnUnmount) stops this capture and waits for confirmation.
        if (generation !== lifecycleGeneration) throw new Error(VIEW_CLOSED_MESSAGE);
        emit({ kind: "recording" });
        return { sessionId: session };
      })();
      starting = run;
      try {
        return await run;
      } catch (err) {
        // A capture that did start stays owned until native capture confirms it stopped.
        if (!captureActive) releaseSession();
        emit({ kind: "error", message: errorMessage(err) });
        throw err;
      } finally {
        starting = null;
      }
    },

    async stop() {
      if (sessionId === null || baseUrl === null || startedAt === null) {
        throw new Error("No local recording is active");
      }
      if (stopping) throw new Error("The local recording is already stopping");
      const session = sessionId;
      const sessionStartedAt = startedAt;
      const serverUrl = baseUrl;
      const generation = lifecycleGeneration;
      stopping = true;
      try {
        emit({ kind: "stopping" });
        let stopped: CaptureStoppedEvent;
        try {
          stopped = await confirmCaptureStopped(await bridge());
        } catch (err) {
          // Without the terminal event the capture may still be live: keep the
          // session so the user can retry Stop instead of being told it stopped.
          const message = `Stopping was not confirmed: ${errorMessage(err)}. The recording may still be running.`;
          emit({ kind: "error", message });
          throw new CaptureStopUnconfirmedError(message);
        }

        // Native capture has ended; every outcome from here releases the session.
        try {
          // Capture can fail and still leave a usable audio file; only its absence loses the recording.
          const audioPath = stopped.audio_path;
          if (!audioPath) {
            throw new Error(stopped.error ? `Capture failed: ${stopped.error}` : "Recording produced no audio file");
          }
          const recording: StoppedRecording = {
            sessionId: session,
            startedAt: sessionStartedAt,
            audioPath,
            model,
            language,
            engine: sessionEngine,
          };
          const open = generation === lifecycleGeneration;
          // The job outlives this view: if it closed while capture was stopping,
          // the next view takes the job over.
          const job: TranscriptionJob = {
            recording,
            owner: open ? ownerId : null,
            report: open ? emit : null,
            account: account(),
            cloud:
              sessionEngine === "private-cloud"
                ? { captureHandle: null, handleLost: false, attemptId: newAttemptId(), transcriptionId: null, next: "submit" }
                : null,
            // A failed capture's partial recording is kept untranscribed until
            // the user chooses to transcribe or discard it.
            attempt: stopped.error
              ? Promise.resolve({
                  ok: false,
                  error: new PartialRecordingError(`Capture failed: ${stopped.error}. A partial recording was kept.`),
                })
              : NOT_ATTEMPTED,
            running: false,
          };
          keepRecording(recording, job.account);
          if (!stopped.error) {
            emit({ kind: "transcribing", progress: null });
            runAttempt(job, serverUrl);
          }
          transcriptionJobs.set(nativeKey, job);
          const result = await takeTranscription(nativeKey, job, ownerId);
          emit({ kind: "done" });
          return result;
        } finally {
          releaseSession();
        }
      } finally {
        stopping = false;
      }
    },

    async retryTranscription(opts) {
      const job = transcriptionJobs.get(nativeKey);
      if (job === undefined || job.owner !== ownerId) throw new Error("No recording is waiting to be transcribed");
      if (job.running) throw new Error("The recording is already being transcribed");
      if (opts?.onDevice) {
        // An explicit user choice, never automatic: the same audio file, now on-device.
        if (job.recording.engine !== "private-cloud" || job.recording.audioPath === "") {
          throw new Error("This recording cannot be transcribed on this Mac");
        }
        releaseCloud(job);
        job.cloud = null;
        job.recording = { ...job.recording, engine: "on-device", model: opts.onDevice.model };
        keepRecording(job.recording, job.account);
      }
      emit({ kind: "transcribing", progress: null });
      runAttempt(job, null);
      const result = await takeTranscription(nativeKey, job, ownerId);
      emit({ kind: "done" });
      return result;
    },

    discardRecording() {
      const job = transcriptionJobs.get(nativeKey);
      if (job === undefined || job.owner !== ownerId) throw new Error("No recording is waiting to be transcribed");
      if (job.running) throw new Error("The recording is being transcribed; it can be discarded if that fails");
      transcriptionJobs.delete(nativeKey);
      releaseCloud(job);
      forgetRecording(job.recording.sessionId, job.account);
      emit({ kind: "idle" });
    },

    adoptTranscription() {
      const job = transcriptionJobs.get(nativeKey);
      // Never another account's: its transcript would be saved into this account's space.
      if (job === undefined || job.owner !== null || job.account !== account()) return null;
      job.owner = ownerId;
      job.report = emit;
      if (job.running) emit({ kind: "transcribing", progress: null });
      return takeTranscription(nativeKey, job, ownerId);
    },

    previousRecording(onWaiting) {
      return unconfirmedPreviousCapture(nativeKey, bridge, timeouts.queryMs, onWaiting);
    },

    stopPreviousRecording() {
      return recoverPreviousCapture(nativeKey, bridge, timeouts);
    },

    async stopCaptureOnUnmount() {
      lifecycleGeneration++;
      // A transcription outlives its view: hand it, or the outcome it will
      // leave, to the next view (adoptTranscription).
      const job = transcriptionJobs.get(nativeKey);
      if (job?.owner === ownerId) {
        job.owner = null;
        job.report = null;
      }
      const activeListeners = listeners;
      listeners = null;
      void activeListeners?.then((unlisteners) => unlisteners.forEach((unlisten) => unlisten()), ignore);
      const pendingStart = starting;
      if (!captureActive && pendingStart === null) {
        // Capture already ended without stop() taking it (it ended on its own,
        // or a timed-out Stop's event came late): keep it, then release it.
        if (!stopping && sessionId !== null && captureStopped !== null) {
          keepOnClose(sessionId, startedAt, captureStopped);
          releaseSession();
        }
        return;
      }
      // The view is going away, but the stop still has to be confirmed. Until it
      // is, a remounted view's start() waits on it; if it is not confirmed, the
      // capture is left as the previous recording for the next view to stop.
      const closing = (async () => {
        // Bounded, like every wait in start(). A start in flight sees the new
        // generation and leaves its capture here; its own rejection goes to its caller.
        if (pendingStart !== null) await pendingStart.then(ignore, ignore);
        const session = sessionId;
        const sessionStartedAt = startedAt;
        if (!captureActive || session === null) return;
        let stopped: CaptureStoppedEvent;
        try {
          stopped = await confirmCaptureStopped(await bridge());
        } catch (err) {
          adoptOrphan(
            nativeKey,
            bridge,
            session,
            `The Local recording view closed before its recording confirmed it stopped (${errorMessage(err)}).`,
            null,
          );
          throw err;
        }
        // A stop() in flight keeps its own, with its transcription job.
        if (!stopping) keepOnClose(session, sessionStartedAt, stopped);
        releaseSession();
      })();
      closingCaptures.set(nativeKey, closing);
      const forget = () => {
        if (closingCaptures.get(nativeKey) === closing) closingCaptures.delete(nativeKey);
      };
      closing.then(forget, forget);
      await closing;
    },

    onStatus(cb) {
      statusCbs.add(cb);
      cb(status);
      return () => statusCbs.delete(cb);
    },

    async privateCloudAvailability() {
      if (cloud === null) return "hidden";
      try {
        const { configured } = await (await cloudNative()).status();
        if (!configured) return "hidden";
        if ((await cloud.api.capabilities()) === null) {
          // Dark, or this account left the cohort: a pending job cannot be
          // finished here (tenant-list recovery picks it up if it comes back).
          pendingStore.clear();
          return "hidden";
        }
        return "available";
      } catch (err) {
        console.warn("Checking private cloud transcription failed", err);
        return "failed";
      }
    },

    async anyModelDownloaded() {
      const b = await bridge();
      for (const m of LOCAL_WHISPER_MODELS) {
        if (await modelDownloaded(b, m.id)) return true;
      }
      return false;
    },

    resumeCloudTranscription() {
      if (cloud === null || transcriptionJobs.has(nativeKey)) return null;
      const pending = pendingStore.read();
      if (pending === null) return null;
      const job: TranscriptionJob = {
        recording: {
          sessionId: pending.sessionId,
          startedAt: pending.startedAt,
          audioPath: "",
          model: DEFAULT_LOCAL_MODEL,
          language: pending.language,
          engine: "private-cloud",
        },
        owner: ownerId,
        report: emit,
        account: account(),
        cloud: {
          captureHandle: null,
          handleLost: true,
          attemptId: pending.attemptId,
          transcriptionId: pending.transcriptionId,
          next: "resolve",
        },
        attempt: NOT_ATTEMPTED,
        running: false,
      };
      transcriptionJobs.set(nativeKey, job);
      emit({ kind: "transcribing", progress: null });
      runAttempt(job, null);
      return takeTranscription(nativeKey, job, ownerId).then(
        (result): LocalTranscriptResult | null => {
          emit({ kind: "done" });
          return result;
        },
        (err: unknown) => {
          // The job is gone (deleted, or expired past its transcript's 24 h):
          // nothing is left to finish, so forget it instead of failing.
          if (err instanceof TranscriptionFailedError && err.code === "transcription_not_found") {
            if (transcriptionJobs.get(nativeKey) === job) transcriptionJobs.delete(nativeKey);
            pendingStore.clear();
            emit({ kind: "idle" });
            return null;
          }
          throw err;
        },
      );
    },

    resumeKeptRecording() {
      setAsideOtherAccountJob();
      if (transcriptionJobs.has(nativeKey)) return null;
      const did = account();
      const kept = keptStore(did)?.read() ?? null;
      if (kept === null || savingTranscripts.get(nativeKey)?.has(kept.sessionId)) return null;
      const job: TranscriptionJob = {
        recording: { ...kept, engine: "on-device" },
        owner: ownerId,
        report: emit,
        account: did,
        cloud: null,
        // Never transcribed on its own: the user chooses Transcribe or Discard.
        attempt: Promise.resolve({
          ok: false,
          error: new KeptRecordingError(
            `"${localRecordingTitle(kept.startedAt)}" stopped, but its transcript was never saved. The recording was kept on this Mac.`,
          ),
        }),
        running: false,
      };
      transcriptionJobs.set(nativeKey, job);
      return takeTranscription(nativeKey, job, ownerId);
    },

    savingOnDeviceTranscript(result, saving) {
      let sessions = savingTranscripts.get(nativeKey);
      if (sessions === undefined) {
        sessions = new Map();
        savingTranscripts.set(nativeKey, sessions);
      }
      const session = result.sessionId;
      const settled = saving.then(ignore, ignore).then(() => {
        if (sessions.get(session) === settled) sessions.delete(session);
      });
      sessions.set(session, settled);
    },

    keptRecordingSave() {
      const kept = keptStore(account())?.read() ?? null;
      return kept === null ? null : (savingTranscripts.get(nativeKey)?.get(kept.sessionId) ?? null);
    },

    finishOnDeviceTranscript(result) {
      forgetRecording(result.sessionId, account());
    },

    async recoverCloudTranscripts() {
      if (cloud === null) return 0;
      const known = new Set<string>();
      const current = transcriptionJobs.get(nativeKey)?.cloud?.transcriptionId;
      if (current) known.add(current);
      const pending = pendingStore.read()?.transcriptionId;
      if (pending) known.add(pending);
      let finished = 0;
      for (const listed of await cloud.api.list()) {
        if (known.has(listed.id)) continue;
        // Only jobs this desktop app made (its channel labels); a phone's voice note is not ours.
        if (privateCloudJobClient(listed) !== "exo-desktop") continue;
        // awaiting_upload: only its own recording can upload it; it expires on its own.
        if (listed.status !== "queued" && listed.status !== "processing" && listed.status !== "completed") continue;
        try {
          if ((await recoverCloudJob(listed.id)) === "finished") finished++;
        } catch (err) {
          console.warn("Recovering a private cloud transcription failed; the next launch retries", err);
        }
      }
      return finished;
    },

    async finishCloudTranscript(result) {
      const deps = requireCloud();
      if (result.captureHandle !== null) await (await cloudNative()).cancel(result.captureHandle);
      await deps.api.remove(result.transcriptionId);
      // Only once PTX has deleted it: until then a relaunch resumes (and
      // idempotently re-saves) the job instead of recovering it as a stranger.
      const pending = pendingStore.read();
      if (pending !== null && pending.sessionId === result.sessionId) pendingStore.clear();
    },
  };
}

// ── Normalization → Meetings store ─────────────────────────────────────

function collectWords(response: BatchResponse): LocalWord[] {
  const words: LocalWord[] = [];
  for (const channel of response.results?.channels ?? []) {
    const alt = channel.alternatives?.[0];
    for (const w of alt?.words ?? []) {
      const text = (w.punctuated_word ?? w.word ?? "").trim();
      if (!text) continue;
      const start = Number.isFinite(w.start) ? w.start : null;
      const end = Number.isFinite(w.end) ? w.end : null;
      if (start === null || end === null) continue;
      words.push({ text, start, end, channel: w.channel });
    }
  }
  return words.sort((a, b) => a.start - b.start);
}

/** PTX segments (one VAD region each, per channel) as sentences, in time order. */
function cloudSentences(transcript: PrivateCloudTranscript): FirefliesSentence[] {
  return transcript.segments
    .map((seg) => ({ ...seg, text: seg.text.trim() }))
    .filter((seg) => seg.text.length > 0 && Number.isFinite(seg.start) && Number.isFinite(seg.end))
    .sort((a, b) => a.start - b.start || a.channel - b.channel)
    .map((seg, index) => ({
      index,
      speaker_name: localChannelLabel(seg.channel),
      text: seg.text,
      start_time: seg.start,
      end_time: seg.end,
    }));
}

/** The same `exo-local` meeting either engine saves; the engine is metadata. */
function normalizeCloudTranscript(r: CloudTranscriptResult): { meeting: NormalizedMeeting; sentences: FirefliesSentence[] } {
  const sentences = cloudSentences(r.transcript);
  const lastEnd = sentences.length > 0 ? Math.max(...sentences.map((s) => s.end_time)) : 0;
  const duration = r.transcript.duration_seconds ?? (lastEnd > 0 ? lastEnd : null);
  const speakerNames = [...new Set(sentences.map((s) => s.speaker_name).filter((n): n is string => n !== null))];
  return {
    meeting: {
      id: crypto.randomUUID(),
      source: LOCAL_MEETING_SOURCE,
      sourceId: `local:${r.sessionId}`,
      title: localRecordingTitle(r.startedAt),
      startedAt: r.startedAt,
      durationSecs: duration !== null ? Math.round(duration) : null,
      organizerEmail: null,
      participants: speakerNames.map((name) => ({ name, email: null })),
      summaryOverview: null,
      summaryActionItems: null,
      keywords: null,
      meetingType: null,
      metadata: {
        capture: "local",
        transcription_engine: "private-cloud",
        transcript_provider: "tinycloud-private-transcription",
        inference_provider: "tinfoil",
        model: r.transcript.model ?? null,
        language: r.transcript.language ?? r.language,
        transcript_text: sentences.map((s) => s.text).join("\n") || null,
        // Channel 0 = mic (You), 1 = system audio (Others); one sentence per
        // detected speech region, no audio path. Mic-echo removal is on-device only.
        speaker_labels: "channel-you-others",
      },
    },
    sentences,
  };
}

function localRecordingTitle(startedAt: string): string {
  return `Local recording ${new Date(startedAt).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })}`;
}

export function normalizeLocalTranscript(
  r: LocalTranscriptResult,
): { meeting: NormalizedMeeting; sentences: FirefliesSentence[] } {
  if (r.engine === "private-cloud") return normalizeCloudTranscript(r);
  const sentences = localTranscriptTurns(collectWords(r.response));

  // Fallback: a channel alternative with a transcript but no word timings still
  // saves as one sentence, rather than silently dropping speech.
  if (sentences.length === 0) {
    for (const [i, channel] of (r.response.results?.channels ?? []).entries()) {
      const text = channel.alternatives?.[0]?.transcript?.trim();
      if (!text) continue;
      sentences.push({
        index: sentences.length,
        speaker_name: localChannelLabel(i),
        text,
        start_time: 0,
        end_time: 0,
      });
    }
  }

  // Turns are ordered by start, so the last one need not end last.
  const lastEnd = sentences.reduce((end, s) => Math.max(end, s.end_time), 0);
  const transcriptText = sentences.map((s) => s.text).join("\n");
  const speakerNames = [...new Set(sentences.map((s) => s.speaker_name).filter((n): n is string => n !== null))];
  const started = r.startedAt;

  return {
    meeting: {
      id: crypto.randomUUID(),
      source: LOCAL_MEETING_SOURCE,
      sourceId: `local:${r.sessionId}`,
      title: `Local recording ${new Date(started).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })}`,
      startedAt: started,
      durationSecs: lastEnd > 0 ? Math.round(lastEnd) : null,
      organizerEmail: null,
      participants: speakerNames.map((name) => ({ name, email: null })),
      summaryOverview: null,
      summaryActionItems: null,
      keywords: null,
      meetingType: null,
      metadata: {
        capture: "local",
        transcript_provider: "whispercpp",
        model: r.model,
        language: r.language,
        transcript_text: transcriptText || null,
        // Deliberately no audio_path: the recording stays on this Mac and the
        // space must not learn a local filesystem path.
        speaker_labels: "channel-you-others",
      },
    },
    sentences,
  };
}

/** A normalized transcript with speech, ready to save (and to re-save verbatim on retry). */
export type PreparedLocalTranscript = ReturnType<typeof normalizeLocalTranscript>;

export const NO_SPEECH_MESSAGE = "No speech was transcribed — nothing was saved.";

/** Normalize once for the save and every retry of it. Throws when there is no
 *  speech, so silence never becomes an empty meeting. */
export function prepareLocalTranscript(r: LocalTranscriptResult): PreparedLocalTranscript {
  const prepared = normalizeLocalTranscript(r);
  if (prepared.sentences.length === 0) throw new Error(NO_SPEECH_MESSAGE);
  return prepared;
}

/** Write the local transcript into the user's space. upsertMeeting is keyed on
 *  (source, sourceId) and rewrites the transcript KV body, so re-running it
 *  with the same prepared value repairs a partial earlier write. */
export async function saveLocalTranscript(
  tcw: TinyCloudWeb,
  prepared: PreparedLocalTranscript,
): Promise<StoreResult<UpsertMeetingOutcome>> {
  return upsertMeeting(tcw, prepared.meeting, prepared.sentences);
}

/** How long one TinyCloud save (meeting row + transcript body) may take. */
const LOCAL_SAVE_TIMEOUT_MS = 60_000;

export type LocalTranscriptSaver = (
  prepared: PreparedLocalTranscript,
) => Promise<StoreResult<UpsertMeetingOutcome>>;

/**
 * Saves one prepared transcript at a time, each bounded by `timeoutMs`. A save
 * that timed out may still be writing, so the next one first waits (also
 * bounded) for it to settle instead of writing beside it.
 */
export function createLocalTranscriptSaver(
  tcw: TinyCloudWeb,
  options: { timeoutMs?: number; save?: typeof saveLocalTranscript } = {},
): LocalTranscriptSaver {
  const timeoutMs = options.timeoutMs ?? LOCAL_SAVE_TIMEOUT_MS;
  const save = options.save ?? saveLocalTranscript;
  /** The last save started, until it settles — even after its caller timed out. */
  let writing: Promise<unknown> | null = null;
  let busy = false;
  return async (prepared) => {
    if (busy) throw new Error("The transcript is already being saved");
    busy = true;
    try {
      if (writing !== null) {
        await withTimeout(writing.then(ignore, ignore), timeoutMs, "the previous save to finish");
      }
      const attempt = save(tcw, prepared);
      writing = attempt;
      const settled = () => {
        if (writing === attempt) writing = null;
      };
      attempt.then(settled, settled);
      return await withTimeout(attempt, timeoutMs, "TinyCloud to save the transcript");
    } finally {
      busy = false;
    }
  };
}
