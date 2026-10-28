import { expect, test } from "bun:test";
import type { BatchResponse, TranscriptionEvent } from "@/lib/anarlog/transcription.gen";
import type { LocalTranscript } from "../nativeVoiceNotes";
import { newIdbEnv } from "../web/testing/idb";
import { memoryLocks, openWebStore, recordingFromSession } from "../web/webStore";
import type { DesktopBridge } from "./desktopVoiceNotes";
import { createDesktopWhisperQueue, type DesktopWhisperBridge, type DesktopWhisperQueue } from "./desktopWhisper";

const AUDIO = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]);
const oldTranscript: LocalTranscript = { version: 2, noteId: "rerun", rev: 1, transcriber: "on-device",
  engine: "whisper", model: "QuantizedTinyEn", language: "en", outcome: "transcribed", diarized: false,
  createdAt: "2026-01-01T00:00:00.000Z", segments: [{ start: 0, end: 1000, text: "Saved transcript", speaker: null }] };
const response = { metadata: { duration: 2 }, results: { channels: [{ alternatives: [{ transcript: "Late result", confidence: 1,
  words: [{ word: "Late", punctuated_word: "Late result", start: 0, end: 1, confidence: 1, speaker: null, channel: 0 }] }] }] } } as unknown as BatchResponse;

async function setup(ids: string[]) {
  const env = newIdbEnv();
  const dbName = crypto.randomUUID();
  const options = { env, dbName, locks: memoryLocks(), decodeCheck: null };
  const store = await openWebStore(options);
  for (const id of ids) {
    await store.beginSession({ id, startedAt: 1, source: "in_app", owner: null, transitionGen: 0,
      options: { transcriber: "on-device", identifySpeakers: false }, mimeType: "audio/wav", input: null, maxDurationMs: 60_000 });
    await store.appendChunk(id, AUDIO, { audioMs: 2000 });
    await store.commitSession(id, (session, size) => recordingFromSession(session, size, {
      endedAt: 2001, durationMs: 2000, recovered: false, endedUnexpectedly: false, exitReason: null }));
  }
  let capture = true;
  let nextStart = Promise.withResolvers<void>();
  const started = Promise.withResolvers<string>();
  const listeners = new Set<(event: TranscriptionEvent) => void>();
  const retired: ((event: TranscriptionEvent) => void)[] = [];
  const stops: string[] = [];
  const files = { invoke: async (command: string) => command === "recorder_models_get" ? "QuantizedTinyEn"
    : command === "recorder_models_list" ? [{ id: "QuantizedTinyEn", downloaded: true }] : undefined } as unknown as DesktopBridge;
  const whisper: DesktopWhisperBridge = {
    startServer: async () => "http://127.0.0.1:1", stopServer: async () => {},
    startTranscription: async ({ id }) => { started.resolve(id); nextStart.resolve(); },
    stopTranscription: async (id) => { stops.push(id); },
    onTranscription: async (listener) => { listeners.add(listener); return () => { listeners.delete(listener); retired.push(listener); }; },
  };
  const makeQueue = () => createDesktopWhisperQueue({ store, files, whisper, captureLive: () => capture });
  const queue = makeQueue();
  const notes = (await store.listPending()).recordings;
  for (const note of notes) await queue.noteCommitted(note);
  return { store, options, queue, makeQueue, stops, started: started.promise,
    nextStart() { nextStart = Promise.withResolvers<void>(); return nextStart.promise; },
    start() { capture = false; queue.captureEnded(); },
    late(id: string) { for (const listener of retired) listener({ type: "completed", session_id: id, mode: "streamed", response }); },
    complete(id: string) { for (const listener of listeners) listener({ type: "completed", session_id: id, mode: "streamed", response }); } };
}

function jobState(queue: DesktopWhisperQueue, id: string, state: string): Promise<void> {
  if (queue.snapshot().get(id)?.state === state) return Promise.resolve();
  const { promise, resolve } = Promise.withResolvers<void>();
  const stop = queue.subscribe(() => {
    if (queue.snapshot().get(id)?.state === state) { stop(); resolve(); }
  });
  return promise;
}

test("queued cancellation survives reopening the store without deleting saved audio or starting another note", async () => {
  const h = await setup(["queued", "other"]);
  try {
    await h.queue.cancel("queued");
    h.queue.dispose();
    const reopened = await openWebStore(h.options);
    const note = (await reopened.listPending()).recordings.find((row) => row.id === "queued");
    expect(note?.stt?.state).toBe("cancelled");
    expect((await reopened.readNoteAudio("queued")).bytes).toEqual(AUDIO);
    const restored = h.makeQueue();
    try {
      await restored.resume();
      expect(restored.snapshot().get("queued")?.state).toBe("cancelled");
      expect(restored.snapshot().get("other")?.state).toBe("queued");
      expect(h.stops).toEqual([]);
    } finally { restored.dispose(); }
  } finally { h.queue.dispose(); }
});

test("active cancellation stops only its decoder, ignores a late result, and permits a fresh run", async () => {
  const h = await setup(["active", "other"]);
  try {
    h.start();
    expect(await h.started).toBe("active");
    await h.queue.cancel("active");
    h.late("active");
    expect(h.stops).toEqual(["active"]);
    expect((await h.store.getTranscript({ id: "active" })).transcript).toBeNull();
    expect((await h.store.readNoteAudio("active")).bytes).toEqual(AUDIO);
    await h.queue.cancel("other");
    const restarted = h.nextStart();
    await h.queue.retry("active");
    await restarted;
    h.late("active");
    expect((await h.store.getTranscript({ id: "active" })).transcript).toBeNull();
    const finished = jobState(h.queue, "active", "done");
    h.complete("active");
    await finished;
    expect((await h.store.getTranscript({ id: "active" })).transcript?.segments[0]?.text).toBe("Late result");
  } finally { h.queue.dispose(); }
});

test("cancelling a replacement run preserves the exact previous transcript across reload", async () => {
  const h = await setup(["rerun"]);
  try {
    await h.queue.cancel("rerun");
    await h.store.putTranscript({ id: "rerun", transcript: oldTranscript });
    await h.queue.rerun({ id: "rerun", rev: 2, baseRev: 1, baseHash: "committed-hash" });
    h.start();
    await h.started;
    await h.queue.cancel("rerun");
    h.late("rerun");
    const reopened = await openWebStore(h.options);
    expect((await reopened.getTranscript({ id: "rerun" })).transcript).toEqual(oldTranscript);
    expect((await reopened.readNoteAudio("rerun")).bytes).toEqual(AUDIO);
    expect((await reopened.listPending()).recordings[0]?.stt).toMatchObject({ state: "cancelled", rerunRev: 2, rerunBaseRev: 1 });
  } finally { h.queue.dispose(); }
});
