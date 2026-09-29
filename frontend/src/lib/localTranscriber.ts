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
// 1 = system audio in the recorded stereo file — inferred, not yet confirmed by
// a two-source smoke test), so sentences are labeled "Speaker 1"/"Speaker 2"
// rather than asserting which side is the user. Flip to You/Others once the
// channel order is verified on a real capture.

import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import {
  upsertMeeting,
  type NormalizedMeeting,
  type StoreResult,
  type UpsertMeetingOutcome,
} from "./connectors/connectorStore";
import type { FirefliesSentence } from "./connectors/firefliesClient";
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

export type TranscriberKind = "meeting-bot" | "local";

/** `connector_meeting.source` for local recordings. Distinct from the bot's
 *  `tinycloud-transcriber` so Meetings and meeting chat can tell them apart;
 *  registered in EXPLORER_MEETING_SOURCES and SUPPORTED_MEETING_SOURCES. */
export const LOCAL_MEETING_SOURCE = "exo-local";

/** Human label for the explorer chip. */
export const LOCAL_MEETING_SOURCE_LABEL = "Exo Local";

export const LOCAL_KIND_STORAGE_KEY = "exo.transcriber.kind";
export const LOCAL_MODEL_STORAGE_KEY = "exo.transcriber.localModel";

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

export interface LocalTranscriptResult {
  sessionId: string;
  /** ISO timestamp captured at start(), used for the meeting's startedAt. */
  startedAt: string;
  model: WhisperModel;
  language: string;
  /** Raw whisper.cpp batch response (channels → alternatives → words). */
  response: BatchResponse;
}

export type LocalTranscriberStatus =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "recording" }
  | { kind: "stopping" }
  | { kind: "transcribing"; progress: number | null }
  | { kind: "done" }
  | { kind: "error"; message: string };

export interface LocalTranscriber {
  /** True when the model file is already on disk. */
  isModelDownloaded(model: WhisperModel): Promise<boolean>;
  /** Download the model if needed; `onProgress` receives 0–100. */
  ensureModel(model: WhisperModel, onProgress?: (pct: number) => void): Promise<void>;
  /** Mic device names for an optional picker. */
  listMicrophoneDevices(): Promise<string[]>;
  /** Start the local Whisper server (idempotent) and begin capturing mic+system audio.
   *  First waits for a closed view's capture to confirm it stopped. */
  start(opts: { model: WhisperModel; language: string; micDevice?: string }): Promise<{ sessionId: string }>;
  /** Stop capture, batch-transcribe the recording, return the raw response.
   *  Rejects with CaptureStopUnconfirmedError, keeping the session so stop()
   *  can be retried, when native capture does not confirm it stopped. Rejects
   *  with TranscriptionFailedError, keeping the stopped recording for
   *  retryTranscription(), when transcribing its audio file fails. */
  stop(): Promise<LocalTranscriptResult>;
  /** Re-transcribe the kept recording: same audio file, session, model and
   *  language, after starting the local Whisper server again. Rejects with
   *  TranscriptionFailedError, still keeping the recording, if it fails again. */
  retryTranscription(): Promise<LocalTranscriptResult>;
  /** Give up on the kept recording without transcribing it. Its audio file
   *  stays on disk. */
  discardRecording(): void;
  /** Stop an unfinished native capture when its UI is removed. Resolves only
   *  once native capture confirms it stopped; rejects otherwise. */
  stopCaptureOnUnmount(): Promise<void>;
  /** Subscribe to capture/transcription status; returns unsubscribe. */
  onStatus(cb: (s: LocalTranscriberStatus) => void): () => void;
}

/** How long to wait for a native command plus its terminal event. */
export interface LocalTranscriberTimeouts {
  captureStopMs: number;
  transcribeMs: number;
  modelDownloadMs: number;
}

const DEFAULT_TIMEOUTS: LocalTranscriberTimeouts = {
  captureStopMs: 120_000,
  transcribeMs: 30 * 60_000,
  modelDownloadMs: 30 * 60_000,
};

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
  constructor(message: string) {
    super(message);
    this.name = "TranscriptionFailedError";
  }
}

type CaptureStoppedEvent = Extract<CaptureLifecycleEvent, { type: "stopped" }>;

