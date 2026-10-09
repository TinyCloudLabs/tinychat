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

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { _resetConnectorSchemaMemoForTests, transcriptKvKey } from "../connectors/connectorStore";
import {
  buildPtxUploadOrigin,
  interpretUploadResponse,
  parsePtxUploadOrigin,
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
} from "../privateCloud";
import { base64ToBytes, bytesToBase64, type AudioDecoder } from "./voiceNoteAudio";
import { createFakeVoiceNotes } from "./fakeVoiceNotes";
import { __setVoiceNotesForTests, VoiceNotes } from "./nativeVoiceNotes";
import { readTranscriptCommit } from "./voiceNoteCommits";
import {
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
  createVoiceNoteCloud,
  createVoiceNoteCloudForBuild,
  localStorageVoiceNoteConsentStore,
  localStorageVoiceNotePendingStore,
  maxTranscriptionSeconds,
  prepareVoiceNoteTranscript,
  transcribeVoiceNote,
  transcriptionStatusText,
  voiceNoteSentences,
  voiceNoteTranscriptionFailure,
  VOICE_NOTE_CONSENT_KEY,
  VOICE_NOTE_PENDING_JOBS_KEY,
  type PtxPutRequest,
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
};
const AUDIO = { mimeType: "audio/mp4", base64: bytesToBase64(new Uint8Array([1, 2, 3, 4])) };
const originalVoiceNotes = VoiceNotes;
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
  jobs?: (PrivateCloudJob | PrivateCloudError)[];
  creates?: (PrivateCloudCreated | PrivateCloudError)[];
  puts?: (PtxPutResponse | PrivateCloudError)[];
  result?: PrivateCloudTranscript;
  pending?: ReturnType<typeof localStorageVoiceNotePendingStore>;
  now?: () => number;
  removeFails?: boolean;
  uploadSupported?: () => Promise<boolean>;
  decode?: AudioDecoder;
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
      const next = jobs.length > 1 ? jobs.shift()! : jobs[0]!;
      if (next instanceof PrivateCloudError) throw next;
      return { ...next, id };
    },
    async result(id) {
      calls.push(`result:${id}`);
      return { status: "completed", transcript: script.result ?? TRANSCRIPT };
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
    clock: {
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
      const next = putAnswers.shift();
      if (next === undefined) throw new Error("unexpected put");
      if (next instanceof PrivateCloudError) throw next;
      return next;
    },
  });
  return { cloud, calls, creates, puts, removed, cancelled, pending, sleeps };
}

