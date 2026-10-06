// The voice-note saves, shared by the recorder and by the app's save after
// sign-in (PendingVoiceNotesSaver). Module singletons, so there is one set of
// guards however many views mount (StrictMode mounts effects twice), moved
// here from the Voice notes card (TC-761, PR4). Never copy them into another
// module; a second set would save a recording twice.
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

/**
 * What saving one recording came to. Saving to the space and removing the
 * device copy are separate steps: a note can be in the space while its copy is
 * still on the phone (`cleanupError`), and that copy is never hidden; the
 * pending count is always re-listed from the phone.
 *  - `saved`: in the space now.
 *  - `already-saved`: saved earlier in this app session; only the device copy was left.
 *  - `in-flight`: another run is saving it right now.
 *  - `failed`: not in the space; it stays on the phone.
 */
export type SaveOutcome =
  | { kind: "saved"; audio: VoiceNoteAudio | null; cleanupError: string | null }
  | { kind: "already-saved"; cleanupError: string | null }
  | { kind: "in-flight" }
  | { kind: "failed"; failure: string };

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/** Remove a saved recording's device copy; the error message when the phone kept it. */
async function removeDeviceCopy(id: string): Promise<string | null> {
  try {
    await VoiceNotes.deleteAudio({ id });
    return null;
  } catch (caught) {
    return `Saved to your space, but this phone kept its copy: ${messageOf(caught)}`;
  }
}

/**
 * Upload one stopped recording, part by part from the device; the device copy is deleted
 * only after the save is confirmed. A saved note carries its audio when it is short enough
 * to transcribe and every part was read in this attempt (handed to transcription, so it is
 * not read back). The in-flight guard matters because upsertMeeting's select-then-insert is
 * not atomic: two concurrent saves of one recording would write two rows.
 */
export async function saveRecording(
  tcw: TinyCloudWeb,
  recording: VoiceNoteRecording,
  onProgress?: (storedBytes: number, totalBytes: number) => void,
): Promise<SaveOutcome> {
  if (savesInFlight.has(recording.id)) return { kind: "in-flight" };
  // Saved earlier in this session (a late "autoStopped" event, or a copy the phone kept).
  if (savedThisSession.has(recording.id)) return { kind: "already-saved", cleanupError: await removeDeviceCopy(recording.id) };
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
    if (!saved.ok) return { kind: "failed", failure: saved.error.message };
    savedThisSession.add(recording.id);
    const cleanupError = await removeDeviceCopy(recording.id);
    const whole = keep && kept.reduce((n, c) => n + c.byteLength, 0) === native.size;
    return {
      kind: "saved",
      audio: whole ? { mimeType: recording.mimeType, base64: bytesToBase64(concatBytes(kept)) } : null,
      cleanupError,
    };
  } catch (caught) {
    return { kind: "failed", failure: messageOf(caught) };
  } finally {
    savesInFlight.delete(recording.id);
  }
}

export interface PendingRun {
  total: number;
  /** Not in the space: they stay on the phone. */
  left: VoiceNoteRecording[];
  /** Saved to the space by this run. */
  saved: VoiceNoteRecording[];
  lastError: string | null;
}

let pendingRunInFlight: Promise<PendingRun> | null = null;

/**
 * Retry every recording still on the device, oldest first, one at a time. Single-flight: the
 * recorder and the app's save after sign-in (PendingVoiceNotesSaver) share it. Afterwards the
 * phone is listed again, so the pending count is what is really still there (a saved note
 * whose copy could not be removed included).
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
      if (outcome.kind === "saved") {
        saved.push(recording);
        if (outcome.cleanupError) lastError = outcome.cleanupError;
      } else if (outcome.kind === "already-saved") {
        if (outcome.cleanupError) lastError = outcome.cleanupError;
      } else if (outcome.kind === "failed") {
        left.push(recording);
        lastError = outcome.failure;
      }
    }
    await relistPending(lastError);
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
  /** Count what is on the phone again (after a save, failed or not), with what went wrong, if anything. */
  refresh(lastError: string | null = pendingSnapshot.lastError): Promise<void> {
    return relistPending(lastError);
  },
};

/** The pending count is always what the phone lists; a listing that fails is told, never zeroed. */
async function relistPending(lastError: string | null): Promise<void> {
  try {
    const { recordings } = await VoiceNotes.listPending();
    publishPending({ count: recordings.length, lastError });
  } catch (caught) {
    publishPending({ lastError: `Could not list the notes on this phone: ${messageOf(caught)}` });
  }
}
