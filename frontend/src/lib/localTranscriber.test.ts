// Local-transcriber unit tests. The vendored plugin bindings are never imported
// here: `createLocalTranscriber` takes an injected LocalTranscriberBridge, so the
// full command/event sequence (download → start_server → capture → stopped →
// start_transcription → completed/failed) is exercised against a fake.
//
// Asserted behavior:
//   - normalizeLocalTranscript: exo-local source, `local:<session>` identity,
//     Speaker N channel labels, 1.5 s gap split, word-timing and
//     transcript-only fallback, no audio path in metadata;
//   - the start/stop invoke order and error surfacing (missing audio_path,
//     transcription failed, capture error);
//   - saveLocalTranscript delegates to upsertMeeting with the normalized pair.

import { describe, expect, test } from "bun:test";

import {
  createLocalTranscriber,
  normalizeLocalTranscript,
  LOCAL_MEETING_SOURCE,
  saveLocalTranscript,
  type LocalTranscriberBridge,
  type LocalTranscriptResult,
} from "./localTranscriber";
import type {
  CaptureLifecycleEvent,
  TranscriptionEvent,
} from "./anarlog/transcription.gen";
import type { DownloadProgressPayload } from "./anarlog/localStt.gen";

type Handler<T> = (e: { payload: T }) => void;

interface FakeBridge extends LocalTranscriberBridge {
  calls: string[];
  emitCaptureLifecycle(p: CaptureLifecycleEvent): void;
  emitTranscription(p: TranscriptionEvent): void;
  emitDownloadProgress(p: DownloadProgressPayload): void;
}


function makeBridge(opts: {
  modelDownloaded?: boolean;
  captureError?: string;
  downloadFails?: string;
} = {}): FakeBridge {
  const calls: string[] = [];
  const lifecycle = new Set<Handler<CaptureLifecycleEvent>>();
  const transcription = new Set<Handler<TranscriptionEvent>>();
  const status = new Set<Handler<never>>();
  const downloads = new Set<Handler<DownloadProgressPayload>>();

  const bridge: FakeBridge = {
    calls,
    emitCaptureLifecycle: (p) => lifecycle.forEach((cb) => cb({ payload: p })),
    emitTranscription: (p) => transcription.forEach((cb) => cb({ payload: p })),
    emitDownloadProgress: (p) => downloads.forEach((cb) => cb({ payload: p })),
    transcription: {
      listMicrophoneDevices: async () => ({ status: "ok", data: ["MacBook Mic"] }),
      startCapture: async (params) => {
        calls.push(`start_capture:${params.transcription_mode}:${params.base_url}:${params.mic_device ?? "default"}`);
        return opts.captureError
          ? { status: "error", error: opts.captureError }
          : { status: "ok", data: null };
      },
      stopCapture: async () => {
        calls.push("stop_capture");
        return { status: "ok", data: null };
      },
      getCaptureState: async () => ({ status: "ok", data: "inactive" as const }),
      startTranscription: async (params) => {
        calls.push(`start_transcription:${params.provider}:${params.file_path}`);
        return { status: "ok", data: null };
      },
      events: {
        captureLifecycleEvent: { listen: async (cb) => { lifecycle.add(cb); return () => lifecycle.delete(cb); } },
        captureStatusEvent: { listen: async (cb) => { status.add(cb); return () => status.delete(cb); } },
        transcriptionEvent: { listen: async (cb) => { transcription.add(cb); return () => transcription.delete(cb); } },
      },
    },
    localStt: {
      isModelDownloaded: async () => ({ status: "ok", data: opts.modelDownloaded ?? false }),
      downloadModel: async () => {
        calls.push("download_model");
        if (opts.downloadFails !== undefined) {
          bridge.emitDownloadProgress({
            model: "QuantizedTinyEn",
            status: { failed: opts.downloadFails },
          });
        } else {
          bridge.emitDownloadProgress({ model: "QuantizedTinyEn", status: { downloading: 42 } });
          bridge.emitDownloadProgress({ model: "QuantizedTinyEn", status: "completed" });
          opts.modelDownloaded = true;
        }
        return { status: "ok", data: null };
      },
      startServer: async (model) => {
        calls.push(`start_server:${model}`);
        return { status: "ok", data: "http://127.0.0.1:48732/v1" };
      },
      events: {
        downloadProgressPayload: { listen: async (cb) => { downloads.add(cb); return () => downloads.delete(cb); } },
      },
    },
  };
  return bridge;
}

function batchResponse(words: { word: string; start: number; end: number; channel?: number; punctuated_word?: string }[]) {
  return {
    metadata: {},
    results: {
      channels: [{ alternatives: [{ transcript: "", confidence: 1, words }] }],
    },
  };
}

