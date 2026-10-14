// Private cloud transcription of voice notes. Rules:
//   1. gating: no PTX origin in the build = never offered; a backend-issued upload path may only
//      be `/uploads/trn_…` joined to that origin;
//   2. the flow is the desktop's: create (Idempotency-Key, metadata only) → ONE PUT of the WAV to PTX
//      with the job capability → poll through the backend → result → delete the job once saved;
//   3. after any upload failure the job's status decides (awaiting_upload = upload again, with a fresh
//      capability from the idempotent create replay; anything later = the bytes landed);
//   4. a job in flight is re-joined (relaunch/Retry), never uploaded twice; a job that ended is
//      forgotten so Retry starts a new one;
//   5. the transcript is saved as readable "You" turns with the desktop's engine metadata; silence is
//      an outcome, not a failure;
//   6. notes transcribe one at a time (PTX: one active job per account);
//   7. a job never holds the account's one slot for nothing: an unusable job is cancelled;
//   8. turning transcription off stops anything not yet sent, and consent and jobs are per account;
//   9. a note whose outcome is saved is never transcribed again, even if its PTX delete failed.

import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { Database } from "bun:sqlite";
import { captureEvents } from "@/capture/captureEvents";
import { advanceAccountGeneration, currentAccountGeneration, mountVoiceNoteAccount } from "./accountContext";

import { _resetConnectorSchemaMemoForTests, transcriptKvKey } from "../connectors/connectorStore";
import { memoryHoldStore } from "@/harness/memoryHoldStore";
import {
  buildPtxUploadOrigin,
  interpretUploadResponse,
  parsePtxUploadOrigin,
  parseRateLimitWaitSeconds,
  PrivateCloudError,
  privateCloudJobClient,
  ptxUploadUrl,
  type PrivateCloudApi,
  type PrivateCloudCapabilities,
  type PrivateCloudCreateBody,
  type PrivateCloudCreated,
  type PrivateCloudJob,
  type PrivateCloudTranscript,
  type PtxPutResponse,
  type PrivateCloudResult,
} from "../privateCloud";
import { base64ToBytes, bytesToBase64, type AudioDecoder } from "./voiceNoteAudio";
import { createFakeVoiceNotes } from "./fakeVoiceNotes";
import { __resetCaptureEngineForTests, __setInstalledEngineForTests, captureCapabilities } from "./captureEngine";
import { __setVoiceNotesForTests, VoiceNotes, type LocalTranscript, type VoiceNoteRecording } from "./nativeVoiceNotes";
import { syncOnDeviceTranscript } from "./onDeviceTranscriber";
import { readTranscriptCommit } from "./voiceNoteCommits";
import { resolveVoiceNoteRow } from "./voiceNoteRows";
import { pendingStore } from "./recorderSaves";
import { advanceAccountGeneration } from "./accountContext";
import {
  readVoiceNoteForTranscription,
  VOICE_NOTE_SOURCE,
  listVoiceNotes,
  saveVoiceNote as storeVoiceNote,
  saveVoiceNoteTranscript,
  voiceNoteAudioKvKey,
  voiceNoteAudioPartKey,
  voiceNoteAudioSourceFromBase64,
  type VoiceNoteAudio,
} from "./voiceNoteStore";
import {
  accountStorageKey,
  capacitorPtxPut,
  createVoiceNoteTranscriber,
  createVoiceNoteCloud,
  createVoiceNoteCloudForBuild,
  localStorageVoiceNoteConsentStore,
  localStorageVoiceNoteHoldStore,
  localStorageVoiceNotePendingStore,
  localStorageVoiceNotePrivateChoiceStore,
  maxTranscriptionSeconds,
  privateCloudAccepts,
  acceptedContentTypes,
  prepareVoiceNoteTranscript,
  transcribeVoiceNote,
  transcriptionStatusText,
  voiceNoteSentences,
  voiceNoteTranscriptionFailure,
  VOICE_NOTE_CONSENT_KEY,
  VOICE_NOTE_PENDING_JOBS_KEY,
  type PtxPutRequest,
  type VoiceNoteCloud,
  type VoiceNoteHoldStore,
  type VoiceNoteTranscriptionStatus,
} from "./voiceNoteTranscription";

const ID = "trn_01J8Z3K4M5N6P7Q8R9S0T1V2W3";
const ID2 = "trn_01J8Z3K4M5N6P7Q8R9S0T1V2W4";
const CAP = "tcu_abcdefghijklmnop0123456789";
const CAP2 = "tcu_zyxwvutsrqponmlk9876543210";
const ORIGIN = "https://ptx.example";
const CAPS: PrivateCloudCapabilities = {
  max_bytes: 120_960_000,
  max_duration_seconds: 7_200,
  content_types: ["audio/mpeg", "audio/wav", "audio/ogg"],
  admission: "open",
  diarization: true,
};
const AUDIO = { mimeType: "audio/mp4", base64: bytesToBase64(new Uint8Array([1, 2, 3, 4])) };
test("accepted PTX content types drop parameters and normalize case", () => {
  expect(acceptedContentTypes({ ...CAPS, content_types: ["Audio/WebM;codecs=opus"] }))
    .toEqual(["audio/webm"]);
});
const originalVoiceNotes = VoiceNotes;
test("native PTX upload passes the file descriptor and progress across the JS boundary", async () => {
  const fake = createFakeVoiceNotes();
  let upload: unknown;
  let progressListener: ((event: { uploadId: string; loaded: number; total: number }) => void) | undefined;
  fake.plugin.uploadAudio = async (request) => { upload = request; return { status: 201, body: null }; };
  fake.plugin.addListener = (async (_event: string, listener: never) => {
    progressListener = listener as typeof progressListener;
    return { remove: async () => {} };
  }) as typeof fake.plugin.addListener;
  __setVoiceNotesForTests(fake.plugin, { available: true });
  const progress: number[] = [];
  try {
    const result = await capacitorPtxPut({ url: `${ORIGIN}/uploads/${ID}`, capability: CAP, contentType: "audio/mp4",
      base64: "", nativeFileId: "rec-1", contentLength: 181_440_000, correlationId: "upload-1",
      onProgress: (loaded, total) => progress.push(loaded / total) });
    progressListener?.({ uploadId: "upload-1", loaded: 90_720_000, total: 181_440_000 });
    expect(result.status).toBe(201);
    expect(upload).toMatchObject({ id: "rec-1", contentLength: 181_440_000, contentType: "audio/mp4", uploadId: "upload-1" });
    expect(progress).toEqual([0.5]);
  } finally { __setVoiceNotesForTests(originalVoiceNotes, { available: null }); }
});

test("an account change during native upload setup prevents the native task from starting", async () => {
  const fake = createFakeVoiceNotes();
  let registerListener!: (handle: { remove(): Promise<void> }) => void;
  let starts = 0;
  fake.plugin.addListener = (() => new Promise((resolve) => { registerListener = resolve; })) as typeof fake.plugin.addListener;
  fake.plugin.uploadAudio = async () => { starts++; return { status: 201, body: null }; };
  __setVoiceNotesForTests(fake.plugin, { available: true });
  try {
    const attempt = capacitorPtxPut({ url: `${ORIGIN}/uploads/${ID}`, capability: CAP, contentType: "audio/mp4",
      base64: "", nativeFileId: "rec-1", contentLength: 4, correlationId: "setup-cancel",
      canStart: () => true });
    await Promise.resolve();
    advanceAccountGeneration();
    registerListener({ remove: async () => {} });
    await expect(attempt).rejects.toMatchObject({ code: "transcription_off" });
    expect(starts).toBe(0);
  } finally { __setVoiceNotesForTests(originalVoiceNotes, { available: null }); }
});

test("an account-generation change cancels an in-flight native upload", async () => {
  const fake = createFakeVoiceNotes();
  let rejectUpload!: (reason: unknown) => void;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const cancelled: string[] = [];
  fake.plugin.uploadAudio = async () => new Promise((_, reject) => { rejectUpload = reject; markStarted(); });
  fake.plugin.cancelAudioUpload = async ({ uploadId }) => { cancelled.push(uploadId); rejectUpload(Object.assign(new Error("cancelled"), { code: "cancelled" })); };
  __setVoiceNotesForTests(fake.plugin, { available: true });
  try {
    const attempt = capacitorPtxPut({ url: `${ORIGIN}/uploads/${ID}`, capability: CAP, contentType: "audio/mp4",
      base64: "", nativeFileId: "rec-1", contentLength: 4, correlationId: "generation-cancel" });
    await started;
    advanceAccountGeneration();
    await expect(attempt).rejects.toMatchObject({ code: "upload_outcome_unknown" });
    expect(cancelled).toEqual(["generation-cancel"]);
  } finally { __setVoiceNotesForTests(originalVoiceNotes, { available: null }); }
});
beforeEach(() => {
  const fake = createFakeVoiceNotes();
  fake.plugin.listPending = async () => ({ recordings: [{ ...RECORDING, ledger: {
    transcriptSync: { state: "pending", rev: 0, at: null },
  }, owner: "did:test:voice", ownerUnknown: false } as never] });
  fake.plugin.getTranscript = async () => ({ transcript: null });
  __setVoiceNotesForTests(fake.plugin, { available: true });
});
afterEach(() => __setVoiceNotesForTests(originalVoiceNotes, { available: null }));

const silentDecoder = (seconds = 1): AudioDecoder => async (_bytes, sampleRate) => ({
  channels: [new Float32Array(Math.round(seconds * sampleRate)).fill(0.25)],
  sampleRate,
});

function job(status: PrivateCloudJob["status"], extra: Partial<PrivateCloudJob> = {}): PrivateCloudJob {
  return { id: ID, status, ...extra };
}

const TRANSCRIPT: PrivateCloudTranscript = {
  language: "en",
  duration_seconds: 9,
  provider: "tinfoil",
  model: "whisper-large-v3-turbo",
  channels: 1,
  segments: [
    { id: "seg_0002", speaker_id: "channel_0", channel: 0, start: 5, end: 9, text: " the venue. " },
    { id: "seg_0001", speaker_id: "channel_0", channel: 0, start: 0.5, end: 4, text: "Remember to book" },
  ],
  text: "Speaker 1: Remember to book\nSpeaker 1: the venue.",
};

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    map,
  };
}

const DID = "did:pkh:eip155:1:0x1111111111111111111111111111111111111111";

/**
 * A scripted backend + PTX. `jobs` is the status sequence api.get answers (the last repeats);
 * `creates` the create answers in order; `puts` the PUT answers in order.
 */
function harness(script: {
  clock?: { now: () => number; sleep: (ms: number) => Promise<void>; random: () => number };
  getJob?: (now: number) => PrivateCloudJob;
  onStatusRequest?: (now: number) => void;
  onResultRequest?: (now: number) => void;
  jobs?: (PrivateCloudJob | PrivateCloudError)[];
  creates?: (PrivateCloudCreated | PrivateCloudError)[];
  puts?: (PtxPutResponse | PrivateCloudError)[];
  result?: PrivateCloudTranscript;
  resultRequests?: (PrivateCloudResult | PrivateCloudError)[];
  pending?: ReturnType<typeof localStorageVoiceNotePendingStore>;
  now?: () => number;
  removeFails?: boolean;
  uploadSupported?: () => Promise<boolean>;
  decode?: AudioDecoder;
  nativeTransport?: boolean;
}) {
  const calls: string[] = [];
  const creates: { attemptId: string; body: PrivateCloudCreateBody }[] = [];
  const puts: PtxPutRequest[] = [];
  const jobs = [...(script.jobs ?? [job("queued"), job("processing", { progress: { regions_completed: 1, regions_total: 2 } }), job("completed")])];
  const createAnswers = [...(script.creates ?? [{ id: ID, status: "awaiting_upload", upload: { path: `/uploads/${ID}`, capability: CAP } }])];
  const putAnswers = [...(script.puts ?? [{ status: 201, body: { status: "queued" } }])];
  const removed: string[] = [];
  const cancelled: string[] = [];
  let n = 0;
  let resultReads = 0;
  const api: PrivateCloudApi = {
    backendUrl: "https://api.example",
    bearer: () => "tok",
    capabilities: async () => {
      calls.push("capabilities");
      return CAPS;
    },
    // The phone never lists the account's jobs: it re-joins only the ones it remembers.
    list: async () => {
      throw new Error("voice notes never list the account's jobs");
    },
    async get(id) {
      calls.push(`get:${id}`);
      script.onStatusRequest?.(script.clock?.now() ?? clockNow);
      if (script.getJob) return { ...script.getJob(script.clock?.now() ?? clockNow), id };
      const next = jobs.length > 1 ? jobs.shift()! : jobs[0]!;
      if (next instanceof PrivateCloudError) throw next;
      return { ...next, id };
    },
    async result(id) {
      calls.push(`result:${id}`);
      script.onResultRequest?.(script.clock?.now() ?? clockNow);
      const results = script.resultRequests;
      const answer = results?.[Math.min(resultReads++, results.length - 1)];
      if (answer instanceof PrivateCloudError) throw answer;
      return answer ?? { status: "completed", transcript: script.result ?? TRANSCRIPT };
    },
    async cancel(id) {
      calls.push(`cancel:${id}`);
      cancelled.push(id);
    },
    async remove(id) {
      calls.push(`remove:${id}`);
      if (script.removeFails) throw new PrivateCloudError("service_unavailable", "down");
      removed.push(id);
    },
  };
  const pending = script.pending ?? localStorageVoiceNotePendingStore(DID, memoryStorage());
  const sleeps: number[] = [];
  let clockNow = 0;
  const cloud = createVoiceNoteCloud({
    api,
    origin: ORIGIN,
    pending,
    uploadSupported: script.uploadSupported,
    decode: script.decode ?? silentDecoder(),
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
    clock: script.clock ?? {
      now: script.now ?? (() => clockNow),
      sleep: async (ms) => {
        sleeps.push(ms);
        clockNow += ms;
      },
      random: () => 0.5,
    },
    async create(request) {
      calls.push(`create:${request.attemptId}`);
      creates.push({ attemptId: request.attemptId, body: request.body });
      const next = createAnswers.shift();
      if (next === undefined) throw new Error("unexpected create");
      if (next instanceof PrivateCloudError) throw next;
      return next;
    },
    async put(request) {
      calls.push(`put:${request.url}`);
      puts.push(request);
      if (script.nativeTransport) return capacitorPtxPut(request);
      const next = putAnswers.shift();
      if (next === undefined) throw new Error("unexpected put");
      if (next instanceof PrivateCloudError) throw next;
      return next;
    },
  });
  return { cloud, calls, creates, puts, removed, cancelled, pending, sleeps, resultReads: () => resultReads };
}

const run = (h: ReturnType<typeof harness>, report: (s: VoiceNoteTranscriptionStatus) => void = () => {}) =>
  h.cloud.transcribe({ sourceId: "rec-1", capabilities: CAPS, loadAudio: async () => AUDIO }, report);

test("Private asks PTX to identify speakers only when enabled, mono, and supported", async () => {
  for (const [identifySpeakers, channelCount, diarization] of [[true, 1, true], [false, 1, true], [true, 2, true], [true, 1, false]] as const) {
    const h = harness({});
    await h.cloud.transcribe({ sourceId: `rec-${identifySpeakers}-${channelCount}-${diarization}`, capabilities: { ...CAPS, diarization },
      loadAudio: async () => AUDIO, identifySpeakers, channelCount }, () => {});
    expect(h.creates[0]?.body.diarize).toBe(identifySpeakers && channelCount === 1 && diarization ? true : undefined);
    expect(h.creates[0]?.body).toMatchObject(channelCount === 2
      ? { channel_mode: "separate", channel_labels: ["Me", "Them"] }
      : { channel_mode: "mixed", channel_labels: ["Exo voice note"] });
  }
});

describe("gating", () => {
  test("a PTX origin is a bare https origin; http only to a loopback port when allowed", () => {
    expect(parsePtxUploadOrigin(undefined, false)).toBeNull();
    expect(parsePtxUploadOrigin("", false)).toBeNull();
    expect(parsePtxUploadOrigin("https://abc-8080.gw.example", false)).toBe("https://abc-8080.gw.example");
    expect(parsePtxUploadOrigin("https://abc-8080.gw.example/", false)).toBe("https://abc-8080.gw.example");
    for (const bad of [
      "http://abc.example",
      "https://abc.example/uploads",
      "https://u:p@abc.example",
      "https://abc.example?x=1",
      "https://abc.example#f",
      "ftp://abc.example",
      "not a url",
    ]) {
      expect(parsePtxUploadOrigin(bad, true)).toBeNull();
    }
    expect(parsePtxUploadOrigin("http://127.0.0.1:8080", false)).toBeNull();
    expect(parsePtxUploadOrigin("http://127.0.0.1:8080", true)).toBe("http://127.0.0.1:8080");
    expect(parsePtxUploadOrigin("http://127.0.0.1", true)).toBeNull();
  });

  test("no origin in this build: the engine does not exist, whatever the backend would say", () => {
    expect(buildPtxUploadOrigin()).toBeNull();
    expect(createVoiceNoteCloudForBuild("https://api.example", { getToken: () => "tok", isExpired: () => false } as never, DID)).toBeNull();
  });

  test("an upload path joins the build's origin only as /uploads/trn_…", () => {
    expect(ptxUploadUrl(ORIGIN, `/uploads/${ID}`)).toBe(`${ORIGIN}/uploads/${ID}`);
    for (const bad of [`//evil.example/uploads/${ID}`, `https://evil.example/uploads/${ID}`, `/uploads/${ID}/../x`, "/v1/transcriptions", `/uploads/${ID}?x`]) {
      expect(() => ptxUploadUrl(ORIGIN, bad)).toThrow(PrivateCloudError);
    }
  });

  test("the supported duration comes from PTX", () => {
    expect(maxTranscriptionSeconds(null)).toBe(Number.POSITIVE_INFINITY);
    expect(maxTranscriptionSeconds(CAPS)).toBe(7_200);
    expect(maxTranscriptionSeconds({ ...CAPS, max_duration_seconds: 120 })).toBe(120);
    expect(maxTranscriptionSeconds({ ...CAPS, max_duration_seconds: 10_800 })).toBe(10_800);
    expect(privateCloudAccepts(7_200, CAPS)).toBe(true);
    expect(privateCloudAccepts(7_201, CAPS)).toBe(false);
    expect(privateCloudAccepts(null, CAPS)).toBe(true);
    expect(privateCloudAccepts(1, null)).toBe(false);
  });
});

