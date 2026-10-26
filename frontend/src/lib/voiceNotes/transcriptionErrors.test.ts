import { describe, expect, test } from "bun:test";
import { PrivateCloudError, privateCloudCodeMessage, privateCloudMessage } from "../privateCloud";
import { storageFullTranscriptCopy, transcriptionErrorCopy, voiceNoteTranscriptionFailureForCode } from "./transcriptionErrors";

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
  test("a transcript refused by full storage is not retried automatically, and says local audio only with evidence", () => {
    expect(voiceNoteTranscriptionFailureForCode("storage_full").retryable).toBe(false);
    expect(voiceNoteTranscriptionFailureForCode("storage_full").message).toMatch(/wasn.t saved/);
    expect(storageFullTranscriptCopy(false)).not.toContain("safe on this device");
    expect(storageFullTranscriptCopy(true)).toContain("Your recording is safe on this device.");
  });
  test("keeps Private-choice Retry copy distinct from storage-full actions", () => {
    expect(voiceNoteTranscriptionFailureForCode("private_choice_persistence_failed")).toMatchObject({
      retryable: true, message: "Could not save this Private choice on this device. Check storage and retry.",
    });
    expect(voiceNoteTranscriptionFailureForCode("storage_full")).toMatchObject({
      retryable: false, message: expect.stringContaining("Your TinyCloud storage is full"),
    });
  });
});

describe("TC-2081 too-long recordings say the audio is kept", () => {
  const SENTENCE = "Your recording is saved, but it's too long for private transcription. The audio is kept, so nothing is lost.";
  test("recording_too_long_for_cloud and recording_too_long_for_phone show the new sentence with no retry wording", () => {
    for (const code of ["recording_too_long_for_cloud", "recording_too_long_for_phone"]) {
      const failure = voiceNoteTranscriptionFailureForCode(code);
      expect(failure.message, code).toBe(SENTENCE);
      expect(failure.message, code).not.toMatch(/\b(?:Retry|Retrying|try again)\b/i);
    }
  });
});
