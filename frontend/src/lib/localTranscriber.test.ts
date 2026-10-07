// Local-transcriber unit tests. The vendored plugin bindings are never imported
// here: `createLocalTranscriber` takes an injected LocalTranscriberBridge, so the
// full command/event sequence (download → start_server → capture → stopped →
// start_transcription → completed/failed) is exercised against a fake.
//
// Asserted behavior:
//   - normalizeLocalTranscript: exo-local source, `local:<session>` identity,
//     You (mic) / Others (system audio) turns with mic echo dropped (turn
//     shaping itself is covered in localTranscriptTurns.test.ts), word-timing
//     and transcript-only fallback, no audio path in metadata;
//   - the start/stop invoke order and error surfacing (missing audio_path,
//     transcription failed, capture error);
//   - capture is only "stopped" on its matching terminal event: a timed-out,
//     failed, or hung stop keeps the session for Retry stop; unmount waits for
//     confirmation and a remount never starts over an unconfirmed capture;
//   - a close-time stop that is not confirmed, or a start_capture that times
//     out, leaves a process-wide previous recording: a remounted view reports
//     it, stops it (stop_capture + that session's stopped event), and only
//     then starts; a start_capture that may still return keeps it unconfirmed;
//   - every native wait is bounded (bridge/listener registration, readiness
//     reads, get_capture_state, start_server, start_capture), and unmount
//     never waits forever on a pending start;
//   - lifetime listeners register all-or-nothing and a failure is retryable;
//   - saveLocalTranscript delegates to upsertMeeting with the prepared pair, a
//     retried save repairs a partial write, and silence is never saved; saves
//     are bounded and a retry after a timed-out save waits for it, never
//     writing beside it;
//   - a failed transcription keeps the stopped recording: retryTranscription
//     restarts the server and re-transcribes the same audio file until it
//     succeeds, and discardRecording releases it without transcribing;
//   - a capture that fails but leaves an audio file keeps it as a partial
//     recording to transcribe or discard;
//   - a transcription outlives its view: closing the view during the first
//     attempt or a retry hands it to the next view, which alone takes its
//     outcome (once), and no capture starts while it is running or kept;
//   - a stopped on-device recording is persisted before it is transcribed and
//     outlives a quit or crash: a relaunch offers it (Transcribe through
//     retryTranscription, or Discard) until its transcript is saved or it is
//     discarded, and one whose audio file is gone can only be discarded;
//   - kept recordings belong to the signed-in account: another account is
//     never offered one (nor adopts a closed view's job), and is not blocked;
//   - closing the view mid-recording keeps the recording (complete or
//     partial), also when capture already ended on its own or a timed-out
//     Stop's event came late, and one whose transcript is being saved is not
//     offered until that save settles.

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import {
  CaptureStopUnconfirmedError,
  createLocalTranscriber,
  createLocalTranscriptSaver,
  KeptRecordingError,
  localStorageKeptRecordingStore,
  localStoragePendingCloudStore,
  normalizeLocalTranscript,
  LOCAL_KEPT_RECORDING_KEY,
  LOCAL_MEETING_SOURCE,
  LOCAL_WHISPER_MODELS,
  NO_SPEECH_MESSAGE,
  PartialRecordingError,
  prepareLocalTranscript,
  PreviousCaptureUnconfirmedError,
  saveLocalTranscript,
  TranscriptionFailedError,
  type KeptLocalRecording,
  type KeptRecordingStore,
  type LocalTranscriberBridge,
  type LocalTranscriptResult,
  type OnDeviceTranscriptResult,
} from "./localTranscriber";
import { transcriptKvKey } from "./connectors/connectorStore";
import { legacyPendingCloudStore, PRIVATE_CLOUD_PENDING_KEY, type PendingCloudJob } from "./privateCloud";
import type {
  CaptureLifecycleEvent,
  TranscriptionEvent,
} from "./anarlog/transcription.gen";
import type { DownloadProgressPayload } from "./anarlog/localStt.gen";

type Handler<T> = (e: { payload: T }) => void;