describe("interpretUploadResponse (desktop upload_result)", () => {
  const code = (status: number, body: unknown = null) => {
    try {
      interpretUploadResponse({ status, body }, "cid-1");
      return "ok";
    } catch (err) {
      return (err as PrivateCloudError).code;
    }
  };
  test("201 is the only success; each other answer is a stable code", () => {
    expect(code(201, { status: "queued" })).toBe("ok");
    expect(code(200)).toBe("upload_outcome_unknown");
    expect(code(302)).toBe("service_misconfigured");
    expect(code(401, { error: { code: "upload_capability_invalid" } })).toBe("upload_outcome_unknown");
    expect(code(409, { error: { code: "upload_in_progress" } })).toBe("upload_outcome_unknown");
    expect(code(400, { error: { code: "upload_length_mismatch" } })).toBe("upload_interrupted");
    expect(code(408)).toBe("upload_interrupted");
    expect(code(410)).toBe("upload_capability_expired");
    expect(code(413)).toBe("recording_too_large");
    expect(code(415)).toBe("unsupported_recording");
    expect(code(422, { error: { code: "upload_rejected", job_error: { code: "invalid_audio" } } })).toBe("invalid_audio");
    expect(code(422, { error: { code: "upload_rejected", job_error: { code: "made_up" } } })).toBe("upstream_bad_response");
    expect(code(429, { error: { code: "service_busy", retry_after_seconds: 30 } })).toBe("service_busy");
    expect(code(503, { error: { code: "service_paused" } })).toBe("service_paused");
    expect(code(503)).toBe("upload_outcome_unknown");
    expect(code(502)).toBe("upload_outcome_unknown");
  });

  test("the reference is PTX's correlation id, else ours", () => {
    const theirs = (() => {
      try {
        interpretUploadResponse({ status: 408, body: { error: { correlation_id: "ptx-cid" } } }, "cid-1");
      } catch (err) {
        return err as PrivateCloudError;
      }
    })()!;
    expect(theirs.correlationId).toBe("ptx-cid");
    const ours = (() => {
      try {
        interpretUploadResponse({ status: 408, body: "not json" }, "cid-1");
      } catch (err) {
        return err as PrivateCloudError;
      }
    })()!;
    expect(ours.correlationId).toBe("cid-1");
  });
});

describe("createVoiceNoteCloud.transcribe", () => {
  test.each([3_600, 10_800])("uploads a %i-second note when PTX advertises that duration", async (durationSeconds) => {
    const h = harness({});
    await h.cloud.transcribe({ sourceId: "rec-1", capabilities: { ...CAPS, max_duration_seconds: durationSeconds },
      loadAudio: async () => AUDIO, durationSeconds }, () => {});
    expect(h.creates).toHaveLength(1);
    expect(h.puts).toHaveLength(1);
  });

  test("happy path: create (metadata only) → one PUT of the WAV to the build's origin → poll → result", async () => {
    const h = harness({});
    const statuses: VoiceNoteTranscriptionStatus[] = [];
    const out = await run(h, (s) => statuses.push(s));
    expect(out).toEqual({ transcriptionId: ID, transcript: TRANSCRIPT });

    // Create: a UUID Idempotency-Key and the WAV's metadata, never audio.
    expect(h.creates).toHaveLength(1);
    expect(h.creates[0]!.attemptId).toMatch(/^[0-9a-f-]{36}$/);
    const body = h.creates[0]!.body;
    expect(Object.keys(body).sort()).toEqual(["byte_size", "channel_labels", "channel_mode", "content_type", "language", "sha256"]);
    // Mono, and marked as a voice note's job so Exo desktop's recovery never adopts it.
    expect(body).toMatchObject({ channel_mode: "mixed", channel_labels: ["Exo voice note"] });
    expect(privateCloudJobClient(body as never)).toBe("exo-voice-note");
    expect(body.content_type).toBe("audio/wav");
    expect(body.language).toBe("en");
    expect(body.byte_size).toBe(44 + 32_000);

    // Upload: the bytes the create described, to <origin>/uploads/<id>, with the job capability.
    expect(h.puts).toHaveLength(1);
    const put = h.puts[0]!;
    expect(put.url).toBe(`${ORIGIN}/uploads/${ID}`);
    expect(put.capability).toBe(CAP);
    expect(put.contentType).toBe("audio/wav");
    const bytes = base64ToBytes(put.base64);
    expect(bytes.byteLength).toBe(body.byte_size);
    expect(new Bun.CryptoHasher("sha256").update(bytes).digest("hex")).toBe(body.sha256);

    expect(h.calls).toEqual([`create:${h.creates[0]!.attemptId}`, `put:${ORIGIN}/uploads/${ID}`, `get:${ID}`, `get:${ID}`, `get:${ID}`, `result:${ID}`]);
    expect(statuses.map((s) => s.kind)).toEqual(["preparing", "uploading", "queued", "queued", "processing"]);
    // The job is remembered until finish() deletes it.
    expect(h.pending.read("rec-1")).toEqual({ attemptId: h.creates[0]!.attemptId, transcriptionId: ID });
    await h.cloud.finish("rec-1", ID);
    expect(h.removed).toEqual([ID]);
    expect(h.pending.read("rec-1")).toBeNull();
  });

  test("an upload that failed while the job still awaits it is retried by replaying the same create", async () => {
    const h = harness({
      creates: [
        { id: ID, status: "awaiting_upload", upload: { path: `/uploads/${ID}`, capability: CAP } },
        { id: ID, status: "awaiting_upload", upload: { path: `/uploads/${ID}`, capability: CAP2 } },
      ],
      puts: [new PrivateCloudError("upload_outcome_unknown", "connection reset"), { status: 201, body: { status: "queued" } }],
      // After the failed PUT, and again when Retry re-joins: still awaiting the upload.
      jobs: [job("awaiting_upload"), job("awaiting_upload"), job("completed")],
    });
    const first = await run(h).catch((e: unknown) => e);
    expect((first as PrivateCloudError).code).toBe("upload_outcome_unknown");
    expect(h.pending.read("rec-1")?.transcriptionId).toBe(ID);

    // Retry: the remembered job still awaits its upload → same Idempotency-Key, fresh capability.
    const out = await run(h);
    expect(out.transcriptionId).toBe(ID);
    expect(h.creates.map((c) => c.attemptId)).toEqual([h.creates[0]!.attemptId, h.creates[0]!.attemptId]);
    expect(h.creates[1]!.body).toEqual(h.creates[0]!.body);
    expect(h.puts.map((p) => p.capability)).toEqual([CAP, CAP2]);
  });

  test("an unclear upload answer whose job moved on is carried on as accepted (no second upload)", async () => {
    const h = harness({
      puts: [{ status: 502, body: null }],
      jobs: [job("queued"), job("completed")],
    });
    const out = await run(h);
    expect(out.transcriptionId).toBe(ID);
    expect(h.puts).toHaveLength(1);
  });

  test("a rejected upload ends the job, which is forgotten so Retry starts a new one", async () => {
    const h = harness({
      puts: [{ status: 422, body: { error: { code: "upload_rejected", job_error: { code: "invalid_audio" } } } }],
      jobs: [job("failed", { error: { code: "invalid_audio", message: "The recording could not be read as audio." } })],
    });
    const err = (await run(h).catch((e: unknown) => e)) as PrivateCloudError;
    expect(err.code).toBe("invalid_audio");
    expect(h.pending.read("rec-1")).toBeNull();
  });

  test("a relaunch re-joins a job past its upload: no create, no upload, just its transcript", async () => {
    const pending = localStorageVoiceNotePendingStore(DID, memoryStorage());
    pending.write("rec-1", { attemptId: "00000000-0000-4000-8000-00000000abcd", transcriptionId: ID });
    const h = harness({ pending, jobs: [job("processing"), job("completed")] });
    const out = await h.cloud.transcribe(
      { sourceId: "rec-1", capabilities: CAPS, loadAudio: async () => { throw new Error("audio is not needed"); } },
      () => {},
    );
    expect(out.transcriptionId).toBe(ID);
    expect(h.creates).toHaveLength(0);
    expect(h.puts).toHaveLength(0);
  });

  test("a remembered job that is gone (404) is forgotten and the note gets a new job", async () => {
    const pending = localStorageVoiceNotePendingStore(DID, memoryStorage());
    pending.write("rec-1", { attemptId: "00000000-0000-4000-8000-00000000abcd", transcriptionId: ID2 });
    const h = harness({
      pending,
      jobs: [new PrivateCloudError("transcription_not_found", "gone"), job("completed")],
    });
    const out = await run(h);
    expect(out.transcriptionId).toBe(ID);
    expect(h.creates[0]!.attemptId).not.toBe("00000000-0000-4000-8000-00000000abcd");
  });

  test("a create key used for different bytes (idempotency_conflict) starts one new job", async () => {
    const h = harness({
      creates: [
        new PrivateCloudError("idempotency_conflict", "different request"),
        { id: ID, status: "awaiting_upload", upload: { path: `/uploads/${ID}`, capability: CAP } },
      ],
    });
    await run(h);
    expect(h.creates).toHaveLength(2);
    expect(h.creates[1]!.attemptId).not.toBe(h.creates[0]!.attemptId);
    expect(h.pending.read("rec-1")?.attemptId).toBe(h.creates[1]!.attemptId);
  });

  test("another active job for this account is reported, nothing is uploaded", async () => {
    const h = harness({ creates: [new PrivateCloudError("active_transcription_exists", "busy", { transcriptionId: ID2 })] });
    const err = (await run(h).catch((e: unknown) => e)) as PrivateCloudError;
    expect(err.code).toBe("active_transcription_exists");
    expect(h.puts).toHaveLength(0);
    expect(voiceNoteTranscriptionFailure(err)).toEqual(expect.objectContaining({ retryable: true }));
  });

  test("a note over PTX's advertised duration is refused before any job exists", async () => {
    const h = harness({});
    const err = await h.cloud
      .transcribe({ sourceId: "rec-1", capabilities: { ...CAPS, max_duration_seconds: 0.5 }, loadAudio: async () => AUDIO }, () => {})
      .catch((e: unknown) => e);
    expect((err as { code: string }).code).toBe("recording_too_long");
    expect(h.creates).toHaveLength(0);
    expect(h.pending.read("rec-1")).toBeNull();
    expect(voiceNoteTranscriptionFailure(err)).toEqual(expect.objectContaining({ retryable: true }));
  });

  test("transient poll failures are ridden out; ten minutes of them is 'connection lost', and the job is kept", async () => {
    const transient = new PrivateCloudError("service_unavailable", "503");
    const recovered = harness({ jobs: [transient, transient, job("completed")] });
    expect((await run(recovered)).transcriptionId).toBe(ID);
    expect(recovered.sleeps.slice(0, 2)).toEqual([5_000, 5_000]);

    const lost = harness({ jobs: [transient] });
    const err = (await run(lost).catch((e: unknown) => e)) as PrivateCloudError;
    expect(err.code).toBe("connection_lost");
    expect(lost.pending.read("rec-1")?.transcriptionId).toBe(ID);
    expect(voiceNoteTranscriptionFailure(err).retryable).toBe(true);
  });

  test("alternating 503 and 429 preserves status failure history while excluding the 429 waits", async () => {
    const transient = new PrivateCloudError("service_unavailable", "503");
    const rateLimited = Object.assign(
      new PrivateCloudError("service_busy", "429", { retryAfterSeconds: 60 }),
      { statusCode: 429 },
    );
    const jobs: (PrivateCloudJob | PrivateCloudError)[] = Array.from({ length: 240 }, (_, index) =>
      index % 2 === 0 ? transient : rateLimited);
    jobs.push(new PrivateCloudError("stop", "429 cleared the failure history"));
    const h = harness({ jobs });
    const error = (await run(h).catch((caught: unknown) => caught)) as PrivateCloudError;
    expect(error.code).toBe("connection_lost");
    const throttles = h.sleeps.filter((delay) => delay >= 60_000);
    expect(throttles.length).toBeGreaterThan(0);
    expect(h.sleeps.filter((delay) => delay < 60_000).reduce((sum, delay) => sum + delay, 0)).toBeGreaterThanOrEqual(600_000);
    expect(h.pending.read("rec-1")?.transcriptionId).toBe(ID);
  });

  test("eleven minutes of resumed-status 429s waits for the server and does not fail the job", async () => {
    const rateLimited = Object.assign(
      new PrivateCloudError("service_busy", "429", { retryAfterSeconds: 60 }),
      { statusCode: 429 },
    );
    const pending = localStorageVoiceNotePendingStore(DID, memoryStorage());
    pending.write("rec-1", { attemptId: "00000000-0000-4000-8000-00000000abcd", transcriptionId: ID });
    const h = harness({ pending, jobs: [...Array.from({ length: 11 }, () => rateLimited), job("completed")] });
    expect((await run(h)).transcriptionId).toBe(ID);
    expect(h.sleeps.reduce((total, ms) => total + ms, 0)).toBeGreaterThanOrEqual(11 * 60_000);
  });

  test("status 429 suspension leaves the result failure budget active", async () => {
    const rateLimited = Object.assign(
      new PrivateCloudError("service_busy", "429", { retryAfterSeconds: 900 }),
      { statusCode: 429 },
    );
    const h = harness({
      jobs: [job("completed"), rateLimited, job("completed")],
      resultRequests: [new PrivateCloudError("service_unavailable", "503"), { status: "completed", transcript: TRANSCRIPT }],
    });
    expect((await run(h)).transcriptionId).toBe(ID);
    expect(Math.max(...h.sleeps)).toBeGreaterThanOrEqual(900_000);
  });

  test("successful status reads do not reset repeated result failures", async () => {
    const results = [
      ...Array.from({ length: 49 }, () => new PrivateCloudError("service_unavailable", "503")),
      new PrivateCloudError("stop", "result retry escaped its failure budget"),
    ];
    const h = harness({ jobs: [job("completed")], resultRequests: results });
    const error = (await run(h).catch((caught: unknown) => caught)) as PrivateCloudError;
    expect(error.code).toBe("connection_lost");
  });

  test("a 30-second voice note completes in the fast polling phase", async () => {
    let now = 0;
    const reads: number[] = [];
    const h = harness({
      clock: {
        now: () => now,
        sleep: async (ms) => { now += ms; },
        random: () => 0.5,
      },
      creates: [{ id: ID, status: "queued", upload: null }],
      getJob: (at) => job(at >= 30_000 ? "completed" : "processing"),
      onStatusRequest: (at) => reads.push(at),
    });
    await h.cloud.transcribe({
      sourceId: "short-note",
      capabilities: CAPS,
      loadAudio: async () => AUDIO,
      durationSeconds: 30,
    }, () => {});
    expect(reads).toEqual([0, 5_000, 10_000, 15_000, 20_000, 25_000, 30_000]);
    expect(now).toBeLessThanOrEqual(30_000);
  });

  test("three independent 72-minute voice-note poll loops stay inside the shared 900-second budget", async () => {
    const maxRequests = (timestamps: number[]) => {
      timestamps.sort((a, b) => a - b);
      let max = 0;
      let left = 0;
      for (let right = 0; right < timestamps.length; right++) {
        while (timestamps[right]! - timestamps[left]! >= 900_000) left++;
        max = Math.max(max, right - left + 1);
      }
      return max;
    };
    for (const completionMs of [25 * 60_000, 40 * 60_000]) {
      for (const randomValue of [0, 0.999]) {
        const requests: number[] = [];
        await Promise.all([0, 1, 2].map(async (index) => {
          let now = 0;
          const h = harness({
            clock: {
              now: () => now,
              sleep: async (ms) => { now += ms; },
              random: () => randomValue,
            },
            creates: [{ id: ID, status: "queued", upload: null }],
            getJob: (at) => job(at >= completionMs ? "completed" : "processing"),
            onStatusRequest: (at) => requests.push(at),
            onResultRequest: (at) => requests.push(at),
          });
          await h.cloud.transcribe({
            sourceId: `long-note-${index}`,
            capabilities: CAPS,
            loadAudio: async () => AUDIO,
            durationSeconds: 72 * 60,
          }, () => {});
        }));
        expect(maxRequests(requests)).toBeLessThanOrEqual(80);
      }
    }
  });

  test("malformed PTX status throttle values keep each voice-note retry on the slow floor", async () => {
    for (const { headers, minGapMs } of [
      { headers: { "Retry-After": "" }, minGapMs: 30_000 },
      { headers: { "Retry-After": "-1" }, minGapMs: 30_000 },
      { headers: { "Retry-After": "12garbage" }, minGapMs: 30_000 },
      { headers: { "Retry-After": new Date(0).toUTCString() }, minGapMs: 30_000 },
      { headers: { RateLimit: "limit=600, remaining=0, reset=12garbage" }, minGapMs: 30_000 },
      { headers: { RateLimit: 'limit=600, remaining=0, reset="0' }, minGapMs: 30_000 },
      { headers: { RateLimit: 'limit=600, remaining=0, reset=0"' }, minGapMs: 30_000 },
      { headers: { RateLimit: 'limit=600, remaining=0, reset="90"' }, minGapMs: 90_000 },
    ]) {
      let now = 0;
      const requests: number[] = [];
      const waitSeconds = parseRateLimitWaitSeconds(new Headers(headers));
      const limited = Object.assign(new PrivateCloudError("service_busy", "429", {
        retryAfterSeconds: waitSeconds,
        statusCode: 429,
      }), { statusCode: 429 });
      const h = harness({
        clock: { now: () => now, sleep: async (ms) => { now += ms; }, random: () => 0 },
        jobs: [...Array.from({ length: 100 }, () => limited), job("completed")],
        onStatusRequest: (at) => requests.push(at),
      });
      await run(h);
      expect(requests).toHaveLength(101);
      expect(requests.slice(1).every((at, index) => at - requests[index]! >= minGapMs)).toBe(true);
    }
  });

  test("a job that fails while processing is reported with its code and forgotten", async () => {
    const h = harness({ jobs: [job("processing"), job("failed", { error: { code: "provider_unavailable", message: "x" } })] });
    const err = (await run(h).catch((e: unknown) => e)) as PrivateCloudError;
    expect(err.code).toBe("provider_unavailable");
    expect(h.pending.read("rec-1")).toBeNull();
  });
});