function resultWith(words: Parameters<typeof batchResponse>[0]): LocalTranscriptResult {
  return {
    sessionId: "sess-1",
    startedAt: "2026-09-28T18:00:00.000Z",
    model: "QuantizedTinyEn",
    language: "en",
    response: batchResponse(words) as never,
  };
}

describe("normalizeLocalTranscript", () => {
  test("groups words into channel-labeled sentences, splitting on gaps and channel changes", () => {
    const { meeting, sentences } = normalizeLocalTranscript(
      resultWith([
        { word: "hello", punctuated_word: "Hello", start: 0.0, end: 0.4, channel: 0 },
        { word: "there", punctuated_word: "there.", start: 0.5, end: 0.9, channel: 0 },
        // 2.6 s gap → new sentence, same channel
        { word: "again", start: 3.5, end: 3.9, channel: 0 },
        // channel change → new sentence
        { word: "hi", punctuated_word: "Hi", start: 4.0, end: 4.2, channel: 1 },
        { word: "back", punctuated_word: "back.", start: 4.3, end: 4.6, channel: 1 },
      ]),
    );

    expect(meeting.source).toBe(LOCAL_MEETING_SOURCE);
    expect(meeting.sourceId).toBe("local:sess-1");
    expect(meeting.title).toContain("Local recording");
    expect(meeting.startedAt).toBe("2026-09-28T18:00:00.000Z");
    expect(meeting.durationSecs).toBe(5);
    expect(meeting.metadata.capture).toBe("local");
    expect(meeting.metadata.transcript_provider).toBe("whispercpp");
    expect(meeting.metadata.model).toBe("QuantizedTinyEn");
    expect(Object.keys(meeting.metadata).join(",")).not.toContain("audio_path");

    expect(sentences).toHaveLength(3);
    expect(sentences[0]).toMatchObject({
      index: 0,
      speaker_name: "Speaker 1",
      text: "Hello there.",
      start_time: 0,
      end_time: 0.9,
    });
    expect(sentences[1]).toMatchObject({ speaker_name: "Speaker 1", text: "again" });
    expect(sentences[2]).toMatchObject({
      speaker_name: "Speaker 2",
      text: "Hi back.",
      start_time: 4.0,
      end_time: 4.6,
    });
    // participants carry the distinct speaker labels
    expect(meeting.participants.map((p) => p.name)).toEqual(["Speaker 1", "Speaker 2"]);
  });

  test("falls back to whole-channel transcript when words have no timings", () => {
    const { sentences } = normalizeLocalTranscript({
      sessionId: "s2",
      startedAt: "2026-09-28T18:00:00.000Z",
      model: "QuantizedTinyEn",
      language: "en",
      response: {
        metadata: {},
        results: {
          channels: [
            { alternatives: [{ transcript: "  full sentence without words.  ", confidence: 1 }] },
          ],
        },
      } as never,
    });
    expect(sentences).toHaveLength(1);
    expect(sentences[0]).toMatchObject({ speaker_name: "Speaker 1", text: "full sentence without words." });
  });

  test("empty response yields an empty sentence list and no duration", () => {
    const { meeting, sentences } = normalizeLocalTranscript(resultWith([]));
    expect(sentences).toHaveLength(0);
    expect(meeting.durationSecs).toBeNull();
  });
});

