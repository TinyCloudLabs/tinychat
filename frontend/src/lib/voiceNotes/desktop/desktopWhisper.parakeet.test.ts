import { expect, test } from "bun:test";
import type { BatchResponse, TranscriptionEvent } from "@/lib/anarlog/transcription.gen";
import type { LocalTranscript, NoteSttState, VoiceNoteRecording } from "../nativeVoiceNotes";
import type { WebStore } from "../web/webStore";
import type { DesktopBridge } from "./desktopVoiceNotes";
import { createDesktopWhisperQueue, type DesktopWhisperBridge } from "./desktopWhisper";

// Parakeet next to Whisper in the after-stop queue: the selected model decides the native command, and only Whisper
// leases and starts the Whisper server.

const NOTE_MS = 240_000;
const PARAKEET = "soniqo-parakeet-batch";

function response(decodedSeconds: number): BatchResponse {
  const words = [{ word: "hello", punctuated_word: "hello", start: 0, end: 0.4, confidence: 1, speaker: null, channel: 0 }];
  return {
    metadata: { duration: decodedSeconds, channels: 1, timing_source: "synthetic_text" },
    results: { channels: [{ alternatives: [{ transcript: "hello", confidence: 1, words }] }] },
  } as unknown as BatchResponse;
}

/** One real queue job with `model` selected and on disk; the native side answers `decodedSeconds`. */
async function run(model: string, { decodedSeconds = 240, parakeetBridge = true, onDisk = true } = {}) {
  const calls: string[] = [];
  const started: unknown[] = [];
  const updates: NoteSttState[] = [];
  const saved: LocalTranscript[] = [];
  const note = { id: "note-1", durationMs: NOTE_MS, options: { transcriber: "on-device" } } as unknown as VoiceNoteRecording;
  const store = {
    updateStt: async (_id: string, stt: NoteSttState) => { updates.push(stt); },
    listPending: async () => ({ recordings: [note] }),
    getTranscript: async () => ({ transcript: saved[0] ?? null }),
    putTranscriptForOwner: async ({ transcript }: { transcript: LocalTranscript }) => { saved.push(transcript); return { transcript }; },
  } as unknown as WebStore;
  const files = {
    invoke: async (command: string) => {
      calls.push(command);
      return command === "recorder_models_get" ? model
        : command === "recorder_models_list" ? [{ id: model, downloaded: onDisk }] : undefined;
    },
  } as unknown as DesktopBridge;
  let listener: (event: TranscriptionEvent) => void = () => {};
  const complete = (id: string) =>
    listener({ type: "completed", session_id: id, mode: "direct", response: response(decodedSeconds) });
  const whisper: DesktopWhisperBridge = {
    startServer: async (server) => { calls.push(`startServer:${server}`); return "http://127.0.0.1:0"; },
    stopServer: async () => { calls.push("stopServer"); },
    stopTranscription: async () => {},
    onTranscription: async (cb) => { listener = cb; return () => {}; },
    startTranscription: async (params) => { calls.push("startTranscription"); started.push(params); complete(params.id); },
    ...(parakeetBridge ? {
      startLocalStt: async (params: { id: string; stageId: string; model: typeof PARAKEET }) => {
        calls.push("startLocalStt"); started.push(params); complete(params.id);
      },
    } : {}),
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
    return { job: queue.snapshot().get("note-1"), calls, started, updates, saved };
  } finally {
    queue.dispose();
  }
}

test("a Parakeet job starts the Parakeet command on the staged recording and leases no Whisper server", async () => {
  const { job, calls, started, saved, updates } = await run(PARAKEET);
  expect(job?.state).toBe("done");
  expect(calls).toContain("recorder_whisper_stage_audio");
  expect(calls).toContain("startLocalStt");
  expect(calls).not.toContain("startTranscription");
  expect(calls.some((call) => call.startsWith("startServer"))).toBe(false);
  expect(calls).not.toContain("stopServer");
  expect(started).toEqual([{ id: "note-1", stageId: expect.stringMatching(/^whisper-[0-9a-f]{32}$/), model: PARAKEET }]);
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject({ engine: "parakeet-tdt-0.6b-v3", model: PARAKEET, transcriber: "on-device" });
  expect(updates.filter((stt) => stt.state === "running" || stt.state === "done").every((stt) => stt.engine === "parakeet")).toBe(true);
});

test("a Whisper job still leases the server and starts the Whisper command", async () => {
  const { job, calls, started, saved, updates } = await run("QuantizedSmall");
  expect(job?.state).toBe("done");
  expect(calls).toContain("startServer:QuantizedSmall");
  expect(calls).toContain("startTranscription");
  expect(calls).not.toContain("startLocalStt");
  expect(started).toEqual([{ id: "note-1", stageId: expect.stringMatching(/^whisper-[0-9a-f]{32}$/), model: "QuantizedSmall" }]);
  expect(saved[0]).toMatchObject({ engine: "whispercpp", model: "QuantizedSmall" });
  expect(updates.every((stt) => stt.engine === "whisper")).toBe(true);
});

test("a Parakeet transcript that covers too little of the recording is reported under Parakeet's name", async () => {
  const { job, saved } = await run(PARAKEET, { decodedSeconds: 102 });
  expect(job?.state).toBe("failed");
  expect(job?.error).toBe("Parakeet transcribed only 1:42 of this 4:00 recording. Retry transcription.");
  expect(saved).toEqual([]);
});

test("the same shortfall under Whisper keeps its words", async () => {
  const { job } = await run("QuantizedSmall", { decodedSeconds: 102 });
  expect(job?.error).toBe("Whisper transcribed only 1:42 of this 4:00 recording. Retry transcription.");
});

test("Parakeet selected but not on disk waits for the model and starts nothing", async () => {
  const { job, calls } = await run(PARAKEET, { onDisk: false });
  expect(job?.state).toBe("failed");
  expect(job?.error).toBe("unavailable: the selected Parakeet model is not downloaded");
  expect(calls).not.toContain("startLocalStt");
  expect(calls).not.toContain("recorder_whisper_stage_audio");
});

test("a bridge without the Parakeet command fails the job before staging and starts nothing", async () => {
  const { job, calls } = await run(PARAKEET, { parakeetBridge: false });
  expect(job?.state).toBe("failed");
  expect(job?.error).toStartWith("unavailable:");
  expect(calls).not.toContain("recorder_whisper_stage_audio");
  expect(calls).not.toContain("startTranscription");
  expect(calls.some((call) => call.startsWith("startServer"))).toBe(false);
});
