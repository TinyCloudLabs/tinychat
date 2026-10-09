// Private cloud engine in the Local transcriber, driven through fakes: the
// plugin bridge (capture), the Exo native cloud commands (capture handle,
// submit, cancel) and the backend API (status, result, delete), with a fake
// clock for polling.
//
// Asserted behavior:
//   - a cloud recording never starts Whisper; capture runs in batch mode and
//     the capture-ready listener is registered before capture starts;
//   - a cloud recording is never the on-device kept recording, until
//     "Transcribe on this Mac" moves it there (and forgets the cloud job);
//   - Stop → capture handle → submit (attempt id, compiled backend, bearer) →
//     poll → transcript, saved as the same exo-local meeting with engine
//     metadata, then deleted from PTX and the handle released;
//   - a missing capture handle or an oversize recording is a kept-recording
//     failure without Retry; only an explicit "Transcribe on this Mac" runs Whisper;
//   - post-acceptance recovery is status-only: after any failed upload of a
//     created job, status decides — a lost 201 (the upload landed) continues
//     polling with no second upload and no user action; awaiting_upload keeps
//     the recording and Retry re-uploads the SAME attempt; a PTX-side failure
//     retries as a NEW attempt;
//   - tenant-list recovery (plan §4.7): an active_transcription_exists names
//     another job of this account, which is finished and saved as its own
//     meeting before this recording uploads (same attempt); a relaunch with no
//     pending record, or whose pending job is gone, lists the account's jobs
//     and finishes the ones no recording here knows, skipping awaiting_upload;
//   - polling rides out 10 minutes of transient failures (backing off to 30 s
//     after one minute), then reports connection lost, and Keep waiting
//     resumes polling without re-uploading;
//   - a job left by a relaunch resumes from the persisted pending record;
//   - availability needs both native configuration and the backend's 200; a
//     failed check is "failed", not hidden; a clean 404 keeps the pending
//     record, offered for Transcribe on this Mac or Discard;
//   - cloud recordings use `cloud-` session ids (native opens only those);
//   - TC-772: the pending record is per account and written at Stop or when the
//     view closes mid-recording (also after capture ended on its own). The next
//     view or launch offers a recording never uploaded (Transcribe in private
//     cloud, Transcribe on this Mac, Discard), and re-sends an interrupted
//     upload; both re-open the audio by session id after a relaunch, always
//     with the record's attempt id (no duplicate job). Another account never
//     sees, resumes, overwrites or clears it; a set-aside job's handle is
//     released; the pre-TC-772 shared record goes only to the account that can
//     read its job.

import { describe, expect, test } from "bun:test";

import {
  CloudConnectionLostError,
  createLocalTranscriber,
  KeptRecordingError,
  normalizeLocalTranscript,
  unfinishedTranscriptOwners,
  TranscriptionFailedError,
  type CloudTranscriptResult,
  type KeptLocalRecording,
  type LocalTranscriberBridge,
  type LocalTranscriberStatus,
} from "./localTranscriber";
import {
  PrivateCloudError,
  type CaptureReadyEvent,
  type PendingCloudJob,
  type PrivateCloudApi,
  type PrivateCloudJob,
  type PrivateCloudNative,
  type PrivateCloudSubmitArgs,
  type PrivateCloudTranscript,
  type RecordStore,
  type UploadProgressEvent,
} from "./privateCloud";
import type { CaptureLifecycleEvent } from "./anarlog/transcription.gen";

const ID = "trn_01J8Z3K4M5N6P7Q8R9S0T1V2W3";
const ACCOUNT_A = "did:pkh:eip155:1:0xA";
const ACCOUNT_B = "did:pkh:eip155:1:0xB";
const ATTEMPT_1 = "00000000-0000-4000-8000-000000000001";
const AUDIO = "/vault/sessions/s/audio.mp3";
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
      stopServer: async () => { calls.push("stop_server"); return { status: "ok", data: true }; },
      events: { downloadProgressPayload: { listen: async () => () => {} } },
    },
  };
  /** The capture ends on its own (e.g. the mic stream closed), before any Stop. */
  const endCapture = (error: string | null = null) => {
    const stopped: CaptureLifecycleEvent = {
      type: "stopped",
      session_id: active!,
      audio_path: state.audioPath,
      requested_live_transcription: false,
      live_transcription_active: false,
      error,
    };
    lifecycle.forEach((cb) => cb({ payload: stopped }));
    state.onStopped(active!);
  };
  return { bridge, calls, state, endCapture };
}

function makeNative(opts: { configured?: boolean } = {}) {
  const ready = new Set<(e: CaptureReadyEvent) => void>();
  const progress = new Set<(e: UploadProgressEvent) => void>();
  const submits: PrivateCloudSubmitArgs[] = [];
  const cancels: string[] = [];
  const reopens: string[] = [];
  /** Session ids whose recording native can re-open (as on disk), and the handle it issues. */
  const onDisk = new Map<string, string>();
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
    reopen: async (sessionId) => {
      reopens.push(sessionId);
      const handle = onDisk.get(sessionId);
      if (handle === undefined) throw new PrivateCloudError("capture_not_available", "The recording is no longer on this Mac");
      return { captureHandle: handle, sizeBytes: 100, format: "mp3" };
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
    reopens,
    onDisk,
    log,
    emitReady: (e: CaptureReadyEvent) => ready.forEach((cb) => cb(e)),
    setSubmit: (fn: typeof submitImpl) => {
      submitImpl = fn;
    },
  };
}

type Step = () => PrivateCloudJob | Promise<PrivateCloudJob>;
const DESKTOP_JOB = { channel_mode: "separate", channel_labels: ["Speaker 1", "Speaker 2"] } as const;
const PHONE_JOB = { channel_mode: "mixed", channel_labels: ["Exo voice note"] } as const;
const job = (status: PrivateCloudJob["status"], extra: Partial<PrivateCloudJob> = {}): Step => () => ({ id: ID, status, ...extra });
const failing = (code: string): Step => () => {
  throw new PrivateCloudError(code, code);
};

