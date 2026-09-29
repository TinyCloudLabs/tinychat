// Private cloud engine in the Local transcriber, driven through fakes: the
// plugin bridge (capture), the Exo native cloud commands (capture handle,
// submit, cancel) and the backend API (status, result, delete), with a fake
// clock for polling.
//
// Asserted behavior:
//   - a cloud recording never starts Whisper; capture runs in batch mode and
//     the capture-ready listener is registered before capture starts;
//   - Stop → capture handle → submit (attempt id, compiled backend, bearer) →
//     poll → transcript, saved as the same exo-local meeting with engine
//     metadata, then deleted from PTX and the handle released;
//   - a missing capture handle or an oversize recording is a kept-recording
//     failure without Retry; only an explicit "Transcribe on this Mac" runs Whisper;
//   - post-acceptance recovery is status-only: after any failed upload of a
//     created job, status decides — a lost 201 (the upload landed) continues
//     polling with no second upload and no user action; awaiting_upload keeps
//     the recording and Retry re-uploads the SAME attempt; a PTX-side failure
//     retries as a NEW attempt; someone else's active job is never adopted;
//   - polling rides out 10 minutes of transient failures (backing off to 30 s
//     after one minute), then reports connection lost, and Keep waiting
//     resumes polling without re-uploading;
//   - a job left by a relaunch resumes from the persisted pending record;
//   - availability needs both native configuration and the backend's 200.

import { describe, expect, test } from "bun:test";

import {
  CloudConnectionLostError,
  createLocalTranscriber,
  normalizeLocalTranscript,
  TranscriptionFailedError,
  type CloudTranscriptResult,
  type LocalTranscriberBridge,
  type LocalTranscriberStatus,
} from "./localTranscriber";
import {
  PrivateCloudError,
  type CaptureReadyEvent,
  type PendingCloudJob,
  type PendingCloudStore,
  type PrivateCloudApi,
  type PrivateCloudJob,
  type PrivateCloudNative,
  type PrivateCloudSubmitArgs,
  type PrivateCloudTranscript,
  type UploadProgressEvent,
} from "./privateCloud";
import type { CaptureLifecycleEvent } from "./anarlog/transcription.gen";

const ID = "trn_01J8Z3K4M5N6P7Q8R9S0T1V2W3";
const OTHER_ID = "trn_01J8Z3K4M5N6P7Q8R9S0T1V2W4";

const TRANSCRIPT: PrivateCloudTranscript = {
  language: "en",
  duration_seconds: 26,
  provider: "tinfoil",
  model: "voxtral-small-24b",
  channels: 2,
  segments: [
    { id: "r2", speaker_id: "channel_1", channel: 1, start: 13, end: 16, text: "Good morning, this is Bob." },
    { id: "r1", speaker_id: "channel_0", channel: 0, start: 0, end: 4, text: "The quick brown fox, says Alice." },
    { id: "r3", speaker_id: "channel_0", channel: 0, start: 20, end: 21, text: "   " },
  ],
  text: "The quick brown fox, says Alice. Good morning, this is Bob.",
};

type Handler<T> = (e: { payload: T }) => void;

function makeBridge() {
  const calls: string[] = [];
  const lifecycle = new Set<Handler<CaptureLifecycleEvent>>();
  let active: string | null = null;
  const state = { onStopped: (_session: string) => {}, audioPath: "/vault/sessions/s/audio.mp3" };
  const bridge: LocalTranscriberBridge = {
    transcription: {
      listMicrophoneDevices: async () => ({ status: "ok", data: [] }),
      startCapture: async (p) => {
        calls.push(`start_capture:${p.transcription_mode}:${p.base_url}:${p.model}`);
        active = p.session_id;
        return { status: "ok", data: null };
      },
      stopCapture: async () => {
        calls.push("stop_capture");
        const session = active!;
        const stopped: CaptureLifecycleEvent = {
          type: "stopped",
          session_id: session,
          audio_path: state.audioPath,
          requested_live_transcription: false,
          live_transcription_active: false,
          error: null,
        };
        queueMicrotask(() => {
          lifecycle.forEach((cb) => cb({ payload: stopped }));
          state.onStopped(session);
        });
        return { status: "ok", data: null };
      },
      getCaptureState: async () => ({ status: "ok", data: "inactive" as const }),
      startTranscription: async (p) => {
        calls.push(`start_transcription:${p.file_path}`);
        return { status: "ok", data: null };
      },
      events: {
        captureLifecycleEvent: { listen: async (cb) => { lifecycle.add(cb); return () => lifecycle.delete(cb); } },
        captureStatusEvent: { listen: async () => () => {} },
        transcriptionEvent: { listen: async () => () => {} },
      },
    },
    localStt: {
      isModelDownloaded: async () => ({ status: "ok", data: false }),
      downloadModel: async () => ({ status: "ok", data: null }),
      startServer: async (m) => {
        calls.push(`start_server:${m}`);
        return { status: "ok", data: "http://127.0.0.1:1/v1" };
      },
      events: { downloadProgressPayload: { listen: async () => () => {} } },
    },
  };
  return { bridge, calls, state };
}

