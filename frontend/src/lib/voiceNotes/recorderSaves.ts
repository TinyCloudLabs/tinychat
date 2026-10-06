// The voice-note saves, shared by every recorder view and by the app's save
// after sign-in (PendingVoiceNotesSaver). Module singletons, so there is one
// set of guards however many views mount (StrictMode mounts effects twice):
// moved here unchanged from the Voice notes card (TC-761, PR4). Never copy
// them into another module; a second set would save a recording twice.
//
// `pendingStore` is what the recorder views show about recordings still only
// on this phone: how many, whether a save of them is running, and the last
// failure. `savePendingRecordings` publishes to it when it starts and ends.

import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import {
  VoiceNotes,
  nativePlatform,
  nativeRecordingSource,
  type VoiceNoteRecording,
} from "@/lib/voiceNotes/nativeVoiceNotes";
import { bytesToBase64, VOICE_NOTE_TRANSCRIPTION_MAX_SECONDS } from "@/lib/voiceNotes/voiceNoteAudio";
import { saveVoiceNote, type VoiceNoteAudio, type VoiceNoteAudioSource } from "@/lib/voiceNotes/voiceNoteStore";

export function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) return String((error as { message: unknown }).message);
  return String(error);
}

export function errorCode(error: unknown): string | null {
  if (error && typeof error === "object" && "code" in error && typeof (error as { code: unknown }).code === "string") {
    return (error as { code: string }).code;
  }
  return null;
}

/** Recordings being uploaded right now, across mounts (StrictMode mounts effects twice). */
const savesInFlight = new Set<string>();
/**
 * Recordings this app session saved: a late "autoStopped" event or a pending retry
 * that still lists one must not save it again (its device copy may already be gone).
 */
const savedThisSession = new Set<string>();

export type SaveOutcome = { saved: true; audio: VoiceNoteAudio | null } | { saved: false; failure: string | null };

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/**
 * Upload one stopped recording, part by part from the device; the device copy is deleted
 * only after the save is confirmed. Resolves `saved` with the audio when the note is short
 * enough to transcribe and every part was read in this attempt (handed to transcription, so
 * it is not read back), or with the failure message (null when the recording is being or
 * has been saved elsewhere). The in-flight guard matters because upsertMeeting's
 * select-then-insert is not atomic: two concurrent saves of one recording would write two rows.
 */
export async function saveRecording(
  tcw: TinyCloudWeb,
  recording: VoiceNoteRecording,
  onProgress?: (storedBytes: number, totalBytes: number) => void,
): Promise<SaveOutcome> {
  if (savesInFlight.has(recording.id)) return { saved: false, failure: null };
  if (savedThisSession.has(recording.id)) {
    await VoiceNotes.deleteAudio({ id: recording.id }).catch(() => {});
    return { saved: false, failure: null };
  }
  savesInFlight.add(recording.id);
  try {
    const native = nativeRecordingSource(recording);
    const kept: Uint8Array[] = [];
    const keep = recording.durationMs <= VOICE_NOTE_TRANSCRIPTION_MAX_SECONDS * 1000;
    const source: VoiceNoteAudioSource = keep
      ? {
          ...native,
          readPart: async (offset, length) => {
            const bytes = await native.readPart(offset, length);
            kept.push(bytes);
            return bytes;
          },
        }
      : native;
    const saved = await saveVoiceNote(tcw, recording, source, nativePlatform(), { onProgress });
    if (!saved.ok) return { saved: false, failure: saved.error.message };
    savedThisSession.add(recording.id);
    await VoiceNotes.deleteAudio({ id: recording.id });
    const whole = keep && kept.reduce((n, c) => n + c.byteLength, 0) === native.size;
    return { saved: true, audio: whole ? { mimeType: recording.mimeType, base64: bytesToBase64(concatBytes(kept)) } : null };
  } catch (caught) {
    return { saved: false, failure: messageOf(caught) };
  } finally {
    savesInFlight.delete(recording.id);
  }
}

export interface PendingRun {
  total: number;
  left: VoiceNoteRecording[];
  saved: VoiceNoteRecording[];
  lastError: string | null;
}

let pendingRunInFlight: Promise<PendingRun> | null = null;

/**
 * Retry every recording still on the device, oldest first, one at a time. Single-flight: the
 * card, the chat screen's bar and the app's save after sign-in (PendingVoiceNotesSaver) share it.
 */
export function savePendingRecordings(tcw: TinyCloudWeb): Promise<PendingRun> {
  if (pendingRunInFlight) return pendingRunInFlight;
  publishPending({ running: true });
  pendingRunInFlight = (async () => {
    const { recordings } = await VoiceNotes.listPending();
    const left: VoiceNoteRecording[] = [];
    const saved: VoiceNoteRecording[] = [];
    let lastError: string | null = null;
    for (const recording of [...recordings].sort((a, b) => a.startedAt - b.startedAt)) {
      const outcome = await saveRecording(tcw, recording);
      if (outcome.saved) {
        saved.push(recording);
      } else if (outcome.failure) {
        left.push(recording);
        lastError = outcome.failure;
      }
    }
    publishPending({ count: left.length, lastError });
    return { total: recordings.length, left, saved, lastError };
  })().finally(() => {
    pendingRunInFlight = null;
    publishPending({ running: false });
  });
  return pendingRunInFlight;
}

/** Recordings still only on this phone, as the recorder views show them. */
export interface PendingSnapshot {
  count: number;
  /** A save of them is running (savePendingRecordings). */
  running: boolean;
  lastError: string | null;
}

let pendingSnapshot: PendingSnapshot = { count: 0, running: false, lastError: null };
const pendingListeners = new Set<() => void>();

function publishPending(patch: Partial<PendingSnapshot>): void {
  pendingSnapshot = { ...pendingSnapshot, ...patch };
  for (const listener of pendingListeners) listener();
}

export const pendingStore = {
  /** The same object until something changes (useSyncExternalStore). */
  snapshot(): PendingSnapshot {
    return pendingSnapshot;
  },
  subscribe(listener: () => void): () => void {
    pendingListeners.add(listener);
    return () => {
      pendingListeners.delete(listener);
    };
  },
  /** Count what is on the phone again (after a failed save, say). */
  async refresh(): Promise<void> {
    const { recordings } = await VoiceNotes.listPending();
    publishPending({ count: recordings.length });
  },
};