const run = (h: ReturnType<typeof harness>, report: (s: VoiceNoteTranscriptionStatus) => void = () => {}) =>
  h.cloud.transcribe({ sourceId: "rec-1", capabilities: CAPS, loadAudio: async () => AUDIO }, report);

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

  test("the longest note offered is the phone's limit, or PTX's when lower", () => {
    expect(maxTranscriptionSeconds(null)).toBe(600);
    expect(maxTranscriptionSeconds(CAPS)).toBe(600);
    expect(maxTranscriptionSeconds({ ...CAPS, max_duration_seconds: 120 })).toBe(120);
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

  test("a note over the phone's limit is refused before any job exists", async () => {
    const h = harness({});
    const err = await h.cloud
      .transcribe({ sourceId: "rec-1", capabilities: { ...CAPS, max_duration_seconds: 0.5 }, loadAudio: async () => AUDIO }, () => {})
      .catch((e: unknown) => e);
    expect((err as { code: string }).code).toBe("recording_too_long_for_phone");
    expect(h.creates).toHaveLength(0);
    expect(h.pending.read("rec-1")).toBeNull();
    expect(voiceNoteTranscriptionFailure(err)).toEqual(expect.objectContaining({ retryable: false }));
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

  test("a job that fails while processing is reported with its code and forgotten", async () => {
    const h = harness({ jobs: [job("processing"), job("failed", { error: { code: "provider_unavailable", message: "x" } })] });
    const err = (await run(h).catch((e: unknown) => e)) as PrivateCloudError;
    expect(err.code).toBe("provider_unavailable");
    expect(h.pending.read("rec-1")).toBeNull();
  });
});

describe("a job never holds the account's one slot for nothing", () => {
  test("a non-retryable upload answer (413, a redirect) cancels the job still awaiting it and forgets it", async () => {
    for (const [put, code] of [
      [{ status: 413, body: { error: { code: "recording_too_large" } } }, "recording_too_large"],
      [{ status: 302, body: null }, "service_misconfigured"],
      [{ status: 415, body: null }, "unsupported_recording"],
    ] as const) {
      const h = harness({ puts: [put], jobs: [job("awaiting_upload")] });
      const err = (await run(h).catch((e: unknown) => e)) as PrivateCloudError;
      expect(err.code).toBe(code);
      expect(h.cancelled).toEqual([ID]);
      expect(h.pending.read("rec-1")).toBeNull();
      expect(voiceNoteTranscriptionFailure(err).retryable).toBe(false);
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
      .transcribe({ sourceId: "rec-1", capabilities: CAPS, loadAudio: async () => AUDIO, allowed: () => false }, () => {})
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
        allowed: () => {
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
  test("a device that cannot upload (Android below 8.0) is hidden without asking the backend", async () => {
    const unable = harness({ uploadSupported: async () => false });
    expect(await unable.cloud.capabilities()).toBeNull();
    expect(unable.calls).toEqual([]);
    const able = harness({ uploadSupported: async () => true });
    expect(await able.cloud.capabilities()).toEqual(CAPS);
  });

  test("consent and jobs in flight are kept per account DID", () => {
    const storage = memoryStorage();
    const a = localStorageVoiceNoteConsentStore("did:a", storage);
    const b = localStorageVoiceNoteConsentStore("did:b", storage);
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
  test("segments become time-ordered 'You' turns of at most 60 s, trimmed, empty ones dropped", () => {
    expect(voiceNoteSentences(TRANSCRIPT)).toEqual([
      { index: 0, speaker_name: "You", text: "Remember to book the venue.", start_time: 0.5, end_time: 9 },
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
    expect(long.map((s) => [s.text, s.start_time, s.end_time])).toEqual([["one two", 0, 59], ["three", 60, 70]]);
  });

  test("the save carries the desktop's engine metadata; no sentences is the no-speech outcome", () => {
    const prepared = prepareVoiceNoteTranscript(TRANSCRIPT, "2026-10-03T10:00:00.000Z", 1);
    expect(prepared.speakers).toEqual(["You"]);
    expect(prepared.metadata).toEqual({
      transcription_engine: "private-cloud",
      transcript_provider: "tinycloud-private-transcription",
      inference_provider: "tinfoil",
      model: "whisper-large-v3-turbo",
      language: "en",
      transcript_text: "Remember to book the venue.",
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
  storeVoiceNote(tcw, recording, voiceNoteAudioSourceFromBase64(audio), platform);

/** The connector store on real SQLite plus in-memory KV (strings, and raw bytes for audio parts). */
function sqliteSpace() {
  const sqlite = new Database(":memory:");
  const kv = new Map<string, string | Uint8Array>();
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
    tcw: {
      did: "did:test:voice",
      sql: {
        db: () => ({
          query: async (sql: string, params: unknown[] = []) => runSql(() => ({ rows: sqlite.query(sql).values(...(params as never[])) })),
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
};

describe("transcribeVoiceNote (one note end to end)", () => {
  beforeEach(() => _resetConnectorSchemaMemoForTests());

  test("a note owned by another account is rejected before contacting private cloud", async () => {
    const space = sqliteSpace();
    expect((await saveVoiceNote(space.tcw, RECORDING, AUDIO, "android")).ok).toBe(true);
    const list = VoiceNotes.listPending.bind(VoiceNotes);
    VoiceNotes.listPending = async () => ({ recordings: (await list()).recordings.map((note) => ({ ...note, owner: "did:other" })) });
    const h = harness({});
    await expect(transcribeVoiceNote({ tcw: space.tcw, cloud: h.cloud, capabilities: CAPS,
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
      expect(await transcribeVoiceNote({ tcw: space.tcw, cloud: h.cloud, capabilities: CAPS,
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
    expect(await transcribeVoiceNote({ tcw: space.tcw, cloud: h.cloud, capabilities: CAPS,
      sourceId: "rec-1", report: () => {} })).toBe("transcribed");
    expect(await readTranscriptCommit(space.tcw, "rec-1")).toMatchObject({ rev: 1 });
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
      sourceId: "rec-1",
      report: () => {},
      now: () => new Date("2026-10-03T10:00:00.000Z"),
    });
    expect(outcome).toBe("transcribed");
    expect(await readTranscriptCommit(space.tcw, "rec-1")).toMatchObject({ rev: 1, speakerLabels: false });
    expect(JSON.parse(space.kv.get(transcriptKvKey(VOICE_NOTE_SOURCE, "rec-1")) as string)).toEqual([
      { index: 0, speaker_name: "You", text: "Remember to book the venue.", start_time: 0.5, end_time: 9 },
    ]);
    const listed = await listVoiceNotes(space.tcw);
    expect(listed.ok && listed.data[0]).toEqual(expect.objectContaining({
      sourceId: "rec-1",
      durationSecs: 9,
      title: expect.stringContaining("Voice note"),
      transcript: { status: "transcribed", preview: "Remember to book the venue." },
    }));
    expect(h.removed).toEqual([ID]);
    expect(h.pending.read("rec-1")).toBeNull();
  });

  test("no speech is saved as an outcome (the note is not offered again) and the job is deleted", async () => {
    const space = sqliteSpace();
    await saveVoiceNote(space.tcw, RECORDING, AUDIO, "ios");
    const h = harness({ jobs: [job("failed", { error: { code: "no_speech", message: "No speech was found in the recording." } })] });
    const outcome = await transcribeVoiceNote({ tcw: space.tcw, cloud: h.cloud, capabilities: CAPS, sourceId: "rec-1", report: () => {} });
    expect(outcome).toBe("no_speech");
    expect(space.kv.get(transcriptKvKey(VOICE_NOTE_SOURCE, "rec-1"))).toBe("[]");
    const listed = await listVoiceNotes(space.tcw);
    expect(listed.ok && listed.data[0]!.transcript).toEqual({ status: "no_speech", preview: null });
    expect(h.removed).toEqual([ID]);
  });

  test("a note that no longer exists: nothing is sent, no row is created, its leftover job is deleted", async () => {
    const space = sqliteSpace();
    await saveVoiceNote(space.tcw, { ...RECORDING, id: "other" }, AUDIO, "android");
    const h = harness({});
    h.pending.write("rec-1", { attemptId: "00000000-0000-4000-8000-00000000abcd", transcriptionId: ID2 });
    const err = await transcribeVoiceNote({ tcw: space.tcw, cloud: h.cloud, capabilities: CAPS, sourceId: "rec-1", audio: AUDIO, report: () => {} })
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
    expect(await transcribeVoiceNote({ tcw: space.tcw, cloud: h.cloud, capabilities: CAPS, sourceId: "rec-1", report: () => {} })).toBe("transcribed");
    expect(h.calls).toContain(`remove:${ID}`);
    // Forgotten before the delete was tried: a later run (Retry, relaunch) cannot re-join it, and
    // a 404 from PTX's own deletion can never turn into a second upload.
    expect(h.pending.read("rec-1")).toBeNull();
    const calls = h.calls.length;
    expect(await transcribeVoiceNote({ tcw: space.tcw, cloud: h.cloud, capabilities: CAPS, sourceId: "rec-1", report: () => {} })).toBe("transcribed");
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
    expect(await transcribeVoiceNote({ tcw: space.tcw, cloud: h.cloud, capabilities: CAPS, sourceId: "rec-1", report: () => {} })).toBe("transcribed");
    expect(h.calls).toEqual([`remove:${ID}`]);
    expect(h.pending.read("rec-1")).toBeNull();
  });

  test("the note's own length is checked before its audio is read", async () => {
    const space = sqliteSpace();
    await saveVoiceNote(space.tcw, { ...RECORDING, durationMs: 11 * 60_000 }, AUDIO, "android");
    const h = harness({});
    let loads = 0;
    const realGet = (space.tcw as { kv: { get: (k: string) => Promise<unknown> } }).kv.get;
    (space.tcw as { kv: { get: unknown } }).kv.get = async (k: string) => {
      loads++;
      return realGet(k);
    };
    const err = await transcribeVoiceNote({ tcw: space.tcw, cloud: h.cloud, capabilities: CAPS, sourceId: "rec-1", report: () => {} })
      .catch((e: unknown) => e);
    expect((err as { code: string }).code).toBe("recording_too_long_for_phone");
    expect(loads).toBe(0);
    expect(h.creates).toHaveLength(0);
  });

  test("a failed save keeps the job, so Retry re-joins it and saves again without uploading", async () => {
    const space = sqliteSpace();
    await saveVoiceNote(space.tcw, RECORDING, AUDIO, "android");
    const h = harness({});
    const realPut = (space.tcw as { kv: { put: (k: string, v: string) => Promise<unknown> } }).kv.put;
    (space.tcw as { kv: { put: unknown } }).kv.put = async () => ({ ok: false, error: { code: "KV_ERROR", message: "offline" } });
    const err = await transcribeVoiceNote({ tcw: space.tcw, cloud: h.cloud, capabilities: CAPS, sourceId: "rec-1", report: () => {} })
      .catch((e: unknown) => e);
    expect(voiceNoteTranscriptionFailure(err)).toEqual(expect.objectContaining({ code: "transcript_save_failed", retryable: true }));
    expect(h.removed).toEqual([]);
    expect(h.pending.read("rec-1")?.transcriptionId).toBe(ID);

    (space.tcw as { kv: { put: unknown } }).kv.put = realPut;
    expect(await transcribeVoiceNote({ tcw: space.tcw, cloud: h.cloud, capabilities: CAPS, sourceId: "rec-1", report: () => {} })).toBe("transcribed");
    expect(h.puts).toHaveLength(1);
    expect(h.removed).toEqual([ID]);
  });
});

describe("transcribeVoiceNote reads the note's stored audio (TC-517)", () => {
  beforeEach(() => _resetConnectorSchemaMemoForTests());

  test("a note stored in parts is reassembled, in order, for the upload", async () => {
    const space = sqliteSpace();
    const bytes = new Uint8Array(2_500).map((_, i) => i % 251);
    await storeVoiceNote(space.tcw, RECORDING, voiceNoteAudioSourceFromBase64({ mimeType: "audio/mp4", base64: bytesToBase64(bytes) }), "android", { partSize: 1_000 });
    expect(space.kv.get(voiceNoteAudioPartKey("rec-1", 2))).toBeInstanceOf(Uint8Array);
    let decoded: Uint8Array | null = null;
    const quiet = silentDecoder();
    const h = harness({
      decode: async (buffer, rate) => {
        decoded = new Uint8Array(buffer.slice(0));
        return quiet(buffer, rate);
      },
    });
    expect(await transcribeVoiceNote({ tcw: space.tcw, cloud: h.cloud, capabilities: CAPS, sourceId: "rec-1", report: () => {} })).toBe("transcribed");
    expect(decoded).toEqual(bytes);
  });

  test("a note saved before TC-517 (one base64 value) still transcribes", async () => {
    const space = sqliteSpace();
    await saveVoiceNote(space.tcw, RECORDING, AUDIO, "android");
    // Rewrite it the old way: no manifest, the whole audio at the base key.
    for (const key of [...space.kv.keys()]) if (key.startsWith(`${voiceNoteAudioKvKey("rec-1")}/`)) space.kv.delete(key);
    space.kv.set(voiceNoteAudioKvKey("rec-1"), JSON.stringify(AUDIO));
    const h = harness({});
    expect(await transcribeVoiceNote({ tcw: space.tcw, cloud: h.cloud, capabilities: CAPS, sourceId: "rec-1", report: () => {} })).toBe("transcribed");
  });

  test("a note of unknown length that is too large is refused from its manifest, before any part is read", async () => {
    const space = sqliteSpace();
    // 10 min at twice the phone's bitrate is the most read back; this note claims more.
    const big = new Uint8Array(600 * 16_000 + 1);
    await storeVoiceNote(space.tcw, { ...RECORDING, durationMs: 0 }, voiceNoteAudioSourceFromBase64({ mimeType: "audio/mp4", base64: bytesToBase64(big) }), "android");
    const h = harness({});
    const gets: string[] = [];
    const realGet = (space.tcw as { kv: { get: (k: string) => Promise<unknown> } }).kv.get;
    (space.tcw as { kv: { get: unknown } }).kv.get = async (k: string) => {
      gets.push(k);
      return realGet(k);
    };
    const err = await transcribeVoiceNote({ tcw: space.tcw, cloud: h.cloud, capabilities: CAPS, sourceId: "rec-1", report: () => {} })
      .catch((e: unknown) => e);
    expect((err as { code: string }).code).toBe("recording_too_long_for_phone");
    expect(gets.filter((k) => k.includes("/p/"))).toEqual([]);
    expect(h.creates).toHaveLength(0);
  });
});

describe("progress copy", () => {
  test("progress copy", () => {
    expect(transcriptionStatusText({ kind: "queued", position: 3 })).toBe("Queued (position 3)…");
    expect(transcriptionStatusText({ kind: "processing", completed: 2, total: 5 })).toBe("Transcribing in private cloud… 2/5");
    expect(transcriptionStatusText({ kind: "processing", completed: null, total: null })).toBe("Transcribing in private cloud…");
  });
});