/** A stopped recording's audio file plus what its transcription and save need. */
interface StoppedRecording {
  sessionId: string;
  startedAt: string;
  audioPath: string;
  model: WhisperModel;
  language: string;
}

const VIEW_CLOSED_MESSAGE = "Recording stopped because the Local recording view closed";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Registers the listener, then runs the command and waits for its matching
 * terminal event. One timer covers both, so a command that never returns
 * cannot outlive the timeout.
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
  // Await registration before invoking: a native command may emit its terminal
  // event before its own promise resolves.
  const unlisten = await subscribe((e) => {
    onEvent?.(e.payload);
    if (match(e.payload)) resolveEvent(e.payload);
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
  });
  try {
    const [, payload] = await Promise.race([Promise.all([invoke(), event]), timeout]);
    return payload;
  } finally {
    clearTimeout(timer);
    unlisten();
  }
}

/** Identity of the real native listener, which is process-wide. An injected
 *  (test) bridge is its own identity. */
const NATIVE_CAPTURE = {};

/**
 * Close-time stops that may not have confirmed yet, keyed by native identity.
 * A remounted view gets a new transcriber, so this is how its start() learns
 * that the previous view's capture could still be live.
 */
const closingCaptures = new WeakMap<object, Promise<void>>();

async function awaitClosingCapture(nativeKey: object, b: LocalTranscriberBridge): Promise<void> {
  const closing = closingCaptures.get(nativeKey);
  if (closing === undefined) return;
  const confirmed = await closing.then(() => true, () => false);
  if (!confirmed) {
    // The closed view never received its terminal event; only native state can
    // say whether that capture is still running.
    const state = await b.transcription.getCaptureState();
    if (state.status === "error") throw new Error(`get_capture_state: ${state.error}`);
    if (state.data !== "inactive") {
      throw new Error(
        `A previous local recording has not confirmed it stopped (native capture is ${state.data}). Try again once it finishes.`,
      );
    }
  }
  if (closingCaptures.get(nativeKey) === closing) closingCaptures.delete(nativeKey);
}

