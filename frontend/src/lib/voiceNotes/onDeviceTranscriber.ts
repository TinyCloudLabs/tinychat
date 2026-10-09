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

/**
 * If this note already has a local on-device transcript and a space row (`ledger.audio.state ===
 * "saved"`), write it onto that row through the existing path. A no-op without either. Errors are
 * swallowed (logged): the local transcript stays valid, and the next save or "transcribed" event
 * tries again.
 */
export async function syncOnDeviceTranscript(
  tcw: TinyCloudWeb,
  recording: { id: string; ledger?: { audio: { state: string } } },
): Promise<void> {
  if (recording.ledger?.audio.state !== "saved") return;
  let transcript: LocalTranscript | null;
  try {
    ({ transcript } = await VoiceNotes.getTranscript({ id: recording.id }));
  } catch (err) {
    console.warn("[OnDeviceStt] Could not read the local transcript", err);
    return;
  }
  if (!transcript) return;
  try {
    const result = await saveVoiceNoteTranscript(tcw, recording.id, localTranscriptToSave(transcript));
    if (!result.ok) console.warn("[OnDeviceStt] Could not save the on-device transcript to the space", result.error);
  } catch (err) {
    console.warn("[OnDeviceStt] Could not save the on-device transcript to the space", err);
  }
}
