// Bridges the native on-device transcript (`VoiceNotes.getTranscript`, written by the
// `TranscriptionQueue` in ExoStt/stt — see mobile/docs/stt-ios.md, stt-android.md) onto a note's
// space row, through the existing transcript write path (`saveVoiceNoteTranscript`). On-device
// transcription itself runs fully natively and works signed out and offline; this module only
// handles getting an already-produced local transcript onto the space once the note is saved
// there and the account is signed in — the same step the private-cloud path's `prepareVoiceNoteTranscript`
// does for its own source.
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { VOICE_NOTE_SPEAKER } from "./voiceNoteTranscription";
import { saveVoiceNoteTranscript, type VoiceNoteTranscriptSave } from "./voiceNoteStore";
import { VoiceNotes, type LocalTranscript } from "./nativeVoiceNotes";

function engineMetadata(transcript: LocalTranscript) {
  return {
    transcription_engine: "on-device",
    transcript_provider: transcript.engine,
    transcribed_at: transcript.createdAt,
  };
}

/** The on-device transcript as it is saved onto the note, in the same shape the private-cloud
 * path uses (`prepareVoiceNoteTranscript`/`noSpeechTranscript` in voiceNoteTranscription.ts). */
export function prepareOnDeviceTranscript(transcript: LocalTranscript): VoiceNoteTranscriptSave {
  if (transcript.outcome === "no_speech" || transcript.segments.length === 0) {
    return { sentences: [], speakers: [], metadata: { ...engineMetadata(transcript), transcript_text: null, transcription_outcome: "no_speech" } };
  }
  const sentences = transcript.segments.map((segment, index) => ({
    index,
    speaker_name: segment.speaker ?? VOICE_NOTE_SPEAKER,
    text: segment.text,
    start_time: segment.start,
    end_time: segment.end,
  }));
  return {
    sentences,
    speakers: [...new Set(sentences.map((s) => s.speaker_name))],
    metadata: {
      ...engineMetadata(transcript),
      inference_provider: null,
      model: transcript.model,
      language: transcript.language,
      transcript_text: sentences.map((s) => s.text).join("\n"),
      transcription_outcome: "transcribed",
      speaker_labels: transcript.diarized ? "diarized" : "single-speaker",
    },
  };
}

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
    const result = await saveVoiceNoteTranscript(tcw, recording.id, prepareOnDeviceTranscript(transcript));
    if (!result.ok) console.warn("[OnDeviceStt] Could not save the on-device transcript to the space", result.error);
  } catch (err) {
    console.warn("[OnDeviceStt] Could not save the on-device transcript to the space", err);
  }
}
