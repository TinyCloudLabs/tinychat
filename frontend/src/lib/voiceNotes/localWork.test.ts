import { expect, test } from "bun:test";
import type { VoiceNoteRecording } from "./nativeVoiceNotes";
import { hasLocalWorkInProgress } from "./localWork";

// A saved note whose local work finished. Phone producers leave `transcript.state` at "pending" (onDeviceTranscriber.ts:282-284
// writes only transcriptSync and outcome), so "pending" is the finished state here.
const finishedLedger = { localAudio: { state: "ready" }, transcript: { state: "pending" }, remote: [] };

function note(ledger: object, extra: object = {}): VoiceNoteRecording {
  return { id: "n", options: { transcriber: "assemblyai" }, ledger: { ...finishedLedger, ...ledger }, ...extra } as unknown as VoiceNoteRecording;
}

const onDevice = { options: { transcriber: "on-device" } };

const pinned: Array<[string, object, object]> = [
  ["a preparing import", { localAudio: { state: "preparing" } }, {}],
  ["a failed import", { localAudio: { state: "failed" } }, {}],
  ["an on-device Whisper job waiting for its model", {}, { ...onDevice, stt: { state: "waiting_for_model" } }],
  ["a queued on-device Whisper job", {}, { ...onDevice, stt: { state: "queued" } }],
  ["a running on-device Whisper job", {}, { ...onDevice, stt: { state: "running" } }],
  ["a failed on-device Whisper job", {}, { ...onDevice, stt: { state: "failed" } }],
  ["an unsubmitted hosted upload", { remote: [{ mode: "hosted", stage: "uploading" }] }, {}],
  ["a submitted hosted job awaiting its saved transcript", { remote: [{ mode: "hosted", stage: "submitted" }] }, {}],
  ["an own-key upload still reading local bytes", { remote: [{ mode: "own", stage: "uploading" }] }, {}],
];

test.each(pinned)("keeps local bytes while %s", (_label, ledger, extra) => {
  expect(hasLocalWorkInProgress(note(ledger, extra))).toBe(true);
});

test("pins a note without a ledger", () => {
  expect(hasLocalWorkInProgress({ id: "n" } as unknown as VoiceNoteRecording)).toBe(true);
});

// Producer flows that must not pin forever. Each state is what the named producer leaves behind.
test("releases an uploaded note with transcription off whose default STT request was never queued", () => {
  // webStore.ts:258-259 writes waiting_for_model for every new note; desktopVoiceNotes.ts sets the transcriber to "off"
  // when desktop Whisper is unavailable, and desktopWhisper.ts drain never queues it.
  expect(hasLocalWorkInProgress(note({}, { options: { transcriber: "off" }, stt: { state: "waiting_for_model" } }))).toBe(false);
});

test("releases a note on another transcriber whose default STT request was never queued", () => {
  expect(hasLocalWorkInProgress(note({}, { stt: { state: "waiting_for_model" } }))).toBe(false);
});

test("releases an on-device note whose transcript completed", () => {
  expect(hasLocalWorkInProgress(note({}, { ...onDevice, stt: { state: "done" } }))).toBe(false);
});

test("releases a cancelled on-device job, which drain never queues and retry rejects", () => {
  expect(hasLocalWorkInProgress(note({}, { ...onDevice, stt: { state: "cancelled" } }))).toBe(false);
});

test("releases a saved note whose work is finished", () => {
  expect(hasLocalWorkInProgress(note({}))).toBe(false);
});

test("releases a hosted job once its remote stage is done", () => {
  expect(hasLocalWorkInProgress(note({ remote: [{ mode: "hosted", stage: "done" }] }))).toBe(false);
});

test("releases an own-key job once it has been submitted", () => {
  expect(hasLocalWorkInProgress(note({ remote: [{ mode: "own", stage: "submitted" }] }))).toBe(false);
});