describe("createLocalTranscriber", () => {
  test("start → stop runs server → capture → transcription and returns the response", async () => {
    const bridge = makeBridge();
    const t = createLocalTranscriber(bridge);

    await t.ensureModel("QuantizedTinyEn");
    const { sessionId } = await t.start({ model: "QuantizedTinyEn", language: "en" });

    const stopPromise = t.stop();
    // capture stops, plugin emits Stopped with the recorded file
    await new Promise((r) => setTimeout(r, 0));
    bridge.emitCaptureLifecycle({
      type: "stopped",
      session_id: sessionId,
      audio_path: "/vault/sessions/x/audio.mp3",
      requested_live_transcription: false,
      live_transcription_active: false,
      error: null,
    });
    await new Promise((r) => setTimeout(r, 0));
    // transcription completes with one channel of words
    bridge.emitTranscription({
      type: "completed",
      session_id: sessionId,
      response: batchResponse([{ word: "hi", start: 0, end: 0.5, channel: 0 }]) as never,
      mode: "streamed",
    });

    const result = await stopPromise;
    expect(result.sessionId).toBe(sessionId);
    expect(result.response.results.channels[0]!.alternatives[0]!.words).toHaveLength(1);
    expect(bridge.calls).toEqual([
      "download_model",
      "start_server:QuantizedTinyEn",
      "start_capture:batch:http://127.0.0.1:48732/v1:default",
      "stop_capture",
      "start_transcription:whispercpp:/vault/sessions/x/audio.mp3",
    ]);
  });

  test("stop() rejects when Stopped carries no audio path", async () => {
    const bridge = makeBridge();
    const t = createLocalTranscriber(bridge);
    const { sessionId } = await t.start({ model: "QuantizedTinyEn", language: "en" });

    const stopPromise = t.stop();
    await new Promise((r) => setTimeout(r, 0));
    bridge.emitCaptureLifecycle({
      type: "stopped",
      session_id: sessionId,
      audio_path: null,
      requested_live_transcription: false,
      live_transcription_active: false,
      error: null,
    });
    await expect(stopPromise).rejects.toThrow("no audio file");
  });

  test("stop() surfaces a failed transcription event", async () => {
    const bridge = makeBridge();
    const t = createLocalTranscriber(bridge);
    const { sessionId } = await t.start({ model: "QuantizedTinyEn", language: "en" });

    const stopPromise = t.stop();
    await new Promise((r) => setTimeout(r, 0));
    bridge.emitCaptureLifecycle({
      type: "stopped",
      session_id: sessionId,
      audio_path: "/vault/sessions/x/audio.mp3",
      requested_live_transcription: false,
      live_transcription_active: false,
      error: null,
    });
    await new Promise((r) => setTimeout(r, 0));
    bridge.emitTranscription({
      type: "failed",
      session_id: sessionId,
      code: "progressive_stream_error",
      error: "server exploded",
    });
    await expect(stopPromise).rejects.toThrow("server exploded");
  });

  test("start() surfaces capture errors and frees the session", async () => {
    const bridge = makeBridge({ captureError: "mic denied" });
    const t = createLocalTranscriber(bridge);
    await expect(t.start({ model: "QuantizedTinyEn", language: "en" })).rejects.toThrow(
      "start_capture: mic denied",
    );
    // A retry is allowed after failure.
    bridge.calls.length = 0;
    const t2 = createLocalTranscriber(makeBridge());
    await expect(t2.start({ model: "QuantizedTinyEn", language: "en" })).resolves.toBeTruthy();
  });

  test("ensureModel skips download when already on disk and reports progress", async () => {
    const downloaded = makeBridge({ modelDownloaded: true });
    const t = createLocalTranscriber(downloaded);
    const seen: number[] = [];
    await t.ensureModel("QuantizedTinyEn", (p) => seen.push(p));
    expect(downloaded.calls).not.toContain("download_model");
    expect(seen).toEqual([100]);

    const fresh = makeBridge();
    const t2 = createLocalTranscriber(fresh);
    const seen2: number[] = [];
    await t2.ensureModel("QuantizedTinyEn", (p) => seen2.push(p));
    expect(fresh.calls).toContain("download_model");
    expect(seen2).toContain(42);
    expect(seen2).toContain(100);
  });

  test("ensureModel surfaces a failed download", async () => {
    const bridge = makeBridge({ downloadFails: "network unreachable" });
    const t = createLocalTranscriber(bridge);
    await expect(t.ensureModel("QuantizedTinyEn")).rejects.toThrow("network unreachable");
  });

  test("a second start while active throws", async () => {
    const t = createLocalTranscriber(makeBridge());
    await t.start({ model: "QuantizedTinyEn", language: "en" });
    await expect(t.start({ model: "QuantizedTinyEn", language: "en" })).rejects.toThrow("already active");
  });
});

describe("saveLocalTranscript", () => {
  test("delegates to upsertMeeting with the normalized meeting and sentences", async () => {
    // upsertMeeting is module-bound; drive the real store contract with a tcw
    // fake that captures the SQL INSERT row and KV put.
    const writes: { sql: string; params: unknown[] }[] = [];
    const kvPuts: string[] = [];
    const tcw = {
      sql: {
        db: () => ({
          query: async (sql: string, params: unknown[] = []) => {
            writes.push({ sql, params });
            if (sql.startsWith("SELECT source_id")) return { ok: true, data: { rows: [] } };
            if (sql.startsWith("SELECT id, created_at")) return { ok: true, data: { rows: [] } };
            return { ok: true, data: { rows: [] } };
          },
          execute: async (sql: string, params: unknown[] = []) => {
            writes.push({ sql, params });
            return { ok: true, data: { rows: [] } };
          },
        }),
      },
      kv: {
        put: async (key: string) => {
          kvPuts.push(key);
          return { ok: true, data: null };
        },
      },
    } as never;

    const r = await saveLocalTranscript(tcw, resultWith([{ word: "hi", start: 0, end: 1, channel: 0 }]));
    expect(r.ok).toBe(true);
    const insert = writes.find((w) => w.sql.startsWith("INSERT INTO connector_meeting"));
    expect(insert).toBeTruthy();
    expect(insert!.params[1]).toBe(LOCAL_MEETING_SOURCE);
    expect(insert!.params[2]).toBe("local:sess-1");
    expect(kvPuts.some((k) => k.includes("exo-local/transcript/local:sess-1"))).toBe(true);
  });
});