function makeNative(opts: { configured?: boolean } = {}) {
  const ready = new Set<(e: CaptureReadyEvent) => void>();
  const progress = new Set<(e: UploadProgressEvent) => void>();
  const submits: PrivateCloudSubmitArgs[] = [];
  const cancels: string[] = [];
  const log: string[] = [];
  let submitImpl = async (_args: PrivateCloudSubmitArgs): Promise<{ transcriptionId: string; status: string | null }> => ({
    transcriptionId: ID,
    status: "queued",
  });
  const native: PrivateCloudNative = {
    status: async () => ({ configured: opts.configured ?? true }),
    submit: async (args) => {
      submits.push({ ...args });
      progress.forEach((cb) => cb({ captureHandle: args.captureHandle, sentBytes: 50, totalBytes: 100 }));
      return submitImpl(args);
    },
    cancel: async (h) => {
      cancels.push(h);
    },
    onCaptureReady: async (cb) => {
      log.push("listen:capture-ready");
      ready.add(cb);
      return () => ready.delete(cb);
    },
    onUploadProgress: async (cb) => {
      progress.add(cb);
      return () => progress.delete(cb);
    },
  };
  return {
    native,
    submits,
    cancels,
    log,
    emitReady: (e: CaptureReadyEvent) => ready.forEach((cb) => cb(e)),
    setSubmit: (fn: typeof submitImpl) => {
      submitImpl = fn;
    },
  };
}

type Step = () => PrivateCloudJob | Promise<PrivateCloudJob>;
const job = (status: PrivateCloudJob["status"], extra: Partial<PrivateCloudJob> = {}): Step => () => ({ id: ID, status, ...extra });
const failing = (code: string): Step => () => {
  throw new PrivateCloudError(code, code);
};

function makeApi(opts: { capabilities?: PrivateCloudApi["capabilities"] } = {}) {
  const calls: string[] = [];
  const gets: Step[] = [];
  const api: PrivateCloudApi = {
    backendUrl: "https://api.example",
    bearer: () => "tok",
    capabilities: opts.capabilities ?? (async () => ({ max_bytes: 120960000 })),
    get: async (id) => {
      calls.push(`get:${id}`);
      const next = gets.shift();
      if (!next) throw new Error(`unexpected get ${id}`);
      return next();
    },
    result: async (id) => {
      calls.push(`result:${id}`);
      return { status: "completed", transcript: TRANSCRIPT };
    },
    cancel: async (id) => {
      calls.push(`cancel:${id}`);
    },
    remove: async (id) => {
      calls.push(`remove:${id}`);
    },
  };
  return { api, calls, gets };
}

function memoryPending(initial: PendingCloudJob | null = null): PendingCloudStore & { value: PendingCloudJob | null } {
  const store = {
    value: initial,
    read: () => store.value,
    write: (j: PendingCloudJob) => {
      store.value = { ...j };
    },
    clear: () => {
      store.value = null;
    },
  };
  return store;
}

function fakeClock() {
  const clock = {
    t: 0,
    sleeps: [] as number[],
    now: () => clock.t,
    sleep: async (ms: number) => {
      clock.sleeps.push(ms);
      clock.t += ms;
    },
    random: () => 0.5, // jitter factor exactly 1.0
  };
  return clock;
}

function setup(opts: { configured?: boolean; capabilities?: PrivateCloudApi["capabilities"]; pending?: PendingCloudJob | null } = {}) {
  const b = makeBridge();
  const n = makeNative({ configured: opts.configured });
  const a = makeApi({ capabilities: opts.capabilities });
  const pending = memoryPending(opts.pending ?? null);
  const clock = fakeClock();
  let attempt = 0;
  const t = createLocalTranscriber(b.bridge, {
    timeouts: { captureReadyMs: 50 },
    cloud: {
      api: a.api,
      native: n.native,
      pending,
      clock,
      newAttemptId: () => `00000000-0000-4000-8000-00000000000${++attempt}`,
    },
  });
  const statuses: LocalTranscriberStatus[] = [];
  t.onStatus((s) => statuses.push(s));
  return { t, ...b, n, a, pending, clock, statuses };
}