describe("a job never holds the account's one slot for nothing", () => {
  test("recomputable and permanent upload answers cancel the unneeded job and forget it", async () => {
    for (const [put, code, retryable] of [
      [{ status: 413, body: { error: { code: "recording_too_large" } } }, "recording_too_large", true],
      [{ status: 302, body: null }, "service_misconfigured", false],
      [{ status: 415, body: null }, "unsupported_recording", true],
    ] as const) {
      const h = harness({ puts: [put], jobs: [job("awaiting_upload")] });
      const err = (await run(h).catch((e: unknown) => e)) as PrivateCloudError;
      expect(err.code).toBe(code);
      expect(h.cancelled).toEqual([ID]);
      expect(h.pending.read("rec-1")).toBeNull();
      expect(voiceNoteTranscriptionFailure(err).retryable).toBe(retryable);
    }
  });

  test("a retryable upload failure keeps the job for Retry (same job, fresh capability)", async () => {
    const h = harness({ puts: [{ status: 408, body: null }], jobs: [job("awaiting_upload")] });
    expect(((await run(h).catch((e: unknown) => e)) as PrivateCloudError).code).toBe("upload_interrupted");
    expect(h.cancelled).toEqual([]);
    expect(h.pending.read("rec-1")?.transcriptionId).toBe(ID);
  });

  test("the audio cannot be read after re-joining a job awaiting its upload: that job is cancelled", async () => {
    const pending = localStorageVoiceNotePendingStore(DID, memoryStorage());
    pending.write("rec-1", { attemptId: "00000000-0000-4000-8000-00000000abcd", transcriptionId: ID });
    const h = harness({ pending, jobs: [job("awaiting_upload")] });
    const err = await h.cloud
      .transcribe({ sourceId: "rec-1", capabilities: CAPS, loadAudio: async () => { throw new Error("KV offline"); } }, () => {})
      .catch((e: unknown) => e);
    expect((err as Error).message).toBe("KV offline");
    expect(h.cancelled).toEqual([ID]);
    expect(h.pending.read("rec-1")).toBeNull();
    expect(h.creates).toHaveLength(0);
  });

  test("idempotency_conflict for a re-joined job: the old job is cancelled before a new key is minted", async () => {
    const pending = localStorageVoiceNotePendingStore(DID, memoryStorage());
    pending.write("rec-1", { attemptId: "00000000-0000-4000-8000-00000000abcd", transcriptionId: ID2 });
    const h = harness({
      pending,
      jobs: [job("awaiting_upload"), job("completed")],
      creates: [
        new PrivateCloudError("idempotency_conflict", "different request"),
        { id: ID, status: "awaiting_upload", upload: { path: `/uploads/${ID}`, capability: CAP } },
      ],
    });
    expect((await run(h)).transcriptionId).toBe(ID);
    expect(h.cancelled).toEqual([ID2]);
    expect(h.creates.map((c) => c.attemptId)).toEqual(["00000000-0000-4000-8000-00000000abcd", expect.not.stringContaining("abcd")]);
  });

  test("a second idempotency_conflict releases the new job's key and fails without retrying forever", async () => {
    const h = harness({
      creates: [new PrivateCloudError("idempotency_conflict", "x"), new PrivateCloudError("idempotency_conflict", "x")],
    });
    expect(((await run(h).catch((e: unknown) => e)) as PrivateCloudError).code).toBe("idempotency_conflict");
    expect(h.creates).toHaveLength(2);
    expect(h.pending.read("rec-1")).toBeNull();
  });
});

describe("turning transcription off", () => {
  test("off before anything is sent: no job is created", async () => {
    const h = harness({});
    const err = await h.cloud
      .transcribe({ sourceId: "rec-1", capabilities: CAPS, loadAudio: async () => AUDIO, allowed: (scope) => scope === "account" }, () => {})
      .catch((e: unknown) => e);
    expect((err as PrivateCloudError).code).toBe("transcription_off");
    expect(h.creates).toHaveLength(0);
    expect(h.pending.read("rec-1")).toBeNull();
  });

  test("off between creating the job and the upload: nothing is uploaded and the job is cancelled", async () => {
    let allowed = true;
    const h = harness({
      creates: [{ id: ID, status: "awaiting_upload", upload: { path: `/uploads/${ID}`, capability: CAP } }],
    });
    const created = h.cloud.transcribe(
      {
        sourceId: "rec-1",
        capabilities: CAPS,
        loadAudio: async () => AUDIO,
        allowed: (scope) => {
          if (scope === "account") return true;
          // Turned off once the job exists (the third question is right before the PUT).
          if (h.creates.length > 0) allowed = false;
          return allowed;
        },
      },
      () => {},
    );
    expect(((await created.catch((e: unknown) => e)) as PrivateCloudError).code).toBe("transcription_off");
    expect(h.puts).toHaveLength(0);
    expect(h.cancelled).toEqual([ID]);
    expect(h.pending.read("rec-1")).toBeNull();
  });

  test("releaseUnsent cancels jobs still waiting for their upload and keeps ones already sent", async () => {
    const pending = localStorageVoiceNotePendingStore(DID, memoryStorage());
    pending.write("waiting", { attemptId: "a1", transcriptionId: ID });
    pending.write("sent", { attemptId: "a2", transcriptionId: ID2 });
    pending.write("no-job", { attemptId: "a3", transcriptionId: null });
    pending.write("gone", { attemptId: "a4", transcriptionId: "trn_01J8Z3K4M5N6P7Q8R9S0T1V2W9" });
    const h = harness({ pending });
    const statuses: Record<string, PrivateCloudJob | PrivateCloudError> = {
      [ID]: job("awaiting_upload"),
      [ID2]: job("processing"),
      trn_01J8Z3K4M5N6P7Q8R9S0T1V2W9: new PrivateCloudError("transcription_not_found", "gone"),
    };
    const cloud = createVoiceNoteCloud({
      api: {
        backendUrl: "x",
        bearer: () => "tok",
        capabilities: async () => CAPS,
        list: async () => [],
        get: async (id) => {
          const answer = statuses[id]!;
          if (answer instanceof PrivateCloudError) throw answer;
          return { ...answer, id };
        },
        result: async () => ({ status: "pending", jobStatus: "queued" }),
        cancel: async (id) => {
          h.cancelled.push(id);
        },
        remove: async () => {},
      },
      create: async () => {
        throw new Error("unused");
      },
      put: async () => {
        throw new Error("unused");
      },
      origin: ORIGIN,
      pending,
    });
    await cloud.releaseUnsent();
    expect(h.cancelled).toEqual([ID]);
    expect(pending.sourceIds()).toEqual(["sent"]);
  });
});

describe("per device capability and per account storage", () => {
  test("a device that cannot upload fails availability without asking the backend", async () => {
    const unable = harness({ uploadSupported: async () => false });
    expect(((await unable.cloud.capabilities().catch((error) => error)) as PrivateCloudError).code).toBe("feature_unavailable");
    expect(unable.calls).toEqual([]);
    const able = harness({ uploadSupported: async () => true });
    expect(await able.cloud.capabilities()).toEqual(CAPS);
  });

  test("consent and jobs in flight are kept per account DID", () => {
    const storage = memoryStorage();
    const a = localStorageVoiceNoteConsentStore("did:a", storage);
    const b = localStorageVoiceNoteConsentStore("did:b", storage);
    storage.setItem(accountStorageKey(VOICE_NOTE_CONSENT_KEY, "did:a"), "1");
    expect(a.get()).toBe(false);
    a.set(true);
    expect([a.get(), b.get()]).toEqual([true, false]);
    expect(storage.map.has(accountStorageKey(VOICE_NOTE_CONSENT_KEY, "did:a"))).toBe(true);
    a.set(false);
    expect(a.get()).toBe(false);

    const pa = localStorageVoiceNotePendingStore("did:a", storage);
    const pb = localStorageVoiceNotePendingStore("did:b", storage);
    pa.write("rec-1", { attemptId: "x", transcriptionId: ID });
    expect(pb.sourceIds()).toEqual([]);
    expect(pa.sourceIds()).toEqual(["rec-1"]);
    expect(storage.map.has(`${VOICE_NOTE_PENDING_JOBS_KEY}:did:a`)).toBe(true);
  });
});

describe("transcript normalization", () => {
  test("stereo Private segments retain Me and Them through the saved transcript", () => {
    const transcript: PrivateCloudTranscript = { ...TRANSCRIPT, channels: 2, diarized: false,
      segments: [{ channel: 1, start: 2, end: 3, text: "Reply" }, { channel: 0, start: 0, end: 1, text: "Question" }] };
    const saved = prepareVoiceNoteTranscript(transcript, "2026-10-13T00:00:00Z", 1);
    expect(saved.sentences.map((sentence) => [sentence.speaker_name, sentence.text])).toEqual([["Me", "Question"], ["Them", "Reply"]]);
    expect(saved.metadata.speaker_labels).toBe("channels");
  });
  test("diarized Private turns retain their speaker labels", () => {
    const transcript: PrivateCloudTranscript = {
      ...TRANSCRIPT, diarized: true,
      speakers: [{ id: "speaker_0", name: "Speaker 1", channel: 0 }, { id: "speaker_1", name: "Speaker 2", channel: 0 }],
      segments: [
        { channel: 0, start: 0, end: 1, text: "hello", speaker_id: "speaker_0" },
        { channel: 0, start: 1, end: 2, text: "hi", speaker_id: "speaker_1" },
      ],
    };
    expect(voiceNoteSentences(transcript).map((sentence) => sentence.speaker_name)).toEqual(["Speaker 1", "Speaker 2"]);
    expect(prepareVoiceNoteTranscript(transcript, "2026-10-12T00:00:00Z", 1)).toMatchObject({
      speakers: ["Speaker 1", "Speaker 2"], metadata: { speaker_labels: "diarized" },
    });
  });
  test("PTX regions remain separate timed segments, trimmed and ordered", () => {
    expect(voiceNoteSentences(TRANSCRIPT)).toEqual([
      { index: 0, speaker_name: null, text: "Remember to book", start_time: 0.5, end_time: 4, channel: 0, timing: "engine" },
      { index: 1, speaker_name: null, text: "the venue.", start_time: 5, end_time: 9, channel: 0, timing: "engine" },
    ]);
    const long = voiceNoteSentences({
      segments: [
        { channel: 0, start: 0, end: 30, text: "one" },
        { channel: 0, start: 31, end: 59, text: "two" },
        { channel: 0, start: 60, end: 70, text: "three" },
        { channel: 0, start: 71, end: 72, text: "   " },
        { channel: 0, start: Number.NaN, end: 1, text: "bad" },
      ],
    });
    expect(long.map((s) => [s.text, s.start_time, s.end_time])).toEqual([["one", 0, 30], ["two", 31, 59], ["three", 60, 70]]);
  });

  test("the save carries the desktop's engine metadata; no sentences is the no-speech outcome", () => {
    const prepared = prepareVoiceNoteTranscript(TRANSCRIPT, "2026-10-03T10:00:00.000Z", 1);
    expect(prepared.speakers).toEqual([]);
    expect(prepared.metadata).toEqual({
      transcription_engine: "private-cloud",
      transcript_provider: "tinycloud-private-transcription",
      inference_provider: "tinfoil",
      model: "whisper-large-v3-turbo",
      language: "en",
      transcript_text: "Remember to book\nthe venue.",
      transcription_outcome: "transcribed",
      speaker_labels: "single-speaker",
      transcribed_at: "2026-10-03T10:00:00.000Z",
    });
    const silent = prepareVoiceNoteTranscript({ ...TRANSCRIPT, segments: [] }, "2026-10-03T10:00:00.000Z", 1);
    expect(silent.sentences).toEqual([]);
    expect(silent.metadata.transcription_outcome).toBe("no_speech");
  });
});

/** Save a note whose audio is already in memory (the phone reads it part by part instead). */
const saveVoiceNote = (tcw: never, recording: typeof RECORDING, audio: VoiceNoteAudio, platform: string) =>
  storeVoiceNote(tcw, recording, voiceNoteAudioSourceFromBase64(audio), platform, {}, true);

/** The connector store on real SQLite plus in-memory KV (strings, and raw bytes for audio parts). */
function sqliteSpace() {
  const sqlite = new Database(":memory:");
  const kv = new Map<string, string | Uint8Array>();
  let noteRowReads = 0;
  let failNoteRowReads = 0;
  const runSql = <T>(fn: () => T) => {
    try {
      return { ok: true, data: fn() };
    } catch (error) {
      return { ok: false, error: { code: "SQL", message: String(error) } };
    }
  };
  return {
    sqlite,
    kv,
    failNextNoteRowRead: () => { failNoteRowReads++; },
    noteRowReadCount: () => noteRowReads,
    tcw: {
      did: "did:test:voice",
      sql: {
        db: () => ({
          query: async (sql: string, params: unknown[] = []) => {
            if (sql.includes("SELECT duration_secs, metadata")) {
              noteRowReads++;
              if (failNoteRowReads > 0) {
                failNoteRowReads--;
                return { ok: false, error: { code: "SQL", message: "temporary row read failure" } };
              }
            }
            return runSql(() => ({ rows: sqlite.query(sql).values(...(params as never[])) }));
          },
          execute: async (sql: string, params: unknown[] = []) =>
            runSql(() => {
              sqlite.query(sql).run(...(params as never[]));
              return { rows: [] };
            }),
        }),
      },
      kv: {
        put: async (key: string, value: string | Uint8Array) => {
          kv.set(key, value);
          return { ok: true, data: { headers: {} } };
        },
        get: async (key: string) => (kv.has(key) ? { ok: true, data: { data: kv.get(key) } } : { ok: false, error: { code: "KV_NOT_FOUND", message: "missing" } }),
        list: async ({ path }: { path: string }) => ({ ok: true, data: { keys: [...kv.keys()].filter((k) => k.startsWith(path)) } }),
      },
    } as never,
  };
}

const RECORDING = {
  id: "rec-1",
  startedAt: Date.parse("2026-10-03T09:00:00.000Z"),
  durationMs: 9_000,
  mimeType: "audio/mp4",
  sizeBytes: 72_000,
  silencedMs: 0,
  silencedEvents: 0,
  noSignalMs: 0,
  options: { transcriber: "private-cloud", identifySpeakers: false, uploadAudio: true },
};