export function createLocalTranscriber(
  injected?: LocalTranscriberBridge,
  options: { timeouts?: Partial<LocalTranscriberTimeouts> } = {},
): LocalTranscriber {
  const timeouts: LocalTranscriberTimeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
  let bridgePromise: Promise<LocalTranscriberBridge> | null = injected
    ? Promise.resolve(injected)
    : null;
  const bridge = () => (bridgePromise ??= loadBridge());
  const nativeKey: object = injected ?? NATIVE_CAPTURE;

  let sessionId: string | null = null;
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
  /** A stopped recording whose transcription failed, kept for retryTranscription(). */
  let untranscribed: StoppedRecording | null = null;
  let retrying = false;
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

  // Event listeners live for the transcriber's lifetime; each is subscribed
  // lazily so nothing touches the bridge before it's needed.
  let listeners: Promise<Unlisten[]> | null = null;
  const ensureListeners = (b: LocalTranscriberBridge): Promise<Unlisten[]> =>
    (listeners ??= Promise.all([
      b.transcription.events.captureLifecycleEvent.listen((e) => {
        if (e.payload.session_id !== sessionId) return;
        if (e.payload.type === "started") emit({ kind: "recording" });
        if (e.payload.type === "finalizing") emit({ kind: "stopping" });
        // Also records a capture that ended on its own (e.g. a failed audio
        // actor) before Stop, so stop() uses it instead of waiting on a no-op.
        if (e.payload.type === "stopped") markCaptureStopped(e.payload);
      }),
      b.transcription.events.captureStatusEvent.listen((e) => {
        if (e.payload.session_id !== sessionId) return;
        if (e.payload.type === "audio_error" && e.payload.is_fatal) {
          emit({ kind: "error", message: e.payload.error });
        }
        if (e.payload.type === "connection_error") {
          emit({ kind: "error", message: e.payload.error });
        }
      }),
      b.transcription.events.transcriptionEvent.listen((e) => {
        if (e.payload.session_id !== sessionId) return;
        if (e.payload.type === "progress" && e.payload.event.type === "progress") {
          emit({ kind: "transcribing", progress: Math.round(e.payload.event.percentage) });
        }
      }),
    ]));

  /** Ask native capture to stop, then wait for this session's `stopped` event. */
  const confirmCaptureStopped = (b: LocalTranscriberBridge): Promise<CaptureStoppedEvent> => {
    if (captureStopped !== null) return Promise.resolve(captureStopped);
    if (captureStop !== null) return captureStop;
    const session = sessionId;
    captureStop = invokeAndWaitForEvent<CaptureLifecycleEvent>(
      (cb) => b.transcription.events.captureLifecycleEvent.listen(cb),
      (p) => p.type === "stopped" && p.session_id === session,
      timeouts.captureStopMs,
      "native capture to confirm it stopped",
      async () => {
        const r = await b.transcription.stopCapture();
        if (r.status === "error") throw new Error(`stop_capture: ${r.error}`);
      },
    )
      .then((p) => {
        if (p.type !== "stopped") throw new Error("Unexpected capture lifecycle state");
        markCaptureStopped(p);
        return p;
      })
      .finally(() => {
        captureStop = null;
      });
    return captureStop;
  };

  /** Start (or reuse) the in-process Whisper server; returns its base URL. */
  const startWhisperServer = async (b: LocalTranscriberBridge, m: WhisperModel): Promise<string> => {
    const server = await b.localStt.startServer(m);
    if (server.status === "error") throw new Error(`start_server: ${server.error}`);
    return server.data;
  };

  /** Batch-transcribe a stopped recording's audio file and wait for its terminal event. */
  const transcribe = async (
    b: LocalTranscriberBridge,
    recording: StoppedRecording,
    serverUrl: string,
  ): Promise<LocalTranscriptResult> => {
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
      throw new Error(`Transcription failed (${done.code}): ${done.error}`);
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

  return {
    async isModelDownloaded(m) {
      const b = await bridge();
      const r = await b.localStt.isModelDownloaded(m);
      if (r.status === "error") throw new Error(`is_model_downloaded: ${r.error}`);
      return r.data;
    },

    async ensureModel(m, onProgress) {
      const b = await bridge();
      const downloaded = await b.localStt.isModelDownloaded(m);
      if (downloaded.status === "error") {
        throw new Error(`is_model_downloaded: ${downloaded.error}`);
      }
      if (downloaded.data) {
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
      const r = await b.transcription.listMicrophoneDevices();
      if (r.status === "error") throw new Error(`list_microphone_devices: ${r.error}`);
      return r.data;
    },

    async start(opts) {
      if (sessionId !== null || starting !== null) throw new Error("A local recording is already active");
      if (untranscribed !== null) {
        throw new Error("A stopped recording is waiting to be transcribed; retry or discard it first");
      }
      const generation = lifecycleGeneration;
      model = opts.model;
      language = opts.language;
      emit({ kind: "starting" });
      const run = (async () => {
        const b = await bridge();
        // Never start over a closed view's capture that is not yet confirmed stopped.
        await awaitClosingCapture(nativeKey, b);
        if (generation !== lifecycleGeneration) throw new Error(VIEW_CLOSED_MESSAGE);
        await ensureListeners(b);
        baseUrl = await startWhisperServer(b, model);
        const session = crypto.randomUUID();
        sessionId = session;
        startedAt = new Date().toISOString();
        const r = await b.transcription.startCapture({
          session_id: session,
          languages: [language],
          onboarding: false,
          model,
          base_url: baseUrl,
          api_key: "",
          keywords: [],
          mic_device: opts.micDevice ?? null,
          transcription_mode: "batch",
        });
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
      stopping = true;
      try {
        const b = await bridge();
        emit({ kind: "stopping" });
        let stopped: CaptureStoppedEvent;
        try {
          stopped = await confirmCaptureStopped(b);
        } catch (err) {
          // Without the terminal event the capture may still be live: keep the
          // session so the user can retry Stop instead of being told it stopped.
          const message = `Stopping was not confirmed: ${errorMessage(err)}. The recording may still be running.`;
          emit({ kind: "error", message });
          throw new CaptureStopUnconfirmedError(message);
        }

        // Native capture has ended; every outcome from here releases the session.
        try {
          if (stopped.error) throw new Error(`Capture failed: ${stopped.error}`);
          const audioPath = stopped.audio_path;
          if (!audioPath) throw new Error("Recording produced no audio file");

          const recording: StoppedRecording = {
            sessionId: session,
            startedAt: sessionStartedAt,
            audioPath,
            model,
            language,
          };
          emit({ kind: "transcribing", progress: null });
          let result: LocalTranscriptResult;
          try {
            result = await transcribe(b, recording, serverUrl);
          } catch (err) {
            // The audio file exists: keep it so transcription can be retried.
            untranscribed = recording;
            throw new TranscriptionFailedError(errorMessage(err));
          }
          emit({ kind: "done" });
          return result;
        } finally {
          releaseSession();
        }
      } finally {
        stopping = false;
      }
    },

    async retryTranscription() {
      const recording = untranscribed;
      if (recording === null) throw new Error("No recording is waiting to be transcribed");
      if (retrying) throw new Error("The recording is already being transcribed");
      retrying = true;
      try {
        emit({ kind: "transcribing", progress: null });
        let result: LocalTranscriptResult;
        try {
          const b = await bridge();
          // Never assume the server from the recording is still up.
          const serverUrl = await startWhisperServer(b, recording.model);
          result = await transcribe(b, recording, serverUrl);
        } catch (err) {
          throw new TranscriptionFailedError(errorMessage(err));
        }
        untranscribed = null;
        emit({ kind: "done" });
        return result;
      } finally {
        retrying = false;
      }
    },

    discardRecording() {
      untranscribed = null;
      emit({ kind: "idle" });
    },

    async stopCaptureOnUnmount() {
      lifecycleGeneration++;
      const activeListeners = listeners;
      listeners = null;
      void activeListeners?.then((unlisteners) => unlisteners.forEach((unlisten) => unlisten())).catch(() => {});
      const pendingStart = starting;
      if (!captureActive && pendingStart === null) return;
      // The view is going away, but the stop still has to be confirmed. Until it
      // is, a remounted view's start() waits on (or re-checks) this capture.
      const closing = (async () => {
        // A start in flight sees the new generation and leaves its capture here;
        // its own rejection is delivered to its caller.
        if (pendingStart !== null) await pendingStart.then(() => {}, () => {});
        if (!captureActive) return;
        await confirmCaptureStopped(await bridge());
        releaseSession();
      })();
      closingCaptures.set(nativeKey, closing);
      await closing;
    },

    onStatus(cb) {
      statusCbs.add(cb);
      cb(status);
      return () => statusCbs.delete(cb);
    },
  };
}

// ── Normalization → Meetings store ─────────────────────────────────────

/** Sentence-boundary split: a channel change or a pause longer than this. */
const SEGMENT_GAP_SECONDS = 1.5;

/** Conservative label: channel order (mic vs system) is unverified, so we
 *  number speakers instead of asserting "You"/"Others". */
export function localChannelLabel(channel: number | undefined): string | null {
  return channel === undefined ? null : `Speaker ${channel + 1}`;
}

interface LocalWord {
  text: string;
  start: number;
  end: number;
  channel: number | undefined;
}

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

function wordsToSentences(words: LocalWord[]): FirefliesSentence[] {
  const sentences: FirefliesSentence[] = [];
  let cur: LocalWord[] = [];
  let curChannel: number | undefined;

  const flush = () => {
    if (cur.length === 0) return;
    sentences.push({
      index: sentences.length,
      speaker_name: localChannelLabel(curChannel),
      text: cur.map((w) => w.text).join(" "),
      start_time: cur[0]!.start,
      end_time: cur[cur.length - 1]!.end,
    });
    cur = [];
  };

  for (const w of words) {
    const prev = cur[cur.length - 1];
    if (prev !== undefined && (w.channel !== curChannel || w.start - prev.end > SEGMENT_GAP_SECONDS)) {
      flush();
    }
    curChannel = w.channel;
    cur.push(w);
  }
  flush();
  return sentences;
}

export function normalizeLocalTranscript(
  r: LocalTranscriptResult,
): { meeting: NormalizedMeeting; sentences: FirefliesSentence[] } {
  const words = collectWords(r.response);
  const sentences = wordsToSentences(words);

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

  const lastEnd = sentences.length > 0 ? sentences[sentences.length - 1]!.end_time : 0;
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
        speaker_labels: "channel-numbered-unverified",
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
