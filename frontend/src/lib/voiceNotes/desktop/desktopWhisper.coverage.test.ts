import { expect, test } from "bun:test";
import type { BatchResponse, TranscriptionEvent } from "@/lib/anarlog/transcription.gen";
import type { VoiceNoteRecording } from "../nativeVoiceNotes";
import type { WebStore } from "../web/webStore";
import type { DesktopBridge } from "./desktopVoiceNotes";
import { createDesktopWhisperQueue, type DesktopWhisperBridge } from "./desktopWhisper";

const NOTE_MS = 240_000;

function response(decodedSeconds: number | null): BatchResponse {
  const words = [{ word: "hello", punctuated_word: "hello", start: 1, end: 2, confidence: 1, speaker: null, channel: 0 }];
  return {
    metadata: decodedSeconds === null ? null : { duration: decodedSeconds, channels: 1 },
    results: { channels: [{ alternatives: [{ transcript: "hello", confidence: 1, words }] }] },
  } as unknown as BatchResponse;
}

/** Runs one real queue job whose native decode reports `decodedSeconds` of audio. */
async function run(decodedSeconds: number | null) {
  const updates: { state: string; error: string | null }[] = [];
  const saved: unknown[] = [];
  const note = { id: "note-1", durationMs: NOTE_MS, options: { transcriber: "on-device" } } as unknown as VoiceNoteRecording;
  const store = {
    updateStt: async (_id: string, stt: { state: string; error: string | null }) => { updates.push(stt); },
    listPending: async () => ({ recordings: [note] }),
    getTranscript: async () => ({ transcript: saved[0] ?? null }),
    putTranscript: async ({ transcript }: { transcript: unknown }) => { saved.push(transcript); },
  } as unknown as WebStore;
  const files = {
    invoke: async (command: string) => command === "recorder_models_get" ? "QuantizedLargeTurbo"
      : command === "recorder_models_list" ? [{ id: "QuantizedLargeTurbo", downloaded: true }] : undefined,
  } as unknown as DesktopBridge;
  let listener: (event: TranscriptionEvent) => void = () => {};
  const whisper: DesktopWhisperBridge = {
    startServer: async () => "http://127.0.0.1:0",
    stopServer: async () => {},
    stopTranscription: async () => {},
    onTranscription: async (cb) => { listener = cb; return () => {}; },
    startTranscription: async ({ id }) => {
      listener({ type: "completed", session_id: id, mode: "streamed", response: response(decodedSeconds) });
    },
  };
  const queue = createDesktopWhisperQueue({ store, files, whisper, captureLive: () => false });
  try {
    const settled = Promise.withResolvers<void>();
    const unsubscribe = queue.subscribe(() => {
      if (["done", "failed"].includes(queue.snapshot().get("note-1")?.state ?? "")) settled.resolve();
    });
    await queue.noteCommitted(note);
    await settled.promise;
    unsubscribe();
    return { job: queue.snapshot().get("note-1"), updates, saved };
  } finally {
    queue.dispose();
  }
}

test("a transcript that decoded only part of the recording is reported as failed, not saved as complete", async () => {
  const { job, updates, saved } = await run(102);
  expect(job?.state).toBe("failed");
  expect(job?.error).toContain("1:42");
  expect(job?.error).toContain("4:00");
  expect(updates.at(-1)?.state).toBe("failed");
  expect(saved).toEqual([]);
});

test("a transcript that covers the recording, within encoder padding, completes", async () => {
  const { job, saved } = await run(239.4);
  expect(job?.state).toBe("done");
  expect(saved).toHaveLength(1);
});

test("a response with no decoded duration is not treated as incomplete", async () => {
  const { job } = await run(null);
  expect(job?.state).toBe("done");
});