describe("transcribeVoiceNote (one note end to end)", () => {
  beforeEach(() => _resetConnectorSchemaMemoForTests());

  test("a stereo space copy sends Private separate mode after local cleanup", async () => {
    const space = sqliteSpace();
    expect((await saveVoiceNote(space.tcw, { ...RECORDING, channels: 2 }, AUDIO, "tauri")).ok).toBe(true);
    const fake = createFakeVoiceNotes();
    fake.plugin.listPending = async () => ({ recordings: [] });
    __setVoiceNotesForTests(fake.plugin, { available: true });
    const h = harness({ decode: silentDecoder() });
    expect(await transcribeVoiceNote({ tcw: space.tcw, cloud: h.cloud, capabilities: CAPS,
      overrideCommitted: true, explicit: true, sourceId: "rec-1", report: () => {} })).toBe("transcribed");
    expect(h.creates[0]?.body).toMatchObject({ channel_mode: "separate", channel_labels: ["Me", "Them"] });
  });

  for (const platform of ["ios", "android", "tauri"] as const) {
    test(`${platform} native file upload uses metadata and never reads audio over the JS bridge`, async () => {
      const space = sqliteSpace();
      expect((await saveVoiceNote(space.tcw, RECORDING, AUDIO, platform)).ok).toBe(true);
      const fake = createFakeVoiceNotes();
      let readCalls = 0;
      let uploadRequest: unknown;
      let progressListener: ((event: { uploadId: string; loaded: number; total: number }) => void) | undefined;
      fake.plugin.listPending = async () => ({ recordings: [{ ...RECORDING, sizeBytes: 4, ledger: {
        audio: { state: "saved" }, transcriptSync: { state: "pending", rev: 0, at: null },
      } } as never] });
      fake.plugin.getTranscript = async () => ({ transcript: null });
      fake.plugin.audioMetadata = async () => ({ size: 4, mimeType: "audio/mp4", sha256: "a".repeat(64) });
      fake.plugin.readAudioChunk = async () => { readCalls++; throw new Error("must not read native audio over JS"); };
      fake.plugin.uploadAudio = async (request) => {
        uploadRequest = request;
        progressListener?.({ uploadId: request.uploadId, loaded: 2, total: 4 });
        return { status: 201, body: { status: "queued" } };
      };
      fake.plugin.addListener = (async (_event: string, listener: never) => {
        progressListener = listener as typeof progressListener;
        return { remove: async () => {} };
      }) as typeof fake.plugin.addListener;
      __setVoiceNotesForTests(fake.plugin, { available: true });
      __setInstalledEngineForTests(platform === "tauri" ? "tauri" : "native", { ...captureCapabilities(), nativeFileUpload: true });
      const h = harness({ nativeTransport: true });
      const progress: VoiceNoteTranscriptionStatus[] = [];
      const outcome = await transcribeVoiceNote({ tcw: space.tcw, cloud: h.cloud, capabilities: {
        ...CAPS, content_types: [...CAPS.content_types, "audio/mp4"],
      }, sourceId: "rec-1", overrideCommitted: true, explicit: true,
      report: (status) => progress.push(status) });
      expect(outcome).toBe("transcribed");
      expect(h.creates[0]?.body).toMatchObject({ content_type: "audio/mp4", byte_size: 4, sha256: "a".repeat(64) });
      expect(uploadRequest).toMatchObject({ id: "rec-1", contentLength: 4, contentType: "audio/mp4" });
      expect(readCalls).toBe(0);
      expect(progress).toContainEqual({ kind: "uploading", progress: 0.5 });
      __setVoiceNotesForTests(originalVoiceNotes, { available: null });
      __resetCaptureEngineForTests();
    });
  }

  test("missing native file at metadata time falls back to the committed space copy", async () => {
    const space = sqliteSpace();
    expect((await saveVoiceNote(space.tcw, RECORDING, AUDIO, "ios")).ok).toBe(true);
    const fake = createFakeVoiceNotes();
    fake.plugin.listPending = async () => ({ recordings: [{ ...RECORDING, ledger: {
      audio: { state: "saved" }, transcriptSync: { state: "pending", rev: 0, at: null },
    } } as never] });
    fake.plugin.getTranscript = async () => ({ transcript: null });
    fake.plugin.audioMetadata = async () => { throw Object.assign(new Error("gone"), { code: "not_found" }); };
    __setVoiceNotesForTests(fake.plugin, { available: true });
    const h = harness({});
    expect(await transcribeVoiceNote({ tcw: space.tcw, cloud: h.cloud,
      capabilities: { ...CAPS, content_types: [...CAPS.content_types, "audio/mp4"] },
      sourceId: "rec-1", overrideCommitted: true, explicit: true, nativePlatform: "ios", report: () => {} })).toBe("transcribed");
    expect(h.creates[0]?.body.byte_size).toBe(4);
    expect(h.puts[0]?.nativeFileId).toBeUndefined();
    expect(h.puts[0]?.base64).toBe(AUDIO.base64);
    __setVoiceNotesForTests(originalVoiceNotes, { available: null });
  });

  test("launch resume deletes an old cloud job for an on-device note and the next launch does not retry it", async () => {
    const space = sqliteSpace();
    expect((await saveVoiceNote(space.tcw, RECORDING, AUDIO, "ios")).ok).toBe(true);
    space.sqlite.query(`UPDATE connector_meeting SET metadata = json_set(metadata,
      '$.capture.version', 2, '$.capture.options.transcriber', 'on-device') WHERE source_id = 'rec-1'`).run();
    VoiceNotes.listPending = async () => ({ recordings: [] }); // The native sidecar has been removed.
    const h = harness({});
    h.pending.write("rec-1", { attemptId: "00000000-0000-4000-8000-00000000abcd", transcriptionId: ID });
    const launch = () => createVoiceNoteTranscriber({
      cloud: h.cloud, consent: { get: () => true, set: () => {} }, tcw: () => space.tcw, holds: memoryHoldStore(),
    });
    await launch().check();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.removed).toEqual([ID]);
    expect(h.pending.sourceIds()).toEqual([]);
    expect(h.creates).toHaveLength(0);
    expect(h.puts).toHaveLength(0);

    await launch().check();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.removed).toEqual([ID]);
    expect(h.pending.sourceIds()).toEqual([]);
    expect(h.creates).toHaveLength(0);
  });

  test("a native on-device choice also deletes a pending cloud job for a legacy-shaped space row", async () => {
    const space = sqliteSpace();
    expect((await saveVoiceNote(space.tcw, RECORDING, AUDIO, "ios")).ok).toBe(true);
    VoiceNotes.listPending = async () => ({ recordings: [{ ...RECORDING,
      options: { transcriber: "on-device", identifySpeakers: false } } as never] });
    const h = harness({});
    h.pending.write("rec-1", { attemptId: "00000000-0000-4000-8000-00000000abcd", transcriptionId: ID2 });
    const error = await transcribeVoiceNote({ tcw: space.tcw, cloud: h.cloud, capabilities: CAPS, explicit: true,
      sourceId: "rec-1", report: () => {} }).catch((caught: unknown) => caught);
    expect((error as PrivateCloudError).code).toBe("transcription_off");
    expect(h.removed).toEqual([ID2]);
    expect(h.pending.sourceIds()).toEqual([]);
    expect(h.creates).toHaveLength(0);
  });

  test("manual Retry obeys the committed v2 choice after the native sidecar is gone", async () => {
    for (const transcriber of ["off", "on-device", "private-cloud"] as const) {
      _resetConnectorSchemaMemoForTests();
      const space = sqliteSpace();
      expect((await saveVoiceNote(space.tcw, RECORDING, AUDIO, "ios")).ok).toBe(true);
      space.sqlite.query(`UPDATE connector_meeting SET metadata = json_set(metadata,
        '$.capture.version', 2, '$.capture.options.transcriber', ?) WHERE source_id = 'rec-1'`).run(transcriber);
      VoiceNotes.listPending = async () => ({ recordings: [] });
      const h = harness({});
      const attempt = transcribeVoiceNote({ tcw: space.tcw, cloud: h.cloud, capabilities: CAPS, explicit: true,
        sourceId: "rec-1", report: () => {} });
      if (transcriber === "private-cloud") {
        expect(await attempt).toBe("transcribed");
        expect(h.creates).toHaveLength(1);
      } else {
        expect((await attempt.catch((error: unknown) => error) as PrivateCloudError).code).toBe("transcription_off");
        expect(h.calls).toEqual([]);
      }
    }
  });

  test("overrideCommitted (Use Private instead) transcribes a note committed to Local or Audio only", async () => {
    for (const transcriber of ["off", "on-device"] as const) {
      _resetConnectorSchemaMemoForTests();
      const space = sqliteSpace();
      expect((await saveVoiceNote(space.tcw, RECORDING, AUDIO, "ios")).ok).toBe(true);
      space.sqlite.query(`UPDATE connector_meeting SET metadata = json_set(metadata,
        '$.capture.version', 2, '$.capture.options.transcriber', ?) WHERE source_id = 'rec-1'`).run(transcriber);
      VoiceNotes.listPending = async () => ({ recordings: [{ ...RECORDING, options: { transcriber, identifySpeakers: false } } as never] });
      const h = harness({});
      const outcome = await transcribeVoiceNote({ tcw: space.tcw, cloud: h.cloud, capabilities: CAPS,
        sourceId: "rec-1", overrideCommitted: true, explicit: true, report: () => {} });
      expect(outcome).toBe("transcribed");
      expect(h.creates).toHaveLength(1);
    }
  });

  test("a note owned by another account is rejected before contacting private cloud", async () => {
    const space = sqliteSpace();
    expect((await saveVoiceNote(space.tcw, RECORDING, AUDIO, "android")).ok).toBe(true);
    const list = VoiceNotes.listPending.bind(VoiceNotes);
    VoiceNotes.listPending = async () => ({ recordings: (await list()).recordings.map((note) => ({ ...note, owner: "did:other" })) });
    const h = harness({});
    await expect(transcribeVoiceNote({ tcw: space.tcw, cloud: h.cloud, capabilities: CAPS, explicit: true,
      sourceId: "rec-1", report: () => {} })).rejects.toMatchObject({ code: "transcript_save_failed" });
    expect(h.calls).toEqual([]);
  });

  test("Library Transcribe saves other-device and old random-id notes absent from this phone", async () => {
    for (const rowId of ["vn-rec-1", "older-random-row"]) {
      _resetConnectorSchemaMemoForTests();
      const space = sqliteSpace();
      expect((await saveVoiceNote(space.tcw, RECORDING, AUDIO, "android")).ok).toBe(true);
      if (rowId !== "vn-rec-1") space.sqlite.query("UPDATE connector_meeting SET id = ? WHERE id = 'vn-rec-1'").run(rowId);
      VoiceNotes.listPending = async () => ({ recordings: [] });
      VoiceNotes.getTranscript = async () => { throw new Error("No phone transcript read expected"); };
      const h = harness({});
      expect(await transcribeVoiceNote({ tcw: space.tcw, cloud: h.cloud, capabilities: CAPS, explicit: true,
        sourceId: "rec-1", report: () => {} })).toBe("transcribed");
      expect(h.creates).toHaveLength(1);
      expect(await readTranscriptCommit(space.tcw, "rec-1")).toMatchObject({ rev: 1, speakerLabels: false });
    }
  });

  test("a claimed iOS v1 phone copy without a ledger can be transcribed", async () => {
    const space = sqliteSpace();
    expect((await saveVoiceNote(space.tcw, RECORDING, AUDIO, "ios")).ok).toBe(true);
    VoiceNotes.listPending = async () => ({ recordings: [{ ...RECORDING, version: 1,
      owner: "did:test:voice", ownerUnknown: false } as never] });
    const h = harness({});
    expect(await transcribeVoiceNote({ tcw: space.tcw, cloud: h.cloud, capabilities: CAPS, explicit: true,
      sourceId: "rec-1", report: () => {} })).toBe("transcribed");
    expect(await readTranscriptCommit(space.tcw, "rec-1")).toMatchObject({ rev: 1 });
  });
  test("a null row duration uses capture duration, then leaves an unknown raw duration to PTX", async () => {
    const tooLong = sqliteSpace();
    expect((await saveVoiceNote(tooLong.tcw, RECORDING, AUDIO, "web")).ok).toBe(true);
    tooLong.sqlite.query(`UPDATE connector_meeting SET duration_secs = NULL,
      metadata = json_set(metadata, '$.capture.duration_ms', 7201000) WHERE source_id = 'rec-1'`).run();
    const rejected = harness({});
    const refusal = await transcribeVoiceNote({ tcw: tooLong.tcw, cloud: rejected.cloud, capabilities: CAPS, explicit: true,
      sourceId: "rec-1", report: () => {} }).catch((caught: unknown) => caught);
    expect(refusal).toMatchObject({ code: "recording_too_long" });
    expect(rejected.creates).toHaveLength(0);

    _resetConnectorSchemaMemoForTests();
    const unknownDuration = sqliteSpace();
    expect((await saveVoiceNote(unknownDuration.tcw, RECORDING, AUDIO, "web")).ok).toBe(true);
    unknownDuration.sqlite.query(`UPDATE connector_meeting SET duration_secs = NULL,
      metadata = json_remove(metadata, '$.capture.duration_ms') WHERE source_id = 'rec-1'`).run();
    const ptx = harness({});
    expect(await transcribeVoiceNote({ tcw: unknownDuration.tcw, cloud: ptx.cloud,
      capabilities: { ...CAPS, content_types: [...CAPS.content_types, "audio/mp4"] },
      explicit: true, sourceId: "rec-1", report: () => {} })).toBe("transcribed");
    expect(ptx.creates).toHaveLength(1);
  });

  test("only diarizing metadata sets the commit's speaker-label flag", async () => {
    const space = sqliteSpace();
    expect((await saveVoiceNote(space.tcw, RECORDING, AUDIO, "ios")).ok).toBe(true);
    for (const [index, label] of ["single-speaker", "diarized", "channels", "channel-you-others", "none"].entries()) {
      const prepared = prepareVoiceNoteTranscript(TRANSCRIPT, "2026-10-03T10:00:00.000Z", index + 1);
      prepared.metadata.speaker_labels = label;
      expect((await saveVoiceNoteTranscript(space.tcw, "rec-1", prepared)).ok).toBe(true);
      expect((await readTranscriptCommit(space.tcw, "rec-1"))?.speakerLabels).toBe(index > 0 && index < 4);
    }
  });

  test("the transcript lands on the note's transcript key and row, then the PTX job is deleted", async () => {
    const space = sqliteSpace();
    expect((await saveVoiceNote(space.tcw, RECORDING, AUDIO, "android")).ok).toBe(true);
    const h = harness({});
    const outcome = await transcribeVoiceNote({
      tcw: space.tcw,
      cloud: h.cloud,
      capabilities: CAPS,
      explicit: true,
      sourceId: "rec-1",
      report: () => {},
      now: () => new Date("2026-10-03T10:00:00.000Z"),
    });
    expect(outcome).toBe("transcribed");
    expect(await readTranscriptCommit(space.tcw, "rec-1")).toMatchObject({ rev: 1, speakerLabels: false });
    expect(JSON.parse(space.kv.get(transcriptKvKey(VOICE_NOTE_SOURCE, "rec-1")) as string)).toEqual([
      { index: 0, speaker_name: null, text: "Remember to book", start_time: 0.5, end_time: 4, channel: 0, timing: "engine" },
      { index: 1, speaker_name: null, text: "the venue.", start_time: 5, end_time: 9, channel: 0, timing: "engine" },
    ]);
    const listed = await listVoiceNotes(space.tcw);
    expect(listed.ok && listed.data[0]).toEqual(expect.objectContaining({
      sourceId: "rec-1",
      durationSecs: 9,
      title: expect.stringContaining("Voice note"),
      transcript: { status: "transcribed", preview: "Remember to book\nthe venue." },
    }));
    expect(space.kv.has(`${voiceNoteAudioKvKey("rec-1")}/manifest`)).toBe(true);
    expect([...space.kv.keys()].some((key) => key.startsWith(`${voiceNoteAudioKvKey("rec-1")}/p/`))).toBe(true);
    expect(h.removed).toEqual([ID]);
    expect(h.pending.read("rec-1")).toBeNull();
  });
  test("PTX quiet VAD diagnostics commit to the row and clear on a later stats-less commit", async () => {
    const space = sqliteSpace();
    expect((await saveVoiceNote(space.tcw, RECORDING, AUDIO, "web")).ok).toBe(true);
    const diagnostics = {
      vad_mode: "quiet", noise_floor_dbfs: -61.5, median_dbfs: -58, p99_dbfs: -29,
      speech_peak_s: 2.4, dropped_above_noise_pct: 3.5,
    };
    const first = harness({ result: { ...TRANSCRIPT, stats: diagnostics } as unknown as PrivateCloudTranscript });
    expect(await transcribeVoiceNote({ tcw: space.tcw, cloud: first.cloud, capabilities: CAPS, explicit: true,
      sourceId: "rec-1", report: () => {} })).toBe("transcribed");
    expect((await resolveVoiceNoteRow(space.tcw, "rec-1"))?.metadata).toMatchObject({
      transcription_vad_mode: "quiet", transcription_noise_floor_dbfs: -61.5,
      transcription_median_dbfs: -58, transcription_p99_dbfs: -29,
      transcription_speech_peak_s: 2.4, transcription_vad_dropped_above_noise_pct: 3.5,
    });

    const later = { ...TRANSCRIPT, text: "follow-up", segments: TRANSCRIPT.segments.map((segment, index) =>
      index === 0 ? { ...segment, text: "follow-up" } : segment), stats: undefined };
    const prepared = prepareVoiceNoteTranscript(later, "2026-10-04T10:00:00.000Z", 2);
    expect((await saveVoiceNoteTranscript(space.tcw, "rec-1", prepared)).ok).toBe(true);
    const metadata = (await resolveVoiceNoteRow(space.tcw, "rec-1"))?.metadata;
    expect(metadata?.transcript_text).toBe("Remember to book\nfollow-up");
    for (const key of ["transcription_vad_mode", "transcription_noise_floor_dbfs", "transcription_median_dbfs",
      "transcription_p99_dbfs", "transcription_speech_peak_s", "transcription_vad_dropped_above_noise_pct"])
      expect(metadata?.[key]).toBeUndefined();
  });
  test("invalid optional quiet VAD diagnostics do not block transcript commits", async () => {
    const space = sqliteSpace();
    expect((await saveVoiceNote(space.tcw, RECORDING, AUDIO, "web")).ok).toBe(true);
    const h = harness({ result: { ...TRANSCRIPT, stats: {
      vad_mode: "noisy", noise_floor_dbfs: Number.NaN, median_dbfs: Number.POSITIVE_INFINITY,
      p99_dbfs: -Infinity,
    } } as unknown as PrivateCloudTranscript });
    expect(await transcribeVoiceNote({ tcw: space.tcw, cloud: h.cloud, capabilities: CAPS, explicit: true,
      sourceId: "rec-1", report: () => {} })).toBe("transcribed");
    expect(await readTranscriptCommit(space.tcw, "rec-1")).toMatchObject({ outcome: "transcribed" });
    const metadata = (await resolveVoiceNoteRow(space.tcw, "rec-1"))?.metadata;
    for (const key of ["transcription_vad_mode", "transcription_noise_floor_dbfs", "transcription_median_dbfs",
      "transcription_p99_dbfs"])
      expect(metadata?.[key]).toBeUndefined();
  });
  test("a 4,337-second low-coverage completion is saved as retryable failure and its job is deleted", async () => {
    const space = sqliteSpace();
    const recording = { ...RECORDING, durationMs: 4_337_000 };
    expect((await saveVoiceNote(space.tcw, recording, AUDIO, "web")).ok).toBe(true);
    const h = harness({ result: {
      ...TRANSCRIPT, duration_seconds: 4_337,
      stats: { tinfoil_calls: 1, tinfoil_audio_seconds: 1_248, voiced_seconds: 1_200,
        dropped_above_floor_pct: 72, vad_fallback: false, vad_mode: "quiet", noise_floor_dbfs: -61.5,
        median_dbfs: -58, p99_dbfs: -29, speech_peak_s: 2.4, dropped_above_noise_pct: 3.5 },
    } as unknown as PrivateCloudTranscript });
    const error = await transcribeVoiceNote({ tcw: space.tcw, cloud: h.cloud, capabilities: CAPS, explicit: true,
      sourceId: "rec-1", report: () => {} }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "transcript_incomplete" });
    expect(await readTranscriptCommit(space.tcw, "rec-1")).toBeNull();
    expect((await resolveVoiceNoteRow(space.tcw, "rec-1"))?.metadata).toMatchObject({
      transcription_outcome: "failed",
      transcription_error_code: "transcript_incomplete",
      transcription_audio_seconds: 1_248,
      transcription_duration_seconds: 4_337,
      transcription_vad_dropped_above_floor_pct: 72,
      transcription_vad_fallback: false,
      transcription_voiced_seconds: 1_200,
      transcription_vad_mode: "quiet",
      transcription_noise_floor_dbfs: -61.5,
      transcription_median_dbfs: -58,
      transcription_p99_dbfs: -29,
      transcription_speech_peak_s: 2.4,
      transcription_vad_dropped_above_noise_pct: 3.5,
    });
    expect(h.removed).toEqual([ID]);
  });
  test("mostly silent PTX notes below 0.35 coverage stay retryable even when reported VAD drops are within threshold", async () => {
    const space = sqliteSpace();
    expect((await saveVoiceNote(space.tcw, { ...RECORDING, durationMs: 639_600 }, AUDIO, "web")).ok).toBe(true);
    const h = harness({ result: {
      ...TRANSCRIPT,
      duration_seconds: 639.6,
      stats: { tinfoil_calls: 1, tinfoil_audio_seconds: 66.5, dropped_above_floor_pct: 3.8 },
    } as unknown as PrivateCloudTranscript });

    const error = await transcribeVoiceNote({ tcw: space.tcw, cloud: h.cloud, capabilities: CAPS, explicit: true,
      sourceId: "rec-1", report: () => {} }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "transcript_incomplete" });
    expect(await readTranscriptCommit(space.tcw, "rec-1")).toBeNull();
    expect((await resolveVoiceNoteRow(space.tcw, "rec-1"))?.metadata).toMatchObject({
      transcription_outcome: "failed", transcription_error_code: "transcript_incomplete",
    });
    expect(h.removed).toEqual([ID]);
  });
  test("quiet PTX recordings with low coverage are rejected even when VAD reports no drops", async () => {
    const space = sqliteSpace();
    expect((await saveVoiceNote(space.tcw, { ...RECORDING, durationMs: 639_600 }, AUDIO, "web")).ok).toBe(true);
    const h = harness({ result: {
      ...TRANSCRIPT, duration_seconds: 639.6,
      stats: { tinfoil_audio_seconds: 639.6 * 0.2, dropped_above_floor_pct: 0, vad_fallback: false },
    } as unknown as PrivateCloudTranscript });

    const error = await transcribeVoiceNote({ tcw: space.tcw, cloud: h.cloud, capabilities: CAPS, explicit: true,
      sourceId: "rec-1", report: () => {} }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "transcript_incomplete" });
    expect(await readTranscriptCommit(space.tcw, "rec-1")).toBeNull();
    expect(h.removed).toEqual([ID]);
  });
  test("dropped percentage rejects only above 10 even when coverage is adequate", async () => {
    for (const [dropped, expected] of [[10, "commit"], [10.1, "reject"]] as const) {
      _resetConnectorSchemaMemoForTests();
      const space = sqliteSpace();
      expect((await saveVoiceNote(space.tcw, { ...RECORDING, durationMs: 639_600 }, AUDIO, "web")).ok).toBe(true);
      const h = harness({ result: {
        ...TRANSCRIPT, duration_seconds: 639.6,
        stats: { tinfoil_audio_seconds: 639.6 * 0.9, dropped_above_floor_pct: dropped, vad_fallback: false },
      } as unknown as PrivateCloudTranscript });
      const result = await transcribeVoiceNote({ tcw: space.tcw, cloud: h.cloud, capabilities: CAPS, explicit: true,
        sourceId: "rec-1", report: () => {} }).then(() => "commit", (error: unknown) => error);
      if (expected === "reject") {
        expect(result).toMatchObject({ code: "transcript_incomplete" });
        expect(await readTranscriptCommit(space.tcw, "rec-1")).toBeNull();
        expect(h.removed).toEqual([ID]);
      } else {
        expect(result).toBe("commit");
        expect(await readTranscriptCommit(space.tcw, "rec-1")).toMatchObject({ outcome: "transcribed" });
      }
    }
  });
  test("missing dropped percentage retains the long-note coverage fallback", async () => {
    for (const [coverage, expected] of [[0.29, "reject"], [0.36, "commit"]] as const) {
      _resetConnectorSchemaMemoForTests();
      const space = sqliteSpace();
      expect((await saveVoiceNote(space.tcw, { ...RECORDING, durationMs: 639_600 }, AUDIO, "web")).ok).toBe(true);
      const h = harness({ result: {
        ...TRANSCRIPT, duration_seconds: 639.6, stats: { tinfoil_audio_seconds: 639.6 * coverage },
      } as unknown as PrivateCloudTranscript });
      const result = await transcribeVoiceNote({ tcw: space.tcw, cloud: h.cloud, capabilities: CAPS, explicit: true,
        sourceId: "rec-1", report: () => {} }).then(() => "commit", (error: unknown) => error);
      if (expected === "reject") expect(result).toMatchObject({ code: "transcript_incomplete" });
      else expect(result).toBe("commit");
    }
  });
  test("AMI-like fallback result commits and emits an id-free count event", async () => {
    const space = sqliteSpace();
    expect((await saveVoiceNote(space.tcw, { ...RECORDING, durationMs: 722_500 }, AUDIO, "web")).ok).toBe(true);
    const lines: string[] = [];
    const info = console.info;
    console.info = ((line?: unknown) => { lines.push(String(line)); }) as typeof console.info;
    const h = harness({ result: {
      ...TRANSCRIPT, duration_seconds: 722.5,
      stats: { tinfoil_audio_seconds: 511.8, dropped_above_floor_pct: 0, vad_fallback: true },
    } as unknown as PrivateCloudTranscript });
    try {
      expect(await transcribeVoiceNote({ tcw: space.tcw, cloud: h.cloud, capabilities: CAPS, explicit: true,
        sourceId: "rec-1", report: () => {} })).toBe("transcribed");
    } finally { console.info = info; }
    const event = lines.map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((entry) => entry.operation === "transcription_vad_fallback");
    expect(event).toMatchObject({ count: 1, source_id: null, phase: "committed" });
    expect(JSON.stringify(event)).not.toContain("rec-1");
  });
  test("PTX with no usable stats commits, marks the row, logs a count without identifiers, then clears on a stats-free later commit", async () => {
    const space = sqliteSpace();
    expect((await saveVoiceNote(space.tcw, RECORDING, AUDIO, "web")).ok).toBe(true);
    const lines: string[] = [];
    const info = console.info;
    console.info = ((line?: unknown) => { lines.push(String(line)); }) as typeof console.info;
    const h = harness({ result: { ...TRANSCRIPT, duration_seconds: undefined, stats: undefined } as unknown as PrivateCloudTranscript });
    try {
      expect(await transcribeVoiceNote({ tcw: space.tcw, cloud: h.cloud, capabilities: CAPS, explicit: true,
        sourceId: "rec-1", report: () => {} })).toBe("transcribed");
    } finally { console.info = info; }
    expect((await resolveVoiceNoteRow(space.tcw, "rec-1"))?.metadata.transcription_stats_missing).toBe(true);
    const missingEvent = lines.map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((event) => event.operation === "transcription_stats_missing");
    expect(missingEvent).toMatchObject({ count: 1, source_id: null, phase: "committed" });
    expect(JSON.stringify(missingEvent)).not.toContain("rec-1");
    const prepared = prepareVoiceNoteTranscript(TRANSCRIPT, "2026-10-03T10:00:00.000Z", 2);
    expect((await saveVoiceNoteTranscript(space.tcw, "rec-1", prepared)).ok).toBe(true);
    expect((await resolveVoiceNoteRow(space.tcw, "rec-1"))?.metadata.transcription_stats_missing).toBeUndefined();
  });

  test("adequate coverage at the drop threshold and absent stats preserve the commit path", async () => {
    for (const [stats, expectedMetadata] of [
      [{ tinfoil_calls: 1, tinfoil_audio_seconds: 4_200, voiced_seconds: 4_100,
        dropped_above_floor_pct: 10, vad_fallback: true }, {
        transcription_audio_seconds: 4_200, transcription_duration_seconds: 4_337,
        transcription_voiced_seconds: 4_100,
        transcription_vad_dropped_above_floor_pct: 10, transcription_vad_fallback: true,
      }],
      [undefined, {}],
    ] as const) {
      _resetConnectorSchemaMemoForTests();
      const space = sqliteSpace();
      const recording = { ...RECORDING, durationMs: 4_337_000 };
      expect((await saveVoiceNote(space.tcw, recording, AUDIO, "web")).ok).toBe(true);
      const h = harness({ result: {
        ...TRANSCRIPT, duration_seconds: 4_337, ...(stats ? { stats } : {}),
      } as unknown as PrivateCloudTranscript });
      expect(await transcribeVoiceNote({ tcw: space.tcw, cloud: h.cloud, capabilities: CAPS, explicit: true,
        sourceId: "rec-1", report: () => {} })).toBe("transcribed");
      expect(await readTranscriptCommit(space.tcw, "rec-1")).toMatchObject({ outcome: "transcribed" });
      const metadata = (await resolveVoiceNoteRow(space.tcw, "rec-1"))?.metadata;
      expect(metadata).toMatchObject(expectedMetadata);
      if (stats === undefined) expect(metadata?.transcription_stats_missing).toBe(true);
      expect(h.removed).toEqual([ID]);
    }
  });
  test("non-finite dropped percentage uses the legacy coverage guard", async () => {
    const space = sqliteSpace();
    expect((await saveVoiceNote(space.tcw, { ...RECORDING, durationMs: 639_600 }, AUDIO, "web")).ok).toBe(true);
    const h = harness({ result: {
      ...TRANSCRIPT, duration_seconds: 639.6,
      stats: { tinfoil_audio_seconds: 185.5, dropped_above_floor_pct: Number.NaN },
    } as unknown as PrivateCloudTranscript });
    await expect(transcribeVoiceNote({ tcw: space.tcw, cloud: h.cloud, capabilities: CAPS, explicit: true,
      sourceId: "rec-1", report: () => {} })).rejects.toMatchObject({ code: "transcript_incomplete" });
    expect(await readTranscriptCommit(space.tcw, "rec-1")).toBeNull();
  });

  test("a private-cloud job started under A cannot notify B after the account switches before its save", async () => {
    const space = sqliteSpace();
    expect((await saveVoiceNote(space.tcw, RECORDING, AUDIO, "android")).ok).toBe(true);
    const h = harness({});
    const events: unknown[] = [];
    const off = captureEvents.on("library-changed", (detail) => events.push(detail));
    try {
      let switched = false;
      const error = await transcribeVoiceNote({ tcw: space.tcw, cloud: h.cloud, capabilities: CAPS, explicit: true,
        sourceId: "rec-1", report: (status) => {
          if (status.kind === "saving" && !switched) {
            switched = true;
            advanceAccountGeneration();
          }
        } }).catch((caught: unknown) => caught);
      expect((error as PrivateCloudError).code).toBe("account_changed");
      expect(switched).toBe(true);
      expect(events).toEqual([]);
      expect(await readTranscriptCommit(space.tcw, "rec-1")).toBeNull();
      expect((await resolveVoiceNoteRow(space.tcw, "rec-1"))?.metadata.transcription_outcome).toBe("pending");
    } finally {
      off();
    }
  });

  test("a queued private-cloud job retains its original account before its first task runs", async () => {
    const space = sqliteSpace();
    expect((await saveVoiceNote(space.tcw, RECORDING, AUDIO, "android")).ok).toBe(true);
    const h = harness({});
    const transcriber = createVoiceNoteTranscriber({
      cloud: h.cloud, consent: { get: () => true, set: () => {} }, tcw: () => space.tcw,
    });
    const generation = currentAccountGeneration();
    await transcriber.check({ current: () => currentAccountGeneration() === generation });
    const settled = Promise.withResolvers<void>();
    const unsubscribe = transcriber.subscribe((event) => {
      if (event.kind === "changed" && !transcriber.snapshot().jobs.has("rec-1")) settled.resolve();
    });
    const events: unknown[] = [];
    const off = captureEvents.on("library-changed", (detail) => events.push(detail));
    const unmount = mountVoiceNoteAccount(space.tcw.did);
    try {
      transcriber.transcribe("rec-1");
      advanceAccountGeneration();
      await settled.promise;
      expect(await readTranscriptCommit(space.tcw, "rec-1")).toBeNull();
      expect((await resolveVoiceNoteRow(space.tcw, "rec-1"))?.metadata.transcription_outcome).toBe("pending");
      expect(events).toEqual([]);
    } finally {
      unmount();
      unsubscribe();
      off();
    }
  });

  for (const transition of ["sign-out", "mounted account swap"] as const) {
    test(`a late on-device sync cannot notify after ${transition}`, async () => {
      const space = sqliteSpace();
      expect((await saveVoiceNote(space.tcw, RECORDING, AUDIO, "ios")).ok).toBe(true);
      const started = Promise.withResolvers<void>();
      const pending = Promise.withResolvers<{ transcript: LocalTranscript | null }>();
      VoiceNotes.getTranscript = () => { started.resolve(); return pending.promise; };
      const unmountA = mountVoiceNoteAccount(space.tcw.did);
      const events: unknown[] = [];
      const off = captureEvents.on("library-changed", (detail) => events.push(detail));
      let unmountB: (() => void) | undefined;
      try {
        const syncing = syncOnDeviceTranscript(space.tcw, { id: "rec-1", ledger: { audio: { state: "saved" } } });
        await started.promise;
        if (transition === "sign-out") advanceAccountGeneration();
        else {
          unmountA();
          unmountB = mountVoiceNoteAccount("did:test:other");
        }
        pending.resolve({ transcript: {
          version: 1, noteId: "rec-1", transcriber: "on-device", rev: 1,
          engine: "apple-speech", model: null, language: "en", outcome: "transcribed",
          diarized: false, segments: [{ start: 0, end: 1000, text: "Local words", speaker: null }],
          createdAt: "2026-10-03T10:00:00.000Z",
        } });
        await syncing;
        // A sign-out abandons the sync (the next launch's catch-up saves it); a swap of the mounted account still saves, silently.
        if (transition === "sign-out") expect(await readTranscriptCommit(space.tcw, "rec-1")).toBeNull();
        else expect(await readTranscriptCommit(space.tcw, "rec-1")).toMatchObject({ rev: 1 });
        expect(events).toEqual([]);
      } finally {
        unmountA();
        unmountB?.();
        off();
      }
    });
  }

  test("PTX no_speech failure saves its terminal outcome, marks missing stats, and logs a count", async () => {
    const space = sqliteSpace();
    await saveVoiceNote(space.tcw, RECORDING, AUDIO, "ios");
    const lines: string[] = [];
    const info = console.info;
    console.info = ((line?: unknown) => { lines.push(String(line)); }) as typeof console.info;
    const h = harness({ jobs: [job("failed", { error: { code: "no_speech", message: "No speech was found in the recording." } })] });
    try {
      const outcome = await transcribeVoiceNote({ tcw: space.tcw, cloud: h.cloud, capabilities: CAPS, explicit: true,
        sourceId: "rec-1", report: () => {} });
      expect(outcome).toBe("no_speech");
    } finally { console.info = info; }
    expect(space.kv.get(transcriptKvKey(VOICE_NOTE_SOURCE, "rec-1"))).toBe("[]");
    expect(h.calls).not.toContain(`result:${ID}`);
    const listed = await listVoiceNotes(space.tcw);
    expect(listed.ok && listed.data[0]!.transcript).toEqual({ status: "no_speech", preview: null });
    expect((await resolveVoiceNoteRow(space.tcw, "rec-1"))?.metadata.transcription_stats_missing).toBe(true);
    const event = lines.map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((entry) => entry.operation === "transcription_stats_missing");
    expect(event).toMatchObject({ count: 1, source_id: null, phase: "committed" });
    expect(JSON.stringify(event)).not.toContain("rec-1");
    expect(h.removed).toEqual([ID]);
  });

  test("completed empty PTX transcript commits no_speech through the result path without missing stats", async () => {
    const space = sqliteSpace();
    await saveVoiceNote(space.tcw, RECORDING, AUDIO, "ios");
    const lines: string[] = [];
    const info = console.info;
    console.info = ((line?: unknown) => { lines.push(String(line)); }) as typeof console.info;
    const h = harness({ result: { ...TRANSCRIPT, segments: [], text: "", stats: { tinfoil_audio_seconds: 9 } } });
    try {
      const outcome = await transcribeVoiceNote({ tcw: space.tcw, cloud: h.cloud, capabilities: CAPS, explicit: true,
        sourceId: "rec-1", report: () => {} });
      expect(outcome).toBe("no_speech");
    } finally { console.info = info; }
    expect(await readTranscriptCommit(space.tcw, "rec-1")).toMatchObject({ outcome: "no_speech" });
    expect(h.calls).toContain(`result:${ID}`);
    const metadata = (await resolveVoiceNoteRow(space.tcw, "rec-1"))?.metadata;
    expect(metadata).not.toHaveProperty("transcription_stats_missing");
    expect(lines.map((line) => JSON.parse(line) as Record<string, unknown>)
      .some((entry) => entry.operation === "transcription_stats_missing")).toBe(false);
    expect(h.removed).toEqual([ID]);
  });

  test("PTX partial stats mark the coverage pair missing", async () => {
    for (const transcript of [
      { ...TRANSCRIPT, duration_seconds: 9, stats: undefined },
      { ...TRANSCRIPT, duration_seconds: undefined, stats: { tinfoil_audio_seconds: 9 } },
      { ...TRANSCRIPT, duration_seconds: undefined, stats: null },
    ] as unknown as PrivateCloudTranscript[]) {
      _resetConnectorSchemaMemoForTests();
      const space = sqliteSpace();
      await saveVoiceNote(space.tcw, RECORDING, AUDIO, "ios");
      const h = harness({ result: transcript });
      expect(await transcribeVoiceNote({ tcw: space.tcw, cloud: h.cloud, capabilities: CAPS, explicit: true,
        sourceId: "rec-1", report: () => {} })).toBe("transcribed");
      expect((await resolveVoiceNoteRow(space.tcw, "rec-1"))?.metadata.transcription_stats_missing).toBe(true);
    }
  });

  test("an active account job deferral leaves the note pending", async () => {
    const space = sqliteSpace();
    await saveVoiceNote(space.tcw, RECORDING, AUDIO, "ios");
    const h = harness({ creates: [new PrivateCloudError("active_transcription_exists", "busy", { transcriptionId: ID2 })] });
    await expect(transcribeVoiceNote({ tcw: space.tcw, cloud: h.cloud, capabilities: CAPS,
      explicit: true, sourceId: "rec-1", report: () => {} })).rejects.toMatchObject({ code: "active_transcription_exists" });
    expect((await resolveVoiceNoteRow(space.tcw, "rec-1"))?.metadata.transcription_outcome).toBe("pending");
  });
  test("a failed no-speech commit persists its save failure", async () => {
    const space = sqliteSpace();
    await saveVoiceNote(space.tcw, RECORDING, AUDIO, "ios");
    const baseDb = space.tcw.sql.db.bind(space.tcw.sql);
    space.tcw.sql.db = ((name: string) => {
      const db = baseDb(name);
      return { ...db, execute: async (sql: string, params?: unknown[], options?: unknown) =>
        sql.includes("INSERT INTO voice_note_transcript")
          ? { ok: false, error: { code: "SQL", message: "offline" } }
          : db.execute(sql, params as never, options as never) };
    }) as typeof space.tcw.sql.db;
    const h = harness({ jobs: [job("failed", { error: { code: "no_speech", message: "No speech was found in the recording." } })] });
    await expect(transcribeVoiceNote({ tcw: space.tcw, cloud: h.cloud, capabilities: CAPS, explicit: true,
      sourceId: "rec-1", allowed: () => true, report: () => {} })).rejects.toMatchObject({ code: "transcript_save_failed" });
    expect((await resolveVoiceNoteRow(space.tcw, "rec-1"))?.metadata).toMatchObject({
      transcription_outcome: "failed", transcription_error_code: "transcript_save_failed",
    });
  });


  test("persists a service-busy failure in a legacy space without the transcript table", async () => {
    const space = sqliteSpace();
    await saveVoiceNote(space.tcw, RECORDING, AUDIO, "android");
    space.sqlite.exec("DROP TABLE voice_note_transcript");
    const legacyTcw = { ...space.tcw } as never;
    const h = harness({});
    h.cloud.transcribe = async () => { throw new PrivateCloudError("service_busy", "busy"); };
    await expect(transcribeVoiceNote({ tcw: legacyTcw, cloud: h.cloud, capabilities: CAPS,
      explicit: true, sourceId: "rec-1", report: () => {} })).rejects.toMatchObject({ code: "service_busy" });
    expect((await resolveVoiceNoteRow(legacyTcw, "rec-1"))?.metadata).toMatchObject({
      transcription_outcome: "failed", transcription_error_code: "service_busy",
    });
  });

  test("persists failure on the reindexed keeper in a cold pre-index space", async () => {
    const space = sqliteSpace();
    await saveVoiceNote(space.tcw, RECORDING, AUDIO, "android");
    space.sqlite.exec("DROP INDEX uq_connector_meeting_voice_note");
    space.sqlite.prepare(`INSERT INTO connector_meeting
      (id, source, source_id, title, started_at, duration_secs, organizer_email, participants,
       summary_overview, summary_action_items, keywords, meeting_type, metadata, created_at, updated_at)
      SELECT 'a-keeper', source, source_id, title, started_at, duration_secs, organizer_email, participants,
       summary_overview, summary_action_items, keywords, meeting_type, metadata, created_at, updated_at
      FROM connector_meeting WHERE id = 'vn-rec-1'`).run();
    _resetConnectorSchemaMemoForTests();
    const coldTcw = { ...space.tcw } as never;
    const h = harness({});
    h.cloud.transcribe = async () => { throw new PrivateCloudError("service_busy", "busy"); };
    await expect(transcribeVoiceNote({ tcw: coldTcw, cloud: h.cloud, capabilities: CAPS,
      explicit: true, sourceId: "rec-1", report: () => {} })).rejects.toMatchObject({ code: "service_busy" });
    expect(await resolveVoiceNoteRow(coldTcw, "rec-1")).toMatchObject({
      id: "a-keeper", metadata: { transcription_outcome: "failed", transcription_error_code: "service_busy" },
    });
  });

  test("a failure SELECT followed by an account switch cancels its queued UPDATE", async () => {
    const space = sqliteSpace();
    await saveVoiceNote(space.tcw, RECORDING, AUDIO, "android");
    let current = true;
    const baseDb = space.tcw.sql.db.bind(space.tcw.sql);
    space.tcw.sql.db = ((name: string) => {
      const db = baseDb(name);
      return { ...db, query: async (sql: string, params?: unknown[], options?: unknown) => {
        const result = await db.query(sql, params as never, options as never);
        if (sql.includes("SELECT id, source_id, metadata, created_at FROM connector_meeting WHERE source = 'exo-voice-note'")) {
          current = false;
          advanceAccountGeneration();
        }
        return result;
      } };
    }) as typeof space.tcw.sql.db;
    const h = harness({});
    h.cloud.transcribe = async () => { throw new PrivateCloudError("service_busy", "busy"); };
    const error = await transcribeVoiceNote({ tcw: space.tcw, cloud: h.cloud, capabilities: CAPS,
      explicit: true, sourceId: "rec-1", allowed: () => current, report: () => {} }).catch((caught: unknown) => caught);
    expect((error as PrivateCloudError).code).toBe("service_busy");
    expect((await resolveVoiceNoteRow(space.tcw, "rec-1"))?.metadata.transcription_outcome).toBe("pending");
  });

  test("a note that no longer exists: nothing is sent, no row is created, its leftover job is deleted", async () => {
    const space = sqliteSpace();
    await saveVoiceNote(space.tcw, { ...RECORDING, id: "other" }, AUDIO, "android");
    const h = harness({});
    h.pending.write("rec-1", { attemptId: "00000000-0000-4000-8000-00000000abcd", transcriptionId: ID2 });
    const err = await transcribeVoiceNote({ tcw: space.tcw, cloud: h.cloud, capabilities: CAPS, explicit: true, sourceId: "rec-1", audio: AUDIO, report: () => {} })
      .catch((e: unknown) => e);
    expect((err as PrivateCloudError).code).toBe("voice_note_not_found");
    expect(voiceNoteTranscriptionFailure(err).retryable).toBe(false);
    const listed = await listVoiceNotes(space.tcw);
    expect(listed.ok && listed.data.map((n) => n.sourceId)).toEqual(["other"]);
    expect(h.creates).toHaveLength(0);
    expect(h.puts).toHaveLength(0);
    expect(h.removed).toEqual([ID2]);
    expect(h.pending.read("rec-1")).toBeNull();
  });

  test("a PTX delete that fails after the save: the job is forgotten anyway, and the note is never transcribed again", async () => {
    const space = sqliteSpace();
    await saveVoiceNote(space.tcw, RECORDING, AUDIO, "android");
    const h = harness({ removeFails: true });
    expect(await transcribeVoiceNote({ tcw: space.tcw, cloud: h.cloud, capabilities: CAPS, explicit: true, sourceId: "rec-1", report: () => {} })).toBe("transcribed");
    expect(h.calls).toContain(`remove:${ID}`);
    // Forgotten before the delete was tried: a later run (Retry, relaunch) cannot re-join it, and
    // a 404 from PTX's own deletion can never turn into a second upload.
    expect(h.pending.read("rec-1")).toBeNull();
    const calls = h.calls.length;
    expect(await transcribeVoiceNote({ tcw: space.tcw, cloud: h.cloud, capabilities: CAPS, explicit: true, sourceId: "rec-1", report: () => {} })).toBe("transcribed");
    expect(h.calls.slice(calls)).toEqual([]);
    expect(h.puts).toHaveLength(1);
  });

  test("a note whose row already records an outcome is not transcribed again; a leftover job is deleted", async () => {
    const space = sqliteSpace();
    await saveVoiceNote(space.tcw, RECORDING, AUDIO, "android");
    await saveVoiceNoteTranscript(space.tcw, "rec-1", prepareVoiceNoteTranscript(TRANSCRIPT, "2026-10-03T10:00:00.000Z", 1));
    const h = harness({});
    // An older build saved the transcript, then lost the race to forget its job.
    h.pending.write("rec-1", { attemptId: "00000000-0000-4000-8000-00000000abcd", transcriptionId: ID });
    expect(await transcribeVoiceNote({ tcw: space.tcw, cloud: h.cloud, capabilities: CAPS, explicit: true, sourceId: "rec-1", report: () => {} })).toBe("transcribed");
    expect(h.calls).toEqual([`remove:${ID}`]);
    expect(h.pending.read("rec-1")).toBeNull();
  });

  test("the note's own length is checked against PTX before its audio is read", async () => {
    const space = sqliteSpace();
    await saveVoiceNote(space.tcw, { ...RECORDING, durationMs: 7_201_000 }, AUDIO, "android");
    const h = harness({});
    let loads = 0;
    const realGet = (space.tcw as { kv: { get: (k: string) => Promise<unknown> } }).kv.get;
    (space.tcw as { kv: { get: unknown } }).kv.get = async (k: string) => {
      loads++;
      return realGet(k);
    };
    const err = await transcribeVoiceNote({ tcw: space.tcw, cloud: h.cloud, capabilities: CAPS, explicit: true, sourceId: "rec-1", report: () => {} })
      .catch((e: unknown) => e);
    expect((err as { code: string }).code).toBe("recording_too_long");
    expect(loads).toBe(0);
    expect(h.creates).toHaveLength(0);
  });

  test("a failed save keeps the job, so Retry re-joins it and saves again without uploading", async () => {
    const space = sqliteSpace();
    await saveVoiceNote(space.tcw, RECORDING, AUDIO, "android");
    const h = harness({});
    const realPut = (space.tcw as { kv: { put: (k: string, v: string) => Promise<unknown> } }).kv.put;
    (space.tcw as { kv: { put: unknown } }).kv.put = async () => ({ ok: false, error: { code: "KV_ERROR", message: "offline" } });
    const err = await transcribeVoiceNote({ tcw: space.tcw, cloud: h.cloud, capabilities: CAPS, explicit: true,
      sourceId: "rec-1", account: { did: space.tcw.did, spaceId: "", generation: currentAccountGeneration() },
      allowed: () => true, report: () => {} })
      .catch((e: unknown) => e);
    expect(voiceNoteTranscriptionFailure(err)).toEqual(expect.objectContaining({ code: "transcript_save_failed", retryable: true }));
    const failed = await readVoiceNoteForTranscription(space.tcw, "rec-1");
    expect(failed.ok && failed.data?.transcript).toEqual({ status: "failed", preview: null });
    const errorRow = await resolveVoiceNoteRow(space.tcw, "rec-1");
    expect(errorRow?.metadata.transcription_error_code).toBe("transcript_save_failed");
    expect(h.removed).toEqual([]);
    expect(h.pending.read("rec-1")?.transcriptionId).toBe(ID);

    (space.tcw as { kv: { put: unknown } }).kv.put = realPut;
    expect(await transcribeVoiceNote({ tcw: space.tcw, cloud: h.cloud, capabilities: CAPS, explicit: true,
      sourceId: "rec-1", allowed: () => true, report: () => {} })).toBe("transcribed");
    expect(h.puts).toHaveLength(1);
    expect(h.removed).toEqual([ID]);
  });
});

