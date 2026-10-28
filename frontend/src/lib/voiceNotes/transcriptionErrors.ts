import { PRIVATE_TOO_LARGE_NOTE, PRIVATE_TOO_LONG_NOTE, privateCloudCodeMessage } from "../privateCloud";
import { STORAGE_FULL_TRANSCRIPT_NOT_SAVED_LINE, STORAGE_FULL_TRANSCRIPT_NOT_SAVED_LOCAL_AUDIO_LINE } from "../storageStatus";

export const TRANSCRIPT_STORAGE_FULL_CODE = "storage_full";

export interface VoiceNoteTranscriptionFailure {
  code: string;
  message: string;
  retryable: boolean;
  /** Correlation id, shown as a reference. */
  reference: string | null;
}

const NON_RETRYABLE_CODES: Readonly<Record<string, true>> = {
  invalid_audio: true,
  no_speech: true,
  feature_unavailable: true,
  service_misconfigured: true,
  audio_size_mismatch: true,
  VOICE_NOTE_AUDIO_CORRUPT: true,
  invalid_argument: true,
  voice_note_not_found: true,
  transcription_off: true,
  [TRANSCRIPT_STORAGE_FULL_CODE]: true,
  voice_note_account_mismatch: true,
};

const TRANSCRIPTION_ERROR_COPY: Readonly<Record<string, string>> = {
  recording_too_long_for_phone: PRIVATE_TOO_LONG_NOTE,
  recording_too_long: PRIVATE_TOO_LONG_NOTE,
  recording_too_large: PRIVATE_TOO_LARGE_NOTE,
  unsupported_recording: "Private cloud transcription does not accept this recording's format.",
  invalid_audio: "This note's audio is damaged or unsupported.",
  decode_failed: "This phone could not read the recording to transcribe it.",
  decode_unavailable: "This phone could not read the recording to transcribe it.",
  no_speech: "No speech was found in this note.",
  active_transcription_exists: "Another private cloud transcription for your account hasn't finished (an unfinished upload expires within 2 hours). Try again later.",
  connection_lost: "Lost contact with private cloud transcription. The job may still be running; Retry checks on it.",
  feature_unavailable: "Private transcription is unavailable on this device. Try again.",
  service_misconfigured: "Private transcription is not configured for this account.",
  voice_note_not_found: "This voice note no longer exists.",
  transcript_save_failed: "The transcript could not be saved to your space. Retry saves it again.",
  transcript_save_timed_out: "Saving the transcript to your space took too long. Retry saves it again.",
  note_unreadable: "Could not read this note from your space just now. Retry tries again.",
  audio_read_failed: "Could not read this note's audio from this device or your space. Retry tries again.",
  audio_not_ready: "This recording is still being saved on this device. Try again when it finishes.",
  audio_size_mismatch: "The recording changed on disk after it stopped, so it was not uploaded.",
  audio_upload_pending: "This note's audio is still being saved to your space. Try again when the upload finishes.",
  VOICE_NOTE_AUDIO_CORRUPT: "This note's audio is damaged and can't be transcribed.",
  invalid_argument: "This note cannot be transcribed with the supplied audio.",
  transcription_off: "Transcription was turned off.",
  transcript_incomplete: "Private Transcription returned a transcript that may be incomplete. Try again later.",
  [TRANSCRIPT_STORAGE_FULL_CODE]: STORAGE_FULL_TRANSCRIPT_NOT_SAVED_LINE,
  held_result_persistence_failed: "The finished transcript could not be kept on this device. The Private job remains available for 24 hours; retry now.",
  private_choice_persistence_failed: "Could not save this Private choice on this device. Check storage and retry.",
  voice_note_account_mismatch: "This voice note belongs to a different account. Switch accounts and retry there.",
};

/** A persisted storage refusal remains the actionable blocker when local choice cleanup also fails. */
export function storageFullPrecedesChoiceFailure(
  outcome: string | undefined, persistedCode: string | null | undefined, localCode: string,
): boolean {
  return outcome === "failed" && persistedCode === TRANSCRIPT_STORAGE_FULL_CODE
    && localCode === "private_choice_persistence_failed";
}

export function transcriptionErrorCopy(code: string): string | undefined {
  return TRANSCRIPTION_ERROR_COPY[code];
}

/** A Private transcript that storage refused: the local-audio sentence only with positive evidence the recording is on this device. */
export function storageFullTranscriptCopy(localAudioReady: boolean): string {
  return localAudioReady ? STORAGE_FULL_TRANSCRIPT_NOT_SAVED_LOCAL_AUDIO_LINE : STORAGE_FULL_TRANSCRIPT_NOT_SAVED_LINE;
}

/** Durable failures have only a code; unmapped and unknown codes remain retryable with generic copy. */
export function voiceNoteTranscriptionFailureForCode(code: string | null | undefined): VoiceNoteTranscriptionFailure {
  const normalized = typeof code === "string" && code.trim() ? code.trim() : "transcription_error";
  return {
    code: normalized,
    message: transcriptionErrorCopy(normalized) ?? privateCloudCodeMessage(normalized) ?? "Transcription failed. Try again.",
    retryable: !Object.hasOwn(NON_RETRYABLE_CODES, normalized),
    reference: null,
  };
}
