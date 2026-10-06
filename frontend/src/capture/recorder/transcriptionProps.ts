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
 * Private cloud transcription as the card sees it. `hidden` (no PTX origin in
 * this build, or the backend's 404: dark or not in the cohort) and `checking`
 * offer nothing; `failed` means the check itself failed (offline, 5xx).
 */
export interface VoiceNoteTranscriptionProps {
  availability: TranscriptionAvailability;
  consented: boolean;
  /** The longest note offered, in seconds. */
  maxSeconds: number;
  /** Notes being transcribed, waiting their turn, or whose last attempt failed. */
  jobs: ReadonlyMap<string, NoteTranscriptionState>;
  onTranscribe: (sourceId: string) => void;
  onConsent: () => void;
  onTurnOff: () => void;
  onRecheck: () => void;
}

export const HIDDEN_SNAPSHOT: VoiceNoteTranscriberSnapshot = {
  availability: "hidden",
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
    consented: snapshot.consented,
    maxSeconds: maxTranscriptionSeconds(snapshot.capabilities),
    jobs: snapshot.jobs,
    onTranscribe: (sourceId) => transcriber.transcribe(sourceId),
    onConsent: () => transcriber.consent(),
    onTurnOff: () => void transcriber.turnOff(),
    onRecheck: () => void transcriber.check(),
  };
}