function makeApi(opts: { capabilities?: PrivateCloudApi["capabilities"]; bearer?: PrivateCloudApi["bearer"] } = {}) {
  const calls: string[] = [];
  /** Status answers for ID (and any job without its own queue). */
  const gets: Step[] = [];
  /** Status answers for other jobs. */
  const getsById = new Map<string, Step[]>();
  const listed: PrivateCloudJob[] = [];
  const control = { removeFails: false };
  const api: PrivateCloudApi = {
    backendUrl: "https://api.example",
    bearer: opts.bearer ?? (() => "tok"),
    capabilities: opts.capabilities ?? (async () => ({ max_bytes: 120960000 })),
    // Jobs are this desktop's (its create's channel choices) unless a test says otherwise.
    list: async () => {
      calls.push("list");
      return listed.map((j) => ({ ...DESKTOP_JOB, ...j }));
    },
    get: async (id) => {
      calls.push(`get:${id}`);
      const next = (getsById.get(id) ?? gets).shift();
      if (!next) throw new Error(`unexpected get ${id}`);
      const answer = await next();
      return { ...DESKTOP_JOB, ...answer, id };
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
      if (control.removeFails) throw new PrivateCloudError("service_unavailable", "down");
    },
  };
  return { api, calls, gets, getsById, listed, control };
}

