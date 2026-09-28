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

/** Quantized whisper.cpp models exposed at the pinned rev. */
export const LOCAL_WHISPER_MODELS: readonly LocalWhisperModel[] = [
  { id: "QuantizedTinyEn", label: "Whisper Tiny (English)", englishOnly: true, approxSizeMb: 32 },
  { id: "QuantizedTiny", label: "Whisper Tiny (multilingual)", englishOnly: false, approxSizeMb: 32 },
  { id: "QuantizedBaseEn", label: "Whisper Base (English)", englishOnly: true, approxSizeMb: 58 },
  { id: "QuantizedBase", label: "Whisper Base (multilingual)", englishOnly: false, approxSizeMb: 58 },
  { id: "QuantizedSmallEn", label: "Whisper Small (English)", englishOnly: true, approxSizeMb: 182 },
  { id: "QuantizedSmall", label: "Whisper Small (multilingual)", englishOnly: false, approxSizeMb: 182 },
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
  /** Start the local Whisper server (idempotent) and begin capturing mic+system audio. */
  start(opts: { model: WhisperModel; language: string; micDevice?: string }): Promise<{ sessionId: string }>;
  /** Stop capture, batch-transcribe the recording, return the raw response. */
  stop(): Promise<LocalTranscriptResult>;
  /** Subscribe to capture/transcription status; returns unsubscribe. */
  onStatus(cb: (s: LocalTranscriberStatus) => void): () => void;
}


const CAPTURE_STOP_TIMEOUT_MS = 120_000;
const TRANSCRIBE_TIMEOUT_MS = 30 * 60_000;
const MODEL_DOWNLOAD_TIMEOUT_MS = 30 * 60_000;

function waitForEvent<T>(
  subscribe: (cb: (e: { payload: T }) => void) => Promise<Unlisten>,
  match: (payload: T) => boolean,
  timeoutMs: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let unlisten: Unlisten | null = null;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unlisten?.();
      fn();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error(`Timed out waiting for ${label}`))),
      timeoutMs,
    );
    void subscribe((e) => {
      if (match(e.payload)) finish(() => resolve(e.payload));
    }).then(
      (un) => {
        unlisten = un;
        if (settled) un();
      },
      (err) =>
        finish(() => reject(err instanceof Error ? err : new Error(String(err)))),
    );
  });
}