describe("transcribeVoiceNote reads the note's stored audio (TC-517)", () => {
  beforeEach(() => {
    _resetConnectorSchemaMemoForTests();
    const fake = createFakeVoiceNotes();
    fake.plugin.listPending = async () => ({ recordings: [] });
    fake.plugin.getTranscript = async () => ({ transcript: null });
    __setVoiceNotesForTests(fake.plugin, { available: true });
  });

  test("internal audio read details are logged through errors, never shown in transcription copy", () => {
    const failure = voiceNoteTranscriptionFailure(new Error("loadVoiceNoteAudio: Key not found: private/key"));
    expect(failure.message).toBe("Transcription failed. Try again.");
    expect(failure.message).not.toContain("private/key");
  });

  test("uses retained local audio before the space copy when the KV key is missing", async () => {
    const space = sqliteSpace();
    const localBytes = new Uint8Array([9, 8, 7, 6, 5]);
    await storeVoiceNote(space.tcw, RECORDING, AUDIO, "android");
    for (const key of [...space.kv.keys()]) if (key.startsWith(`${voiceNoteAudioKvKey("rec-1")}/`)) space.kv.delete(key);
    space.kv.delete(voiceNoteAudioKvKey("rec-1"));

    const fake = createFakeVoiceNotes();
    fake.plugin.listPending = async () => ({ recordings: [{ ...RECORDING, sizeBytes: localBytes.byteLength, ledger: {
      audio: { state: "saved" }, transcriptSync: { state: "pending", rev: 0, at: null },
    } } as never] });
    fake.plugin.getTranscript = async () => ({ transcript: null });
    fake.plugin.readAudioChunk = async ({ id, offset, length }) => {
      const bytes = localBytes.slice(offset, offset + length);
      return { id, offset, base64: bytesToBase64(bytes), bytesRead: bytes.byteLength, size: localBytes.byteLength,
        eof: offset + bytes.byteLength >= localBytes.byteLength };
    };
    __setVoiceNotesForTests(fake.plugin, { available: true });

    let decoded: Uint8Array | null = null;
    const quiet = silentDecoder();
    const h = harness({ decode: async (buffer, rate) => {
      decoded = new Uint8Array(buffer.slice(0));
      return quiet(buffer, rate);
    } });
    await transcribeVoiceNote({ tcw: space.tcw, cloud: h.cloud, capabilities: CAPS, explicit: true, sourceId: "rec-1", report: () => {} });
    expect(decoded).toEqual(localBytes);
  });

  test("two saved notes transcribe without waiting for unrelated queued saves", async () => {
    const space = sqliteSpace();
    const ids = ["rec-1", "rec-2"];
    for (const id of ids) expect((await saveVoiceNote(space.tcw as never, { ...RECORDING, id }, AUDIO, "android")).ok).toBe(true);
    const fake = createFakeVoiceNotes();
    fake.plugin.listPending = async () => ({ recordings: [] });
    __setVoiceNotesForTests(fake.plugin, { available: true });
    const finishOtherSave = pendingStore.beginManualSave();
    try {
      for (const id of ids) {
        const h = harness({});
        const outcome = await transcribeVoiceNote({
          tcw: space.tcw as never, cloud: h.cloud, capabilities: CAPS, explicit: true, sourceId: id,
          report: () => {}, audioReadyStallMs: 5,
        });
        expect(outcome).toBe("transcribed");
        expect(h.creates).toHaveLength(1);
      }
    } finally {
      finishOtherSave();
    }
  });

  test("a pending ledger for this note stalls visibly instead of reading unsaved space audio", async () => {
    const space = sqliteSpace();
    expect((await saveVoiceNote(space.tcw as never, RECORDING, AUDIO, "android")).ok).toBe(true);
    const fake = createFakeVoiceNotes();
    fake.plugin.listPending = async () => ({ recordings: [{ ...RECORDING, source: "in_app", ledger: {
      audio: { state: "pending", rowId: null, at: null },
      transcriptSync: { state: "pending", rev: 0, at: null },
    } } as never] });
    fake.plugin.getTranscript = async () => ({ transcript: null });
    fake.plugin.readAudioChunk = async () => { throw Object.assign(new Error("file was removed"), { code: "not_found" }); };
    __setVoiceNotesForTests(fake.plugin, { available: true });
    const h = harness({});
    await expect(transcribeVoiceNote({
      tcw: space.tcw as never, cloud: h.cloud, capabilities: CAPS, explicit: true,
      sourceId: "rec-1", report: () => {}, audioReadyStallMs: 5, audioReadyPollMs: 1,
    })).rejects.toMatchObject({ code: "audio_read_failed" });
    expect(h.creates).toHaveLength(0);
  });

  for (const [platformShape, fail] of [
    ["iOS not_found", async () => { throw Object.assign(new Error("gone"), { code: "not_found" }); }],
    ["Android FileNotFoundException", async () => { throw Object.assign(new Error("gone"), { code: "java.io.FileNotFoundException: /recording.m4a" }); }],
    ["web tombstoned", async () => { throw Object.assign(new Error("gone"), { code: "tombstoned" }); }],
    ["truncated native read", async ({ id, offset }: { id: string; offset: number }) => ({
      id, offset, base64: bytesToBase64(new Uint8Array([9, 8])), bytesRead: 2, size: 5, eof: false,
    })],
  ] as const) {
    test(`falls back to the committed space copy for ${platformShape}`, async () => {
      const space = sqliteSpace();
      await saveVoiceNote(space.tcw as never, RECORDING, AUDIO, "android");
      const fake = createFakeVoiceNotes();
      fake.plugin.listPending = async () => ({ recordings: [{ ...RECORDING, sizeBytes: 5, ledger: {
        audio: { state: "saved" }, transcriptSync: { state: "pending", rev: 0, at: null },
      } } as never] });
      fake.plugin.getTranscript = async () => ({ transcript: null });
      fake.plugin.readAudioChunk = fail as typeof fake.plugin.readAudioChunk;
      __setVoiceNotesForTests(fake.plugin, { available: true });
      let decoded: Uint8Array | null = null;
      const quiet = silentDecoder();
      const h = harness({ decode: async (buffer, rate) => {
        decoded = new Uint8Array(buffer.slice(0));
        return quiet(buffer, rate);
      } });
      expect(await transcribeVoiceNote({ tcw: space.tcw, cloud: h.cloud, capabilities: CAPS, explicit: true, sourceId: "rec-1", report: () => {} })).toBe("transcribed");
      expect(decoded).toEqual(base64ToBytes(AUDIO.base64));
    });
  }

  test("does not read the space copy after an unrecognized local read error", async () => {
    const space = sqliteSpace();
    await saveVoiceNote(space.tcw as never, RECORDING, AUDIO, "android");
    const fake = createFakeVoiceNotes();
    fake.plugin.listPending = async () => ({ recordings: [{ ...RECORDING, sizeBytes: 5, ledger: {
      audio: { state: "saved" }, transcriptSync: { state: "pending", rev: 0, at: null },
    } } as never] });
    fake.plugin.getTranscript = async () => ({ transcript: null });
    fake.plugin.readAudioChunk = async () => { throw Object.assign(new Error("denied"), { code: "permission_denied" }); };
    __setVoiceNotesForTests(fake.plugin, { available: true });
    let audioReads = 0;
    const client = space.tcw as unknown as { kv: { get: (key: string) => Promise<unknown> } };
    const originalGet = client.kv.get;
    client.kv.get = async (key) => {
      if (key.startsWith(voiceNoteAudioKvKey("rec-1"))) audioReads++;
      return originalGet(key);
    };
    try {
      const h = harness({});
      await expect(transcribeVoiceNote({ tcw: space.tcw, cloud: h.cloud, capabilities: CAPS, explicit: true, sourceId: "rec-1", report: () => {} }))
        .rejects.toThrow("Could not read this note's local audio");
      expect(audioReads).toBe(0);
      expect(h.creates).toHaveLength(0);
    } finally { client.kv.get = originalGet; }
  });

  test("a note stored in parts is reassembled, in order, for the upload", async () => {
    const space = sqliteSpace();
    const bytes = new Uint8Array(2_500).map((_, i) => i % 251);
    await storeVoiceNote(space.tcw, RECORDING, voiceNoteAudioSourceFromBase64({ mimeType: "audio/mp4", base64: bytesToBase64(bytes) }), "android", { partSize: 1_000 }, true);
    expect(space.kv.get(voiceNoteAudioPartKey("rec-1", 2))).toBeInstanceOf(Uint8Array);
    let decoded: Uint8Array | null = null;
    const quiet = silentDecoder();
    const h = harness({
      decode: async (buffer, rate) => {
        decoded = new Uint8Array(buffer.slice(0));
        return quiet(buffer, rate);
      },
    });
    expect(await transcribeVoiceNote({ tcw: space.tcw, cloud: h.cloud, capabilities: CAPS, explicit: true, sourceId: "rec-1", report: () => {} })).toBe("transcribed");
    expect(decoded).toEqual(bytes);
  });

  test("a note saved before TC-517 (one base64 value) still transcribes", async () => {
    const space = sqliteSpace();
    await saveVoiceNote(space.tcw, RECORDING, AUDIO, "android");
    // Rewrite it the old way: no manifest, the whole audio at the base key.
    for (const key of [...space.kv.keys()]) if (key.startsWith(`${voiceNoteAudioKvKey("rec-1")}/`)) space.kv.delete(key);
    space.kv.set(voiceNoteAudioKvKey("rec-1"), JSON.stringify(AUDIO));
    const h = harness({});
    expect(await transcribeVoiceNote({ tcw: space.tcw, cloud: h.cloud, capabilities: CAPS, explicit: true, sourceId: "rec-1", report: () => {} })).toBe("transcribed");
  });

  test("a note of unknown length over PTX's byte limit is refused from its manifest before any part is read", async () => {
    const space = sqliteSpace();
    // 10 min at twice the phone's bitrate is the most read back; this note claims more.
    const big = new Uint8Array(600 * 16_000 + 1);
    await storeVoiceNote(space.tcw, { ...RECORDING, durationMs: 0 }, voiceNoteAudioSourceFromBase64({ mimeType: "audio/mp4", base64: bytesToBase64(big) }), "android", {}, true);
    const h = harness({});
    const gets: string[] = [];
    const realGet = (space.tcw as { kv: { get: (k: string) => Promise<unknown> } }).kv.get;
    (space.tcw as { kv: { get: unknown } }).kv.get = async (k: string) => {
      gets.push(k);
      return realGet(k);
    };
    const err = await transcribeVoiceNote({ tcw: space.tcw, cloud: h.cloud, capabilities: { ...CAPS, max_bytes: 1_000 }, explicit: true, sourceId: "rec-1", report: () => {} })
      .catch((e: unknown) => e);
    expect((err as { code: string }).code).toBe("recording_too_large");
    expect(gets.filter((k) => k.includes("/p/"))).toEqual([]);
    expect(h.creates).toHaveLength(0);
  });
});

