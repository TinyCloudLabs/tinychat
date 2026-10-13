export interface VoiceNoteTranscriptionFailure {
  code: string;
  message: string;
  retryable: boolean;
  /** Correlation id, shown as a reference. */
  reference: string | null;
}

const NON_RETRYABLE_CODES: ReadonlySet<string> = new Set([
  "invalid_audio",
  "no_speech",
  "feature_unavailable",
  "service_misconfigured",
  "audio_size_mismatch",
  "VOICE_NOTE_AUDIO_CORRUPT",
  "invalid_argument",
  "voice_note_not_found",
  "transcription_off",
]);

const TRANSCRIPTION_ERROR_COPY: Readonly<Record<string, string>> = {
  recording_too_long_for_phone: "Private cloud can't transcribe a recording this long or large.",
  recording_too_long: "Private cloud can't transcribe a recording this long or large.",
  recording_too_large: "Private cloud can't transcribe a recording this long or large.",
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
  note_unreadable: "Could not read this note from your space just now. Retry tries again.",
  audio_read_failed: "Could not read this note's audio from this device or your space. Retry tries again.",
  audio_not_ready: "This recording is still being saved on this device. Try again when it finishes.",
  audio_size_mismatch: "The recording changed on disk after it stopped, so it was not uploaded.",
  audio_upload_pending: "This note's audio is still being saved to your space. Try again when the upload finishes.",
  VOICE_NOTE_AUDIO_CORRUPT: "This note's audio is damaged and can't be transcribed.",
  invalid_argument: "This note cannot be transcribed with the supplied audio.",
  transcription_off: "Transcription was turned off.",
  transcript_incomplete: "Private Transcription returned a transcript that may be incomplete. Try again later.",
};

export function transcriptionErrorCopy(code: string): string | undefined {
  return TRANSCRIPTION_ERROR_COPY[code];
}

/** Durable failures have only a code; unmapped and unknown codes remain retryable with generic copy. */
export function voiceNoteTranscriptionFailureForCode(code: string | null | undefined): VoiceNoteTranscriptionFailure {
  const normalized = typeof code === "string" && code.trim() ? code.trim() : "transcription_error";
  return {
    code: normalized,
    message: transcriptionErrorCopy(normalized) ?? "Transcription failed. Try again.",
    retryable: !NON_RETRYABLE_CODES.has(normalized),
    reference: null,
  };
}
