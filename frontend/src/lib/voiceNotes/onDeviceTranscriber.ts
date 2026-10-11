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
/** The newest attempt per note that owns its state; an older attempt finishing later publishes nothing. */
const owner = new Map<string, number>();
let attempts = 0;
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
 * save or "transcribed" event tries again. Syncs of one note can overlap (save recovery and the
 * native `transcribed` event); the newest attempt owns the published state, so an older one
 * finishing late never overwrites it.
 */
export async function syncOnDeviceTranscript(
  tcw: TinyCloudWeb,
  recording: { id: string; ledger?: { audio: { state: string } } },
): Promise<void> {
  if (recording.ledger?.audio.state !== "saved") return;
  const key = syncKey(tcw, recording.id);
  const claim = () => {
    const attempt = ++attempts;
    owner.set(key, attempt);
    return attempt;
  };
  const publishIfOwner = (attempt: number, next: OnDeviceTranscriptSyncState) => {
    if (owner.get(key) === attempt) publish(key, next);
  };
  let transcript: LocalTranscript | null;
  try {
    ({ transcript } = await VoiceNotes.getTranscript({ id: recording.id }));
  } catch (err) {
    console.warn("[OnDeviceStt] Could not read the local transcript", err);
    publishIfOwner(claim(), { state: "failed", message: `Couldn't read the transcript on this phone: ${errorMessage(err)}` });
    return;
  }
  if (!transcript) return;
  const attempt = claim();
  publish(key, { state: "syncing" });
  try {
    const result = await saveVoiceNoteTranscript(tcw, recording.id, localTranscriptToSave(transcript));
    if (result.ok) publishIfOwner(attempt, { state: "synced" });
    else {
      console.warn("[OnDeviceStt] Could not save the on-device transcript to the space", result.error);
      publishIfOwner(attempt, { state: "failed", message: result.error.message });
    }
  } catch (err) {
    console.warn("[OnDeviceStt] Could not save the on-device transcript to the space", err);
    publishIfOwner(attempt, { state: "failed", message: errorMessage(err) });
  }
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));
