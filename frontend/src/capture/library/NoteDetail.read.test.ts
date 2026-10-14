import { afterEach, expect, test } from "bun:test";
import { setVoiceNoteSaveDeadlineForTests } from "@/lib/voiceNotes/saveDeadline";
import { readLocalTranscript } from "./NoteDetail";

afterEach(() => setVoiceNoteSaveDeadlineForTests(null));

test("a hung local transcript read times out with a typed retryable result", async () => {
  setVoiceNoteSaveDeadlineForTests(5);
  const stuck = await readLocalTranscript("note-1", () => new Promise(() => undefined));
  expect(stuck).toEqual({ transcript: null, readError: "timeout" });
  const retry = await readLocalTranscript("note-1", async () => ({ transcript: {
    version: 1, noteId: "note-1", transcriber: "on-device", rev: 1, engine: "whispercpp",
    model: "QuantizedTinyEn", language: "en", outcome: "no_speech", diarized: false,
    segments: [], createdAt: "2026-10-13T10:00:00Z",
  } }));
  expect(retry.readError).toBeNull();
  expect(retry.transcript?.outcome).toBe("no_speech");
});
