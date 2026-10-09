// The native voice-notes plugin, implemented by the Exo mobile shell
// (mobile/android/.../voicenotes/VoiceNotesPlugin.java, mobile/ios/App/App/VoiceNotesPlugin.swift).
// On the web and in the desktop app the plugin does not exist, and
// `nativeVoiceNotesAvailable()` is the one gate every caller checks first.

import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";

import { base64ToBytes } from "./voiceNoteAudio";

/**
 * What the OS says about the microphone right now.
 *  - `recording`: capturing, and the OS reports it is not silencing this app.
 *  - `silenced`: still "recording", but the OS is feeding this app silence
 *    (a call or another app took the mic, the mic privacy toggle is off).
 */
export type MicState = "idle" | "recording" | "silenced" | "paused" | "interrupted" | "needs_user";

/**
 * Why the state is what it is; `no_signal` means live but zero input level,
 * `max_duration` (with `idle`) that the recording was stopped at its length limit.
 */
export type MicStateReason = "os_silenced" | "no_signal" | "input_muted" | "call" | "user" | "interruption"
  | "route_change" | "media_services_reset" | "read_error" | "stalled" | "app_suspended" | "writer_stalled"
  | "resume_blocked" | "resume_not_allowed" | "mic_unavailable" | "pause_timeout"
  | "max_duration" | "disk_full" | "write_failed" | "permission_revoked" | null;

export type TranscriberId = "on-device" | "private-cloud" | "assemblyai";
export type CaptureSource = "in_app" | "quick_action" | "app_shortcut" | "intent" | "control" | "tile" | "widget" | "notification";
export interface CaptureOptions { transcriber: TranscriberId; identifySpeakers: boolean }
export interface CaptureDefaults extends CaptureOptions { accountDid: string | null; transitionGen: number }
export type AccountStatus = "signed_in" | "transitioning" | "signed_out";
export interface RemoteOpReceipt {
  id: string; did: string; opId: string; provider: "assemblyai" | "ptx"; mode: "hosted" | "own" | null;
  kind: "hosted_create" | "hosted_submit" | "own_upload" | "own_create" | "ptx_create";
  fingerprint: string; startedAt: number;
}
export interface AudioInput { id: string; name: string; kind: "built_in" | "wired" | "bluetooth" | "usb" | "car" | "other" }
export interface MissingAudioSpan {
  kind: "omitted" | "silenced";
  reason: string;
  startedAt: number;
  endedAt: number | null;
  atAudioMs: number;
  audioMs: number;
}
export interface OutboxEntry {
  entryId: string; did: string; provider: "assemblyai" | "ptx"; mode: "hosted" | "own" | null;
  kind: "transcript" | "hosted_upload" | "hosted_submit" | "ptx_job" | "own_upload_lookup" | "unknown";
  handle: string | null; handleExpiresAt: number | null;
  state: "pending" | "lookup" | "unknown" | "authority_expired" | "done";
  createdAt: number; attempts: number;
}
export type ClaimOptions =
  | { id: string; did: string; evidence: "signed_out_v2" | "user_choice" }
  | { id: string; did: string; evidence: "space_row"; rowId: string };
export interface NoteLedger {
  spaceId?: string | null;
  audio: { state: "pending" | "saved"; rowId: string | null; at: number | null };
  transcript: { state: "pending" | "running" | "retrying" | "blocked" | "needs_attention" | "cancelled" | "failed" | "done";
    outcome: "transcribed" | "no_speech" | null; reason: string | null; attempts: number; nextAttemptAt: number | null };
  transcriptSync: { state: "pending" | "saved"; rev: number; at: number | null };
  landed: { state: "none" | "pending" | "emitted"; eventId: string | null };
  remote: { provider: "assemblyai" | "ptx"; mode: "hosted" | "own" | null;
    stage: "create_unknown" | "uploading" | "uploaded" | "submit_unknown" | "submitted" | "done";
    uploadId: string | null; uploadUrl: string | null; jobId: string | null; cleanup: "none" | "pending" | "done" }[];
}
export interface NoteSttState {
  state: "waiting_for_model" | "queued" | "running" | "done" | "failed" | "cancelled";
  pack: "full" | "small" | null; engine: "parakeet" | "apple-speech" | null;
  segmentsDone: number; windowsDone: number; error: string | null;
}
export interface LocalTranscript {
  version: 1; noteId: string; transcriber: TranscriberId; rev: number;
  engine: "parakeet-tdt-0.6b-v3" | "parakeet-tdt-110m-en" | "apple-speech" | "assemblyai" | "tinycloud-private-transcription";
  model: string | null; language: string | null; outcome: "transcribed" | "no_speech"; diarized: boolean;
  segments: { start: number; end: number; text: string; speaker: string | null }[]; createdAt: string;
  provider?: Record<string, unknown>;
}

