// Private cloud transcription as the voice-note views see it: the recorder's
// route control and the Voice notes card. Moved from the card (TC-761, PR4).
import {
  privateCloudLimits,
  privateCloudRefusal,
  type PrivateCloudLimits,
  type PrivateCloudRefusal,
  type NoteTranscriptionState,
  type TranscriptionAvailability,
  type TranscriptionAdmissionRefusal,
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
  checkErrorCode?: string;
  consented: boolean;
  powerfulAvailable?: boolean;
  powerfulConsented?: boolean;
  onPowerfulConsent?: () => void;
  /** The longest note offered, in seconds; null when PTX advertised no maximum, so Private is not offered. */
  maxSeconds: number | null;
  /** Seconds PTX accepts past `maxSeconds` (0 when it advertises none). */
  graceSeconds?: number;
  /** PTX's byte cap, when it advertises one. */
  maxBytes?: number;
  /** Whether this deployment can identify speaker turns in Private notes. */
  diarization?: boolean;
  /** Notes being transcribed, waiting their turn, or whose last attempt failed. */
  jobs: ReadonlyMap<string, NoteTranscriptionState>;
  onTranscribe: (sourceId: string) => void;
  /** Private cloud for a note committed to another mode (Local); see `VoiceNoteTranscriber.transcribePrivately`. */
  onTranscribePrivately: (sourceId: string) => TranscriptionAdmissionRefusal | null | void;
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
  const limits = privateCloudLimits(snapshot.capabilities);
  return {
    availability: snapshot.availability,
    ...(snapshot.checkError === undefined ? {} : { checkError: snapshot.checkError }),
    ...(snapshot.checkErrorCode === undefined ? {} : { checkErrorCode: snapshot.checkErrorCode }),
    consented: snapshot.consented,
    powerfulAvailable: snapshot.powerfulAvailable,
    powerfulConsented: snapshot.powerfulConsented,
    onPowerfulConsent: () => transcriber.consentPowerful?.(),
    maxSeconds: limits?.maxSeconds ?? null,
    graceSeconds: limits?.graceSeconds ?? 0,
    ...(limits === null || limits.maxBytes === null ? {} : { maxBytes: limits.maxBytes }),
    diarization: snapshot.capabilities?.diarization === true,
    jobs: snapshot.jobs,
    onTranscribe: (sourceId) => transcriber.transcribe(sourceId),
    onTranscribePrivately: (sourceId) => transcriber.transcribePrivately(sourceId),
    onConsent: () => transcriber.consent(),
    onTurnOff: () => void transcriber.turnOff(),
    onRecheck: () => transcriber.check(),
  };
}

/** Whether private cloud takes this note by the rule `run` enforces: PTX's limits (unknown when null), then the byte cap when known. */
export function privateRefusal(
  transcription: Pick<VoiceNoteTranscriptionProps, "maxSeconds" | "graceSeconds" | "maxBytes">,
  durationSecs: number | null,
  sizeBytes: number | null = null,
): PrivateCloudRefusal | null {
  const limits: PrivateCloudLimits | null = transcription.maxSeconds === null
    ? null
    : { maxSeconds: transcription.maxSeconds, graceSeconds: transcription.graceSeconds ?? 0, maxBytes: transcription.maxBytes ?? null };
  return privateCloudRefusal(durationSecs, sizeBytes, limits);
}
