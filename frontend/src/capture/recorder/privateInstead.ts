// "Use Private instead" for a note committed to Local: private cloud has to be on offer, and the
// note short enough for it. The on-device job is stopped first so the two never both write a transcript.
import { cancelOnDeviceNote } from "@/lib/voiceNotes/onDeviceSttStore";
import type { VoiceNoteTranscriptionProps } from "./transcriptionProps";

export function privateInsteadOffered(transcription: VoiceNoteTranscriptionProps | undefined, noteId: string, durationSecs: number | null): boolean {
  if (!transcription || transcription.availability !== "available" || !transcription.consented) return false;
  if (durationSecs !== null && durationSecs > transcription.maxSeconds) return false;
  const job = transcription.jobs.get(noteId);
  return job?.kind !== "active" && job?.kind !== "done";
}

/** The reason it could not switch, or null once private cloud has the note. */
export async function switchToPrivate(transcription: VoiceNoteTranscriptionProps, noteId: string): Promise<string | null> {
  const failure = await cancelOnDeviceNote(noteId);
  if (failure !== null) return failure;
  transcription.onTranscribePrivately(noteId);
  return null;
}
