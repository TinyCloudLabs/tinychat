import { describe, expect, test } from "bun:test";
import { PrivateCloudError, privateCloudCodeMessage, privateCloudMessage } from "../privateCloud";
import { transcriptionErrorCopy, voiceNoteTranscriptionFailureForCode } from "./transcriptionErrors";

const PTX_CODES = [
  "recording_too_long_for_cloud", "recording_too_long", "recording_too_large", "no_speech", "invalid_audio",
  "unsupported_recording", "unsupported_media_type", "diarization_unavailable", "upload_capability_limit",
  "quota_exceeded", "service_busy", "service_paused", "active_transcription_exists", "provider_unavailable",
  "provider_outcome_unknown", "processing_timeout", "processing_failed", "transcription_failed", "upload_outcome_unknown",
  "upload_interrupted", "upload_capability_expired", "upload_expired", "upload_integrity_failed", "transcript_expired",
  "file_changed", "capture_not_available", "unauthenticated", "offline", "request_timeout", "service_unavailable",
  "service_misconfigured", "transcription_not_found", "cancelled",
] as const;

describe("durable voice-note transcription failure copy", () => {
  test("uses private-cloud retry sentences for persisted PTX failures", () => {
    expect(voiceNoteTranscriptionFailureForCode("provider_unavailable").message)
      .toBe("Private cloud transcription failed while transcribing. Retrying uploads the recording again.");
    expect(voiceNoteTranscriptionFailureForCode("transcription_failed").message)
      .toBe("Private cloud transcription failed while transcribing. Retrying uploads the recording again.");
    expect(voiceNoteTranscriptionFailureForCode("upload_outcome_unknown").message)
      .toBe("The upload's result is unknown; Retry checks the job before uploading again.");
  });

  test("keeps generic unknown copy and local overrides", () => {
    expect(voiceNoteTranscriptionFailureForCode("transcription_error").message).toBe("Transcription failed. Try again.");
    expect(voiceNoteTranscriptionFailureForCode("not_a_known_code").message).toBe("Transcription failed. Try again.");
    expect(voiceNoteTranscriptionFailureForCode("recording_too_large").message)
      .toBe("Private cloud couldn't accept this recording's length or size. Try again.");
  });

  test("matches live private-cloud copy for every known PTX code, honoring voice-note overrides", () => {
    for (const code of PTX_CODES) {
      expect(privateCloudCodeMessage(code), code).toBeDefined();
      expect(voiceNoteTranscriptionFailureForCode(code).message, code)
        .toBe(transcriptionErrorCopy(code) ?? privateCloudMessage(new PrivateCloudError(code, "synthetic")));
    }
    expect(privateCloudCodeMessage("not_a_known_code")).toBeUndefined();
  });

  test("every PTX sentence that directs retry has a retryable durable failure", () => {
    for (const code of PTX_CODES) {
      const message = privateCloudCodeMessage(code) ?? "";
      if (/\b(?:Retry|Retrying|try again|retry)\b/i.test(message)) {
        expect(voiceNoteTranscriptionFailureForCode(code).retryable, code).toBe(true);
      }
    }
  });
  test("keeps misconfiguration copy non-retryable", () => {
    const failure = voiceNoteTranscriptionFailureForCode("service_misconfigured");
    expect(failure.message).toBe("Private transcription is not configured for this account.");
    expect(failure.retryable).toBe(false);
  });
});
