// Private cloud transcription as the voice-note views see it: the recorder's
// route control and the Voice notes card. Moved from the card (TC-761, PR4).
import {
  privateCloudLimits,
  privateCloudRefusal,
  type PrivateCloudRefusal,
  type NoteTranscriptionState,
  type TranscriptionAvailability,
  type PrivateStartRefusal,
  type VoiceNoteTranscriber,
  type VoiceNoteTranscriberSnapshot,
} from "@/lib/voiceNotes/voiceNoteTranscription";
import { bareMimeType, expectedTranscriptionWavBytes } from "@/lib/voiceNotes/voiceNoteAudio";


/**
 * Private cloud transcription as the card sees it. A failed check is retryable.
 */
export type VoiceNoteRerunEngine = "on-device" | "private-cloud" | "assemblyai";
export interface VoiceNoteTranscriptionProps {
  availability: TranscriptionAvailability;
  /** Why the availability check failed (`availability` "failed"). */
  checkError?: string;
  checkErrorCode?: string;
  consented: boolean;
  powerfulAvailable?: boolean;
  powerfulConsented?: boolean;
  onPowerfulConsent?: () => void;
  /** PTX's inclusive ceiling on measured duration (accepted limit, or max plus grace); null when unknown, so Private is not offered. */
  maxSeconds: number | null;
  /** PTX's byte cap, when it advertises one. */
  maxBytes?: number;
  /** Whether this deployment can identify speaker turns in Private notes. */
  diarization?: boolean;
  /** Notes being transcribed, waiting their turn, or whose last attempt failed. */
  jobs: ReadonlyMap<string, NoteTranscriptionState>;
  onTranscribe: (sourceId: string) => void;
  /** Private cloud for a note committed to another mode (Local); see `VoiceNoteTranscriber.transcribePrivately`. */
  onTranscribePrivately: (sourceId: string, durationSecs: number | null, sizeBytes?: number | null) => PrivateStartRefusal | null | void;
  /** Starts one user-confirmed rerun. */
  onTranscribeAgain?: (sourceId: string, engine: VoiceNoteRerunEngine) => Promise<string | null> | string | null;
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
    ...(limits === null || limits.maxBytes === null ? {} : { maxBytes: limits.maxBytes }),
    diarization: snapshot.capabilities?.diarization === true,
    jobs: snapshot.jobs,
    onTranscribe: (sourceId) => transcriber.transcribe(sourceId),
    onTranscribePrivately: (sourceId, durationSecs, sizeBytes) => transcriber.transcribePrivately(sourceId, durationSecs, sizeBytes),
    onTranscribeAgain: (sourceId, engine) => transcriber.transcribeAgain?.(sourceId, engine) ?? "Transcription isn’t available here.",
    onConsent: () => transcriber.consent(),
    onTurnOff: () => void transcriber.turnOff(),
    onRecheck: () => transcriber.check(),
  };
}

export interface PrivateAudioSource {
  capturePlatform: string | null;
  mimeType: string | null;
  sizeBytes?: number | null;
}

export interface BrowserWavSizeRefusal {
  kind: "browser-wav-too-large";
}

export type PrivateEligibilityRefusal = PrivateCloudRefusal | BrowserWavSizeRefusal;

export function privateAudioSourceFromMetadata(metadata: Record<string, unknown> | null): PrivateAudioSource {
  const capture = metadata?.capture;
  const platform = capture !== null && typeof capture === "object" && !Array.isArray(capture) && "platform" in capture
    ? capture.platform : null;
  const mimeType = metadata?.audio_mime_type;
  return {
    capturePlatform: typeof platform === "string" ? platform : null,
    mimeType: typeof mimeType === "string" ? mimeType : null,
    sizeBytes: typeof metadata?.audio_bytes === "number" && Number.isSafeInteger(metadata.audio_bytes) ? metadata.audio_bytes : null,
  };
}


/** Whether private cloud takes this note by the rule `run` enforces: PTX's limits (unknown when null), then the byte cap when known. */
export function privateRefusal(
  transcription: Pick<VoiceNoteTranscriptionProps, "maxSeconds" | "maxBytes">,
  durationSecs: number | null,
  sizeBytes: number | null = null,
  source?: PrivateAudioSource,
): PrivateEligibilityRefusal | null {
  const limits = typeof transcription.maxSeconds === "number" && Number.isFinite(transcription.maxSeconds) && transcription.maxSeconds > 0
    && typeof transcription.maxBytes === "number" && Number.isSafeInteger(transcription.maxBytes) && transcription.maxBytes > 0
    ? { maxSeconds: transcription.maxSeconds, maxBytes: transcription.maxBytes }
    : null;
  const refusal = privateCloudRefusal(durationSecs, sizeBytes ?? source?.sizeBytes ?? null, limits);
  if (refusal !== null) return refusal;
  if (source?.capturePlatform === "web"
    && bareMimeType(source.mimeType ?? "") === "audio/webm"
    && durationSecs !== null
    && typeof transcription.maxBytes === "number"
    && expectedTranscriptionWavBytes(durationSecs) > transcription.maxBytes) {
    return { kind: "browser-wav-too-large" };
  }
  return null;
}
