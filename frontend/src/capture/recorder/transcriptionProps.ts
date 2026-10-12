// Private cloud transcription as the voice-note views see it: the recorder's
// route control and the Voice notes card. Moved from the card (TC-761, PR4).
import {
  maxTranscriptionSeconds,
  type NoteTranscriptionState,
  type TranscriptionAvailability,
  type VoiceNoteTranscriber,
  type VoiceNoteTranscriberSnapshot,
} from "@/lib/voiceNotes/voiceNoteTranscription";

/**
 * Private cloud transcription as the card sees it. A failed check is retryable.
 */
export interface VoiceNoteTranscriptionProps {
  availability: TranscriptionAvailability;
  /** Why the availability check failed (`availability` "failed"). */
  checkError?: string;
  consented: boolean;
  /** The longest note offered, in seconds. */
  maxSeconds: number;
  /** Whether this deployment can identify speaker turns in Private notes. */
  diarization?: boolean;
  /** Notes being transcribed, waiting their turn, or whose last attempt failed. */
  jobs: ReadonlyMap<string, NoteTranscriptionState>;
  onTranscribe: (sourceId: string) => void;
  /** Private cloud for a note committed to another mode (Local); see `VoiceNoteTranscriber.transcribePrivately`. */
  onTranscribePrivately: (sourceId: string) => void;
  onConsent: () => void;
  onTurnOff: () => void;
  /** Asks again; resolves once the check has answered. */
  onRecheck: () => void | Promise<void>;
}

export const HIDDEN_SNAPSHOT: VoiceNoteTranscriberSnapshot = {
  availability: "failed",
  capabilities: null,
  consented: false,
  jobs: new Map(),
};
export const noSubscription = () => () => {};

/** The card's view of private cloud transcription; `undefined` when this build or account has none. */
export function transcriptionProps(
  transcriber: VoiceNoteTranscriber | null,
  snapshot: VoiceNoteTranscriberSnapshot,
): VoiceNoteTranscriptionProps | undefined {
  if (transcriber === null) return undefined;
  return {
    availability: snapshot.availability,
    ...(snapshot.checkError === undefined ? {} : { checkError: snapshot.checkError }),
    consented: snapshot.consented,
    maxSeconds: maxTranscriptionSeconds(snapshot.capabilities),
    diarization: snapshot.capabilities?.diarization === true,
    jobs: snapshot.jobs,
    onTranscribe: (sourceId) => transcriber.transcribe(sourceId),
    onTranscribePrivately: (sourceId) => transcriber.transcribePrivately(sourceId),
    onConsent: () => transcriber.consent(),
    onTurnOff: () => void transcriber.turnOff(),
    onRecheck: () => transcriber.check(),
  };
}
