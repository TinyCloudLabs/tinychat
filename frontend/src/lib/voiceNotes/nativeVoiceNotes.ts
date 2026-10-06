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
export type MicState = "idle" | "recording" | "silenced";

/**
 * Why the state is what it is; `no_signal` means live but zero input level,
 * `max_duration` (with `idle`) that the recording was stopped at its length limit.
 */
export type MicStateReason = "os_silenced" | "no_signal" | "max_duration" | null;

/**
 * The longest voice note: 60 minutes, enforced by the native recorder (which
 * stops itself there, through the same path as Stop). At the phone's 64 kbps
 * AAC that is about 29 MB, i.e. about 29 one-MiB parts in the user's space and
 * one Blob in the webview to play back. An unattended recording (6 h was
 * 188 MB) can no longer grow past that.
 */
export const VOICE_NOTE_MAX_DURATION_MS = 60 * 60 * 1000;

/** The shortest limit the recorder accepts (the shells clamp to the same range). */
export const VOICE_NOTE_MIN_DURATION_LIMIT_MS = 1000;

/**
 * localStorage key that LOWERS the limit for this device, for testing the
 * auto-stop without recording an hour (clamped to [1 s, 60 min]; it can never
 * raise the limit).
 */
export const VOICE_NOTE_MAX_DURATION_OVERRIDE_KEY = "exo.voiceNotes.maxDurationMs";

/** The limit to ask the recorder for: 60 minutes unless a test override lowers it. */
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
  at: number;
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
}

/**
 * The recorder stopped itself at its length limit. `recording` is what stop()
 * would have returned (null when nothing was captured); it is also pending
 * (listPending) until saved, so a missed event loses nothing.
 */
export interface VoiceNoteAutoStopEvent {
  reason: "max_duration";
  maxDurationMs: number;
  at: number;
  recording: VoiceNoteRecording | null;
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
  /** `maxDurationMs`: stop by itself after this long (clamped to [1 s, 60 min]; default 60 min). */
  start(options?: { maxDurationMs?: number }): Promise<{ id: string; startedAt: number; maxDurationMs?: number }>;
  stop(): Promise<VoiceNoteRecording>;
  /**
   * `maxDurationMs`: the current recording's limit (the default when idle).
   * `androidSdkInt`: Android only, the OS API level (Build.VERSION.SDK_INT).
   */
  status(): Promise<{
    state: MicState;
    reason: MicStateReason;
    id: string | null;
    elapsedMs: number;
    maxDurationMs?: number;
    androidSdkInt?: number;
  }>;
  /**
   * Up to `length` bytes of a stopped recording from `offset` (the shells cap one
   * call at 4 MiB). The audio crosses the bridge a part at a time, never whole.
   */
  readAudioChunk(options: { id: string; offset: number; length: number }): Promise<VoiceNoteAudioChunk>;
  /** Delete after a confirmed save: until then the recording stays on the device. */
  deleteAudio(options: { id: string }): Promise<void>;
  /** Stopped recordings still on the device, i.e. not yet confirmed saved. */
  listPending(): Promise<{ recordings: VoiceNoteRecording[] }>;
  addListener(event: "micState", listener: (event: MicStateEvent) => void): Promise<PluginListenerHandle>;
  addListener(event: "level", listener: (event: { level: number }) => void): Promise<PluginListenerHandle>;
  addListener(event: "autoStopped", listener: (event: VoiceNoteAutoStopEvent) => void): Promise<PluginListenerHandle>;
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