export function createLocalTranscriber(injected?: LocalTranscriberBridge): LocalTranscriber {
  let bridgePromise: Promise<LocalTranscriberBridge> | null = injected
    ? Promise.resolve(injected)
    : null;
  const bridge = () => (bridgePromise ??= loadBridge());

  let sessionId: string | null = null;
  let model: WhisperModel = DEFAULT_LOCAL_MODEL;
  let language = "en";
  let baseUrl: string | null = null;
  let startedAt: string | null = null;
  const statusCbs = new Set<(s: LocalTranscriberStatus) => void>();
  let status: LocalTranscriberStatus = { kind: "idle" };

  const emit = (s: LocalTranscriberStatus) => {
    status = s;
    for (const cb of statusCbs) cb(s);
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
      // download_model returns as soon as the task is SPAWNED; completion is
      // the "completed"/{failed} status on downloadProgressPayload. Subscribe
      // first so a small model can't finish before the listener attaches.
      const finished = waitForEvent<DownloadProgressPayload>(
        (cb) => b.localStt.events.downloadProgressPayload.listen(cb),
        (p) => p.model === m && (p.status === "completed" || (typeof p.status === "object" && "failed" in p.status)),
        MODEL_DOWNLOAD_TIMEOUT_MS,
        "model download",
      );
      const onProgressUn = await b.localStt.events.downloadProgressPayload.listen((e) => {
        if (e.payload.model !== m) return;
        const s = e.payload.status;
        if (typeof s === "object" && "downloading" in s) onProgress?.(s.downloading);
        if (s === "completed") onProgress?.(100);
      });
      try {
        const r = await b.localStt.downloadModel(m);
        if (r.status === "error") throw new Error(`download_model: ${r.error}`);
        const done = await finished;
        if (typeof done.status === "object" && "failed" in done.status) {
          throw new Error(`Model download failed: ${done.status.failed}`);
        }
      } finally {
        onProgressUn();
      }
    },

    async listMicrophoneDevices() {
      const b = await bridge();
      const r = await b.transcription.listMicrophoneDevices();
      if (r.status === "error") throw new Error(`list_microphone_devices: ${r.error}`);
      return r.data;
    },

    async start(opts) {
      if (sessionId !== null) throw new Error("A local recording is already active");
      model = opts.model;
      language = opts.language;
      emit({ kind: "starting" });
      try {
        const b = await bridge();
        await ensureListeners(b);
        const server = await b.localStt.startServer(model);
        if (server.status === "error") throw new Error(`start_server: ${server.error}`);
        baseUrl = server.data;
        sessionId = crypto.randomUUID();
        startedAt = new Date().toISOString();
        const r = await b.transcription.startCapture({
          session_id: sessionId,
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
        emit({ kind: "recording" });
        return { sessionId };
      } catch (err) {
        sessionId = null;
        emit({ kind: "error", message: err instanceof Error ? err.message : String(err) });
        throw err;
      }
    },

    async stop() {
      if (sessionId === null || baseUrl === null || startedAt === null) {
        throw new Error("No local recording is active");
      }
      const b = await bridge();
      emit({ kind: "stopping" });
      // Any failure releases the session so the user can start a fresh recording.
      try {
        // Subscribe before invoking so a fast Stopped event can't race past us.
        const stoppedPromise = waitForEvent<CaptureLifecycleEvent>(
          (cb) => b.transcription.events.captureLifecycleEvent.listen(cb),
          (p) => p.type === "stopped" && p.session_id === sessionId,
          CAPTURE_STOP_TIMEOUT_MS,
          "capture to finish writing",
        );
        const stopRes = await b.transcription.stopCapture();
        if (stopRes.status === "error") throw new Error(`stop_capture: ${stopRes.error}`);
        const stopped = await stoppedPromise;
        if (stopped.type !== "stopped") throw new Error("Unexpected capture lifecycle state");
        if (stopped.error) throw new Error(`Capture failed: ${stopped.error}`);
        const audioPath = stopped.audio_path;
        if (!audioPath) throw new Error("Recording produced no audio file");

        const donePromise = waitForEvent<TranscriptionEvent>(
          (cb) => b.transcription.events.transcriptionEvent.listen(cb),
          (p) =>
            p.session_id === sessionId && (p.type === "completed" || p.type === "failed"),
          TRANSCRIBE_TIMEOUT_MS,
          "on-device transcription",
        );
        emit({ kind: "transcribing", progress: null });
        const txRes = await b.transcription.startTranscription({
          session_id: sessionId,
          provider: "whispercpp",
          file_path: audioPath,
          model,
          base_url: baseUrl,
          api_key: "",
          languages: [language],
          keywords: [],
        });
        if (txRes.status === "error") throw new Error(`start_transcription: ${txRes.error}`);
        const done = await donePromise;
        if (done.type === "failed") {
          throw new Error(`Transcription failed (${done.code}): ${done.error}`);
        }
        if (done.type !== "completed") {
          throw new Error(`Transcription ended unexpectedly (${done.type})`);
        }

        const result: LocalTranscriptResult = {
          sessionId,
          startedAt,
          model,
          language,
          response: done.response,
        };
        emit({ kind: "done" });
        return result;
      } finally {
        sessionId = null;
        startedAt = null;
      }
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

/** Write the local transcript into the user's space. Idempotent by (source, sourceId). */
export async function saveLocalTranscript(
  tcw: TinyCloudWeb,
  r: LocalTranscriptResult,
): Promise<StoreResult<UpsertMeetingOutcome>> {
  const { meeting, sentences } = normalizeLocalTranscript(r);
  return upsertMeeting(tcw, meeting, sentences);
}