/**
 * The longest voice note: three hours of recorded time, excluding user pauses.
 * Native capture enforces the same upper bound.
 */
export const VOICE_NOTE_MAX_DURATION_MS = 3 * 60 * 60 * 1000;

/** The shortest limit the recorder accepts (the shells clamp to the same range). */
export const VOICE_NOTE_MIN_DURATION_LIMIT_MS = 1000;

/**
 * localStorage key that LOWERS the limit for this device, for testing the
 * auto-stop without recording three hours (clamped to [1 s, 3 h]; it can never
 * raise the limit).
 */
export const VOICE_NOTE_MAX_DURATION_OVERRIDE_KEY = "exo.voiceNotes.maxDurationMs";

/** The limit to ask the recorder for: three hours unless a test override lowers it. */
export function voiceNoteMaxDurationMs(storage: Pick<Storage, "getItem"> | null = safeLocalStorage()): number {
  const raw = storage?.getItem(VOICE_NOTE_MAX_DURATION_OVERRIDE_KEY);
  const requested = raw ? Number(raw) : NaN;
  if (!Number.isFinite(requested) || requested <= 0) return VOICE_NOTE_MAX_DURATION_MS;
  return Math.min(VOICE_NOTE_MAX_DURATION_MS, Math.max(VOICE_NOTE_MIN_DURATION_LIMIT_MS, Math.round(requested)));
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export interface MicStateEvent {
  state: MicState;
  reason: MicStateReason;
  detail?: string;
  input?: AudioInput | null;
  at: number;
  id?: string | null;
  audioMs?: number;
  elapsedMs?: number;
  pausedMs?: number;
  openSpan?: MissingAudioSpan | null;
}

/** iOS emits this retained alert after a successful media-services restart. */
export interface CaptureAlertEvent {
  id: string;
  reason: "media_services_reset";
  message: string;
}

export interface VoiceNoteRecording {
  id: string;
  startedAt: number;
  durationMs: number;
  mimeType: string;
  sizeBytes: number;
  /** Time the OS silenced this capture, and how many separate times. */
  silencedMs: number;
  silencedEvents: number;
  /** Time the input level stayed at zero while the OS said we were live. */
  noSignalMs: number;
  version?: 2; rev?: number; wallMs?: number; pausedMs?: number; spans?: MissingAudioSpan[];
  recovered?: boolean; endedUnexpectedly?: boolean; lastHeartbeatAt?: number | null; exitReason?: string | null;
  legacyImport?: boolean; ownerUnknown?: boolean;
  source?: CaptureSource; owner?: string | null; transitionGen?: number;
  options?: CaptureOptions; input?: AudioInput | null; sampleRate?: number; bitrate?: number;
  ledger?: NoteLedger; stt?: NoteSttState;
}

export interface CaptureStatus {
  state: MicState; reason: MicStateReason; id: string | null;
  detail?: string;
  intent: "recording" | "paused" | "stopped"; availability: "available" | "interrupted" | "blocked";
  startedAt: number | null; elapsedMs: number; audioMs: number; pausedMs: number; maxDurationMs: number;
  spans: MissingAudioSpan[]; openSpan: MissingAudioSpan | null;
  source?: CaptureSource; options?: CaptureOptions; input?: AudioInput | null; owner?: string | null;
  activeId?: string | null;
  transitionGen: number; androidSdkInt?: number;
  /** Android shortcut recovery, queried without consuming a retained event. */
  micDeniedPresentation?: boolean;
  shortcutRecordPending?: boolean;
  microphonePermissionGranted?: boolean;
}

/**
 * The recorder stopped itself at its length limit. `recording` is what stop()
 * would have returned (null when nothing was captured); it is also pending
 * (listPending) until saved, so a missed event loses nothing.
 */
export interface VoiceNoteAutoStopEvent {
  reason: "max_duration" | "disk_full" | "write_failed" | "permission_revoked";
  maxDurationMs: number;
  at: number;
  recording: VoiceNoteRecording | null;
  /** Native finalization error code when recording is null. */
  error?: string | null;
}

/** One slice of a recording on the device. */
export interface VoiceNoteAudioChunk {
  id: string;
  offset: number;
  base64: string;
  bytesRead: number;
  /** The whole file's size. */
  size: number;
  eof: boolean;
}

export interface VoiceNotesPlugin {
  /** `maxDurationMs`: stop by itself after this much recorded time (clamped to [1 s, 3 h]). */
  start(options?: { maxDurationMs?: number } & Partial<CaptureOptions>): Promise<{ id: string; startedAt: number; maxDurationMs?: number }>;
  stop(): Promise<VoiceNoteRecording>;
  /**
   * `maxDurationMs`: the current recording's limit (the default when idle).
   * `androidSdkInt`: Android only, the OS API level (Build.VERSION.SDK_INT).
   */
  status(): Promise<CaptureStatus>;
  dismissShortcutRecovery(): Promise<void>;
  consumeShortcutRecord(): Promise<void>;
  /**
   * Up to `length` bytes of a stopped recording from `offset` (the shells cap one
   * call at 4 MiB). The audio crosses the bridge a part at a time, never whole.
   */
  readAudioChunk(options: { id: string; offset: number; length: number }): Promise<VoiceNoteAudioChunk>;
  /** Delete after a confirmed save: until then the recording stays on the device. */
  deleteAudio(options: { id: string }): Promise<void>;
  /** Stopped recordings still on the device, i.e. not yet confirmed saved. */
  listPending(): Promise<{ recordings: VoiceNoteRecording[] }>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  discard(): Promise<{ id: string | null }>;
  setRecordingOptions(options: Partial<CaptureOptions>): Promise<void>;
  getCaptureDefaults(): Promise<CaptureDefaults & { status: AccountStatus }>;
  setCaptureDefaults(options: CaptureDefaults): Promise<{ claimed: string[] }>;
  setAccountState(options: { status: AccountStatus; accountDid: string | null; transitionGen: number }): Promise<void>;
  beginRemoteOp(receipt: RemoteOpReceipt): Promise<void>;
  recordRemoteResult(options: { id: string; did: string; opId: string; result: {
    handle?: string; uploadId?: string; uploadUrl?: string; jobId?: string; handleExpiresAt?: number;
    outcome: "created" | "failed" | "unknown";
  } }): Promise<{ destination: "ledger" | "outbox" }>;
  claim(options: ClaimOptions): Promise<{ owner: string | null }>;
  updateLedger(options: { id: string; did: string; rev: number; patch: Partial<NoteLedger> }): Promise<{ rev: number }>;
  localAudioUrl(options: { id: string }): Promise<{ url: string }>;
  putTranscript(options: { id: string; transcript: LocalTranscript }): Promise<void>;
  getTranscript(options: { id: string }): Promise<{ transcript: LocalTranscript | null }>;
  listInputs(): Promise<{ inputs: AudioInput[]; selectedId: string | null; activeId: string | null }>;
  selectInput(options: { id: string | null }): Promise<void>;
  listQuarantine(): Promise<{ items: { id: string; reason: string; sizeBytes: number }[] }>;
  deleteQuarantined(options: { id: string }): Promise<void>;
  listOutbox(options: { did: string }): Promise<{ entries: OutboxEntry[] }>;
  completeOutbox(options: { entryId: string; result: "done" | "retry" | "lookup" | "unknown" | "authority_expired" }): Promise<void>;
  addListener(event: "micState", listener: (event: MicStateEvent) => void): Promise<PluginListenerHandle>;
  addListener(event: "captureAlert", listener: (event: CaptureAlertEvent) => void): Promise<PluginListenerHandle>;
  openSettings(): Promise<void>;
  addListener(event: "level", listener: (event: { level: number; peak?: number }) => void): Promise<PluginListenerHandle>;
  addListener(event: "autoStopped", listener: (event: VoiceNoteAutoStopEvent) => void): Promise<PluginListenerHandle>;
  addListener(event: "presentRecorder", listener: (event: { id: string | null; reason?: "permission_denied" | "permission_granted" | string }) => void): Promise<PluginListenerHandle>;
  addListener(event: "recovered" | "committed", listener: (event: { id: string }) => void): Promise<PluginListenerHandle>;
  addListener(event: "inputs", listener: (event: { inputs: AudioInput[]; selectedId: string | null; activeId: string | null }) => void): Promise<PluginListenerHandle>;
}

// `let`, so the browser harnesses can swap in a fake (below): every caller
// imports this binding, and an ES module binding is live.
export let VoiceNotes = registerPlugin<VoiceNotesPlugin>("VoiceNotes");

let availableForTests: boolean | null = null;

export function nativeVoiceNotesAvailable(): boolean {
  if (availableForTests !== null) return availableForTests;
  return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable("VoiceNotes");
}

/**
 * Harnesses and tests only: every caller of `VoiceNotes` now talks to `plugin`,
 * and `nativeVoiceNotesAvailable()` answers `available` (null: ask Capacitor
 * again, to undo a swap). No call site changes.
 */
export function __setVoiceNotesForTests(plugin: VoiceNotesPlugin, options: { available: boolean | null }): void {
  VoiceNotes = plugin;
  availableForTests = options.available;
}

export function nativePlatform(): string {
  return Capacitor.getPlatform();
}

/**
 * A stopped recording on the device, read one slice at a time through
 * readAudioChunk. Every read must return exactly the bytes asked for: a short
 * read (the file changed or vanished) rejects, so a note is never stored
 * truncated.
 */
export function nativeRecordingSource(
  recording: Pick<VoiceNoteRecording, "id" | "mimeType" | "sizeBytes">,
  plugin: Pick<VoiceNotesPlugin, "readAudioChunk"> = VoiceNotes,
): { mimeType: string; size: number; readPart(offset: number, length: number): Promise<Uint8Array> } {
  return {
    mimeType: recording.mimeType,
    size: recording.sizeBytes,
    async readPart(offset, length) {
      const chunk = await plugin.readAudioChunk({ id: recording.id, offset, length });
      const bytes = base64ToBytes(chunk.base64);
      if (bytes.byteLength !== length || chunk.size !== recording.sizeBytes) {
        throw new Error(
          `The recording on this phone changed while it was being saved (read ${bytes.byteLength} of ${length} bytes at ${offset}; file ${chunk.size} bytes, expected ${recording.sizeBytes}).`,
        );
      }
      return bytes;
    },
  };
}

/**
 * Android 8.0 (API 26). Below it, Capacitor's native HTTP writes an empty body
 * for a `dataType: "file"` request (CapacitorHttpUrlConnection uses
 * java.util.Base64, which API 24-25 lack), so a voice note cannot be uploaded.
 */
export const MIN_ANDROID_SDK_FOR_FILE_UPLOAD = 26;

/**
 * Whether this device's native HTTP can send a voice note's bytes. iOS can.
 * Android asks the plugin for its API level; a shell too old to say is
 * treated as unable (fail closed).
 */
export async function nativeHttpFileUploadSupported(
  platform: string = Capacitor.getPlatform(),
  status: () => Promise<{ androidSdkInt?: number }> = () => VoiceNotes.status(),
): Promise<boolean> {
  if (platform === "ios") return true;
  if (platform !== "android") return false;
  try {
    const { androidSdkInt } = await status();
    return typeof androidSdkInt === "number" && androidSdkInt >= MIN_ANDROID_SDK_FOR_FILE_UPLOAD;
  } catch {
    return false;
  }
}

export type AudioInputsSnapshot = {
  inputs: AudioInput[];
  selectedId: string | null;
  activeId: string | null;
};

const inputSubscribers = new Map<
  (snapshot: AudioInputsSnapshot) => void,
  ((caught: unknown) => void) | undefined
>();
let nativeInputsHandle: PluginListenerHandle | null = null;
let nativeInputsQueue: Promise<void> = Promise.resolve();

const fanOutInputs = (snapshot: AudioInputsSnapshot) => {
  for (const subscriber of [...inputSubscribers.keys()]) subscriber(snapshot);
};

/** Brings the one native listener in line with whether anyone is subscribed. */
async function reconcileNativeInputs(): Promise<void> {
  if (inputSubscribers.size > 0 && !nativeInputsHandle) {
    nativeInputsHandle = await VoiceNotes.addListener("inputs", fanOutInputs);
  } else if (inputSubscribers.size === 0 && nativeInputsHandle) {
    await nativeInputsHandle.remove();
    nativeInputsHandle = null;
  }
}

/**
 * Add and remove run one at a time, so a resubscribe straight after the last
 * unsubscribe (React StrictMode does it) waits for the removal and never
 * leaves two native listeners. A failure is logged and goes to every current
 * subscriber's `onError`; the state is left as the plugin left it, and the next
 * change retries.
 */
function syncNativeInputs(): void {
  nativeInputsQueue = nativeInputsQueue
    .then(reconcileNativeInputs)
    .catch((caught: unknown) => {
      console.error(
        "[VoiceNotes] Could not update the audio input listener",
        caught,
      );
      for (const onError of [...inputSubscribers.values()]) onError?.(caught);
    });
}

/**
 * Subscribe to input-list changes. Capacitor delivers a retained event to the
 * first native listener only, so this keeps one native listener for all
 * subscribers: attached with the first, removed with the last.
 */
export function onInputsChanged(
  listener: (snapshot: AudioInputsSnapshot) => void,
  onError?: (caught: unknown) => void,
): () => void {
  inputSubscribers.set(listener, onError);
  syncNativeInputs();
  return () => {
    inputSubscribers.delete(listener);
    syncNativeInputs();
  };
}

export function listInputs(): Promise<AudioInputsSnapshot> {
  return VoiceNotes.listInputs();
}

export function selectInput(id: string | null): Promise<void> {
  return VoiceNotes.selectInput({ id });
}
