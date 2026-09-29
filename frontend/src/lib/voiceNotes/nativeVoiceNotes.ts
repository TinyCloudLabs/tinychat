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
  status(): Promise<{ state: MicState; reason: MicStateReason; id: string | null; elapsedMs: number }>;
  readAudio(options: { id: string }): Promise<{ id: string; mimeType: string; base64: string }>;
  deleteAudio(options: { id: string }): Promise<void>;
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
