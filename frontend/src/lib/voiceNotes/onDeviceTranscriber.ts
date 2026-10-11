// Bridges the native on-device transcript (`VoiceNotes.getTranscript`, written by the
// `TranscriptionQueue` in ExoStt/stt — see mobile/docs/stt-ios.md, stt-android.md) onto a note's
// space row, through the existing transcript write path (`saveVoiceNoteTranscript`). On-device
// transcription itself runs fully natively and works signed out and offline; this module only
// handles getting an already-produced local transcript onto the space once the note is saved
// there and the account is signed in — the same step the private-cloud path's `prepareVoiceNoteTranscript`
// does for its own source.
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { localTranscriptToSave, saveVoiceNoteTranscript } from "./voiceNoteStore";
import { VoiceNotes, type LocalTranscript } from "./nativeVoiceNotes";

/** One note's local transcript -> space write: running, written, or why it did not land (the local transcript stays valid). */
export type OnDeviceTranscriptSyncState = { state: "syncing" } | { state: "synced" } | { state: "failed"; message: string };

const syncStates = new Map<string, OnDeviceTranscriptSyncState>();
const inFlight = new Map<string, number>();
const syncListeners = new Set<() => void>();
const syncKey = (tcw: TinyCloudWeb, id: string) => JSON.stringify([tcw.spaceId, tcw.did, id]);

/** Account-scoped; null until a sync for this note has started in this session. */
export function onDeviceTranscriptSyncState(tcw: TinyCloudWeb, id: string): OnDeviceTranscriptSyncState | null {
  return syncStates.get(syncKey(tcw, id)) ?? null;
}

export function subscribeOnDeviceTranscriptSync(listener: () => void): () => void {
  syncListeners.add(listener);
  return () => { syncListeners.delete(listener); };
}

function publish(key: string, next: OnDeviceTranscriptSyncState | null): void {
  if (JSON.stringify(syncStates.get(key) ?? null) === JSON.stringify(next)) return;
  if (next) syncStates.set(key, next);
  else syncStates.delete(key);
  for (const listener of [...syncListeners]) listener();
}

/**
 * If this note already has a local on-device transcript and a space row (`ledger.audio.state ===
 * "saved"`), write it onto that row through the existing path, publishing `syncing` then `synced`
 * or `failed` (see `onDeviceTranscriptSyncState`). A no-op, with nothing published, without either.
 * Failures are logged and published, not thrown: the local transcript stays valid, and the next
 * save or "transcribed" event tries again.
 */
export async function syncOnDeviceTranscript(
  tcw: TinyCloudWeb,
  recording: { id: string; ledger?: { audio: { state: string } } },
): Promise<void> {
  if (recording.ledger?.audio.state !== "saved") return;
  const key = syncKey(tcw, recording.id);
  let transcript: LocalTranscript | null;
  try {
    ({ transcript } = await VoiceNotes.getTranscript({ id: recording.id }));
  } catch (err) {
    console.warn("[OnDeviceStt] Could not read the local transcript", err);
    publish(key, { state: "failed", message: `Couldn't read the transcript on this phone: ${errorMessage(err)}` });
    return;
  }
  if (!transcript) return;
  inFlight.set(key, (inFlight.get(key) ?? 0) + 1);
  publish(key, { state: "syncing" });
  let outcome: OnDeviceTranscriptSyncState;
  try {
    const result = await saveVoiceNoteTranscript(tcw, recording.id, localTranscriptToSave(transcript));
    if (result.ok) outcome = { state: "synced" };
    else {
      console.warn("[OnDeviceStt] Could not save the on-device transcript to the space", result.error);
      outcome = { state: "failed", message: result.error.message };
    }
  } catch (err) {
    console.warn("[OnDeviceStt] Could not save the on-device transcript to the space", err);
    outcome = { state: "failed", message: errorMessage(err) };
  }
  const left = (inFlight.get(key) ?? 1) - 1;
  if (left > 0) inFlight.set(key, left);
  else inFlight.delete(key);
  // Another sync of this note is still writing: it publishes the result that stands.
  if (left === 0 || outcome.state === "failed") publish(key, outcome);
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));