/** Start a cloud recording; on stop, native reports the capture handle (or `ready`). */
async function recordAndStop(s: ReturnType<typeof setup>, ready?: Partial<CaptureReadyEvent> | null) {
  const { sessionId } = await s.t.start({ model: "QuantizedTinyEn", language: "en", engine: "private-cloud" });
  s.state.onStopped = (session) => {
    if (ready === null) return; // native never hands the recording over
    s.n.emitReady({ sessionId: session, captureHandle: "h1", sizeBytes: 100, format: "mp3", partial: false, ...ready });
  };
  return { sessionId, stopped: s.t.stop() };
}

describe("private cloud engine", () => {
  test("records without Whisper, uploads by handle, polls, and saves engine metadata", async () => {
    const s = setup();
    s.a.gets.push(job("queued", { progress: { queue_position: 2 } }), job("processing", { progress: { regions_completed: 3, regions_total: 9 } }), job("completed"));
    const { sessionId, stopped } = await recordAndStop(s);
    const result = (await stopped) as CloudTranscriptResult;

    expect(s.calls).toEqual(["start_capture:batch::", "stop_capture"]);
    expect(s.n.log[0]).toBe("listen:capture-ready");
    expect(s.n.submits).toEqual([
      {
        captureHandle: "h1",
        attemptId: "00000000-0000-4000-8000-000000000001",
        backendUrl: "https://api.example",
        bearer: "tok",
        language: "en",
      },
    ]);
    expect(result.engine).toBe("private-cloud");
    expect(result.transcriptionId).toBe(ID);
    expect(s.pending.value).toMatchObject({ sessionId, transcriptionId: ID });
    expect(s.statuses).toContainEqual({ kind: "uploading", pct: 50 });
    expect(s.statuses).toContainEqual({ kind: "cloud-processing", stage: "queued", queuePosition: 2, regionsCompleted: null, regionsTotal: null });
    expect(s.statuses).toContainEqual({ kind: "cloud-processing", stage: "processing", queuePosition: null, regionsCompleted: 3, regionsTotal: 9 });
    expect(s.clock.sleeps.every((ms) => ms === 5_000)).toBe(true);

    const { meeting, sentences } = normalizeLocalTranscript(result);
    expect(meeting.source).toBe("exo-local");
    expect(meeting.sourceId).toBe(`local:${sessionId}`);
    expect(meeting.metadata).toMatchObject({
      speaker_labels: "channel-you-others",
      transcription_engine: "private-cloud",
      transcript_provider: "tinycloud-private-transcription",
      inference_provider: "tinfoil",
      model: "voxtral-small-24b",
    });
    expect(Object.keys(meeting.metadata).join(",")).not.toContain("audio_path");
    expect(sentences.map((x) => [x.speaker_name, x.text])).toEqual([
      ["You", "The quick brown fox, says Alice."],
      ["Others", "Good morning, this is Bob."],
    ]);
    expect(meeting.durationSecs).toBe(26);

    await s.t.finishCloudTranscript(result);
    expect(s.n.cancels).toEqual(["h1"]);
    expect(s.a.calls.at(-1)).toBe(`remove:${ID}`);
    expect(s.pending.value).toBeNull();
  });

  test("no capture handle from native is kept for Discard only, never transcribed on-device", async () => {
    const s = setup();
    const { stopped } = await recordAndStop(s, null);
    const err = (await stopped.catch((e) => e)) as TranscriptionFailedError;
    expect(err).toBeInstanceOf(TranscriptionFailedError);
    expect(err.code).toBe("capture_not_available");
    expect(err.retryable).toBe(false);
    expect(s.n.submits).toHaveLength(0);
    expect(s.calls.some((c) => c.startsWith("start_server") || c.startsWith("start_transcription"))).toBe(false);
    s.t.discardRecording();
    await new Promise((r) => setTimeout(r, 0));
    expect(s.pending.value).toBeNull();
  });

  test("an oversize recording offers Transcribe on this Mac, which only runs when chosen", async () => {
    const s = setup();
    const { stopped } = await recordAndStop(s, {
      captureHandle: undefined,
      error: { code: "recording_too_long_for_cloud", message: "Private cloud transcription takes recordings up to 2 hours" },
    });
    const err = (await stopped.catch((e) => e)) as TranscriptionFailedError;
    expect(err.code).toBe("recording_too_long_for_cloud");
    expect(err.retryable).toBe(false);
    expect(err.offerOnDevice).toBe(true);
    expect(s.calls).toEqual(["start_capture:batch::", "stop_capture"]);

    const onDevice = s.t.retryTranscription({ onDevice: { model: "QuantizedBaseEn" } });
    await new Promise((r) => setTimeout(r, 0));
    expect(s.calls.slice(2)).toEqual(["start_server:QuantizedBaseEn", "start_transcription:/vault/sessions/s/audio.mp3"]);
    void onDevice.catch(() => {});
  });

  test("a failed upload that PTX never took: status says awaiting_upload, Retry re-uploads the SAME attempt", async () => {
    const s = setup();
    s.n.setSubmit(async () => {
      throw { code: "upload_interrupted", message: "PTX did not receive the whole recording", correlationId: "c-1", transcriptionId: ID };
    });
    s.a.gets.push(job("awaiting_upload"));
    const { stopped } = await recordAndStop(s);
    const err = (await stopped.catch((e) => e)) as TranscriptionFailedError;
    expect(err.code).toBe("upload_interrupted");
    expect(err.correlationId).toBe("c-1");
    expect(err.retryable).toBe(true);
    expect(s.a.calls).toEqual([`get:${ID}`]);

    s.n.setSubmit(async () => ({ transcriptionId: ID, status: "queued" }));
    s.a.gets.push(job("awaiting_upload"), job("completed"));
    const result = await s.t.retryTranscription();
    expect(result.engine).toBe("private-cloud");
    expect(s.n.submits.map((x) => x.attemptId)).toEqual([
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000001",
    ]);
    expect(s.a.calls[1]).toBe(`get:${ID}`);
  });

  test("a lost final response is recovered from status alone: no second upload, no Retry", async () => {
    // The 201 was lost; a replayed PUT would get 401 (capabilities die on acceptance).
    const s = setup();
    s.n.setSubmit(async () => {
      throw { code: "upload_outcome_unknown", message: "The upload connection failed", transcriptionId: ID };
    });
    s.a.gets.push(failing("service_unavailable"), job("queued"), job("processing"), job("completed"));
    const { stopped } = await recordAndStop(s);
    const result = (await stopped) as CloudTranscriptResult;
    expect(result.transcriptionId).toBe(ID);
    expect(s.n.submits).toHaveLength(1);
    expect(s.pending.value?.transcriptionId).toBe(ID);
  });

  test("an upload that failed the job retries as a new job after status confirms it", async () => {
    const s = setup();
    s.n.setSubmit(async () => {
      throw { code: "invalid_audio", message: "PTX rejected the recording", transcriptionId: ID };
    });
    s.a.gets.push(job("failed", { error: { code: "invalid_audio", message: "x" } }));
    const { stopped } = await recordAndStop(s);
    const err = (await stopped.catch((e) => e)) as TranscriptionFailedError;
    expect(err.code).toBe("invalid_audio");
    expect(err.retryable).toBe(false);
    expect(err.offerOnDevice).toBe(true);
  });

  test("a PTX-side failure retries as a NEW job; someone else's active job is never adopted", async () => {
    const s = setup();
    s.a.gets.push(job("failed", { error: { code: "provider_outcome_unknown", message: "x" } }));
    const { stopped } = await recordAndStop(s);
    const err = (await stopped.catch((e) => e)) as TranscriptionFailedError;
    expect(err.code).toBe("provider_outcome_unknown");
    expect(err.retryable).toBe(true);

    s.n.setSubmit(async () => {
      throw { code: "active_transcription_exists", message: "x", transcriptionId: OTHER_ID };
    });
    const busy = (await s.t.retryTranscription().catch((e) => e)) as TranscriptionFailedError;
    expect(busy.code).toBe("active_transcription_exists");
    expect(s.n.submits.map((x) => x.attemptId)).toEqual([
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
    ]);

    s.n.setSubmit(async () => ({ transcriptionId: ID, status: "queued" }));
    s.a.gets.push(job("completed"));
    await s.t.retryTranscription();
    // Same new attempt, and never a status read of the other job.
    expect(s.n.submits.at(-1)!.attemptId).toBe("00000000-0000-4000-8000-000000000002");
    expect(s.a.calls.some((c) => c.includes(OTHER_ID))).toBe(false);
  });

  test("polling rides out a backend redeploy, backing off to 30 s after a minute", async () => {
    const s = setup();
    // 9 minutes of transient failures, then the job completes.
    for (let i = 0; i < 12; i++) s.a.gets.push(failing(i % 2 ? "service_unavailable" : "offline"));
    for (let i = 0; i < 16; i++) s.a.gets.push(failing("http_5xx"));
    s.a.gets.push(job("processing"), job("completed"));
    const { stopped } = await recordAndStop(s);
    const result = await stopped;
    expect(result.engine).toBe("private-cloud");
    expect(s.clock.sleeps.slice(0, 12).every((ms) => ms === 5_000)).toBe(true);
    expect(s.clock.sleeps.slice(13, 28).every((ms) => ms === 30_000)).toBe(true);
    expect(s.clock.t).toBeLessThan(10 * 60_000);
  });

  test("10 minutes of transient failures is connection lost; Keep waiting resumes polling only", async () => {
    const s = setup();
    for (let i = 0; i < 40; i++) s.a.gets.push(failing("service_unavailable"));
    const { stopped } = await recordAndStop(s);
    const err = await stopped.catch((e) => e);
    expect(err).toBeInstanceOf(CloudConnectionLostError);
    expect(s.clock.t).toBeGreaterThanOrEqual(10 * 60_000);

    s.a.gets.length = 0;
    s.a.gets.push(job("completed"));
    const result = await s.t.retryTranscription();
    expect(result.engine).toBe("private-cloud");
    expect(s.n.submits).toHaveLength(1);
  });

  test("a non-transient polling failure is not ridden out", async () => {
    const s = setup();
    s.a.gets.push(failing("service_misconfigured"));
    const { stopped } = await recordAndStop(s);
    const err = (await stopped.catch((e) => e)) as TranscriptionFailedError;
    expect(err.code).toBe("service_misconfigured");
    expect(err.retryable).toBe(false);
    expect(s.clock.sleeps).toHaveLength(0);
  });

  test("a relaunch resumes an uploaded job from the pending record", async () => {
    const pending = { attemptId: "a-1", transcriptionId: ID, sessionId: "s-9", startedAt: "2026-09-29T10:00:00.000Z", language: "en" };
    const s = setup({ pending });
    s.a.gets.push(job("processing"), job("processing"), job("completed"));
    const resumed = s.t.resumeCloudTranscription();
    expect(resumed).not.toBeNull();
    const result = (await resumed!) as CloudTranscriptResult;
    expect(result.sessionId).toBe("s-9");
    expect(result.captureHandle).toBeNull();
    expect(s.n.submits).toHaveLength(0);
    expect(s.pending.value?.transcriptionId).toBe(ID); // kept until the save finishes
    await s.t.finishCloudTranscript(result);
    expect(s.pending.value).toBeNull();
    expect(s.n.cancels).toHaveLength(0);
  });

  test("a relaunch during the upload keeps the recording and offers Discard only", async () => {
    const s = setup({ pending: { attemptId: "a-1", transcriptionId: ID, sessionId: "s-9", startedAt: "2026-09-29T10:00:00.000Z", language: "en" } });
    s.a.gets.push(job("awaiting_upload"));
    const err = (await s.t.resumeCloudTranscription()!.catch((e) => e)) as TranscriptionFailedError;
    expect(err.code).toBe("upload_interrupted_by_quit");
    expect(err.retryable).toBe(false);
    expect(err.offerOnDevice).toBe(false);
    s.t.discardRecording();
    await new Promise((r) => setTimeout(r, 0));
    expect(s.a.calls.slice(-2)).toEqual([`cancel:${ID}`, `remove:${ID}`]);
    expect(s.pending.value).toBeNull();
  });

  test("availability needs native configuration and the backend's 200", async () => {
    let capabilityCalls = 0;
    const unconfigured = setup({
      configured: false,
      capabilities: async () => {
        capabilityCalls++;
        return { max_bytes: 1 };
      },
    });
    expect(await unconfigured.t.privateCloudAvailable()).toBe(false);
    expect(capabilityCalls).toBe(0);
    expect(await setup({ capabilities: async () => null }).t.privateCloudAvailable()).toBe(false);
    expect(await setup().t.privateCloudAvailable()).toBe(true);
    expect(await createLocalTranscriber(makeBridge().bridge).privateCloudAvailable()).toBe(false);
    await expect(
      createLocalTranscriber(makeBridge().bridge).start({ model: "QuantizedTinyEn", language: "en", engine: "private-cloud" }),
    ).rejects.toThrow("Private cloud transcription is not available");
  });

  test("the on-device engine is unchanged by the cloud wiring", async () => {
    const s = setup();
    await s.t.start({ model: "QuantizedTinyEn", language: "en" });
    expect(s.calls).toEqual(["start_server:QuantizedTinyEn", "start_capture:batch:http://127.0.0.1:1/v1:QuantizedTinyEn"]);
    expect(s.n.log).toHaveLength(0);
  });
});