interface FakeBridge extends LocalTranscriberBridge {
  calls: string[];
  /** Registered (not yet unlistened) lifetime + per-operation listeners, by event. */
  listenerCounts(): { lifecycle: number; status: number; transcription: number };
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
    listenerCounts: () => ({ lifecycle: lifecycle.size, status: status.size, transcription: transcription.size }),
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

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function stoppedEvent(
  sessionId: string,
  patch: Partial<Extract<CaptureLifecycleEvent, { type: "stopped" }>> = {},
): CaptureLifecycleEvent {
  return {
    type: "stopped",
    session_id: sessionId,
    audio_path: "/vault/sessions/x/audio.mp3",
    requested_live_transcription: false,
    live_transcription_active: false,
    error: null,
    ...patch,
  };
}

function completedEvent(sessionId: string): TranscriptionEvent {
  return {
    type: "completed",
    session_id: sessionId,
    response: batchResponse([{ word: "hi", start: 0, end: 0.5, channel: 0 }]) as never,
    mode: "streamed",
  };
}

const startCaptureCalls = (bridge: FakeBridge) => bridge.calls.filter((c) => c.startsWith("start_capture")).length;
const stopCaptureCalls = (bridge: FakeBridge) => bridge.calls.filter((c) => c === "stop_capture").length;
const startTranscriptionCalls = (bridge: FakeBridge) =>
  bridge.calls.filter((c) => c.startsWith("start_transcription")).length;

function failedTranscription(sessionId: string, error: string): TranscriptionEvent {
  return { type: "failed", session_id: sessionId, code: "progressive_stream_timeout", error };
}

/** Start, then Stop with a stopped event and the given transcription outcome. */
async function stopWith(bridge: FakeBridge, t: ReturnType<typeof createLocalTranscriber>, sessionId: string, outcome: TranscriptionEvent) {
  const stopping = t.stop();
  await tick();
  bridge.emitCaptureLifecycle(stoppedEvent(sessionId));
  await tick();
  bridge.emitTranscription(outcome);
  return stopping;
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
  test("groups words into You (mic) / Others (system audio) turns, merging a speaker's consecutive segments", () => {
    const { meeting, sentences } = normalizeLocalTranscript(
      resultWith([
        { word: "hello", punctuated_word: "Hello", start: 0.0, end: 0.4, channel: 0 },
        { word: "there", punctuated_word: "there.", start: 0.5, end: 0.9, channel: 0 },
        // 2.6 s gap: a new segment, but the same speaker's turn continues
        { word: "again", start: 3.5, end: 3.9, channel: 0 },
        // the other channel: a new turn
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

    expect(meeting.metadata.speaker_labels).toBe("channel-you-others");

    expect(sentences).toHaveLength(2);
    expect(sentences[0]).toMatchObject({
      index: 0,
      speaker_name: "You",
      text: "Hello there. again",
      start_time: 0,
      end_time: 3.9,
    });
    expect(sentences[1]).toMatchObject({
      index: 1,
      speaker_name: "Others",
      text: "Hi back.",
      start_time: 4.0,
      end_time: 4.6,
    });
    // participants carry the distinct speaker labels
    expect(meeting.participants.map((p) => p.name)).toEqual(["You", "Others"]);
  });

  test("drops mic echo of system audio from a two-channel whisper response", () => {
    // Real whisper-local output: one results channel per audio channel, each
    // word tagged with its channel and spread evenly across its VAD chunk.
    const spread = (channel: number, start: number, end: number, text: string) => {
      const parts = text.split(" ");
      const step = (end - start) / parts.length;
      return parts.map((word, i) => ({ word, start: start + i * step, end: start + (i + 1) * step, channel }));
    };
    const remote = ["Ship the release on Thursday.", "Blue kites fly over the harbor."];
    const { meeting, sentences } = normalizeLocalTranscript({
      ...resultWith([]),
      response: {
        metadata: {},
        results: {
          channels: [
            { alternatives: [{ transcript: "", confidence: 1, words: [
              ...spread(0, 0, 2, "Can everyone hear me?"),
              ...spread(0, 3.2, 6.1, remote[0]!),
              ...spread(0, 7.2, 10.1, remote[1]!),
            ] }] },
            { alternatives: [{ transcript: "", confidence: 1, words: [
              ...spread(1, 3, 6, remote[0]!),
              ...spread(1, 7, 10, remote[1]!),
            ] }] },
          ],
        },
      } as never,
    });

    expect(sentences.map((s) => `${s.speaker_name}: ${s.text}`)).toEqual([
      "You: Can everyone hear me?",
      `Others: ${remote.join(" ")}`,
    ]);
    expect(meeting.metadata.transcript_text).toBe(`Can everyone hear me?\n${remote.join(" ")}`);
    expect(meeting.participants.map((p) => p.name)).toEqual(["You", "Others"]);
  });

  test("duration is the latest turn end, not the last turn's end", () => {
    const { meeting, sentences } = normalizeLocalTranscript(
      resultWith([
        // A long mic turn that starts first and ends last…
        { word: "one", start: 0, end: 10, channel: 0 },
        { word: "two", start: 10, end: 30, channel: 0 },
        // …and a short system-audio turn inside it, ordered after it.
        { word: "hi", start: 5, end: 6, channel: 1 },
      ]),
    );
    expect(sentences.map((s) => s.speaker_name)).toEqual(["You", "Others"]);
    expect(meeting.durationSecs).toBe(30);
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
    expect(sentences[0]).toMatchObject({ speaker_name: "You", text: "full sentence without words." });
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

  test("registers terminal listeners before commands can emit immediately", async () => {
    const bridge = makeBridge({ modelDownloaded: true });
    let activeSessionId = "";
    const startCapture = bridge.transcription.startCapture;
    bridge.transcription.startCapture = async (params) => {
      activeSessionId = params.session_id;
      return startCapture(params);
    };
    const captureListen = bridge.transcription.events.captureLifecycleEvent.listen;
    bridge.transcription.events.captureLifecycleEvent.listen = async (cb) => {
      await Promise.resolve();
      return captureListen(cb);
    };
    const transcriptionListen = bridge.transcription.events.transcriptionEvent.listen;
    bridge.transcription.events.transcriptionEvent.listen = async (cb) => {
      await Promise.resolve();
      return transcriptionListen(cb);
    };
    bridge.transcription.stopCapture = async () => {
      bridge.emitCaptureLifecycle({
        type: "stopped",
        session_id: activeSessionId,
        audio_path: "/vault/sessions/x/audio.mp3",
        requested_live_transcription: false,
        live_transcription_active: false,
        error: null,
      });
      return { status: "ok", data: null };
    };
    bridge.transcription.startTranscription = async () => {
      bridge.emitTranscription({
        type: "completed",
        session_id: activeSessionId,
        response: batchResponse([{ word: "immediate", start: 0, end: 1 }]) as never,
        mode: "streamed",
      });
      return { status: "ok", data: null };
    };

    const transcriber = createLocalTranscriber(bridge);
    await transcriber.start({ model: "QuantizedTinyEn", language: "en" });
    const result = await transcriber.stop();
    expect(result.response.results.channels[0]!.alternatives[0]!.words?.[0]?.word).toBe("immediate");
  });

  test("leaving the view stops an active native capture and waits for its stopped event", async () => {
    const bridge = makeBridge({ modelDownloaded: true });
    const transcriber = createLocalTranscriber(bridge);
    const { sessionId } = await transcriber.start({ model: "QuantizedTinyEn", language: "en" });
    let settled = false;
    const closing = transcriber.stopCaptureOnUnmount().then(() => { settled = true; });
    await tick();
    expect(bridge.calls).toContain("stop_capture");
    // stop_capture returning is only a dispatch, not proof the capture ended.
    expect(settled).toBe(false);
    bridge.emitCaptureLifecycle(stoppedEvent(sessionId));
    await closing;
    expect(settled).toBe(true);
  });

  test("leaving during start still stops capture once it starts", async () => {
    const bridge = makeBridge({ modelDownloaded: true });
    let finishStart!: () => void;
    let session = "";
    bridge.transcription.startCapture = async (params) => {
      session = params.session_id;
      await new Promise<void>((resolve) => { finishStart = resolve; });
      return { status: "ok", data: null };
    };
    const transcriber = createLocalTranscriber(bridge);
    const starting = transcriber.start({ model: "QuantizedTinyEn", language: "en" });
    while (!finishStart) await Promise.resolve();
    const closing = transcriber.stopCaptureOnUnmount();
    finishStart();
    await expect(starting).rejects.toThrow("view closed");
    await tick();
    expect(bridge.calls).toContain("stop_capture");
    bridge.emitCaptureLifecycle(stoppedEvent(session));
    await expect(closing).resolves.toBeUndefined();
  });

  test("stop_capture success without a stopped event times out and keeps the session for Retry stop", async () => {
    const bridge = makeBridge({ modelDownloaded: true });
    const t = createLocalTranscriber(bridge, { timeouts: { captureStopMs: 20 } });
    const statuses: string[] = [];
    t.onStatus((s) => statuses.push(s.kind));
    const { sessionId } = await t.start({ model: "QuantizedTinyEn", language: "en" });

    const first = t.stop();
    await expect(first).rejects.toBeInstanceOf(CaptureStopUnconfirmedError);
    await expect(first).rejects.toThrow("Timed out waiting for native capture to confirm it stopped");
    expect(statuses.at(-1)).toBe("error");
    // The capture may still be live, so nothing may start over it.
    await expect(t.start({ model: "QuantizedTinyEn", language: "en" })).rejects.toThrow("already active");

    // Retry stop: this time native capture confirms.
    const retry = t.stop();
    await tick();
    bridge.emitCaptureLifecycle(stoppedEvent(sessionId));
    await tick();
    bridge.emitTranscription(completedEvent(sessionId));
    await expect(retry).resolves.toMatchObject({ sessionId });
    expect(stopCaptureCalls(bridge)).toBe(2);
  });

  test("a stop_capture error is unconfirmed, not stopped", async () => {
    const bridge = makeBridge({ modelDownloaded: true });
    bridge.transcription.stopCapture = async () => ({ status: "error", error: "root actor busy" });
    const t = createLocalTranscriber(bridge);
    await t.start({ model: "QuantizedTinyEn", language: "en" });
    const stopping = t.stop();
    await expect(stopping).rejects.toBeInstanceOf(CaptureStopUnconfirmedError);
    await expect(stopping).rejects.toThrow("stop_capture: root actor busy");
    await expect(t.start({ model: "QuantizedTinyEn", language: "en" })).rejects.toThrow("already active");
  });

  test("a stop_capture that never returns still times out; a late stopped event lets Retry stop finish", async () => {
    const bridge = makeBridge({ modelDownloaded: true });
    let stopCalls = 0;
    bridge.transcription.stopCapture = () => {
      stopCalls++;
      return new Promise(() => {});
    };
    const t = createLocalTranscriber(bridge, { timeouts: { captureStopMs: 20 } });
    const { sessionId } = await t.start({ model: "QuantizedTinyEn", language: "en" });
    await expect(t.stop()).rejects.toBeInstanceOf(CaptureStopUnconfirmedError);

    // Native capture reports the stop after the timeout; the lifetime listener records it.
    bridge.emitCaptureLifecycle(stoppedEvent(sessionId));
    const retry = t.stop();
    await tick();
    bridge.emitTranscription(completedEvent(sessionId));
    await expect(retry).resolves.toMatchObject({ sessionId });
    expect(stopCalls).toBe(1);
  });

  test("a hung download_model invoke is bounded by the same timer", async () => {
    const bridge = makeBridge();
    bridge.localStt.downloadModel = () => new Promise(() => {});
    const t = createLocalTranscriber(bridge, { timeouts: { modelDownloadStallMs: 20 } });
    await expect(t.ensureModel("QuantizedTinyEn")).rejects.toThrow(
      "Timed out waiting for the model download to make progress",
    );
  });

  test("a slow model download that keeps making progress is not timed out", async () => {
    const bridge = makeBridge();
    bridge.localStt.downloadModel = async () => {
      void (async () => {
        // Six progress events 40 ms apart: 240 ms in total, well past the
        // 100 ms stall timeout, but never 100 ms without progress.
        for (const pct of [10, 25, 40, 55, 70, 85]) {
          await new Promise((r) => setTimeout(r, 40));
          bridge.emitDownloadProgress({ model: "QuantizedTinyEn", status: { downloading: pct } });
        }
        bridge.emitDownloadProgress({ model: "QuantizedTinyEn", status: "completed" });
      })();
      return { status: "ok", data: null };
    };
    const t = createLocalTranscriber(bridge, { timeouts: { modelDownloadStallMs: 100 } });
    const seen: number[] = [];
    await expect(t.ensureModel("QuantizedTinyEn", (p) => seen.push(p))).resolves.toBeUndefined();
    expect(seen).toEqual([10, 25, 40, 55, 70, 85, 100]);
  });

  test("a model download that stops making progress times out", async () => {
    const bridge = makeBridge();
    bridge.localStt.downloadModel = async () => {
      setTimeout(() => bridge.emitDownloadProgress({ model: "QuantizedTinyEn", status: { downloading: 30 } }), 20);
      // Progress for another model must not keep this wait alive.
      for (const delay of [60, 110, 160, 210]) {
        setTimeout(() => bridge.emitDownloadProgress({ model: "QuantizedBase", status: { downloading: delay } }), delay);
      }
      return { status: "ok", data: null };
    };
    const t = createLocalTranscriber(bridge, { timeouts: { modelDownloadStallMs: 100 } });
    const seen: number[] = [];
    const started = Date.now();
    await expect(t.ensureModel("QuantizedTinyEn", (p) => seen.push(p))).rejects.toThrow(
      "Timed out waiting for the model download to make progress",
    );
    // Expires ~120 ms in (100 ms after the last progress); had the other
    // model's events restarted the clock, not before ~310 ms.
    expect(Date.now() - started).toBeLessThan(250);
    expect(seen).toEqual([30]);

    // The listener is released: a late event no longer reports progress.
    bridge.emitDownloadProgress({ model: "QuantizedTinyEn", status: { downloading: 90 } });
    expect(seen).toEqual([30]);
  });

  test("an actor-failure stopped event ends the capture and surfaces the failure", async () => {
    const bridge = makeBridge({ modelDownloaded: true });
    const t = createLocalTranscriber(bridge);
    const { sessionId } = await t.start({ model: "QuantizedTinyEn", language: "en" });
    const stopping = t.stop();
    await tick();
    bridge.emitCaptureLifecycle(stoppedEvent(sessionId, { audio_path: null, error: "ActorFailed(mic stream closed)" }));
    const err = await stopping.catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(CaptureStopUnconfirmedError);
    expect(err).not.toBeInstanceOf(TranscriptionFailedError);
    expect((err as Error).message).toBe("Capture failed: ActorFailed(mic stream closed)");
    // The terminal event proved capture ended, so a new recording may start.
    await expect(t.start({ model: "QuantizedTinyEn", language: "en" })).resolves.toBeTruthy();
  });

  test("a failed capture that left an audio file keeps it as a partial recording to transcribe or discard", async () => {
    const bridge = makeBridge({ modelDownloaded: true });
    const t = createLocalTranscriber(bridge);
    const { sessionId } = await t.start({ model: "QuantizedTinyEn", language: "en" });
    const stopping = t.stop();
    await tick();
    bridge.emitCaptureLifecycle(
      stoppedEvent(sessionId, { audio_path: "/vault/sessions/x/partial.mp3", error: "ActorFailed(mic stream closed)" }),
    );
    const err = await stopping.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PartialRecordingError);
    expect(err).toBeInstanceOf(TranscriptionFailedError);
    expect((err as Error).message).toBe("Capture failed: ActorFailed(mic stream closed). A partial recording was kept.");
    // Kept untranscribed until the user chooses; nothing new records over it.
    expect(startTranscriptionCalls(bridge)).toBe(0);
    await expect(t.start({ model: "QuantizedTinyEn", language: "en" })).rejects.toThrow("waiting to be transcribed");

    // "Transcribe partial recording" transcribes that file.
    const transcribing = t.retryTranscription();
    await tick();
    bridge.emitTranscription(completedEvent(sessionId));
    await expect(transcribing).resolves.toMatchObject({ sessionId });
    expect(bridge.calls.at(-1)).toBe("start_transcription:whispercpp:/vault/sessions/x/partial.mp3");

    // "Discard recording" drops another partial one without transcribing it.
    const second = await t.start({ model: "QuantizedTinyEn", language: "en" });
    const stoppingSecond = t.stop();
    await tick();
    bridge.emitCaptureLifecycle(stoppedEvent(second.sessionId, { error: "ActorFailed(device lost)" }));
    await expect(stoppingSecond).rejects.toBeInstanceOf(PartialRecordingError);
    t.discardRecording();
    expect(startTranscriptionCalls(bridge)).toBe(1);
    await expect(t.start({ model: "QuantizedTinyEn", language: "en" })).resolves.toBeTruthy();
  });

  test("a capture that fails before Stop is reported without a no-op stop_capture", async () => {
    const bridge = makeBridge({ modelDownloaded: true });
    const t = createLocalTranscriber(bridge);
    const { sessionId } = await t.start({ model: "QuantizedTinyEn", language: "en" });
    bridge.emitCaptureLifecycle(stoppedEvent(sessionId, { audio_path: null, error: "ActorFailed(audio device lost)" }));
    await expect(t.stop()).rejects.toThrow("Capture failed: ActorFailed(audio device lost)");
    expect(stopCaptureCalls(bridge)).toBe(0);
  });

  test("a close-time stop that times out leaves a previous recording the remounted view stops before it can start", async () => {
    const bridge = makeBridge({ modelDownloaded: true });
    let nativeState: "active" | "finalizing" | "inactive" = "active";
    bridge.transcription.getCaptureState = async () => ({ status: "ok", data: nativeState });
    const closed = createLocalTranscriber(bridge, { timeouts: { captureStopMs: 20 } });
    const { sessionId } = await closed.start({ model: "QuantizedTinyEn", language: "en" });
    // Unmount issues the stop but does not claim it succeeded; native capture stays active.
    await expect(closed.stopCaptureOnUnmount()).rejects.toThrow("Timed out");
    expect(stopCaptureCalls(bridge)).toBe(1);

    // Remount: a new transcriber on the same native listener is told why, and what native reports.
    const remounted = createLocalTranscriber(bridge);
    const previous = await remounted.previousRecording();
    expect(previous?.sessionId).toBe(sessionId);
    expect(previous?.message).toContain(
      "The Local recording view closed before its recording confirmed it stopped (Timed out waiting for native capture to confirm it stopped).",
    );
    expect(previous?.message).toContain("Native capture is active.");
    // Nothing starts over it, however long the user waits.
    await expect(remounted.start({ model: "QuantizedTinyEn", language: "en" })).rejects.toBeInstanceOf(
      PreviousCaptureUnconfirmedError,
    );
    expect(startCaptureCalls(bridge)).toBe(1);

    // "Stop previous recording" issues a second stop and waits for that session's stopped event.
    let recovered = false;
    const recovering = remounted.stopPreviousRecording().then(() => { recovered = true; });
    await tick();
    expect(stopCaptureCalls(bridge)).toBe(2);
    expect(recovered).toBe(false);
    nativeState = "inactive";
    bridge.emitCaptureLifecycle(stoppedEvent(sessionId));
    await recovering;

    expect(await remounted.previousRecording()).toBeNull();
    await expect(remounted.start({ model: "QuantizedTinyEn", language: "en" })).resolves.toBeTruthy();
    expect(startCaptureCalls(bridge)).toBe(2);
  });

  test("a recovery stop that is not confirmed keeps the previous recording for another try", async () => {
    const bridge = makeBridge({ modelDownloaded: true });
    bridge.transcription.getCaptureState = async () => ({ status: "ok", data: "active" });
    const closed = createLocalTranscriber(bridge, { timeouts: { captureStopMs: 20 } });
    const { sessionId } = await closed.start({ model: "QuantizedTinyEn", language: "en" });
    await expect(closed.stopCaptureOnUnmount()).rejects.toThrow("Timed out");

    const remounted = createLocalTranscriber(bridge, { timeouts: { captureStopMs: 20 } });
    const failed = remounted.stopPreviousRecording();
    await expect(failed).rejects.toBeInstanceOf(PreviousCaptureUnconfirmedError);
    await expect(failed).rejects.toThrow(
      "Stopping the previous recording was not confirmed (Timed out waiting for the previous recording to confirm it stopped). Native capture is active.",
    );
    expect(stopCaptureCalls(bridge)).toBe(2);
    expect((await remounted.previousRecording())?.sessionId).toBe(sessionId);
  });

  test("a previous recording that native capture already reports inactive is cleared without another stop", async () => {
    const bridge = makeBridge({ modelDownloaded: true });
    let nativeState: "active" | "finalizing" | "inactive" = "active";
    bridge.transcription.getCaptureState = async () => ({ status: "ok", data: nativeState });
    const closed = createLocalTranscriber(bridge, { timeouts: { captureStopMs: 20 } });
    await closed.start({ model: "QuantizedTinyEn", language: "en" });
    await expect(closed.stopCaptureOnUnmount()).rejects.toThrow("Timed out");

    nativeState = "inactive";
    const remounted = createLocalTranscriber(bridge);
    expect(await remounted.previousRecording()).toBeNull();
    await expect(remounted.start({ model: "QuantizedTinyEn", language: "en" })).resolves.toBeTruthy();
    expect(stopCaptureCalls(bridge)).toBe(1);
  });

  test("a remounted view waits for the closed view's stop to confirm before starting", async () => {
    const bridge = makeBridge({ modelDownloaded: true });
    const closed = createLocalTranscriber(bridge);
    const { sessionId } = await closed.start({ model: "QuantizedTinyEn", language: "en" });
    const closing = closed.stopCaptureOnUnmount();

    const remounted = createLocalTranscriber(bridge);
    const starting = remounted.start({ model: "QuantizedTinyEn", language: "en" });
    await tick();
    expect(startCaptureCalls(bridge)).toBe(1);

    bridge.emitCaptureLifecycle(stoppedEvent(sessionId));
    await closing;
    await expect(starting).resolves.toBeTruthy();
    expect(startCaptureCalls(bridge)).toBe(2);
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

  test("a failed transcription keeps the recording; retryTranscription restarts the server, re-transcribes the same file, and it saves once", async () => {
    const bridge = makeBridge({ modelDownloaded: true });
    const params: Parameters<LocalTranscriberBridge["transcription"]["startTranscription"]>[0][] = [];
    const startTranscription = bridge.transcription.startTranscription;
    bridge.transcription.startTranscription = async (p) => {
      params.push(p);
      return startTranscription(p);
    };
    let serverStarts = 0;
    bridge.localStt.startServer = async (model) => {
      bridge.calls.push(`start_server:${model}`);
      serverStarts++;
      return { status: "ok", data: `http://127.0.0.1:4870${serverStarts}/v1` };
    };
    const t = createLocalTranscriber(bridge);
    const { sessionId } = await t.start({ model: "QuantizedBaseEn", language: "en" });

    const err = await stopWith(bridge, t, sessionId, failedTranscription(sessionId, "no progress for 120s")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TranscriptionFailedError);
    expect((err as Error).message).toBe("Transcription failed (progressive_stream_timeout): no progress for 120s");

    const retry = t.retryTranscription();
    await tick();
    bridge.emitTranscription(completedEvent(sessionId));
    const result = await retry;
    expect(result).toMatchObject({ sessionId, model: "QuantizedBaseEn", language: "en" });
    expect(bridge.calls).toEqual([
      "start_server:QuantizedBaseEn",
      "start_capture:batch:http://127.0.0.1:48701/v1:default",
      "stop_capture",
      "start_transcription:whispercpp:/vault/sessions/x/audio.mp3",
      "start_server:QuantizedBaseEn",
      "start_transcription:whispercpp:/vault/sessions/x/audio.mp3",
    ]);
    // Same session, file, model and language; only the freshly started server URL differs.
    expect(params[1]).toEqual({ ...params[0]!, base_url: "http://127.0.0.1:48702/v1" });

    const store = sqliteStore();
    const saved = await saveLocalTranscript(store.tcw, prepareLocalTranscript(result));
    expect(saved.ok).toBe(true);
    expect(store.sqlite.query("SELECT source, source_id FROM connector_meeting").values()).toEqual([
      [LOCAL_MEETING_SOURCE, `local:${sessionId}`],
    ]);

    // A transcribed recording is released: nothing left to retry, and a new recording may start.
    await expect(t.retryTranscription()).rejects.toThrow("No recording is waiting to be transcribed");
    await expect(t.start({ model: "QuantizedBaseEn", language: "en" })).resolves.toBeTruthy();
  });

  test("a retry that fails again keeps the recording and reports the new error", async () => {
    const bridge = makeBridge({ modelDownloaded: true });
    const t = createLocalTranscriber(bridge, { timeouts: { transcribeMs: 20 } });
    const { sessionId } = await t.start({ model: "QuantizedTinyEn", language: "en" });

    // No terminal transcription event: the transcription wait times out.
    const stopping = t.stop();
    await tick();
    bridge.emitCaptureLifecycle(stoppedEvent(sessionId));
    await expect(stopping).rejects.toBeInstanceOf(TranscriptionFailedError);
    await expect(stopping).rejects.toThrow("Timed out waiting for on-device transcription");

    // The server does not come up: surfaced, and nothing is transcribed without it.
    const startServer = bridge.localStt.startServer;
    bridge.localStt.startServer = async () => ({ status: "error", error: "whisper server failed to bind" });
    const second = t.retryTranscription();
    await expect(second).rejects.toBeInstanceOf(TranscriptionFailedError);
    await expect(second).rejects.toThrow("start_server: whisper server failed to bind");
    expect(startTranscriptionCalls(bridge)).toBe(1);

    bridge.localStt.startServer = startServer;
    const third = t.retryTranscription();
    await tick();
    bridge.emitTranscription(failedTranscription(sessionId, "decoder crashed"));
    await expect(third).rejects.toBeInstanceOf(TranscriptionFailedError);
    await expect(third).rejects.toThrow("Transcription failed (progressive_stream_timeout): decoder crashed");

    // Still kept: the next retry transcribes the same recording.
    const fourth = t.retryTranscription();
    await tick();
    bridge.emitTranscription(completedEvent(sessionId));
    await expect(fourth).resolves.toMatchObject({ sessionId });
    expect(startTranscriptionCalls(bridge)).toBe(3);
  });

  test("discarding the kept recording releases it without transcribing", async () => {
    const bridge = makeBridge({ modelDownloaded: true });
    const t = createLocalTranscriber(bridge);
    const { sessionId } = await t.start({ model: "QuantizedTinyEn", language: "en" });
    await expect(stopWith(bridge, t, sessionId, failedTranscription(sessionId, "stalled"))).rejects.toBeInstanceOf(
      TranscriptionFailedError,
    );
    // A new recording never replaces one still waiting to be transcribed.
    await expect(t.start({ model: "QuantizedTinyEn", language: "en" })).rejects.toThrow("waiting to be transcribed");

    t.discardRecording();
    await expect(t.retryTranscription()).rejects.toThrow("No recording is waiting to be transcribed");
    expect(startTranscriptionCalls(bridge)).toBe(1);
    await expect(t.start({ model: "QuantizedTinyEn", language: "en" })).resolves.toBeTruthy();
  });

  test("closing the view during transcription hands the job to the next view, which takes its transcript once", async () => {
    const bridge = makeBridge({ modelDownloaded: true });
    const closed = createLocalTranscriber(bridge);
    const { sessionId } = await closed.start({ model: "QuantizedTinyEn", language: "en" });
    const stopping = closed.stop().catch((e: unknown) => e);
    await tick();
    bridge.emitCaptureLifecycle(stoppedEvent(sessionId));
    await tick();
    expect(startTranscriptionCalls(bridge)).toBe(1);
    // Capture has ended, so unmount has nothing to stop; the transcription keeps running natively.
    await closed.stopCaptureOnUnmount();

    const remounted = createLocalTranscriber(bridge);
    // The single-job Whisper server is busy: no new capture meanwhile.
    await expect(remounted.start({ model: "QuantizedTinyEn", language: "en" })).rejects.toThrow("still being transcribed");
    const adopted = remounted.adoptTranscription();
    expect(adopted).not.toBeNull();
    expect(createLocalTranscriber(bridge).adoptTranscription()).toBeNull();

    bridge.emitTranscription(completedEvent(sessionId));
    await expect(adopted).resolves.toMatchObject({ sessionId });
    // The closed view's stop() never delivers it, so its stale callback cannot save it.
    expect(((await stopping) as Error).message).toContain("the next one takes over this transcription");
    expect(createLocalTranscriber(bridge).adoptTranscription()).toBeNull();

    await expect(remounted.start({ model: "QuantizedTinyEn", language: "en" })).resolves.toBeTruthy();
    expect(startCaptureCalls(bridge)).toBe(2);
    expect(startTranscriptionCalls(bridge)).toBe(1);
  });

  test("closing the view during a retry hands it on too; a transcript that lands with no view open waits for the next one", async () => {
    const bridge = makeBridge({ modelDownloaded: true });
    const closed = createLocalTranscriber(bridge);
    const { sessionId } = await closed.start({ model: "QuantizedTinyEn", language: "en" });
    await expect(stopWith(bridge, closed, sessionId, failedTranscription(sessionId, "stalled"))).rejects.toBeInstanceOf(
      TranscriptionFailedError,
    );
    const retrying = closed.retryTranscription().catch((e: unknown) => e);
    await tick();
    await closed.stopCaptureOnUnmount();
    bridge.emitTranscription(completedEvent(sessionId));
    expect(((await retrying) as Error).message).toContain("the next one takes over this transcription");

    const remounted = createLocalTranscriber(bridge);
    await expect(remounted.start({ model: "QuantizedTinyEn", language: "en" })).rejects.toThrow(
      "waiting to be transcribed or saved",
    );
    await expect(remounted.adoptTranscription()).resolves.toMatchObject({ sessionId });
    expect(createLocalTranscriber(bridge).adoptTranscription()).toBeNull();
    await expect(remounted.start({ model: "QuantizedTinyEn", language: "en" })).resolves.toBeTruthy();
    expect(startTranscriptionCalls(bridge)).toBe(2);
  });

  test("a transcription that fails after its view closed is kept for the next view's Retry or Discard", async () => {
    const bridge = makeBridge({ modelDownloaded: true });
    const closed = createLocalTranscriber(bridge);
    const { sessionId } = await closed.start({ model: "QuantizedTinyEn", language: "en" });
    const stopping = closed.stop().catch((e: unknown) => e);
    await tick();
    bridge.emitCaptureLifecycle(stoppedEvent(sessionId));
    await tick();
    await closed.stopCaptureOnUnmount();
    bridge.emitTranscription(failedTranscription(sessionId, "decoder crashed"));
    expect(await stopping).not.toBeInstanceOf(TranscriptionFailedError);

    const remounted = createLocalTranscriber(bridge);
    await expect(remounted.adoptTranscription()).rejects.toThrow(
      "Transcription failed (progressive_stream_timeout): decoder crashed",
    );
    // Recovery lives in the view that adopted it, not the closed one.
    await expect(closed.retryTranscription()).rejects.toThrow("No recording is waiting to be transcribed");
    const retry = remounted.retryTranscription();
    await tick();
    bridge.emitTranscription(completedEvent(sessionId));
    await expect(retry).resolves.toMatchObject({ sessionId });
    await expect(remounted.start({ model: "QuantizedTinyEn", language: "en" })).resolves.toBeTruthy();
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

  test("a timed-out start_capture is reconciled with native state and left as a previous recording to stop", async () => {
    const bridge = makeBridge({ modelDownloaded: true });
    let nativeState: "active" | "finalizing" | "inactive" = "active";
    bridge.transcription.getCaptureState = async () => ({ status: "ok", data: nativeState });
    const startCapture = bridge.transcription.startCapture;
    let session = "";
    let finishStart!: (r: { status: "ok"; data: null }) => void;
    bridge.transcription.startCapture = (params) => {
      session = params.session_id;
      bridge.calls.push("start_capture:hung");
      return new Promise((resolve) => { finishStart = resolve; });
    };
    const t = createLocalTranscriber(bridge, { timeouts: { captureStartMs: 20 } });

    const err = await t.start({ model: "QuantizedTinyEn", language: "en" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PreviousCaptureUnconfirmedError);
    expect((err as Error).message).toContain(
      "Starting the recording was not confirmed (Timed out waiting for start_capture); it may be recording. Native capture is active.",
    );
    expect((err as Error).message).toContain("start_capture has not returned yet");
    // Not assumed stopped: nothing new starts over it.
    await expect(t.start({ model: "QuantizedTinyEn", language: "en" })).rejects.toBeInstanceOf(
      PreviousCaptureUnconfirmedError,
    );
    expect(startCaptureCalls(bridge)).toBe(1);

    // The late start lands; "Stop previous recording" stops that exact session.
    finishStart({ status: "ok", data: null });
    const recovering = t.stopPreviousRecording();
    await tick();
    expect(stopCaptureCalls(bridge)).toBe(1);
    nativeState = "inactive";
    bridge.emitCaptureLifecycle(stoppedEvent(session));
    await recovering;

    bridge.transcription.startCapture = startCapture;
    await expect(t.start({ model: "QuantizedTinyEn", language: "en" })).resolves.toBeTruthy();
  });

  test("a start_capture that may still return keeps the previous recording unconfirmed even while native reads inactive", async () => {
    const bridge = makeBridge({ modelDownloaded: true });
    let finishStart!: (r: { status: "error"; error: string }) => void;
    bridge.transcription.startCapture = () => new Promise((resolve) => { finishStart = resolve; });
    const t = createLocalTranscriber(bridge, { timeouts: { captureStartMs: 20, captureStopMs: 20 } });
    await expect(t.start({ model: "QuantizedTinyEn", language: "en" })).rejects.toThrow(
      "Native capture is inactive. Its start_capture has not returned yet",
    );

    // Native reads inactive, but the start could still begin a capture: stop it and keep waiting.
    await expect(t.stopPreviousRecording()).rejects.toThrow("start_capture has not returned yet");
    expect(stopCaptureCalls(bridge)).toBe(1);

    // Once start_capture returns (here: it failed), inactive is conclusive.
    finishStart({ status: "error", error: "mic unavailable" });
    await tick();
    expect(await t.previousRecording()).toBeNull();
    expect(stopCaptureCalls(bridge)).toBe(1);
  });

  test("a hung start_server is bounded, and unmount does not wait on the pending start forever", async () => {
    const bridge = makeBridge({ modelDownloaded: true });
    const startServer = bridge.localStt.startServer;
    bridge.localStt.startServer = () => new Promise(() => {});
    const t = createLocalTranscriber(bridge, { timeouts: { serverStartMs: 20 } });
    const starting = t.start({ model: "QuantizedTinyEn", language: "en" });
    await tick();
    const closing = t.stopCaptureOnUnmount();
    await expect(starting).rejects.toThrow("Timed out waiting for the local Whisper server to start");
    await expect(closing).resolves.toBeUndefined();
    expect(startCaptureCalls(bridge)).toBe(0);

    bridge.localStt.startServer = startServer;
    await expect(createLocalTranscriber(bridge).start({ model: "QuantizedTinyEn", language: "en" })).resolves.toBeTruthy();
  });

  test("readiness reads, get_capture_state and listener registration are bounded", async () => {
    const bridge = makeBridge({ modelDownloaded: true });
    bridge.localStt.isModelDownloaded = () => new Promise(() => {});
    bridge.transcription.listMicrophoneDevices = () => new Promise(() => {});
    const t = createLocalTranscriber(bridge, { timeouts: { queryMs: 20, listenMs: 20, captureStopMs: 20 } });
    await expect(t.isModelDownloaded("QuantizedTinyEn")).rejects.toThrow("Timed out waiting for is_model_downloaded");
    await expect(t.ensureModel("QuantizedTinyEn")).rejects.toThrow("Timed out waiting for is_model_downloaded");
    await expect(t.listMicrophoneDevices()).rejects.toThrow("Timed out waiting for list_microphone_devices");

    // A previous recording whose native state cannot be read is an error, never "inactive".
    const closed = createLocalTranscriber(bridge, { timeouts: { captureStopMs: 20 } });
    await closed.start({ model: "QuantizedTinyEn", language: "en" });
    await expect(closed.stopCaptureOnUnmount()).rejects.toThrow("Timed out");
    bridge.transcription.getCaptureState = () => new Promise(() => {});
    await expect(t.previousRecording()).rejects.toThrow("Timed out waiting for get_capture_state");
    await expect(t.start({ model: "QuantizedTinyEn", language: "en" })).rejects.toThrow(
      "Timed out waiting for get_capture_state",
    );
    bridge.transcription.getCaptureState = async () => ({ status: "ok", data: "inactive" });

    // A listener registration that never completes fails the start instead of hanging it.
    const statusListen = bridge.transcription.events.captureStatusEvent.listen;
    bridge.transcription.events.captureStatusEvent.listen = () => new Promise(() => {});
    await expect(t.start({ model: "QuantizedTinyEn", language: "en" })).rejects.toThrow(
      "Timed out waiting for capture event listeners to register",
    );
    expect(bridge.listenerCounts().lifecycle).toBe(0);
    bridge.transcription.events.captureStatusEvent.listen = statusListen;
    await expect(t.start({ model: "QuantizedTinyEn", language: "en" })).resolves.toBeTruthy();
  });

  test("listener registration is all-or-nothing: a failed second listener releases the first, and Start retries cleanly", async () => {
    const bridge = makeBridge({ modelDownloaded: true });
    const statusListen = bridge.transcription.events.captureStatusEvent.listen;
    let failNext = true;
    bridge.transcription.events.captureStatusEvent.listen = async (cb) => {
      if (failNext) {
        failNext = false;
        throw new Error("event.listen not allowed");
      }
      return statusListen(cb);
    };
    const t = createLocalTranscriber(bridge);
    await expect(t.start({ model: "QuantizedTinyEn", language: "en" })).rejects.toThrow(
      "Registering capture event listeners failed: event.listen not allowed",
    );
    // The first listener registered, then was unlistened; the third was too.
    expect(bridge.listenerCounts()).toEqual({ lifecycle: 0, status: 0, transcription: 0 });
    expect(startCaptureCalls(bridge)).toBe(0);

    // The rejection was not memoized: the next Start registers every listener once.
    await expect(t.start({ model: "QuantizedTinyEn", language: "en" })).resolves.toBeTruthy();
    expect(bridge.listenerCounts()).toEqual({ lifecycle: 1, status: 1, transcription: 1 });
  });
});

/** Connector store backed by real SQLite plus an in-memory KV whose next puts can be failed. */
function sqliteStore() {
  const sqlite = new Database(":memory:");
  const kv = new Map<string, string>();
  let failingKvPuts = 0;
  const tcw = {
    did: `did:test:${crypto.randomUUID()}`,
    sql: {
      db: () => ({
        query: async (sql: string, params: unknown[] = []) => {
          try {
            return { ok: true, data: { rows: sqlite.query(sql).values(...(params as never[])) } };
          } catch (error) {
            return { ok: false, error: { code: "SQL", message: String(error) } };
          }
        },
        execute: async (sql: string, params: unknown[] = []) => {
          try {
            sqlite.query(sql).run(...(params as never[]));
            return { ok: true, data: { rows: [] } };
          } catch (error) {
            return { ok: false, error: { code: "SQL", message: String(error) } };
          }
        },
      }),
    },
    kv: {
      put: async (key: string, value: string) => {
        if (failingKvPuts > 0) {
          failingKvPuts--;
          return { ok: false, error: { code: "KV_UNAVAILABLE", message: "kv write failed" } };
        }
        kv.set(key, value);
        return { ok: true, data: null };
      },
    },
  } as never;
  return { tcw, sqlite, kv, failNextKvPut: () => { failingKvPuts++; } };
}

const ACCOUNT_A = "did:pkh:eip155:1:0xA";
const ACCOUNT_B = "did:pkh:eip155:1:0xB";

/** Kept recordings per account DID, like the localStorage store; `value` is account A's. */
function memoryKept() {
  const records = new Map<string, KeptLocalRecording>();
  const forAccount = (did: string): KeptRecordingStore => ({
    read: () => records.get(did) ?? null,
    write: (r) => void records.set(did, { ...r }),
    clear: () => void records.delete(did),
  });
  return {
    records,
    forAccount,
    get value() {
      return records.get(ACCOUNT_A) ?? null;
    },
    write: (r: KeptLocalRecording) => forAccount(ACCOUNT_A).write(r),
  };
}

/** Options for a transcriber signed in as `account` (a getter, so a test can switch accounts). */
function keptOptions(kept: ReturnType<typeof memoryKept>, account: () => string = () => ACCOUNT_A) {
  return { kept: kept.forAccount, account };
}

/** A fresh process: a new native identity (no in-memory jobs) sharing only the persisted store. */
function relaunch(kept: ReturnType<typeof memoryKept>, account = ACCOUNT_A) {
  const bridge = makeBridge({ modelDownloaded: true });
  return { bridge, t: createLocalTranscriber(bridge, keptOptions(kept, () => account)) };
}

describe("kept on-device recordings across a relaunch", () => {
  test("a recording stopped before Exo quit is offered on relaunch, and Transcribe saves it as an Exo Local meeting", async () => {
    const kept = memoryKept();
    const before = makeBridge({ modelDownloaded: true });
    const t = createLocalTranscriber(before, keptOptions(kept));
    const { sessionId } = await t.start({ model: "QuantizedBaseEn", language: "en" });
    void t.stop().catch(() => {});
    await tick();
    before.emitCaptureLifecycle(stoppedEvent(sessionId));
    await tick();
    // Persisted by the time Whisper runs; Exo quits before it finishes.
    expect(startTranscriptionCalls(before)).toBe(1);
    expect(kept.value).toEqual({
      sessionId,
      startedAt: expect.any(String),
      audioPath: "/vault/sessions/x/audio.mp3",
      model: "QuantizedBaseEn",
      language: "en",
    });

    const after = relaunch(kept);
    // The kept recording comes first: nothing new starts over it.
    await expect(after.t.start({ model: "QuantizedTinyEn", language: "en" })).rejects.toThrow("waiting to be transcribed");
    const offered = await after.t.resumeKeptRecording()!.catch((e: unknown) => e);
    expect(offered).toBeInstanceOf(KeptRecordingError);
    expect((offered as KeptRecordingError).retryable).toBe(true);
    expect((offered as Error).message).toContain("stopped, but its transcript was never saved");
    // Offered once: the job now belongs to this view.
    expect(after.t.resumeKeptRecording()).toBeNull();
    expect(startTranscriptionCalls(after.bridge)).toBe(0);

    const transcribing = after.t.retryTranscription();
    await tick();
    after.bridge.emitTranscription(completedEvent(sessionId));
    const result = (await transcribing) as OnDeviceTranscriptResult;
    expect(result).toMatchObject({ sessionId, startedAt: kept.value!.startedAt, model: "QuantizedBaseEn", language: "en" });
    expect(after.bridge.calls).toEqual([
      "start_server:QuantizedBaseEn",
      "start_transcription:whispercpp:/vault/sessions/x/audio.mp3",
    ]);
    // Taken but not yet saved: a quit now would still offer it again.
    expect(kept.value?.sessionId).toBe(sessionId);

    const store = sqliteStore();
    expect((await saveLocalTranscript(store.tcw, prepareLocalTranscript(result))).ok).toBe(true);
    after.t.finishOnDeviceTranscript(result);
    expect(store.sqlite.query("SELECT source, source_id FROM connector_meeting").values()).toEqual([
      [LOCAL_MEETING_SOURCE, `local:${sessionId}`],
    ]);
    expect(kept.value).toBeNull();
    expect(relaunch(kept).t.resumeKeptRecording()).toBeNull();
  });

  test("a relaunch after the transcript was saved offers nothing", async () => {
    const kept = memoryKept();
    const bridge = makeBridge({ modelDownloaded: true });
    const t = createLocalTranscriber(bridge, keptOptions(kept));
    const { sessionId } = await t.start({ model: "QuantizedTinyEn", language: "en" });
    const result = (await stopWith(bridge, t, sessionId, completedEvent(sessionId))) as OnDeviceTranscriptResult;
    t.finishOnDeviceTranscript(result);
    expect(kept.value).toBeNull();

    const after = relaunch(kept);
    expect(after.t.resumeKeptRecording()).toBeNull();
    await expect(after.t.start({ model: "QuantizedTinyEn", language: "en" })).resolves.toBeTruthy();
  });

  test("Discard forgets the kept recording, without transcribing it", async () => {
    const kept = memoryKept();
    const bridge = makeBridge({ modelDownloaded: true });
    const t = createLocalTranscriber(bridge, keptOptions(kept));
    const { sessionId } = await t.start({ model: "QuantizedTinyEn", language: "en" });
    await expect(stopWith(bridge, t, sessionId, failedTranscription(sessionId, "stalled"))).rejects.toBeInstanceOf(
      TranscriptionFailedError,
    );
    expect(kept.value?.sessionId).toBe(sessionId);

    const after = relaunch(kept);
    await expect(after.t.resumeKeptRecording()!).rejects.toBeInstanceOf(KeptRecordingError);
    after.t.discardRecording();
    expect(kept.value).toBeNull();
    expect(startTranscriptionCalls(after.bridge)).toBe(0);
    expect(relaunch(kept).t.resumeKeptRecording()).toBeNull();
    await expect(after.t.start({ model: "QuantizedTinyEn", language: "en" })).resolves.toBeTruthy();
  });

  test("a partial recording is kept across a relaunch too", async () => {
    const kept = memoryKept();
    const bridge = makeBridge({ modelDownloaded: true });
    const t = createLocalTranscriber(bridge, keptOptions(kept));
    const { sessionId } = await t.start({ model: "QuantizedTinyEn", language: "en" });
    const stopping = t.stop();
    await tick();
    bridge.emitCaptureLifecycle(stoppedEvent(sessionId, { error: "ActorFailed(mic stream closed)" }));
    await expect(stopping).rejects.toBeInstanceOf(PartialRecordingError);
    expect(kept.value?.sessionId).toBe(sessionId);
    await expect(relaunch(kept).t.resumeKeptRecording()!).rejects.toBeInstanceOf(KeptRecordingError);
  });

  test("a kept recording whose audio file is gone can only be discarded", async () => {
    const kept = memoryKept();
    kept.write({
      sessionId: "sess-gone",
      startedAt: "2026-10-05T09:00:00.000Z",
      audioPath: "/vault/sessions/sess-gone/audio.mp3",
      model: "QuantizedTinyEn",
      language: "en",
    });
    const after = relaunch(kept);
    await expect(after.t.resumeKeptRecording()!).rejects.toBeInstanceOf(KeptRecordingError);

    const transcribing = after.t.retryTranscription();
    await tick();
    // What whisper reports for a missing file (listener2-core's audio metadata read).
    after.bridge.emitTranscription({
      type: "failed",
      session_id: "sess-gone",
      code: "audio_metadata_read_failed",
      error: "Audio file not found. The recording may have been moved or deleted.",
    });
    const err = (await transcribing.catch((e: unknown) => e)) as TranscriptionFailedError;
    expect(err).toBeInstanceOf(TranscriptionFailedError);
    expect(err.message).toContain("Audio file not found");
    expect(err.retryable).toBe(false);
    // Still kept until the user discards it.
    expect(kept.value?.sessionId).toBe("sess-gone");
    after.t.discardRecording();
    expect(kept.value).toBeNull();
  });

  test("the localStorage store round-trips a record and ignores a malformed one", () => {
    const items = new Map<string, string>();
    const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (k: string) => items.get(k) ?? null,
        setItem: (k: string, v: string) => void items.set(k, v),
        removeItem: (k: string) => void items.delete(k),
      },
    });
    try {
      const record: KeptLocalRecording = {
        sessionId: "s-1",
        startedAt: "2026-10-05T09:00:00.000Z",
        audioPath: "/vault/sessions/s-1/audio.mp3",
        model: "QuantizedSmallEn",
        language: "en",
      };
      const a = localStorageKeptRecordingStore(ACCOUNT_A);
      const key = `${LOCAL_KEPT_RECORDING_KEY}:${ACCOUNT_A}`;
      a.write(record);
      expect(JSON.parse(items.get(key)!)).toEqual(record);
      expect(a.read()).toEqual(record);
      // Keyed by account: another account neither sees nor clears it.
      const b = localStorageKeptRecordingStore(ACCOUNT_B);
      expect(b.read()).toBeNull();
      b.clear();
      expect(a.read()).toEqual(record);
      // An unknown model falls back to the default rather than losing the recording.
      items.set(key, JSON.stringify({ ...record, model: "Retired" }));
      expect(a.read()?.model).toBe("QuantizedTinyEn");
      for (const raw of ["not json", "null", JSON.stringify({ ...record, audioPath: "" })]) {
        items.set(key, raw);
        expect(a.read()).toBeNull();
      }
      a.clear();
      expect(items.has(key)).toBe(false);
    } finally {
      if (original) Object.defineProperty(globalThis, "localStorage", original);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });
});

describe("private cloud pending records in localStorage", () => {
  test("are keyed per account; the old shared key is read only as the legacy record", () => {
    const items = new Map<string, string>();
    const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (k: string) => items.get(k) ?? null,
        setItem: (k: string, v: string) => void items.set(k, v),
        removeItem: (k: string) => void items.delete(k),
      },
    });
    try {
      const record: PendingCloudJob = {
        attemptId: "7d0b6f0e-3c1a-4b8e-9f2d-5a6b7c8d9e0f",
        transcriptionId: null,
        sessionId: "cloud-1",
        startedAt: "2026-10-05T09:00:00.000Z",
        language: "en",
        audioPath: "/vault/sessions/cloud-1/audio.mp3",
        submitted: false,
      };
      const a = localStoragePendingCloudStore(ACCOUNT_A);
      a.write(record);
      expect(JSON.parse(items.get(`${PRIVATE_CLOUD_PENDING_KEY}:${ACCOUNT_A}`)!)).toEqual(record);
      expect(a.read()).toEqual(record);
      // Another account neither sees nor clears it.
      const b = localStoragePendingCloudStore(ACCOUNT_B);
      expect(b.read()).toBeNull();
      b.clear();
      expect(a.read()).toEqual(record);
      // The pre-TC-772 shared key is not any account's record.
      expect(items.has(PRIVATE_CLOUD_PENDING_KEY)).toBe(false);
      items.set(
        PRIVATE_CLOUD_PENDING_KEY,
        JSON.stringify({ attemptId: "a-1", transcriptionId: "trn_1", sessionId: "cloud-0", startedAt: "2026-10-01T09:00:00.000Z", language: "en" }),
      );
      expect(b.read()).toBeNull();
      // It was written as its upload began, and knew no audio path.
      expect(legacyPendingCloudStore.read()).toMatchObject({ sessionId: "cloud-0", audioPath: "", submitted: true });
      a.clear();
      expect(items.has(`${PRIVATE_CLOUD_PENDING_KEY}:${ACCOUNT_A}`)).toBe(false);
    } finally {
      if (original) Object.defineProperty(globalThis, "localStorage", original);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });
});

describe("kept on-device recordings: accounts, closed views and saves in flight", () => {
  test("another account is never offered a kept recording, nor blocked by it; its owner is offered it on return", async () => {
    const kept = memoryKept();
    const bridge = makeBridge({ modelDownloaded: true });
    let signedIn = ACCOUNT_A;
    const opts = keptOptions(kept, () => signedIn);
    const a = createLocalTranscriber(bridge, opts);
    const { sessionId } = await a.start({ model: "QuantizedTinyEn", language: "en" });
    await expect(stopWith(bridge, a, sessionId, failedTranscription(sessionId, "stalled"))).rejects.toBeInstanceOf(
      TranscriptionFailedError,
    );
    await a.stopCaptureOnUnmount();

    // Sign out, sign in as B, same launch: A's failed job is still in memory.
    signedIn = ACCOUNT_B;
    const b = createLocalTranscriber(bridge, opts);
    expect(b.adoptTranscription()).toBeNull();
    expect(b.resumeKeptRecording()).toBeNull();
    const second = await b.start({ model: "QuantizedTinyEn", language: "en" });
    const result = (await stopWith(bridge, b, second.sessionId, completedEvent(second.sessionId))) as OnDeviceTranscriptResult;
    b.finishOnDeviceTranscript(result);
    expect(kept.records.get(ACCOUNT_B)).toBeUndefined();
    // B never overwrote or cleared A's.
    expect(kept.value?.sessionId).toBe(sessionId);
    await b.stopCaptureOnUnmount();

    signedIn = ACCOUNT_A;
    const back = createLocalTranscriber(bridge, opts);
    await expect(back.resumeKeptRecording()!).rejects.toBeInstanceOf(KeptRecordingError);
    const transcribing = back.retryTranscription();
    await tick();
    bridge.emitTranscription(completedEvent(sessionId));
    await expect(transcribing).resolves.toMatchObject({ sessionId });
  });

  test("another account is not offered a recording kept across a relaunch either", async () => {
    const kept = memoryKept();
    kept.write({
      sessionId: "sess-a",
      startedAt: "2026-10-05T09:00:00.000Z",
      audioPath: "/vault/sessions/sess-a/audio.mp3",
      model: "QuantizedTinyEn",
      language: "en",
    });
    const b = relaunch(kept, ACCOUNT_B);
    expect(b.t.resumeKeptRecording()).toBeNull();
    await expect(b.t.start({ model: "QuantizedTinyEn", language: "en" })).resolves.toBeTruthy();
    await expect(relaunch(kept, ACCOUNT_A).t.resumeKeptRecording()!).rejects.toBeInstanceOf(KeptRecordingError);
  });

  test("without an account nothing is kept across a relaunch", async () => {
    const kept = memoryKept();
    const bridge = makeBridge({ modelDownloaded: true });
    const t = createLocalTranscriber(bridge, { kept: kept.forAccount });
    const { sessionId } = await t.start({ model: "QuantizedTinyEn", language: "en" });
    await expect(stopWith(bridge, t, sessionId, failedTranscription(sessionId, "stalled"))).rejects.toBeInstanceOf(
      TranscriptionFailedError,
    );
    expect(kept.records.size).toBe(0);
  });

  test("closing the view while recording keeps the recording; the next view offers it and Transcribe saves it", async () => {
    const kept = memoryKept();
    const bridge = makeBridge({ modelDownloaded: true });
    const closed = createLocalTranscriber(bridge, keptOptions(kept));
    const { sessionId } = await closed.start({ model: "QuantizedSmallEn", language: "en" });
    const closing = closed.stopCaptureOnUnmount();
    await tick();
    bridge.emitCaptureLifecycle(stoppedEvent(sessionId));
    await closing;
    expect(kept.value).toMatchObject({ sessionId, audioPath: "/vault/sessions/x/audio.mp3", model: "QuantizedSmallEn" });
    expect(startTranscriptionCalls(bridge)).toBe(0);

    const next = createLocalTranscriber(bridge, keptOptions(kept));
    await expect(next.resumeKeptRecording()!).rejects.toBeInstanceOf(KeptRecordingError);
    const transcribing = next.retryTranscription();
    await tick();
    bridge.emitTranscription(completedEvent(sessionId));
    const result = (await transcribing) as OnDeviceTranscriptResult;
    expect(result).toMatchObject({ sessionId, model: "QuantizedSmallEn" });
    next.finishOnDeviceTranscript(result);
    expect(kept.value).toBeNull();
  });

  test("closing the view keeps a partial recording too, but nothing when capture left no audio file", async () => {
    const kept = memoryKept();
    const bridge = makeBridge({ modelDownloaded: true });
    const partial = createLocalTranscriber(bridge, keptOptions(kept));
    const first = await partial.start({ model: "QuantizedTinyEn", language: "en" });
    const closing = partial.stopCaptureOnUnmount();
    await tick();
    bridge.emitCaptureLifecycle(stoppedEvent(first.sessionId, { error: "ActorFailed(mic stream closed)" }));
    await closing;
    expect(kept.value?.sessionId).toBe(first.sessionId);
    kept.records.clear();

    const empty = createLocalTranscriber(bridge, keptOptions(kept));
    const second = await empty.start({ model: "QuantizedTinyEn", language: "en" });
    const closingEmpty = empty.stopCaptureOnUnmount();
    await tick();
    bridge.emitCaptureLifecycle(stoppedEvent(second.sessionId, { audio_path: null, error: "no input" }));
    await closingEmpty;
    expect(kept.value).toBeNull();
  });

  test("a capture that ended on its own before Stop is kept when the view closes", async () => {
    const kept = memoryKept();
    const bridge = makeBridge({ modelDownloaded: true });
    const closed = createLocalTranscriber(bridge, keptOptions(kept));
    const { sessionId } = await closed.start({ model: "QuantizedTinyEn", language: "en" });
    // The mic stream closes mid-recording; the user leaves without pressing Stop.
    bridge.emitCaptureLifecycle(stoppedEvent(sessionId, { error: "ActorFailed(mic stream closed)" }));
    await closed.stopCaptureOnUnmount();
    expect(stopCaptureCalls(bridge)).toBe(0);
    expect(kept.value).toMatchObject({ sessionId, audioPath: "/vault/sessions/x/audio.mp3" });

    const next = createLocalTranscriber(bridge, keptOptions(kept));
    await expect(next.resumeKeptRecording()!).rejects.toBeInstanceOf(KeptRecordingError);
  });

  test("a Stop that timed out, whose stopped event came late, is kept when the view closes instead of Retry stop", async () => {
    const kept = memoryKept();
    const bridge = makeBridge({ modelDownloaded: true });
    const closed = createLocalTranscriber(bridge, { ...keptOptions(kept), timeouts: { captureStopMs: 20 } });
    const { sessionId } = await closed.start({ model: "QuantizedTinyEn", language: "en" });
    await expect(closed.stop()).rejects.toBeInstanceOf(CaptureStopUnconfirmedError);
    bridge.emitCaptureLifecycle(stoppedEvent(sessionId));
    await closed.stopCaptureOnUnmount();
    expect(stopCaptureCalls(bridge)).toBe(1);
    expect(kept.value?.sessionId).toBe(sessionId);

    const next = createLocalTranscriber(bridge, keptOptions(kept));
    await expect(next.resumeKeptRecording()!).rejects.toBeInstanceOf(KeptRecordingError);
    const transcribing = next.retryTranscription();
    await tick();
    bridge.emitTranscription(completedEvent(sessionId));
    await expect(transcribing).resolves.toMatchObject({ sessionId });
  });

  test("a recording whose transcript is being saved is not offered as kept; a failed save offers it again", async () => {
    const kept = memoryKept();
    const bridge = makeBridge({ modelDownloaded: true });
    const t = createLocalTranscriber(bridge, keptOptions(kept));
    const { sessionId } = await t.start({ model: "QuantizedTinyEn", language: "en" });
    const result = (await stopWith(bridge, t, sessionId, completedEvent(sessionId))) as OnDeviceTranscriptResult;
    let failSave!: (err: Error) => void;
    const saving = new Promise<void>((_, reject) => {
      failSave = reject;
    });
    t.savingOnDeviceTranscript(result, saving);
    await t.stopCaptureOnUnmount();

    // The view closed mid-save: the next one does not offer what is being saved.
    const next = createLocalTranscriber(bridge, keptOptions(kept));
    expect(next.resumeKeptRecording()).toBeNull();
    const settled = next.keptRecordingSave();
    expect(settled).not.toBeNull();
    failSave(new Error("TinyCloud unavailable"));
    await settled; // never rejects: it only says when to check again
    expect(next.keptRecordingSave()).toBeNull();
    await expect(next.resumeKeptRecording()!).rejects.toBeInstanceOf(KeptRecordingError);
  });
});

describe("prepareLocalTranscript", () => {
  test("refuses a transcript with no speech so silence is never saved as a meeting", () => {
    expect(() => prepareLocalTranscript(resultWith([]))).toThrow(NO_SPEECH_MESSAGE);
    expect(NO_SPEECH_MESSAGE).toBe("No speech was transcribed — nothing was saved.");
    expect(prepareLocalTranscript(resultWith([{ word: "hi", start: 0, end: 1, channel: 0 }])).sentences).toHaveLength(1);
  });
});

describe("LOCAL_WHISPER_MODELS", () => {
  test("sizes match anarlog's model_size_bytes in decimal MB", () => {
    const bytes: Record<string, number> = {
      QuantizedTiny: 43537433,
      QuantizedTinyEn: 43550795,
      QuantizedBase: 81768585,
      QuantizedBaseEn: 81781811,
      QuantizedSmall: 264464607,
      QuantizedSmallEn: 264477561,
      QuantizedLargeTurbo: 874188075,
    };
    for (const m of LOCAL_WHISPER_MODELS) {
      expect(m.approxSizeMb).toBe(Math.round(bytes[m.id]! / 1_000_000));
    }
  });
});

describe("saveLocalTranscript", () => {
  test("a retry of the identical prepared transcript repairs a failed KV write with one meeting", async () => {
    const store = sqliteStore();
    const prepared = prepareLocalTranscript(resultWith([{ word: "hello", start: 0, end: 1, channel: 0 }]));

    store.failNextKvPut();
    const first = await saveLocalTranscript(store.tcw, prepared);
    expect(first.ok).toBe(false);
    // The partial write: the row landed, the transcript body did not.
    expect(store.sqlite.query("SELECT COUNT(*) FROM connector_meeting").values()[0]![0]).toBe(1);
    expect(store.kv.size).toBe(0);

    const retry = await saveLocalTranscript(store.tcw, prepared);
    expect(retry).toEqual({ ok: true, data: expect.objectContaining({ id: prepared.meeting.id, inserted: false }) });
    const rows = store.sqlite.query("SELECT id, source, source_id FROM connector_meeting").values();
    expect(rows).toEqual([[prepared.meeting.id, LOCAL_MEETING_SOURCE, "local:sess-1"]]);
    expect(JSON.parse(store.kv.get(transcriptKvKey(LOCAL_MEETING_SOURCE, "local:sess-1"))!)).toEqual(prepared.sentences);
  });

  test("delegates to upsertMeeting with the prepared meeting and sentences", async () => {
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

    const r = await saveLocalTranscript(tcw, prepareLocalTranscript(resultWith([{ word: "hi", start: 0, end: 1, channel: 0 }])));
    expect(r.ok).toBe(true);
    const insert = writes.find((w) => w.sql.startsWith("INSERT INTO connector_meeting"));
    expect(insert).toBeTruthy();
    expect(insert!.params[1]).toBe(LOCAL_MEETING_SOURCE);
    expect(insert!.params[2]).toBe("local:sess-1");
    expect(kvPuts.some((k) => k.includes("exo-local/transcript/local:sess-1"))).toBe(true);
  });

  test("a timed-out save keeps the transcript; its retry waits for the first write instead of writing beside it", async () => {
    const prepared = prepareLocalTranscript(resultWith([{ word: "hello", start: 0, end: 1, channel: 0 }]));
    let calls = 0;
    let writing = 0;
    let maxWriting = 0;
    let finishFirst!: () => void;
    const saved = { ok: true as const, data: { id: prepared.meeting.id, inserted: true, createdAt: "2026-09-28T18:00:00.000Z" } };
    const save = async (_tcw: unknown, p: typeof prepared) => {
      expect(p).toBe(prepared);
      calls++;
      writing++;
      maxWriting = Math.max(maxWriting, writing);
      try {
        if (calls === 1) await new Promise<void>((resolve) => { finishFirst = resolve; });
        return saved;
      } finally {
        writing--;
      }
    };
    const saveTranscript = createLocalTranscriptSaver({} as never, { timeoutMs: 50, save: save as never });

    await expect(saveTranscript(prepared)).rejects.toThrow("Timed out waiting for TinyCloud to save the transcript");
    const retry = saveTranscript(prepared);
    // A concurrent second retry is refused rather than queued beside it.
    await expect(saveTranscript(prepared)).rejects.toThrow("already being saved");
    await tick();
    expect(calls).toBe(1);
    finishFirst();
    await expect(retry).resolves.toEqual(saved);
    expect(calls).toBe(2);
    expect(maxWriting).toBe(1);
  });

  test("a retry while the timed-out save is still writing is itself bounded and writes nothing", async () => {
    const prepared = prepareLocalTranscript(resultWith([{ word: "hello", start: 0, end: 1, channel: 0 }]));
    let calls = 0;
    const save = () => {
      calls++;
      return new Promise<never>(() => {});
    };
    const saveTranscript = createLocalTranscriptSaver({} as never, { timeoutMs: 20, save: save as never });
    await expect(saveTranscript(prepared)).rejects.toThrow("Timed out waiting for TinyCloud to save the transcript");
    await expect(saveTranscript(prepared)).rejects.toThrow("Timed out waiting for the previous save to finish");
    expect(calls).toBe(1);
  });
});