describe("every path that creates or resumes an off-phone job consults the hold (real cloud, pending, consent and hold stores)", () => {
  beforeEach(() => _resetConnectorSchemaMemoForTests());
  const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };
  const ATTEMPT = "00000000-0000-4000-8000-00000000abcd";

  /** A saved private-cloud note whose row says where it began (`source: null`: a v1 row that says nothing), plus an interrupted attempt. */
  async function setup(source: string | null, opts: { consented?: boolean; holds?: Record<string, "held" | "released">; pending?: boolean; secondJob?: boolean } = {}) {
    const space = sqliteSpace();
    expect((await saveVoiceNote(space.tcw, RECORDING, AUDIO, "ios")).ok).toBe(true);
    if (source !== null) {
      space.sqlite.query(`UPDATE connector_meeting SET metadata = json_set(metadata, '$.capture.version', 2,
        '$.capture.options.transcriber', 'private-cloud', '$.capture.source', ?) WHERE source_id = 'rec-1'`).run(source);
    }
    VoiceNotes.listPending = async () => ({ recordings: [] });
    const storage = memoryStorage();
    const h = harness(opts.secondJob ? {
      creates: [
        { id: ID, status: "awaiting_upload", upload: { path: `/uploads/${ID}`, capability: CAP } },
        { id: ID2, status: "awaiting_upload", upload: { path: `/uploads/${ID2}`, capability: CAP } },
      ],
      puts: [{ status: 201, body: { status: "queued" } }, { status: 201, body: { status: "queued" } }],
      jobs: [job("completed"), job("completed")],
    } : {});
    if (opts.pending !== false) h.pending.write("rec-1", { attemptId: ATTEMPT, transcriptionId: null });
    const consent = localStorageVoiceNoteConsentStore(DID, storage);
    consent.set(opts.consented ?? true);
    const choices = localStorageVoiceNotePrivateChoiceStore(DID, storage);
    const holds = localStorageVoiceNoteHoldStore(DID, storage);
    if (opts.holds) holds.write(opts.holds);
    const launch = (store: VoiceNoteHoldStore = holds) => createVoiceNoteTranscriber({
      cloud: h.cloud, consent: localStorageVoiceNoteConsentStore(DID, storage), tcw: () => space.tcw, holds: store,
      choices: localStorageVoiceNotePrivateChoiceStore(DID, storage) });
    return { space, h, launch, holds, choices, storage };
  }
  const untouched = (h: { creates: unknown[]; puts: unknown[] }) => {
    expect(h.creates).toHaveLength(0);
    expect(h.puts).toHaveLength(0);
  };

  test("Sol r6 (1): a persisted hold plus an interrupted attempt, and consent: check() does not run it", async () => {
    const { h, launch, holds } = await setup("widget", { holds: { "rec-1": "held" } });
    const transcriber = launch();
    expect(transcriber.snapshot().jobs.get("rec-1")?.kind).toBe("held");
    await transcriber.check();
    await settle();
    untouched(h);
    expect(transcriber.snapshot().jobs.get("rec-1")?.kind).toBe("held");
    expect(holds.read()).toEqual({ "rec-1": "held" });
    expect(h.pending.sourceIds()).toEqual(["rec-1"]);
  });

  test("Sol r6 (1): the same through consent(), the account-level action", async () => {
    const { h, launch, holds } = await setup("widget", { consented: false, holds: { "rec-1": "held" } });
    const transcriber = launch();
    await transcriber.check();
    transcriber.consent();
    await settle();
    untouched(h);
    expect(transcriber.snapshot().jobs.get("rec-1")?.kind).toBe("held");
    expect(holds.read()).toEqual({ "rec-1": "held" });
  });

  test("Sol r6 (2): a note held just before check() is not run by the resume that check() starts", async () => {
    const { h, launch, holds } = await setup("widget");
    const transcriber = launch();
    transcriber.noteSaved({ id: "rec-1", durationMs: 9_000, source: "widget", options: { transcriber: "private-cloud", identifySpeakers: false } });
    expect(holds.read()).toEqual({ "rec-1": "held" });
    await transcriber.check();
    await settle();
    untouched(h);
    expect(transcriber.snapshot().jobs.get("rec-1")?.kind).toBe("held");
  });

  test("save-now and reconcile (noteSaved again) after the interrupted attempt: still no job", async () => {
    const { h, launch } = await setup("quick_action");
    const transcriber = launch();
    await transcriber.check();
    await settle();
    untouched(h);
    for (let i = 0; i < 2; i++) {
      transcriber.noteSaved({ id: "rec-1", durationMs: 9_000, source: "quick_action", options: { transcriber: "private-cloud", identifySpeakers: false } });
      await settle();
    }
    untouched(h);
    expect(transcriber.snapshot().jobs.get("rec-1")?.kind).toBe("held");
  });

  for (const source of ["quick_action", "app_shortcut", "intent", "control", "tile", "widget", "notification", "from-the-future", null] as const) {
    test(`an interrupted attempt for a note never offered to the transcriber is checked against its saved source (${source ?? "no source"}): held, not run, and the hold is kept`, async () => {
      const { h, launch, holds } = await setup(source);
      const transcriber = launch();
      expect(transcriber.snapshot().jobs.get("rec-1")).toBeUndefined();
      await transcriber.check();
      await settle();
      untouched(h);
      expect(transcriber.snapshot().jobs.get("rec-1")?.kind).toBe("held");
      expect(holds.read()).toEqual({ "rec-1": "held" });
      expect(launch().snapshot().jobs.get("rec-1")?.kind).toBe("held");
    });
  }


  test("a saved Private note is offered once capabilities recover in-session", async () => {
    const { space, h, storage, choices } = await setup("in_app", { pending: false });
    const answers: (PrivateCloudCapabilities | Error)[] = [
      new PrivateCloudError("service_unavailable", "offline"),
      CAPS,
    ];
    const cloud: VoiceNoteCloud = {
      ...h.cloud,
      capabilities: async () => {
        const answer = answers.shift()!;
        if (answer instanceof Error) throw answer;
        return answer;
      },
      pendingSourceIds: () => [],
    };
    let starts = 0;
    const transcriber = createVoiceNoteTranscriber({
      cloud, consent: localStorageVoiceNoteConsentStore(DID, storage), tcw: () => space.tcw,
      holds: memoryHoldStore(), choices, checkRetryMs: [],
      runNote: async () => { starts++; return "transcribed"; },
    });
    await transcriber.check();
    transcriber.noteSaved({ id: "rec-1", durationMs: 9_000, source: "in_app", options: { transcriber: "private-cloud" } });
    expect(transcriber.snapshot().jobs.get("rec-1")?.kind).toBe("blocked");
    expect(choices.ids()).toEqual(["rec-1"]);
    await transcriber.check();
    await settle();
    expect(starts).toBe(1);
    expect(transcriber.snapshot().jobs.get("rec-1")).toEqual({ kind: "done", outcome: "transcribed" });
  });

  test("a later outage does not strand a Private note after an earlier success", async () => {
    const { space, h, storage, choices } = await setup("in_app", { pending: false });
    const answers: (PrivateCloudCapabilities | Error)[] = [
      CAPS,
      new PrivateCloudError("service_unavailable", "offline"),
      CAPS,
    ];
    const transcriber = createVoiceNoteTranscriber({
      cloud: { ...h.cloud, capabilities: async () => {
        const answer = answers.shift()!;
        if (answer instanceof Error) throw answer;
        return answer;
      }, pendingSourceIds: () => [] },
      consent: localStorageVoiceNoteConsentStore(DID, storage), tcw: () => space.tcw,
      holds: memoryHoldStore(), choices, checkRetryMs: [], failedBackoffMs: [],
    });
    await transcriber.check();
    await transcriber.check();
    transcriber.noteSaved({ id: "rec-1", durationMs: 9_000, source: "in_app", options: { transcriber: "private-cloud" } });
    expect(choices.ids()).toEqual(["rec-1"]);
    await transcriber.check();
    await settle();
    expect(h.creates).toHaveLength(1);
    expect(h.puts).toHaveLength(1);
  });

  test("transient row rereads retry after backoff without rescanning repeated cached checks", async () => {
    const { space, h, storage, choices } = await setup("in_app", { pending: false });
    choices.add("rec-1");
    space.failNextNoteRowRead();
    const clock = { at: 1_000 };
    const transcriber = createVoiceNoteTranscriber({
      cloud: { ...h.cloud, capabilities: async () => CAPS, pendingSourceIds: () => [] },
      consent: localStorageVoiceNoteConsentStore(DID, storage), tcw: () => space.tcw,
      holds: memoryHoldStore(), choices, now: () => clock.at, checkRetryMs: [],
      recoveryBackoffMs: [15_000],
    });
    await transcriber.check({ automatic: true });
    await settle();
    expect(h.creates).toHaveLength(0);
    const readsAfterFailure = space.noteRowReadCount();
    for (let i = 0; i < 5; i++) await transcriber.check({ automatic: true });
    expect(space.noteRowReadCount()).toBe(readsAfterFailure);

    clock.at += 15_000;
    await transcriber.check({ automatic: true });
    await settle();
    // One recovery re-read plus the row read performed by the newly admitted transcription.
    expect(space.noteRowReadCount()).toBe(readsAfterFailure + 2);
    expect(h.creates).toHaveLength(1);
  });

  test("a failed automatic check retries availability after its bounded backoff", async () => {
    vi.useFakeTimers();
    try {
      const { space, h, storage, choices } = await setup("in_app", { pending: false });
      let checks = 0;
      const cloud: VoiceNoteCloud = {
        ...h.cloud,
        capabilities: async () => {
          checks++;
          if (checks === 1) throw new PrivateCloudError("service_unavailable", "offline");
          return CAPS;
        },
        pendingSourceIds: () => [],
      };
      const transcriber = createVoiceNoteTranscriber({
        cloud, consent: localStorageVoiceNoteConsentStore(DID, storage), tcw: () => space.tcw,
        holds: memoryHoldStore(), choices, checkRetryMs: [], failedBackoffMs: [1],
        runNote: async () => "transcribed",
      });
      await transcriber.check({ automatic: true });
      transcriber.noteSaved({ id: "rec-1", durationMs: 9_000, source: "in_app", options: { transcriber: "private-cloud" } });
      vi.advanceTimersByTime(1);
      for (let i = 0; i < 10; i++) await Promise.resolve();
      expect(checks).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a consented saved Private note's stranded intent resumes with a fresh transcriber", async () => {
    const { space, h, storage, choices } = await setup("in_app", { pending: false });
    const cloud: VoiceNoteCloud = { ...h.cloud, capabilities: async () => { throw new PrivateCloudError("service_unavailable", "offline"); } };
    const first = createVoiceNoteTranscriber({ cloud, consent: localStorageVoiceNoteConsentStore(DID, storage), tcw: () => space.tcw,
      holds: memoryHoldStore(), choices, checkRetryMs: [], runNote: async () => "transcribed" });
    await first.check();
    first.noteSaved({ id: "rec-1", durationMs: 9_000, source: "in_app", options: { transcriber: "private-cloud" } });
    expect(choices.ids()).toEqual(["rec-1"]);

    let starts = 0;
    const relaunched = createVoiceNoteTranscriber({
      cloud: { ...cloud, capabilities: async () => CAPS },
      consent: localStorageVoiceNoteConsentStore(DID, storage), tcw: () => space.tcw,
      holds: memoryHoldStore(), choices: localStorageVoiceNotePrivateChoiceStore(DID, storage), checkRetryMs: [],
      runNote: async () => { starts++; return "transcribed"; },
    });
    await relaunched.check();
    await settle();
    expect(starts).toBe(1);
  });

  test("a terminal incomplete outcome clears the choice and never restarts on relaunch", async () => {
    const { space, h, storage, choices } = await setup("in_app", { pending: false });
    const answers: (PrivateCloudCapabilities | Error)[] = [
      new PrivateCloudError("service_unavailable", "offline"),
      CAPS,
    ];
    const cloud: VoiceNoteCloud = { ...h.cloud, capabilities: async () => {
      const answer = answers.shift()!;
      if (answer instanceof Error) throw answer;
      return answer;
    }, pendingSourceIds: () => [] };
    const first = createVoiceNoteTranscriber({ cloud, consent: localStorageVoiceNoteConsentStore(DID, storage), tcw: () => space.tcw,
      holds: memoryHoldStore(), choices, checkRetryMs: [],
      runNote: async () => { throw new PrivateCloudError("transcript_incomplete", "incomplete"); } });
    await first.check();
    first.noteSaved({ id: "rec-1", durationMs: 9_000, source: "in_app", options: { transcriber: "private-cloud" } });
    await first.check();
    await settle();
    expect(first.snapshot().jobs.get("rec-1")).toMatchObject({ kind: "failed", code: "transcript_incomplete" });
    expect(choices.ids()).toEqual([]);

    let starts = 0;
    const relaunched = createVoiceNoteTranscriber({
      cloud: { ...cloud, capabilities: async () => CAPS },
      consent: localStorageVoiceNoteConsentStore(DID, storage), tcw: () => space.tcw,
      holds: memoryHoldStore(), choices: localStorageVoiceNotePrivateChoiceStore(DID, storage), checkRetryMs: [],
      runNote: async () => { starts++; return "transcribed"; },
    });
    await relaunched.check();
    await settle();
    expect(starts).toBe(0);

  });

  test("relaunch reoffers only a matching stranded local-ledger note", async () => {
    const { space, h, storage } = await setup("in_app", { pending: false });
    await saveVoiceNote(space.tcw, { ...RECORDING, id: "rec-2" }, AUDIO, "ios");
    space.sqlite.query(`UPDATE connector_meeting SET metadata = json_set(metadata, '$.transcription_outcome', 'transcribed')
      WHERE source_id = 'rec-2'`).run();
    const local = (id: string): VoiceNoteRecording => ({
      ...RECORDING,
      id,
      source: "in_app",
      options: { transcriber: "private-cloud", identifySpeakers: false },
      ledger: {
        audio: { state: "saved", rowId: id, at: 1 },
        transcript: { state: "pending", outcome: null, reason: null, attempts: 0, nextAttemptAt: null },
        transcriptSync: { state: "pending", rev: 0, at: null },
        landed: { state: "none", eventId: null },
        remote: [],
      },
    });
    VoiceNotes.listPending = async () => ({ recordings: [local("rec-1"), local("rec-2")] });
    let starts = 0;
    const transcriber = createVoiceNoteTranscriber({
      cloud: { ...h.cloud, capabilities: async () => CAPS, pendingSourceIds: () => [] },
      consent: localStorageVoiceNoteConsentStore(DID, storage), tcw: () => space.tcw,
      holds: memoryHoldStore(), choices: localStorageVoiceNotePrivateChoiceStore(DID, storage), checkRetryMs: [],
      runNote: async () => { starts++; return "transcribed"; },
    });
    await transcriber.check();
    await settle();
    expect(starts).toBe(1);
  });


  test("an interrupted attempt for a note the row says began in the app is still resumed", async () => {
    const { h, launch } = await setup("in_app");
    const transcriber = launch();
    await transcriber.check();
    await settle();
    expect(h.creates).toHaveLength(1);
    expect(transcriber.snapshot().jobs.get("rec-1")?.kind).toBe("done");
  });

  test("a legacy consent holds an in-app Private note until the new disclosure is confirmed", async () => {
    const { h, launch, storage } = await setup("in_app", { consented: false });
    storage.setItem(accountStorageKey(VOICE_NOTE_CONSENT_KEY, DID), "1");
    const transcriber = launch();
    expect(transcriber.snapshot().consented).toBe(false);
    await transcriber.check();
    await settle();
    untouched(h);
    transcriber.consent();
    await settle();
    expect(h.creates).toHaveLength(1);
  });

  test("default Private notes remain blocked across a relaunch and all resume after the new consent", async () => {
    const { space, h, launch, choices } = await setup("in_app", { consented: false, pending: false, secondJob: true });
    expect((await saveVoiceNote(space.tcw, { ...RECORDING, id: "rec-2" }, AUDIO, "ios")).ok).toBe(true);
    space.sqlite.query(`UPDATE connector_meeting SET metadata = json_set(metadata, '$.capture.version', 2,
      '$.capture.options.transcriber', 'private-cloud', '$.capture.source', 'in_app') WHERE source_id = 'rec-2'`).run();
    const first = launch();
    await first.check();
    for (const id of ["rec-1", "rec-2"]) first.noteSaved({ id, durationMs: 9_000, options: { transcriber: "private-cloud" }, source: "in_app" });
    expect(choices.ids()).toEqual(["rec-1", "rec-2"]);
    untouched(h);

    const relaunched = launch();
    for (const id of ["rec-1", "rec-2"]) expect(relaunched.snapshot().jobs.get(id)).toEqual({ kind: "blocked", reason: "no-consent" });
    await relaunched.check();
    await settle();
    untouched(h); // Not now leaves the durable blocker and Review action in place.
    relaunched.consent();
    await settle();
    expect(h.creates).toHaveLength(2);
    expect(choices.ids()).toEqual([]);
  });

  test("the hold list cannot be read: an in-app note is still resumed, a shortcut note is not", async () => {
    const unreadable: VoiceNoteHoldStore = { read: () => { throw new Error("unreadable"); }, write: () => {} };
    const silence = console.error;
    console.error = () => {};
    try {
      const shortcut = await setup("widget");
      await shortcut.launch(unreadable).check();
      await settle();
      untouched(shortcut.h);

      _resetConnectorSchemaMemoForTests();
      const inApp = await setup("in_app");
      await inApp.launch(unreadable).check();
      await settle();
      expect(inApp.h.creates).toHaveLength(1);
    } finally {
      console.error = silence;
    }
  });

  test("the hold list cannot be read and the note was explicitly released before: it is not resumed until the user asks again", async () => {
    const unreadable: VoiceNoteHoldStore = { read: () => { throw new Error("unreadable"); }, write: () => {} };
    const silence = console.error;
    console.error = () => {};
    try {
      const { h, launch } = await setup("widget", { holds: { "rec-1": "released" } });
      const transcriber = launch(unreadable);
      await transcriber.check();
      await settle();
      untouched(h);
      expect(transcriber.snapshot().jobs.get("rec-1")?.kind).toBe("held");
    } finally {
      console.error = silence;
    }
  });

  test("the user's own Transcribe on a held note runs it (Retry is the same action), and a later launch resumes it", async () => {
    const { h, launch, holds } = await setup("widget", { holds: { "rec-1": "held" }, pending: false });
    const transcriber = launch();
    await transcriber.check();
    transcriber.transcribe("rec-1");
    await settle();
    expect(h.creates).toHaveLength(1);
    expect(transcriber.snapshot().jobs.get("rec-1")?.kind).toBe("done");
    expect(holds.read()).toEqual({ "rec-1": "released" });

    // An attempt interrupted after that Transcribe is resumed by a later launch: the user asked for it.
    const next = harness({});
    next.pending.write("rec-1", { attemptId: ATTEMPT, transcriptionId: null });
    _resetConnectorSchemaMemoForTests();
    const space = sqliteSpace();
    expect((await saveVoiceNote(space.tcw, RECORDING, AUDIO, "ios")).ok).toBe(true);
    space.sqlite.query(`UPDATE connector_meeting SET metadata = json_set(metadata, '$.capture.version', 2,
      '$.capture.options.transcriber', 'private-cloud', '$.capture.source', 'widget') WHERE source_id = 'rec-1'`).run();
    const later = createVoiceNoteTranscriber({ cloud: next.cloud, consent: { get: () => true, set: () => {} }, tcw: () => space.tcw, holds });
    expect(later.snapshot().jobs.get("rec-1")).toBeUndefined();
    await later.check();
    await settle();
    expect(next.creates).toHaveLength(1);
    expect(later.snapshot().jobs.get("rec-1")?.kind).toBe("done");
  });

  test("a Transcribe the user asks for while consent is off does nothing and leaves the hold", async () => {
    const { h, launch, holds } = await setup("widget", { consented: false, holds: { "rec-1": "held" } });
    const transcriber = launch();
    await transcriber.check();
    transcriber.transcribe("rec-1");
    await settle();
    untouched(h);
    expect(holds.read()).toEqual({ "rec-1": "held" });
  });
});

