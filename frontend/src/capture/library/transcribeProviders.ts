// Which providers a note without a transcript can be transcribed with, and what running one does. Local is the phone's
// own engine and needs the recording on this phone; Private needs private cloud on offer (the recorder's availability).
import { switchToPrivate } from "@/capture/recorder/privateInstead";
import { deviceName } from "@/lib/platform";
import type { VoiceNoteTranscriptionProps } from "@/capture/recorder/transcriptionProps";
import { captureCapabilities } from "@/lib/voiceNotes/captureEngine";
import type { TranscriberId } from "@/lib/voiceNotes/nativeVoiceNotes";
import { privateCloudAccepts } from "@/lib/voiceNotes/voiceNoteTranscription";
import { onDeviceQueuePlace } from "@/lib/voiceNotes/onDeviceQueue";
import { onDeviceSttStore, retryOnDeviceNote } from "@/lib/voiceNotes/onDeviceSttStore";

export type TranscribeProvider = "on-device" | "private-cloud";

/** What the phone holds for a note: its recording is here, the mode it was committed to, and whether native has an on-device state for it. */
export interface PhoneRecording {
  committed: TranscriberId | null;
  hasLocalState: boolean;
}

export const LOCAL_START_FAILED = `Couldn’t start transcribing on ${deviceName()}. Try again in a moment.`;

/** Whether private cloud's advertised length limit takes a note of this length. */
export function privateCloudFits(transcription: VoiceNoteTranscriptionProps, durationSecs: number | null): boolean {
  return privateCloudAccepts(durationSecs, { max_duration_seconds: transcription.maxSeconds });
}

/** Local first: it is the default. Private only for a note within the length private cloud advertises. */
export function transcribeProviders(
  noteId: string,
  transcription: VoiceNoteTranscriptionProps | undefined,
  phone: PhoneRecording | null,
  durationSecs: number | null,
): TranscribeProvider[] {
  const job = transcription?.jobs.get(noteId);
  const providers: TranscribeProvider[] = [];
  if (phone !== null && captureCapabilities().localTranscription) providers.push("on-device");
  if (transcription?.availability === "available" && privateCloudFits(transcription, durationSecs) && job?.kind !== "active" && job?.kind !== "done") providers.push("private-cloud");
  return providers;
}

/** Private asks once for consent; true when it has not been given. */
export function needsConsent(provider: TranscribeProvider, transcription: VoiceNoteTranscriptionProps | undefined): boolean {
  return provider === "private-cloud" && transcription?.consented !== true;
}

/** Starts the transcription. The reason it could not start, or null. */
export async function transcribeWith(
  provider: TranscribeProvider,
  noteId: string,
  transcription: VoiceNoteTranscriptionProps | undefined,
  phone: PhoneRecording | null,
): Promise<string | null> {
  if (provider === "on-device") return (await retryOnDeviceNote(noteId)) === null ? null : LOCAL_START_FAILED;
  if (!transcription) return "Private transcription isn’t available here.";
  // A note committed to another mode (Local, Audio only) is moved to private cloud explicitly; `transcribe` would refuse it.
  if (phone?.committed != null && phone.committed !== "private-cloud") {
    // A Local job on the phone (committed, or chosen here earlier) stops first, so the two never both transcribe it.
    const local = (phone.committed === "on-device" && phone.hasLocalState) || onDeviceQueuePlace(onDeviceSttStore.snapshot(), noteId)?.position != null;
    if (local) return switchToPrivate(transcription, noteId);
    transcription.onTranscribePrivately(noteId);
    return null;
  }
  transcription.onTranscribe(noteId);
  return null;
}
