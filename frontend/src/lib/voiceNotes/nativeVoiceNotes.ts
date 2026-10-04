// The native voice-notes plugin, implemented by the Exo mobile shell
// (mobile/android/.../voicenotes/VoiceNotesPlugin.java). On the web and in the
// desktop app the plugin does not exist, and `nativeVoiceNotesAvailable()` is
// the one gate every caller checks first.

import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";

/**
 * What the OS says about the microphone right now.
 *  - `recording`: capturing, and the OS reports it is not silencing this app.
 *  - `silenced`: still "recording", but the OS is feeding this app silence
 *    (a call or another app took the mic, the mic privacy toggle is off).
 */
export type MicState = "idle" | "recording" | "silenced";

/** Why the state is what it is; `no_signal` means live but zero input level. */
export type MicStateReason = "os_silenced" | "no_signal" | null;

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

export interface VoiceNotesPlugin {
  start(): Promise<{ id: string; startedAt: number }>;
  stop(): Promise<VoiceNoteRecording>;
  /** `androidSdkInt`: Android only, the OS API level (Build.VERSION.SDK_INT). */
  status(): Promise<{ state: MicState; reason: MicStateReason; id: string | null; elapsedMs: number; androidSdkInt?: number }>;
  readAudio(options: { id: string }): Promise<{ id: string; mimeType: string; base64: string }>;
  /** Delete after a confirmed save: until then the recording stays on the device. */
  deleteAudio(options: { id: string }): Promise<void>;
  /** Stopped recordings still on the device, i.e. not yet confirmed saved. */
  listPending(): Promise<{ recordings: VoiceNoteRecording[] }>;
  addListener(event: "micState", listener: (event: MicStateEvent) => void): Promise<PluginListenerHandle>;
  addListener(event: "level", listener: (event: { level: number }) => void): Promise<PluginListenerHandle>;
}

export const VoiceNotes = registerPlugin<VoiceNotesPlugin>("VoiceNotes");

export function nativeVoiceNotesAvailable(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable("VoiceNotes");
}

export function nativePlatform(): string {
  return Capacitor.getPlatform();
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