function memoryStore<T>(initial: T | null = null): RecordStore<T> & { value: T | null } {
  const store = {
    value: initial,
    read: () => store.value,
    write: (j: T) => {
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

function setup(
  opts: {
    configured?: boolean;
    capabilities?: PrivateCloudApi["capabilities"];
    bearer?: PrivateCloudApi["bearer"];
    pending?: Partial<PendingCloudJob> | null;
    legacy?: Partial<PendingCloudJob> | null;
  } = {},
) {
  const b = makeBridge();
  const n = makeNative({ configured: opts.configured });
  const a = makeApi({ capabilities: opts.capabilities, bearer: opts.bearer });
  /** Each account's pending record (per-account keys, like localStorage). */
  const pendingByAccount = new Map<string, ReturnType<typeof memoryStore<PendingCloudJob>>>();
  const pendingFor = (did: string) => {
    let store = pendingByAccount.get(did);
    if (store === undefined) {
      store = memoryStore<PendingCloudJob>();
      pendingByAccount.set(did, store);
    }
    return store;
  };
  const pending = pendingFor(ACCOUNT_A);
  if (opts.pending) pending.value = pendingRecord(opts.pending);
  const legacy = memoryStore<PendingCloudJob>(opts.legacy ? pendingRecord(opts.legacy) : null);
  const kept = memoryStore<KeptLocalRecording>();
  const clock = fakeClock();
  const recovered: CloudTranscriptResult[] = [];
  let attempt = 0;
  const options = {
    timeouts: { captureReadyMs: 50 },
    account: () => ACCOUNT_A,
    kept: () => kept,
    cloud: {
      api: a.api,
      native: n.native,
      pending: pendingFor,
      legacyPending: legacy,
      clock,
      newAttemptId: () => `00000000-0000-4000-8000-00000000000${++attempt}`,
      saveRecovered: async (r: CloudTranscriptResult) => {
        recovered.push(r);
      },
    },
  };
  const t = createLocalTranscriber(b.bridge, options);
  /** Another view on the same Mac, signed in as `account` (e.g. after sign-out and sign-in). */
  const remount = (account: string) => createLocalTranscriber(b.bridge, { ...options, account: () => account });
  /** Another view whose signed-in account is read live (a test can switch it). */
  const remountWith = (account: () => string | null) => createLocalTranscriber(b.bridge, { ...options, account });
  /** Exo relaunched, signed in as `account`: same localStorage and backend, but
   *  a new process (no capture-ready handles from before, a new native identity). */
  const relaunch = (account: string = ACCOUNT_A) => {
    const nb = makeBridge();
    const r = createLocalTranscriber(nb.bridge, { ...options, account: () => account });
    const rs: LocalTranscriberStatus[] = [];
    r.onStatus((x) => rs.push(x));
    return { t: r, statuses: rs, ...nb };
  };
  const statuses: LocalTranscriberStatus[] = [];
  t.onStatus((s) => statuses.push(s));
  return { t, ...b, n, a, pending, pendingFor, legacy, kept, clock, statuses, recovered, remount, remountWith, relaunch };
}

/** A pending record as Exo writes it (submitted: an upload began). */
function pendingRecord(p: Partial<PendingCloudJob>): PendingCloudJob {
  return {
    attemptId: "a-1",
    transcriptionId: null,
    sessionId: "cloud-s",
    startedAt: "2026-09-29T10:00:00.000Z",
    language: "en",
    audioPath: "",
    submitted: true,
    ...p,
  };
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

    expect(sessionId).toMatch(/^cloud-[0-9a-f-]{36}$/);
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
    expect(s.kept.value).toBeNull();

    const onDevice = s.t.retryTranscription({ onDevice: { model: "QuantizedBaseEn" } });
    await new Promise((r) => setTimeout(r, 0));
    expect(s.calls.slice(2)).toEqual(["start_server:QuantizedBaseEn", "start_transcription:/vault/sessions/s/audio.mp3"]);
    // Now an on-device recording: kept across a relaunch like one, and no longer a cloud job.
    expect(s.kept.value).toMatchObject({ audioPath: "/vault/sessions/s/audio.mp3", model: "QuantizedBaseEn" });
    expect(s.pending.value).toBeNull();
    void onDevice.catch(() => {});
  });

  test("another account is never blocked by, nor adopts, an idle private cloud job; that job is left for its account", async () => {
    const s = setup();
    s.n.setSubmit(async () => {
      throw { code: "upload_interrupted", message: "PTX did not receive the whole recording", correlationId: "c-1", transcriptionId: ID };
    });
    s.a.gets.push(job("awaiting_upload"));
    const { stopped } = await recordAndStop(s);
    await expect(stopped).rejects.toBeInstanceOf(TranscriptionFailedError);
    expect(s.pending.value?.transcriptionId).toBe(ID);
    await s.t.stopCaptureOnUnmount();

    const b = s.remount("did:pkh:eip155:1:0xB");
    expect(b.adoptTranscription()).toBeNull();
    await expect(b.start({ model: "QuantizedTinyEn", language: "en" })).resolves.toBeTruthy();
    await new Promise((r) => setTimeout(r, 0));
    // Set aside, not cancelled or deleted at PTX, and its pending record stays
    // (with its audio path); only its native upload handle is released.
    expect(s.a.calls.filter((c) => c.startsWith("cancel:") || c.startsWith("remove:"))).toEqual([]);
    expect(s.n.cancels).toEqual(["h1"]);
    expect(s.pending.value).toMatchObject({ transcriptionId: ID, audioPath: "/vault/sessions/s/audio.mp3" });
    expect(s.pendingFor("did:pkh:eip155:1:0xB").value).toBeNull();
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

  test("a PTX-side failure retries as a NEW job", async () => {
    const s = setup();
    s.a.gets.push(job("failed", { error: { code: "provider_outcome_unknown", message: "x" } }));
    const { stopped } = await recordAndStop(s);
    const err = (await stopped.catch((e) => e)) as TranscriptionFailedError;
    expect(err.code).toBe("provider_outcome_unknown");
    expect(err.retryable).toBe(true);

    s.a.gets.push(job("completed"));
    await s.t.retryTranscription();
    expect(s.n.submits.map((x) => x.attemptId)).toEqual([
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
    ]);
  });

  test("active_transcription_exists: the account's other job is finished and saved on its own, then this recording uploads", async () => {
    const s = setup();
    let submits = 0;
    s.n.setSubmit(async () => {
      if (++submits === 1) throw { code: "active_transcription_exists", message: "x", transcriptionId: OTHER_ID };
      return { transcriptionId: ID, status: "queued" };
    });
    s.a.getsById.set(OTHER_ID, [
      () => ({ id: OTHER_ID, status: "processing", duration_seconds: 600, created_at: "2026-09-29T10:10:00.000Z" }),
      () => ({ id: OTHER_ID, status: "completed" }),
    ]);
    s.a.gets.push(job("completed"));
    const { sessionId, stopped } = await recordAndStop(s);
    const result = (await stopped) as CloudTranscriptResult;

    // The other job's transcript became its own meeting, never this recording's.
    expect(s.recovered).toHaveLength(1);
    expect(s.recovered[0]!.transcriptionId).toBe(OTHER_ID);
    expect(s.recovered[0]!.sessionId).toBe(OTHER_ID);
    expect(s.recovered[0]!.startedAt).toBe("2026-09-29T10:00:00.000Z");
    expect(normalizeLocalTranscript(s.recovered[0]!).meeting.sourceId).toBe(`local:${OTHER_ID}`);
    expect(s.statuses).toContainEqual({ kind: "cloud-recovering" });
    // Then this recording uploaded, with the same attempt, into its own job.
    expect(s.n.submits.map((x) => x.attemptId)).toEqual([
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000001",
    ]);
    expect(result.transcriptionId).toBe(ID);
    expect(result.sessionId).toBe(sessionId);
  });

  test("connection lost while recovering another job re-enters submit on Retry, not a poll with no job id", async () => {
    const s = setup();
    let submits = 0;
    s.n.setSubmit(async () => {
      if (++submits === 1) throw { code: "active_transcription_exists", message: "x", transcriptionId: OTHER_ID };
      return { transcriptionId: ID, status: "queued" };
    });
    // Reading the other job fails transiently for longer than the 10-minute window.
    s.a.getsById.set(OTHER_ID, Array.from({ length: 40 }, () => failing("service_unavailable")));
    const { sessionId, stopped } = await recordAndStop(s);
    const err = await stopped.catch((e) => e);
    expect(err).toBeInstanceOf(CloudConnectionLostError);
    expect(s.n.submits).toHaveLength(1);

    // Retry goes back to submit (same attempt), which now creates this recording's own job.
    s.a.getsById.set(OTHER_ID, [() => ({ id: OTHER_ID, status: "completed" })]);
    s.a.gets.push(job("completed"));
    const result = (await s.t.retryTranscription()) as CloudTranscriptResult;
    expect(s.n.submits.map((x) => x.attemptId)).toEqual([
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000001",
    ]);
    expect(result.transcriptionId).toBe(ID);
    expect(result.sessionId).toBe(sessionId);
  });

  test("active_transcription_exists for a job awaiting another upload keeps this recording, offering on-device", async () => {
    const s = setup();
    s.n.setSubmit(async () => {
      throw { code: "active_transcription_exists", message: "x", transcriptionId: OTHER_ID };
    });
    s.a.getsById.set(OTHER_ID, [() => ({ id: OTHER_ID, status: "awaiting_upload" })]);
    const { stopped } = await recordAndStop(s);
    const err = (await stopped.catch((e) => e)) as TranscriptionFailedError;
    expect(err.code).toBe("active_transcription_exists");
    expect(err.retryable).toBe(true);
    expect(err.offerOnDevice).toBe(true);
    expect(s.recovered).toHaveLength(0);
    expect(s.n.submits).toHaveLength(1);
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

  test("a relaunch during the upload re-opens the recording and re-sends it with the SAME attempt", async () => {
    const s = setup({ pending: { attemptId: "a-1", transcriptionId: ID, sessionId: "cloud-s", audioPath: "/vault/sessions/cloud-s/audio.mp3" } });
    s.n.onDisk.set("cloud-s", "h9");
    s.a.gets.push(job("awaiting_upload"), job("completed"));
    const result = (await s.t.resumeCloudTranscription()!) as CloudTranscriptResult;
    expect(s.n.reopens).toEqual(["cloud-s"]);
    expect(s.n.submits.map((x) => [x.captureHandle, x.attemptId])).toEqual([["h9", "a-1"]]);
    expect(result.transcriptionId).toBe(ID);
    expect(result.captureHandle).toBe("h9");
    await s.t.finishCloudTranscript(result);
    expect(s.n.cancels).toEqual(["h9"]);
    expect(s.pending.value).toBeNull();
  });

  test("a relaunch during the upload whose audio is gone keeps the record for Discard only", async () => {
    const s = setup({ pending: { attemptId: "a-1", transcriptionId: ID, sessionId: "cloud-s" } });
    s.a.gets.push(job("awaiting_upload"));
    const err = (await s.t.resumeCloudTranscription()!.catch((e) => e)) as TranscriptionFailedError;
    expect(err.code).toBe("capture_not_available");
    expect(err.retryable).toBe(false);
    expect(err.offerOnDevice).toBe(false);
    expect(s.n.submits).toHaveLength(0);
    expect(s.pending.value?.transcriptionId).toBe(ID);
    s.t.discardRecording();
    await new Promise((r) => setTimeout(r, 0));
    expect(s.a.calls.slice(-2)).toEqual([`cancel:${ID}`, `remove:${ID}`]);
    expect(s.pending.value).toBeNull();
  });

  test("relaunch without a pending record: the tenant list's unknown jobs are finished and saved", async () => {
    const s = setup();
    s.a.listed.push(
      { id: OTHER_ID, status: "completed", duration_seconds: 60, created_at: "2026-09-29T10:01:00.000Z" },
      { id: ID, status: "queued", created_at: "2026-09-29T11:00:00.000Z" },
      { id: "trn_01J8Z3K4M5N6P7Q8R9S0T1V2W5", status: "awaiting_upload" },
      { id: "trn_01J8Z3K4M5N6P7Q8R9S0T1V2W6", status: "failed", error: { code: "invalid_audio" } },
    );
    s.a.getsById.set(OTHER_ID, [() => ({ id: OTHER_ID, status: "completed", duration_seconds: 60, created_at: "2026-09-29T10:01:00.000Z" }), () => ({ id: OTHER_ID, status: "completed" })]);
    // Every status carries created_at (the backend's DTO requires it).
    const queuedAt = { created_at: "2026-09-29T11:00:00.000Z" };
    s.a.getsById.set(ID, [
      () => ({ id: ID, status: "queued", ...queuedAt }),
      () => ({ id: ID, status: "processing", ...queuedAt }),
      () => ({ id: ID, status: "completed", ...queuedAt }),
    ]);
    expect(s.t.resumeCloudTranscription()).toBeNull();
    expect(await s.t.recoverCloudTranscripts()).toBe(2);
    expect(s.recovered.map((r) => [r.transcriptionId, r.startedAt])).toEqual([
      [OTHER_ID, "2026-09-29T10:00:00.000Z"],
      [ID, "2026-09-29T11:00:00.000Z"],
    ]);
    // Never touched: the job awaiting its recording's upload, and the failed one.
    expect(s.a.calls.filter((c) => c.includes("V2W5") || c.includes("V2W6"))).toEqual([]);
  });

  test("recovery never adopts another client's job: a phone's voice note, or one it cannot identify", async () => {
    const s = setup();
    const PHONE = "trn_01J8Z3K4M5N6P7Q8R9S0T1V2W7";
    const UNLABELLED = "trn_01J8Z3K4M5N6P7Q8R9S0T1V2W8";
    s.a.listed.push(
      { id: PHONE, status: "completed", ...PHONE_JOB },
      { id: UNLABELLED, status: "completed", channel_mode: null, channel_labels: null },
    );
    expect(await s.t.recoverCloudTranscripts()).toBe(0);
    // Not read, not saved, not deleted: the phone finishes and deletes its own job.
    expect(s.a.calls).toEqual(["list"]);
    expect(s.recovered).toHaveLength(0);
  });

  test("active_transcription_exists naming a phone's job: not adopted; this recording waits (Retry)", async () => {
    const s = setup();
    s.n.setSubmit(async () => {
      throw { code: "active_transcription_exists", message: "x", transcriptionId: OTHER_ID };
    });
    s.a.getsById.set(OTHER_ID, [() => ({ id: OTHER_ID, status: "processing", ...PHONE_JOB })]);
    const { stopped } = await recordAndStop(s);
    const err = (await stopped.catch((e) => e)) as TranscriptionFailedError;
    expect(err.code).toBe("active_transcription_exists");
    expect(err.retryable).toBe(true);
    expect(s.recovered).toHaveLength(0);
    expect(s.a.calls.filter((c) => c.startsWith("result:") || c.startsWith("remove:"))).toEqual([]);
  });

  test("recovery skips the job a pending record or the current recording owns", async () => {
    const s = setup({ pending: { attemptId: "a-1", transcriptionId: ID, sessionId: "cloud-s", startedAt: "2026-09-29T10:00:00.000Z", language: "en" } });
    s.a.listed.push({ id: ID, status: "completed" });
    expect(await s.t.recoverCloudTranscripts()).toBe(0);
    expect(s.a.calls).toEqual(["list"]);
  });

  test("relaunch whose pending job is gone forgets it (no failure) and leaves recovery to the list", async () => {
    const s = setup({ pending: { attemptId: "a-1", transcriptionId: ID, sessionId: "cloud-s", startedAt: "2026-09-29T10:00:00.000Z", language: "en" } });
    s.a.gets.push(failing("transcription_not_found"));
    const resumed = s.t.resumeCloudTranscription();
    expect(await resumed!).toBeNull();
    expect(s.pending.value).toBeNull();
    expect(s.statuses.at(-1)).toEqual({ kind: "idle" });
    // Nothing is left for Retry/Discard: a new recording can start.
    await s.t.start({ model: "QuantizedTinyEn", language: "en", engine: "private-cloud" });
  });

  test("the pending record outlives a failed PTX delete, so a relaunch finishes it again", async () => {
    const s = setup();
    s.a.gets.push(job("completed"));
    const { stopped } = await recordAndStop(s);
    const result = (await stopped) as CloudTranscriptResult;
    s.a.control.removeFails = true;
    await expect(s.t.finishCloudTranscript(result)).rejects.toThrow("down");
    expect(s.pending.value?.transcriptionId).toBe(ID);
    s.a.control.removeFails = false;
    await s.t.finishCloudTranscript(result);
    expect(s.pending.value).toBeNull();
  });

  test("availability needs native configuration and the backend's 200; a failed check is not a no", async () => {
    let capabilityCalls = 0;
    const unconfigured = setup({
      configured: false,
      capabilities: async () => {
        capabilityCalls++;
        return { max_bytes: 1 };
      },
    });
    expect(await unconfigured.t.privateCloudAvailability()).toBe("hidden");
    expect(capabilityCalls).toBe(0);
    expect(await setup().t.privateCloudAvailability()).toBe("available");
    expect(await createLocalTranscriber(makeBridge().bridge).privateCloudAvailability()).toBe("hidden");
    const offline = setup({
      capabilities: async () => {
        throw new PrivateCloudError("offline", "Could not reach the backend");
      },
      pending: { attemptId: "a-1", transcriptionId: ID, sessionId: "cloud-s", startedAt: "2026-09-29T10:00:00.000Z", language: "en" },
    });
    expect(await offline.t.privateCloudAvailability()).toBe("failed");
    expect(offline.pending.value).not.toBeNull();
    // A clean 404 (dark, or not in the cohort) hides the engine but keeps the
    // pending job's record (TC-772: an interrupted upload is otherwise lost).
    const dark = setup({
      capabilities: async () => null,
      pending: { attemptId: "a-1", transcriptionId: ID, sessionId: "cloud-s", startedAt: "2026-09-29T10:00:00.000Z", language: "en" },
    });
    expect(await dark.t.privateCloudAvailability()).toBe("hidden");
    expect(dark.pending.value?.transcriptionId).toBe(ID);
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

/** Let pending microtasks and zero-delay timers run. */
async function settle(rounds = 20) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
}

/** Start a cloud recording, then close the view mid-recording (native hands
 *  this launch the capture handle `h1` once it stops). */
async function recordAndClose(s: ReturnType<typeof setup>) {
  const { sessionId } = await s.t.start({ model: "QuantizedTinyEn", language: "en", engine: "private-cloud" });
  s.state.onStopped = (session) =>
    s.n.emitReady({ sessionId: session, captureHandle: "h1", sizeBytes: 100, format: "mp3", partial: false });
  await s.t.stopCaptureOnUnmount();
  return sessionId;
}

describe("private cloud recordings kept across a closed view or relaunch (TC-772)", () => {
  test("Stop records the recording under its account before any upload, and marks it once the upload starts", async () => {
    const s = setup();
    const { sessionId, stopped } = await recordAndStop(s, null); // native never hands it over
    await expect(stopped).rejects.toBeInstanceOf(TranscriptionFailedError);
    expect(s.pending.value).toEqual({
      attemptId: ATTEMPT_1,
      transcriptionId: null,
      sessionId,
      startedAt: expect.any(String),
      language: "en",
      audioPath: AUDIO,
      submitted: false,
    });

    const u = setup();
    let accept!: () => void;
    u.n.setSubmit(() => new Promise((resolve) => (accept = () => resolve({ transcriptionId: ID, status: "queued" }))));
    u.a.gets.push(job("completed"));
    const run = await recordAndStop(u);
    await settle();
    expect(u.n.submits).toHaveLength(1);
    expect(u.pending.value).toMatchObject({ sessionId: run.sessionId, transcriptionId: null, submitted: true, audioPath: AUDIO });
    accept();
    await run.stopped;
    expect(u.pending.value).toMatchObject({ transcriptionId: ID });
  });

  test("closing the view mid-recording keeps it unuploaded; the next view offers it and Transcribe uploads it", async () => {
    const s = setup();
    const sessionId = await recordAndClose(s);
    expect(s.calls).toEqual(["start_capture:batch::", "stop_capture"]);
    expect(s.n.submits).toHaveLength(0);
    expect(s.pending.value).toEqual({
      attemptId: ATTEMPT_1,
      transcriptionId: null,
      sessionId,
      startedAt: expect.any(String),
      language: "en",
      audioPath: AUDIO,
      submitted: false,
    });

    const v = s.remount(ACCOUNT_A);
    expect(v.adoptTranscription()).toBeNull();
    // Not resumed on its own (Stop was never pressed), and nothing new starts over it.
    expect(v.resumeCloudTranscription()).toBeNull();
    await expect(v.start({ model: "QuantizedTinyEn", language: "en", engine: "private-cloud" })).rejects.toThrow(
      "waiting to be transcribed",
    );
    const offered = (await v.resumeKeptRecording()!.catch((e) => e)) as KeptRecordingError;
    expect(offered).toBeInstanceOf(KeptRecordingError);
    expect(offered.engine).toBe("private-cloud");
    expect(offered.offerOnDevice).toBe(true);
    expect(offered.message).toContain("before it was uploaded");
    expect(s.n.submits).toHaveLength(0);

    s.a.gets.push(job("completed"));
    const result = (await v.retryTranscription()) as CloudTranscriptResult;
    // This launch still holds the recording's handle: no re-open needed.
    expect(s.n.reopens).toEqual([]);
    expect(s.n.submits.map((x) => [x.captureHandle, x.attemptId])).toEqual([["h1", ATTEMPT_1]]);
    expect(result.sessionId).toBe(sessionId);
    expect(s.pending.value).toMatchObject({ transcriptionId: ID, submitted: true });
    await v.finishCloudTranscript(result);
    expect(s.n.cancels).toEqual(["h1"]);
    expect(s.pending.value).toBeNull();
  });

  test("after a relaunch, Transcribe re-opens the recording by session id and uploads it with the record's attempt", async () => {
    const s = setup();
    const sessionId = await recordAndClose(s);
    const r = s.relaunch();
    s.n.onDisk.set(sessionId, "h7");
    const offered = (await r.t.resumeKeptRecording()!.catch((e) => e)) as KeptRecordingError;
    expect(offered.engine).toBe("private-cloud");
    s.a.gets.push(job("processing"), job("completed"));
    const result = (await r.t.retryTranscription()) as CloudTranscriptResult;
    expect(s.n.reopens).toEqual([sessionId]);
    expect(s.n.submits).toEqual([
      { captureHandle: "h7", attemptId: ATTEMPT_1, backendUrl: "https://api.example", bearer: "tok", language: "en" },
    ]);
    expect(result).toMatchObject({ sessionId, transcriptionId: ID, captureHandle: "h7" });
    expect(r.statuses).toContainEqual({ kind: "uploading", pct: 50 });
  });

  test("an expired bearer at Stop keeps A's recording for a fresh sign-in after relaunch, never B", async () => {
    let bearer: string | null = null;
    const s = setup({ bearer: () => bearer });
    const { sessionId, stopped } = await recordAndStop(s);
    await expect(stopped).rejects.toMatchObject({ code: "unauthenticated", message: "Your session expired. Sign in again, then retry." });
    expect(s.n.submits).toEqual([]);
    expect(s.pending.value).toMatchObject({
      sessionId,
      attemptId: ATTEMPT_1,
      transcriptionId: null,
      audioPath: AUDIO,
      submitted: false,
    });

    bearer = "fresh";
    const b = s.relaunch(ACCOUNT_B);
    expect(b.t.adoptTranscription()).toBeNull();
    expect(b.t.resumeCloudTranscription()).toBeNull();
    expect(b.t.resumeKeptRecording()).toBeNull();
    await expect(b.t.retryTranscription()).rejects.toThrow("No recording is waiting to be transcribed");
    expect(s.pendingFor(ACCOUNT_B).value).toBeNull();
    expect(s.n.submits).toEqual([]);
    expect(s.pending.value).toMatchObject({ sessionId, attemptId: ATTEMPT_1, submitted: false });

    s.n.onDisk.set(sessionId, "h7");
    const a = s.relaunch(ACCOUNT_A);
    const offered = (await a.t.resumeKeptRecording()!.catch((e) => e)) as KeptRecordingError;
    expect(offered).toBeInstanceOf(KeptRecordingError);
    expect(offered.message).toContain("before it was uploaded");
    s.a.gets.push(job("completed"));
    const result = (await a.t.retryTranscription()) as CloudTranscriptResult;
    expect(s.n.reopens).toEqual([sessionId]);
    expect(s.n.submits).toEqual([
      { captureHandle: "h7", attemptId: ATTEMPT_1, backendUrl: "https://api.example", bearer: "fresh", language: "en" },
    ]);
    expect(result).toMatchObject({ sessionId, transcriptionId: ID, captureHandle: "h7" });
    expect(s.pending.value).toMatchObject({ sessionId, attemptId: ATTEMPT_1, transcriptionId: ID });
    await a.t.finishCloudTranscript(result);
    expect(s.pending.value).toBeNull();
    expect(s.pendingFor(ACCOUNT_B).value).toBeNull();
  });

  test("a capture that ended on its own, then the view closed, is kept too", async () => {
    const s = setup();
    const { sessionId } = await s.t.start({ model: "QuantizedTinyEn", language: "en", engine: "private-cloud" });
    s.endCapture("microphone stream closed");
    await s.t.stopCaptureOnUnmount();
    expect(s.calls).toEqual(["start_capture:batch::"]); // already stopped: no stop_capture
    expect(s.pending.value).toMatchObject({ sessionId, transcriptionId: null, submitted: false, audioPath: AUDIO });
    const offered = await s.relaunch().t.resumeKeptRecording()!.catch((e) => e);
    expect(offered).toBeInstanceOf(KeptRecordingError);
  });

  test("a kept recording whose audio is gone can only be discarded, which forgets it", async () => {
    const s = setup();
    await recordAndClose(s);
    const r = s.relaunch();
    void r.t.resumeKeptRecording()!.catch(() => {});
    await settle();
    const err = (await r.t.retryTranscription().catch((e) => e)) as TranscriptionFailedError;
    expect(err.code).toBe("capture_not_available");
    expect(err.retryable).toBe(false);
    expect(s.n.submits).toHaveLength(0);
    r.t.discardRecording();
    await settle();
    expect(s.pending.value).toBeNull();
    expect(s.a.calls.filter((c) => c.startsWith("cancel:") || c.startsWith("remove:"))).toEqual([]);
  });

  test("Transcribe on this Mac moves a kept cloud recording to on-device Whisper", async () => {
    const s = setup();
    const sessionId = await recordAndClose(s);
    const v = s.remount(ACCOUNT_A);
    void v.resumeKeptRecording()!.catch(() => {});
    await settle();
    void v.retryTranscription({ onDevice: { model: "QuantizedBaseEn" } }).catch(() => {});
    await settle();
    expect(s.calls.slice(2)).toEqual(["start_server:QuantizedBaseEn", `start_transcription:${AUDIO}`]);
    expect(s.pending.value).toBeNull();
    expect(s.kept.value).toMatchObject({ sessionId, audioPath: AUDIO, model: "QuantizedBaseEn" });
    expect(s.n.cancels).toEqual(["h1"]); // this launch's upload handle is released
    expect(s.n.submits).toHaveLength(0);
  });

  test("accounts stay separate: another account is not offered, blocked by, nor overwrites a kept cloud recording", async () => {
    const s = setup();
    const aSession = await recordAndClose(s);

    const b = s.remount(ACCOUNT_B);
    expect(b.adoptTranscription()).toBeNull();
    expect(b.resumeKeptRecording()).toBeNull();
    expect(b.resumeCloudTranscription()).toBeNull();
    await b.start({ model: "QuantizedTinyEn", language: "en", engine: "private-cloud" });
    await b.stopCaptureOnUnmount();
    const bRecord = s.pendingFor(ACCOUNT_B).value;
    expect(bRecord?.sessionId).not.toBe(aSession);
    expect(s.pending.value?.sessionId).toBe(aSession);

    // B discards its own; A's is untouched, and A is offered its own on return.
    const b2 = s.remount(ACCOUNT_B);
    void b2.resumeKeptRecording()!.catch(() => {});
    await settle();
    b2.discardRecording();
    expect(s.pendingFor(ACCOUNT_B).value).toBeNull();
    expect(s.pending.value?.sessionId).toBe(aSession);
    const a = s.remount(ACCOUNT_A);
    const offered = (await a.resumeKeptRecording()!.catch((e) => e)) as KeptRecordingError;
    expect(offered.message).toContain("before it was uploaded");
    s.a.gets.push(job("completed"));
    expect(((await a.retryTranscription()) as CloudTranscriptResult).sessionId).toBe(aSession);
  });

  test("A's failed upload is set aside for B without B reading it; A gets it back with its audio and re-sends it", async () => {
    const s = setup();
    s.n.setSubmit(async () => {
      throw { code: "upload_interrupted", message: "PTX did not receive the whole recording", transcriptionId: ID };
    });
    s.a.gets.push(job("awaiting_upload"));
    const { sessionId, stopped } = await recordAndStop(s);
    await expect(stopped).rejects.toBeInstanceOf(TranscriptionFailedError);
    await s.t.stopCaptureOnUnmount();

    // A signs out, B signs in.
    const b = s.remount(ACCOUNT_B);
    expect(b.adoptTranscription()).toBeNull();
    expect(b.resumeKeptRecording()).toBeNull();
    expect(b.resumeCloudTranscription()).toBeNull();
    await settle();
    expect(s.a.calls).toEqual([`get:${ID}`]); // only A's own status read; B asked nothing about A's job
    expect(s.n.cancels).toEqual(["h1"]); // the set-aside job's native handle is released
    expect(s.pending.value).toMatchObject({ transcriptionId: ID, attemptId: ATTEMPT_1, audioPath: AUDIO, sessionId });
    expect(s.pendingFor(ACCOUNT_B).value).toBeNull();

    // A returns: the job resumes, re-opening the recording and re-sending the SAME attempt.
    s.n.onDisk.set(sessionId, "h2");
    s.n.setSubmit(async () => ({ transcriptionId: ID, status: "queued" }));
    s.a.gets.push(job("awaiting_upload"), job("completed"));
    const a = s.remount(ACCOUNT_A);
    expect(a.resumeKeptRecording()).toBeNull();
    const result = (await a.resumeCloudTranscription()!) as CloudTranscriptResult;
    expect(s.n.reopens).toEqual([sessionId]);
    expect(s.n.submits.map((x) => [x.captureHandle, x.attemptId])).toEqual([
      ["h1", ATTEMPT_1],
      ["h2", ATTEMPT_1],
    ]);
    expect(result).toMatchObject({ sessionId, transcriptionId: ID });
  });

  test("an upload whose job id was lost is offered, not recovered as a stranger, and re-joins its job (no duplicate)", async () => {
    const s = setup({ pending: { attemptId: "a-1", transcriptionId: null, sessionId: "cloud-s", audioPath: "/vault/sessions/cloud-s/audio.mp3", submitted: true } });
    s.a.listed.push({ id: ID, status: "processing" });
    expect(await s.t.recoverCloudTranscripts()).toBe(0);
    expect(s.a.calls).toEqual([]);
    expect(s.t.resumeCloudTranscription()).toBeNull();
    void s.t.resumeKeptRecording()!.catch(() => {});
    await settle();
    // The create replays the same Idempotency-Key: the backend answers with the job it already has.
    s.n.onDisk.set("cloud-s", "h3");
    s.n.setSubmit(async () => ({ transcriptionId: ID, status: "processing" }));
    s.a.gets.push(job("completed"));
    const result = (await s.t.retryTranscription()) as CloudTranscriptResult;
    expect(s.n.submits.map((x) => x.attemptId)).toEqual(["a-1"]);
    expect(result).toMatchObject({ transcriptionId: ID, sessionId: "cloud-s" });
    expect(s.recovered).toHaveLength(0);

    // A record whose upload never began cannot own a listed job: recovery runs.
    const u = setup({ pending: { transcriptionId: null, submitted: false } });
    u.a.listed.push({ id: OTHER_ID, status: "completed" });
    u.a.getsById.set(OTHER_ID, [() => ({ id: OTHER_ID, status: "completed" }), () => ({ id: OTHER_ID, status: "completed" })]);
    expect(await u.t.recoverCloudTranscripts()).toBe(1);
  });

  test("a transcript's owner entry is dropped once it is finished or discarded", async () => {
    const s = setup();
    s.a.gets.push(job("completed"));
    const { stopped } = await recordAndStop(s);
    const result = (await stopped) as CloudTranscriptResult;
    expect(unfinishedTranscriptOwners(s.bridge)).toBe(1);
    // A failed PTX delete keeps it, so the retried finish still clears the right account's record.
    s.a.control.removeFails = true;
    await expect(s.t.finishCloudTranscript(result)).rejects.toThrow("down");
    expect(unfinishedTranscriptOwners(s.bridge)).toBe(1);
    s.a.control.removeFails = false;
    await s.t.finishCloudTranscript(result);
    expect(unfinishedTranscriptOwners(s.bridge)).toBe(0);
  });

  test("a released or evicted handle is re-opened once, with the same attempt", async () => {
    const s = setup();
    let submits = 0;
    s.n.setSubmit(async () => {
      if (++submits === 1) throw { code: "capture_not_available", message: "This recording is no longer available to upload" };
      return { transcriptionId: ID, status: "queued" };
    });
    s.a.gets.push(job("completed"));
    const { sessionId } = await s.t.start({ model: "QuantizedTinyEn", language: "en", engine: "private-cloud" });
    s.n.onDisk.set(sessionId, "h5");
    s.state.onStopped = (session) => s.n.emitReady({ sessionId: session, captureHandle: "h1", partial: false });
    const result = (await s.t.stop()) as CloudTranscriptResult;
    expect(s.n.submits.map((x) => [x.captureHandle, x.attemptId])).toEqual([
      ["h1", ATTEMPT_1],
      ["h5", ATTEMPT_1],
    ]);
    expect(result.captureHandle).toBe("h5");
  });

  test("a clean 404 keeps a recording never uploaded: it is still offered, with Transcribe on this Mac", async () => {
    const s = setup({ capabilities: async () => null, pending: { transcriptionId: null, submitted: false, audioPath: AUDIO } });
    expect(await s.t.privateCloudAvailability()).toBe("hidden");
    expect(s.pending.value).not.toBeNull();
    const offered = (await s.t.resumeKeptRecording()!.catch((e) => e)) as KeptRecordingError;
    expect(offered.offerOnDevice).toBe(true);
  });

  test("a clean 404 keeps an interrupted upload (a named job) and offers it for this Mac or Discard", async () => {
    const s = setup({ capabilities: async () => null, pending: { transcriptionId: ID, audioPath: AUDIO } });
    // Before any availability answer a named job is left for resumeCloudTranscription.
    expect(s.t.resumeKeptRecording()).toBeNull();
    expect(await s.t.privateCloudAvailability()).toBe("hidden");
    expect(s.pending.value?.transcriptionId).toBe(ID);
    const offered = (await s.t.resumeKeptRecording()!.catch((e) => e)) as KeptRecordingError;
    expect(offered.engine).toBe("private-cloud");
    expect(offered.offerOnDevice).toBe(true);
    expect(offered.message).toContain("can't be reached to finish it");
    void s.t.retryTranscription({ onDevice: { model: "QuantizedTinyEn" } }).catch(() => {});
    await settle();
    expect(s.kept.value).toMatchObject({ sessionId: "cloud-s", audioPath: AUDIO });
    expect(s.pending.value).toBeNull();
  });

  test("while private cloud is dark, Transcribe never contacts it and keeps the job (no new attempt), offering this Mac", async () => {
    const s = setup({ capabilities: async () => null, pending: { attemptId: "a-1", transcriptionId: ID, audioPath: AUDIO } });
    expect(await s.t.privateCloudAvailability()).toBe("hidden");
    void s.t.resumeKeptRecording()!.catch(() => {});
    await settle();
    const err = (await s.t.retryTranscription().catch((e) => e)) as TranscriptionFailedError;
    expect(err.code).toBe("feature_unavailable");
    expect(err.retryable).toBe(false);
    expect(err.offerOnDevice).toBe(true);
    // No status read (a dark 404 would look like a deleted job) and no upload.
    expect(s.a.calls).toEqual([]);
    expect(s.n.submits).toHaveLength(0);
    expect(s.pending.value).toMatchObject({ attemptId: "a-1", transcriptionId: ID, submitted: true });
    // Transcribe on this Mac is still there.
    void s.t.retryTranscription({ onDevice: { model: "QuantizedTinyEn" } }).catch(() => {});
    await settle();
    expect(s.kept.value).toMatchObject({ sessionId: "cloud-s", audioPath: AUDIO });
  });

  test("offline, a named job is offered too, nothing new starts over it, and Transcribe finishes it once back", async () => {
    const s = setup({
      capabilities: async () => {
        throw new PrivateCloudError("offline", "Could not reach the backend");
      },
      pending: { transcriptionId: ID, audioPath: AUDIO },
    });
    expect(await s.t.privateCloudAvailability()).toBe("failed");
    await expect(s.t.start({ model: "QuantizedTinyEn", language: "en", engine: "private-cloud" })).rejects.toThrow(
      "finish or discard it first",
    );
    await expect(s.t.start({ model: "QuantizedTinyEn", language: "en" })).rejects.toThrow("finish or discard it first");
    void s.t.resumeKeptRecording()!.catch(() => {});
    await settle();
    // Back online: Transcribe asks the job's status first; it was accepted, so no upload.
    s.a.gets.push(job("processing"), job("completed"));
    const result = (await s.t.retryTranscription()) as CloudTranscriptResult;
    expect(result).toMatchObject({ sessionId: "cloud-s", transcriptionId: ID });
    expect(s.n.submits).toHaveLength(0);
  });

  test("the kept message says what happened: never uploaded, or an upload that did not finish", async () => {
    const never = setup({ pending: { transcriptionId: null, submitted: false } });
    expect(((await never.t.resumeKeptRecording()!.catch((e) => e)) as Error).message).toContain("stopped before it was uploaded");
    const began = setup({ pending: { transcriptionId: null, submitted: true } });
    const msg = ((await began.t.resumeKeptRecording()!.catch((e) => e)) as Error).message;
    expect(msg).toContain("was being uploaded when Exo quit or its view closed");
    expect(msg).not.toContain("before it was uploaded");
  });

  test("a recording belongs to the account that started it, even if another signs in before it is kept", async () => {
    // Closed view, cloud.
    let signedIn: string | null = ACCOUNT_A;
    const s = setup();
    const t = s.remountWith(() => signedIn);
    await t.start({ model: "QuantizedTinyEn", language: "en", engine: "private-cloud" });
    signedIn = ACCOUNT_B;
    await t.stopCaptureOnUnmount();
    expect(s.pending.value).toMatchObject({ transcriptionId: null, audioPath: AUDIO });
    expect(s.pendingFor(ACCOUNT_B).value).toBeNull();

    // Signed out before the view closed: still kept, under A.
    signedIn = ACCOUNT_A;
    const u = setup();
    const ut = u.remountWith(() => signedIn);
    await ut.start({ model: "QuantizedTinyEn", language: "en", engine: "private-cloud" });
    signedIn = null;
    await ut.stopCaptureOnUnmount();
    expect(u.pending.value).toMatchObject({ transcriptionId: null });

    // Stop, cloud: the job and its record are A's.
    signedIn = ACCOUNT_A;
    const v = setup();
    const vt = v.remountWith(() => signedIn);
    v.a.gets.push(job("completed"));
    const { sessionId } = await vt.start({ model: "QuantizedTinyEn", language: "en", engine: "private-cloud" });
    v.state.onStopped = (session) => v.n.emitReady({ sessionId: session, captureHandle: "h1", partial: false });
    signedIn = ACCOUNT_B;
    const result = (await vt.stop()) as CloudTranscriptResult;
    expect(v.pending.value).toMatchObject({ sessionId, transcriptionId: ID });
    expect(v.pendingFor(ACCOUNT_B).value).toBeNull();
    // Finishing it clears A's record, whoever is signed in now.
    await vt.finishCloudTranscript(result);
    expect(v.pending.value).toBeNull();
  });

  test("the pre-TC-772 shared record is adopted only by the account that can read its job", async () => {
    const s = setup({ legacy: { attemptId: "a-1", transcriptionId: ID, sessionId: "cloud-old" } });
    // B's tenant-scoped read cannot see A's job: B adopts nothing, clears nothing, and asks once per launch.
    const b = s.remount(ACCOUNT_B);
    s.a.gets.push(failing("transcription_not_found"));
    expect(await b.resumeCloudTranscription()!).toBeNull();
    expect(b.resumeCloudTranscription()).toBeNull();
    expect(s.a.calls).toEqual([`get:${ID}`]);
    expect(s.legacy.value?.sessionId).toBe("cloud-old");
    expect(s.pendingFor(ACCOUNT_B).value).toBeNull();

    // A can read it: the record moves under A's key and the job is finished.
    s.a.gets.push(job("processing"), job("processing"), job("completed"));
    const result = (await s.t.resumeCloudTranscription()!) as CloudTranscriptResult;
    expect(result).toMatchObject({ sessionId: "cloud-old", transcriptionId: ID });
    expect(s.legacy.value).toBeNull();
    expect(s.pending.value).toMatchObject({ sessionId: "cloud-old", transcriptionId: ID, audioPath: "" });
  });

  test("the shared record is dropped once too old for any job, or when it names no job; a failed check keeps it", async () => {
    const old = setup({ legacy: { transcriptionId: ID, startedAt: "2026-09-29T10:00:00.000Z" } });
    old.clock.t = Date.parse("2026-10-02T10:00:00.000Z");
    old.a.gets.push(failing("transcription_not_found"));
    expect(await old.t.resumeCloudTranscription()!).toBeNull();
    expect(old.legacy.value).toBeNull();

    const offline = setup({ legacy: { transcriptionId: ID } });
    offline.a.gets.push(failing("offline"));
    expect(await offline.t.resumeCloudTranscription()!).toBeNull();
    expect(offline.legacy.value).not.toBeNull();
    expect(offline.pending.value).toBeNull();

    const unnamed = setup({ legacy: { transcriptionId: null } });
    expect(unnamed.t.resumeCloudTranscription()).toBeNull();
    expect(unnamed.legacy.value).toBeNull();
    expect(unnamed.a.calls).toEqual([]);
  });
});
