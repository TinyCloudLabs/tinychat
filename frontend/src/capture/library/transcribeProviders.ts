// Existing transcription engines for notes without a transcript, plus explicit reruns from detail.
import { VoiceNotes } from "@/lib/voiceNotes/nativeVoiceNotes";
import { privateRefusalCopy, switchToPrivate } from "@/capture/recorder/privateInstead";
import { deviceName } from "@/lib/platform";
import type { VoiceNoteTranscriptionProps } from "@/capture/recorder/transcriptionProps";
import { captureCapabilities } from "@/lib/voiceNotes/captureEngine";
import type { TranscriberId } from "@/lib/voiceNotes/nativeVoiceNotes";
import { privateCloudAccepts } from "@/lib/voiceNotes/voiceNoteTranscription";
import { onDeviceQueuePlace } from "@/lib/voiceNotes/onDeviceQueue";
import { onDeviceSttStore, retryOnDeviceNote } from "@/lib/voiceNotes/onDeviceSttStore";

export type TranscribeProvider = "on-device" | "private-cloud" | "assemblyai";

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
/** Local first. Re-runs offer only engines this session can explicitly dispatch. */
export function transcribeProviders(
  noteId: string,
  transcription: VoiceNoteTranscriptionProps | undefined,
  phone: PhoneRecording | null,
  durationSecs: number | null,
  rerun = false,
): TranscribeProvider[] {
  const job = transcription?.jobs.get(noteId);
  const providers: TranscribeProvider[] = [];
  const canRerun = !rerun || transcription?.onTranscribeAgain !== undefined;
  const capabilities = captureCapabilities();
  if (phone !== null && (capabilities.localTranscription || capabilities.desktopWhisper) && canRerun)
    providers.push("on-device");
  if (transcription?.availability === "available" && privateCloudFits(transcription, durationSecs)
    && (rerun || (job?.kind !== "active" && job?.kind !== "done"))) providers.push("private-cloud");
  if (rerun && transcription?.powerfulAvailable && canRerun) providers.push("assemblyai");
  return providers;
}

/** Private and Powerful ask for separate one-time consent. */
export function needsConsent(provider: TranscribeProvider, transcription: VoiceNoteTranscriptionProps | undefined): boolean {
  if (provider === "private-cloud") return transcription?.consented !== true;
  return provider === "assemblyai" && transcription?.powerfulConsented !== true;
}

/** Starts the selected existing engine. The reason it could not start, or null. */
export async function transcribeWith(
  provider: TranscribeProvider,
  noteId: string,
  transcription: VoiceNoteTranscriptionProps | undefined,
  phone: PhoneRecording | null,
  rerun = false,
): Promise<string | null> {
  if (rerun) {
    if (!transcription?.onTranscribeAgain) return "Transcription isn’t available here.";
    if (provider !== "on-device" && phone !== null) {
      try {
        const { recordings } = await VoiceNotes.listPending();
        const native = recordings.find((recording) => recording.id === noteId);
        const state = native?.stt?.state;
        const queued = onDeviceQueuePlace(onDeviceSttStore.snapshot(), noteId);
        const onDeviceActive = state === "waiting_for_model" || state === "queued" || state === "running"
          || queued?.position != null;
        if (onDeviceActive) return "Wait for this phone’s transcription to stop before choosing another engine.";
      } catch {
        return "Couldn’t check whether this phone is still transcribing the note. Try again.";
      }
    }
    return await transcription.onTranscribeAgain(noteId, provider) ?? null;
  }
  if (provider === "on-device") return (await retryOnDeviceNote(noteId)) === null ? null : LOCAL_START_FAILED;
  if (provider === "assemblyai") return "Powerful transcription is available for confirmed reruns only.";
  if (!transcription) return "Private transcription isn’t available here.";
  // A Local job on the phone (committed, or chosen here earlier) stops first, so the two never both transcribe it.
  if (phone?.committed != null && phone.committed !== "private-cloud") {
    const local = (phone.committed === "on-device" && phone.hasLocalState) || onDeviceQueuePlace(onDeviceSttStore.snapshot(), noteId)?.position != null;
    if (local) return switchToPrivate(transcription, noteId);
  }
  // A user's Private tap is explicit even on web, where there is no phone recording to inspect.
  // Refusals reach the action's alert in both the direct and Local-to-Private paths.
  const refusal = transcription.onTranscribePrivately(noteId);
  return typeof refusal === "string" ? privateRefusalCopy(refusal) : null;
}

