import { expect, test } from "bun:test";
import type { VoiceNoteRecording } from "./nativeVoiceNotes";
import { hasLocalWorkInProgress } from "./localWork";

const finishedLedger = { localAudio: { state: "ready" }, transcript: { state: "done" }, remote: [] };

function note(ledger: object, extra: object = {}): VoiceNoteRecording {
  return { id: "n", options: { transcriber: "assemblyai" }, ledger: { ...finishedLedger, ...ledger }, ...extra } as unknown as VoiceNoteRecording;
}

const pinned: Array<[string, object, object]> = [
  ["a preparing import", { localAudio: { state: "preparing" } }, {}],
  ["a failed import", { localAudio: { state: "failed" } }, {}],
  ["an on-device Whisper job waiting for its model", {}, { stt: { state: "waiting_for_model" } }],
  ["a queued on-device Whisper job", {}, { stt: { state: "queued" } }],
  ["a running on-device Whisper job", {}, { stt: { state: "running" } }],
  ["a failed on-device Whisper job", {}, { stt: { state: "failed" } }],
  ["a cancelled on-device Whisper job", {}, { stt: { state: "cancelled" } }],
  ["a pending transcript", { transcript: { state: "pending" } }, {}],
  ["a failed transcript", { transcript: { state: "failed" } }, {}],
  ["a transcript needing attention", { transcript: { state: "needs_attention" } }, {}],
  ["a blocked transcript", { transcript: { state: "blocked" } }, {}],
  ["a retrying transcript", { transcript: { state: "retrying" } }, {}],
  ["a cancelled transcript", { transcript: { state: "cancelled" } }, {}],
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

test("releases a saved note whose work is finished", () => {
  expect(hasLocalWorkInProgress(note({}, { stt: { state: "done" } }))).toBe(false);
});

test("releases a note whose transcriber is off even with no transcript", () => {
  expect(hasLocalWorkInProgress(note({ transcript: { state: "pending" } }, { options: { transcriber: "off" } }))).toBe(false);
});

test("releases a hosted job once its remote stage is done", () => {
  expect(hasLocalWorkInProgress(note({ remote: [{ mode: "hosted", stage: "done" }] }))).toBe(false);
});

test("releases an own-key job once it has been submitted", () => {
  expect(hasLocalWorkInProgress(note({ remote: [{ mode: "own", stage: "submitted" }] }))).toBe(false);
});