describe("progress copy", () => {
  test("progress copy", () => {
    expect(transcriptionStatusText({ kind: "uploading" })).toBe("Sending audio to Private transcription…");
    expect(transcriptionStatusText({ kind: "uploading", progress: 0.42 })).toBe("Sending audio to Private transcription · 42%");
    expect(transcriptionStatusText({ kind: "queued", position: 3 })).toBe("Queued (position 3)…");
    expect(transcriptionStatusText({ kind: "processing", completed: 2, total: 5 })).toBe("Transcribing in private cloud… 2 of 5 parts done");
    expect(transcriptionStatusText({ kind: "processing", completed: 9, total: 9 })).toBe("Transcribing in private cloud… 9 of 9 parts done");
    expect(transcriptionStatusText({ kind: "processing", completed: null, total: null })).toBe("Transcribing in private cloud…");
    expect(transcriptionStatusText({ kind: "processing", completed: 2, total: 0 })).toBe("Transcribing in private cloud…");
  });
});

describe("an explicit move to private cloud survives a restart", () => {
  async function onDeviceNote() {
    _resetConnectorSchemaMemoForTests();
    const space = sqliteSpace();
    expect((await saveVoiceNote(space.tcw, RECORDING, AUDIO, "ios")).ok).toBe(true);
    space.sqlite.query(`UPDATE connector_meeting SET metadata = json_set(metadata,
      '$.capture.version', 2, '$.capture.options.transcriber', 'on-device') WHERE source_id = 'rec-1'`).run();
    VoiceNotes.listPending = async () => ({
      recordings: [{ ...RECORDING, owner: "did:test:voice", options: { transcriber: "on-device", identifySpeakers: false }, stt: { state: "cancelled" } } as never],
    });
    return space;
  }
  const settle = async (t: ReturnType<typeof createVoiceNoteTranscriber>) => {
    for (let i = 0; i < 30 && t.snapshot().jobs.get("rec-1")?.kind === "active"; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  };

  test("a failed uploaded attempt is cleaned up but never restarted after relaunch", async () => {
    const space = await onDeviceNote();
    const storage = memoryStorage();
    const pending = localStorageVoiceNotePendingStore(DID, storage);
    const choices = localStorageVoiceNotePrivateChoiceStore(DID, storage);
    const launch = (h: ReturnType<typeof harness>) =>
      createVoiceNoteTranscriber({
        cloud: h.cloud,
        consent: { get: () => true, set: () => {} },
        choices,
        holds: localStorageVoiceNoteHoldStore(DID, storage),
        tcw: () => space.tcw,
      });
    const first = harness({ pending, jobs: [new PrivateCloudError("offline", "network gone")] });
    const t = launch(first);
    await t.check();
    t.transcribePrivately("rec-1");
    await settle(t);
    expect(t.snapshot().jobs.get("rec-1")).toMatchObject({ kind: "failed", retryable: true });
    expect(first.puts).toHaveLength(1);
    expect(pending.read("rec-1")?.transcriptionId).toBe(ID);
    expect(choices.ids()).toEqual([]);

    const second = harness({ pending, jobs: [job("completed")] });
    const restarted = launch(second);
    await restarted.check();
    for (let i = 0; i < 30 && pending.sourceIds().length > 0; i++)
      await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(restarted.snapshot().jobs.get("rec-1")).toBeUndefined();
    expect(second.puts).toHaveLength(0);
    expect(second.creates).toHaveLength(0);
    expect(second.removed).toEqual([ID]);
  });

  test("the same leftover job without a choice is still deleted", async () => {
    const space = await onDeviceNote();
    const storage = memoryStorage();
    const pending = localStorageVoiceNotePendingStore(DID, storage);
    pending.write("rec-1", { attemptId: "attempt-1", transcriptionId: ID });
    const h = harness({ pending, jobs: [job("completed")] });
    expect(h.cloud.pendingSourceIds()).toEqual(["rec-1"]);
    const t = createVoiceNoteTranscriber({
      cloud: h.cloud,
      consent: { get: () => true, set: () => {} },
      choices: localStorageVoiceNotePrivateChoiceStore(DID, storage),
        holds: localStorageVoiceNoteHoldStore(DID, storage),
      tcw: () => space.tcw,
    });
    await t.check();
    for (let i = 0; i < 30 && h.cloud.pendingSourceIds().length > 0; i++) await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(t.snapshot().jobs.get("rec-1")?.kind).toBe("held");
    expect(h.removed).toEqual([ID]);
  });

  test("a choice whose job failed before reaching the cloud is not retried by the next launch", async () => {
    const space = await onDeviceNote();
    const storage = memoryStorage();
    const choices = localStorageVoiceNotePrivateChoiceStore(DID, storage);
    const h = harness({ jobs: [job("completed")], creates: [new PrivateCloudError("invalid_argument", "no")] });
    const t = createVoiceNoteTranscriber({ cloud: h.cloud, consent: { get: () => true, set: () => {} }, choices, holds: memoryHoldStore(), tcw: () => space.tcw });
    await t.check();
    t.transcribePrivately("rec-1");
    await settle(t);
    expect(t.snapshot().jobs.get("rec-1")?.kind).toBe("failed");
    expect(choices.ids()).toEqual([]);
  });
  test("an incomplete transcript failure does not auto-restart after launch; explicit retry still runs once", async () => {
    const space = await onDeviceNote();
    const storage = memoryStorage();
    const pending = localStorageVoiceNotePendingStore(DID, storage);
    const choices = localStorageVoiceNotePrivateChoiceStore(DID, storage);
    const launch = (h: ReturnType<typeof harness>) => createVoiceNoteTranscriber({
      cloud: h.cloud,
      consent: { get: () => true, set: () => {} },
      choices: localStorageVoiceNotePrivateChoiceStore(DID, storage),
      holds: localStorageVoiceNoteHoldStore(DID, storage),
      tcw: () => space.tcw,
    });
    const settle = async (t: ReturnType<typeof createVoiceNoteTranscriber>) => {
      for (let i = 0; i < 30 && t.snapshot().jobs.get("rec-1")?.kind === "active"; i++)
        await new Promise((resolve) => setTimeout(resolve, 0));
    };
    const incomplete = {
      ...TRANSCRIPT,
      duration_seconds: 4_337,
      stats: { tinfoil_calls: 1, tinfoil_audio_seconds: 1_248 },
    } as unknown as PrivateCloudTranscript;
    const first = harness({
      pending,
      result: incomplete,
    });
    const transcriber = launch(first);
    await transcriber.check();
    transcriber.transcribePrivately("rec-1");
    await settle(transcriber);
    expect(transcriber.snapshot().jobs.get("rec-1")).toMatchObject({ kind: "failed", code: "transcript_incomplete" });
    expect(choices.ids()).toEqual([]);
    expect(first.creates).toHaveLength(1);
    expect(first.puts).toHaveLength(1);

    const retry = harness({ pending, result: {
      ...TRANSCRIPT,
      duration_seconds: 4_337,
      stats: { tinfoil_calls: 1, tinfoil_audio_seconds: 4_200 },
    } as unknown as PrivateCloudTranscript });
    const restarted = launch(retry);
    await restarted.check();
    await settle(restarted);
    expect(retry.creates).toHaveLength(0);
    expect(retry.puts).toHaveLength(0);

    restarted.transcribePrivately("rec-1");
    await settle(restarted);
    expect(retry.creates).toHaveLength(1);
    expect(retry.puts).toHaveLength(1);
  });

  test("a same-session Recent Retry keeps Private mode after transcript_incomplete", async () => {
    const space = await onDeviceNote();
    const pending = localStorageVoiceNotePendingStore(DID, memoryStorage());
    const incomplete = {
      ...TRANSCRIPT,
      duration_seconds: 4_337,
      stats: { tinfoil_calls: 1, tinfoil_audio_seconds: 1_248 },
    } as unknown as PrivateCloudTranscript;
    const created = { id: ID, status: "awaiting_upload" as const, upload: { path: `/uploads/${ID}`, capability: CAP } };
    const h = harness({
      pending,
      result: incomplete,
      creates: [created, created],
      puts: [
        { status: 201, body: { status: "queued" } },
        { status: 201, body: { status: "queued" } },
      ],
    });
    const transcriber = createVoiceNoteTranscriber({
      cloud: h.cloud,
      consent: { get: () => true, set: () => {} },
      choices: localStorageVoiceNotePrivateChoiceStore(DID, memoryStorage()),
      holds: memoryHoldStore(),
      tcw: () => space.tcw,
    });
    await transcriber.check();
    transcriber.transcribePrivately("rec-1");
    await settle(transcriber);
    expect(h.creates).toHaveLength(1);
    expect(transcriber.snapshot().jobs.get("rec-1")).toMatchObject({ kind: "failed", code: "transcript_incomplete" });

    transcriber.transcribe("rec-1");
    await settle(transcriber);
    expect(h.creates).toHaveLength(2);
    expect(transcriber.snapshot().jobs.get("rec-1")).toMatchObject({ kind: "failed", code: "transcript_incomplete" });
    expect(h.puts).toHaveLength(2);
  });

  test("turning private cloud off revokes the choice", async () => {
    const space = await onDeviceNote();
    const storage = memoryStorage();
    const choices = localStorageVoiceNotePrivateChoiceStore(DID, storage);
    choices.add("rec-1");
    const h = harness({ jobs: [job("completed")] });
    const t = createVoiceNoteTranscriber({ cloud: h.cloud, consent: { get: () => true, set: () => {} }, choices, holds: memoryHoldStore(), tcw: () => space.tcw });
    await t.turnOff();
    expect(choices.ids()).toEqual([]);
  });
});

test("a failed audio-read attempt clears Private intent and never restarts on the next launch", async () => {
  _resetConnectorSchemaMemoForTests();
  const space = sqliteSpace();
  expect((await saveVoiceNote(space.tcw, RECORDING, AUDIO, "ios")).ok).toBe(true);
  space.sqlite.query(`UPDATE connector_meeting SET metadata = json_set(metadata,
    '$.capture.version', 2, '$.capture.options.transcriber', 'on-device') WHERE source_id = 'rec-1'`).run();
  VoiceNotes.listPending = async () => ({ recordings: [{ ...RECORDING, owner: "did:test:voice",
    options: { transcriber: "on-device", identifySpeakers: false }, stt: { state: "cancelled" } } as never] });
  const storage = memoryStorage();
  const pending = localStorageVoiceNotePendingStore(DID, storage);
  const choices = localStorageVoiceNotePrivateChoiceStore(DID, storage);
  const client = space.tcw as unknown as { kv: { get: (key: string) => Promise<unknown> } };
  const originalGet = client.kv.get;
  client.kv.get = async key => key.startsWith(voiceNoteAudioKvKey("rec-1"))
    ? { ok: false, error: { code: "NETWORK_ERROR", message: "KV offline" } }
    : originalGet(key);
  const launch = (h: ReturnType<typeof harness>) => createVoiceNoteTranscriber({
    cloud: h.cloud, consent: { get: () => true, set: () => {} },
    choices: localStorageVoiceNotePrivateChoiceStore(DID, storage),
    holds: localStorageVoiceNoteHoldStore(DID, storage), tcw: () => space.tcw,
  });
  const settle = async (t: ReturnType<typeof createVoiceNoteTranscriber>) => {
    for (let i = 0; i < 200 && t.snapshot().jobs.get("rec-1")?.kind === "active"; i++)
      await new Promise(resolve => setTimeout(resolve, 50));
  };
  const first = harness({ pending });
  const t = launch(first);
  await t.check();
  t.transcribePrivately("rec-1");
  await settle(t);
  expect(t.snapshot().jobs.get("rec-1")).toMatchObject({ kind: "failed", retryable: true });
  expect(first.creates).toHaveLength(0);
  expect(pending.sourceIds()).toEqual([]);
  expect(choices.has("rec-1")).toBe(false);
  client.kv.get = originalGet;
  const second = harness({ pending, jobs: [job("completed")] });
  const restarted = launch(second);
  await restarted.check();
  await settle(restarted);
  expect(restarted.snapshot().jobs.get("rec-1")).toBeUndefined();
  expect(second.creates).toHaveLength(0);
}, 15000);

test("Library Transcribe uses local audio while the space upload is pending", async () => {
  _resetConnectorSchemaMemoForTests();
  const space = sqliteSpace();
  expect((await saveVoiceNote(space.tcw, { ...RECORDING, version: 2, source: "in_app", options: { transcriber: "private-cloud", identifySpeakers: false } }, AUDIO, "ios")).ok).toBe(true);
  space.sqlite.query(`UPDATE connector_meeting SET metadata = json_set(metadata,
    '$.capture.version', 2, '$.capture.options.transcriber', 'private-cloud') WHERE source_id = 'rec-1'`).run();
  for (const key of [...space.kv.keys()]) if (key.startsWith(voiceNoteAudioKvKey("rec-1"))) space.kv.delete(key);

  const recording = { ...RECORDING, version: 2 as const, owner: "did:test:voice", source: "in_app" as const, ledger: {
    audio: { state: "pending" as const, rowId: null, at: null },
    transcriptSync: { state: "pending" as const, rev: 0, at: null },
  }, options: { transcriber: "private-cloud" as const, identifySpeakers: false } } as unknown as VoiceNoteRecording;
  VoiceNotes.listPending = async () => ({ recordings: [recording] });
  let audioReads = 0;
  const client = space.tcw as unknown as { kv: { get: (key: string) => Promise<unknown> } };
  const originalGet = client.kv.get;
  client.kv.get = async (key) => {
    if (key.startsWith(voiceNoteAudioKvKey("rec-1"))) audioReads++;
    return originalGet(key);
  };
  VoiceNotes.readAudioChunk = async ({ id, offset, length }) => ({ id, offset,
    base64: bytesToBase64(new Uint8Array(length)), bytesRead: length, size: RECORDING.sizeBytes, eof: offset + length >= RECORDING.sizeBytes });

  const finishTrackedUpload = pendingStore.beginAutomaticSave();
  try {
    const h = harness({});
    const transcriber = createVoiceNoteTranscriber({
      cloud: h.cloud, consent: { get: () => true, set: () => {} }, tcw: () => space.tcw, holds: memoryHoldStore(),
    });
    await transcriber.check();
    // The row is visible and the audio upload is pending, but its native file is valid.
    // Keep a save busy to prove local-first transcription does not wait on the upload queue.
    transcriber.transcribe("rec-1");
    for (let i = 0; i < 100 && transcriber.snapshot().jobs.get("rec-1")?.kind === "active"; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(transcriber.snapshot().jobs.get("rec-1")).toMatchObject({ kind: "done", outcome: "transcribed" });
    expect(h.creates).toHaveLength(1);
    expect(h.puts).toHaveLength(1);
    expect(audioReads).toBe(0);
  } finally {
    finishTrackedUpload();
    client.kv.get = originalGet;
  }
}, 15000);
