// The default transcription choice (plan §2.7), read/written through the native capture
// defaults (`VoiceNotes.getCaptureDefaults`/`setCaptureDefaults`), which already locks signed-out
// capture to "on-device" (CaptureDefaults.options in CaptureModels.swift/.kt). Settings calls
// `setDefaultTranscriber`; the recording view's per-recording override calls
// `setRecordingTranscriber` instead, which never changes this default.
import { VoiceNotes, type TranscriberId } from "./nativeVoiceNotes";

export async function readDefaultTranscriber(): Promise<TranscriberId> {
  const defaults = await VoiceNotes.getCaptureDefaults();
  return defaults.transcriber as TranscriberId;
}

export async function setDefaultTranscriber(transcriber: TranscriberId): Promise<void> {
  const current = await VoiceNotes.getCaptureDefaults();
  await VoiceNotes.setCaptureDefaults({ ...current, transcriber });
}

/** Per-recording override for the note in progress (or about to start); never persisted as the
 * default. A rejection (e.g. no recording in progress yet) is swallowed: Settings' default still
 * applies to the next recording. */
export async function setRecordingTranscriber(transcriber: TranscriberId): Promise<void> {
  try {
    await VoiceNotes.setRecordingOptions({ transcriber });
  } catch (err) {
    console.warn("[VoiceNotes] Could not set this recording's transcriber", err);
  }
}
