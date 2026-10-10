// The web engine turned on, end to end with fakes: register → install → boot recovery → record →
// stop → T18 save → private-cloud transcription over the fetch transport against a fake PTX.
// No real network, no real IndexedDB, no browser.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { _resetConnectorSchemaMemoForTests, CONNECTORS_SQL_DB_NAME } from "../../connectors/connectorStore";
import { sha256Hex, PrivateCloudError, type PrivateCloudApi, type PrivateCloudCreateBody, type PrivateCloudCreated, type PrivateCloudJob, type PrivateCloudTranscript } from "../../privateCloud";
import { currentAccountGeneration } from "../accountContext";
import { __resetCaptureEngineForTests, captureEngineAvailable, captureEngineKind } from "../captureEngine";
import { __setVoiceNotesForTests, VoiceNotes } from "../nativeVoiceNotes";
import type { AudioDecoder } from "../voiceNoteAudio";
import { createVoiceNotePipeline } from "../voiceNotePipeline";
import { voiceNoteAudioManifestKey } from "../voiceNoteStore";
import { createFetchPtxPut, createVoiceNoteCloud, localStorageVoiceNotePendingStore, transcribeVoiceNote } from "../voiceNoteTranscription";
import { registerWebCaptureEngine } from "./registerWebEngine";
import { DecodeCheckError } from "./decodeCheck";
import { startWebCaptureEngine } from "./webEngine";
import { createVoiceNoteRecorderController } from "@/capture/recorder/voiceNoteRecorderController";
import { audioFileExtension } from "../voiceNoteStore";
import { actionCall, runFailedAction } from "@/capture/home/failedActions";
import { issueCanRetry, issueIsRecoverable, withQuarantine } from "@/capture/home/captureIssues";
import { quarantinedFor, readQuarantine } from "../quarantine";
import { createRig, FakeMediaRecorder, type Rig } from "./webTestKit";

const original = VoiceNotes;
const A = "did:test:web-flow-a";
const B = "did:test:web-flow-b";
const ID = "trn_01J8Z3K4M5N6P7Q8R9S0T1V2W3";
const CAP = "tcu_abcdefghijklmnop0123456789";
const ORIGIN = "https://ptx.example";
const TRANSCRIPT: PrivateCloudTranscript = {
  language: "en", duration_seconds: 2, provider: "tinfoil", model: "whisper-large-v3-turbo", channels: 1,
  segments: [{ id: "seg_0001", speaker_id: "channel_0", channel: 0, start: 0, end: 2, text: "hello from the browser" }],
  text: "Speaker 1: hello from the browser",
};
const CAPS = { max_bytes: 120_960_000, max_duration_seconds: 7_200, content_types: ["audio/wav"], admission: "open" as const };

function memoryStorage() {
  const map = new Map<string, string>();
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v), removeItem: (k: string) => void map.delete(k), map };
}

function space(did: string) {
  const sqlite = new Database(":memory:");
  const values = new Map<string, string | Uint8Array>();
  const run = (fn: () => unknown) => {
    try { return { ok: true, data: fn() } as const; } catch (e) { return { ok: false, error: { code: "SQL_ERROR", message: String(e) } } as const; }
  };
  const sql = {
    db(name: string) {
      expect(name).toBe(CONNECTORS_SQL_DB_NAME);
      return {
        query: async (statement: string, params: unknown[] = []) => run(() => ({ rows: sqlite.query(statement).values(...(params as never[])) })),
        execute: async (statement: string, params: unknown[] = []) => run(() => ({ changes: sqlite.query(statement).run(...(params as never[])).changes })),
      };
    },
  };
  const kv = {
    async put(key: string, value: string | Uint8Array, options?: { ifNoneMatch?: string }) {
      if (options?.ifNoneMatch === "*" && values.has(key)) return { ok: false, error: { code: "KV_PRECONDITION_FAILED", message: "412" } };
      values.set(key, value);
      return { ok: true, data: { headers: {} } };
    },
    async get(key: string) {
      return values.has(key) ? { ok: true, data: { data: values.get(key) } } : { ok: false, error: { code: "KV_NOT_FOUND", message: "missing" } };
    },
    async list({ path }: { path: string }) {
      return { ok: true, data: { keys: [...values.keys()].filter((key) => key.startsWith(path)), truncated: false } };
    },
  };
  return { tcw: { did, spaceId: did, sql, kv } as unknown as TinyCloudWeb, sqlite, values };
}

const ctxOf = (tcw: TinyCloudWeb) => ({ did: tcw.did, spaceId: tcw.spaceId, generation: currentAccountGeneration() });
const quietDecoder = (seconds = 1): AudioDecoder => async (_bytes, sampleRate) => ({
  channels: [new Float32Array(Math.round(seconds * sampleRate)).fill(0.25)], sampleRate,
});

/** A fake PTX: records the PUTs it gets and answers like the real one. */
function fakePtx(answer: () => Response | Promise<Response> = () => new Response(JSON.stringify({ status: "queued" }), { status: 201 })) {
  const puts: { url: string; method: string | undefined; headers: Record<string, string>; redirect: RequestRedirect | undefined; body: Uint8Array }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    puts.push({
      url: String(input), method: init?.method, headers: { ...(init?.headers as Record<string, string>) }, redirect: init?.redirect,
      body: init?.body as Uint8Array,
    });
    return answer();
  }) as typeof fetch;
  return { puts, fetchImpl };
}

/** The backend router (create/get/result) scripted, with the fetch transport for the audio PUT. */
function cloudWith(ptx: ReturnType<typeof fakePtx>, jobStatus: PrivateCloudJob["status"] = "completed") {
  const creates: PrivateCloudCreateBody[] = [];
  const api: PrivateCloudApi = {
    backendUrl: "https://api.example", bearer: () => "tok",
    capabilities: async () => CAPS,
    list: async () => { throw new Error("voice notes never list the account's jobs"); },
    get: async (id) => ({ id, status: jobStatus }) as PrivateCloudJob,
    result: async () => ({ status: "completed", transcript: TRANSCRIPT }),
    cancel: async () => {},
    remove: async () => {},
  };
  let n = 0;
  const cloud = createVoiceNoteCloud({
    api, origin: ORIGIN, pending: localStorageVoiceNotePendingStore(A, memoryStorage()), decode: quietDecoder(),
    uploadSupported: () => Promise.resolve(true),
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
    clock: { now: () => 0, sleep: async () => {}, random: () => 0.5 },
    async create(request) {
      creates.push(request.body);
      return { id: ID, status: "awaiting_upload", upload: { path: `/uploads/${ID}`, capability: CAP } } satisfies PrivateCloudCreated;
    },
    put: createFetchPtxPut(ptx.fetchImpl),
  });
  return { cloud, creates };
}

let rig: Rig;

beforeEach(() => {
  __resetCaptureEngineForTests();
  _resetConnectorSchemaMemoForTests();
  FakeMediaRecorder.instances = [];
});
afterEach(() => {
  __setVoiceNotesForTests(original, { available: null });
  __resetCaptureEngineForTests();
});

async function bootWeb(source: Rig) {
  const engine = await startWebCaptureEngine({ store: source.store, captureEnv: () => source.fake.env, now: source.clock.now });
  __setVoiceNotesForTests(engine, { available: true });
  return engine;
}

async function signIn(did: string, transitionGen: number) {
  await VoiceNotes.setCaptureDefaults({ accountDid: did, transitionGen, transcriber: "private-cloud", identifySpeakers: false });
}

describe("registration", () => {
  test("registering the web engine makes a browser that can record select it, without building it", () => {
    const g = globalThis as Record<string, unknown>;
    const savedRecorder = g.MediaRecorder;
    const savedDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
    g.MediaRecorder = class {};
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {} });
    try {
      expect(captureEngineKind()).toBeNull();
      registerWebCaptureEngine();
      expect(captureEngineKind()).toBe("web");
      expect(captureEngineAvailable()).toBe(false);
    } finally {
      if (savedRecorder === undefined) delete g.MediaRecorder; else g.MediaRecorder = savedRecorder;
      if (savedDevices) Object.defineProperty(navigator, "mediaDevices", savedDevices); else delete (navigator as unknown as Record<string, unknown>).mediaDevices;
      __resetCaptureEngineForTests();
    }
  });

  test("the web engine's capabilities are all false", async () => {
    rig = await createRig();
    const engine = await startWebCaptureEngine({ store: rig.store, captureEnv: () => rig.fake.env, now: rig.clock.now });
    expect(engine.capabilities).toEqual({
      nativeShortcuts: false, presentRecorder: false, openSettings: false, micDeniedPresentation: false,
      background: false, localTranscription: false, desktopWhisper: false, offlineRecorder: false,
    });
  });
});

describe("a recorded web note reaches private-cloud transcription", () => {
  test("install web → record → stop → pending → T18 save → fetch PUT to the fake PTX → transcript saved", async () => {
    rig = await createRig();
    await bootWeb(rig);
    await signIn(A, 1);
    const { tcw, values } = space(A);

    await VoiceNotes.start();
    await rig.chunk([1, 2, 3, 4]);
    const note = await VoiceNotes.stop();
    expect(note).toMatchObject({ owner: A, mimeType: "audio/webm;codecs=opus", sizeBytes: 4 });
    expect((await VoiceNotes.listPending()).recordings.map((r) => r.id)).toEqual([note.id]);

    await createVoiceNotePipeline(tcw).reconcileAll(ctxOf(tcw));
    expect((await VoiceNotes.listPending()).recordings[0]?.ledger?.audio.state).toBe("saved");
    // The saved file takes its extension from the container.
    const manifest = JSON.stringify(values.get(voiceNoteAudioManifestKey(note.id)));
    expect(manifest).toContain(`${note.id}.webm`);
    expect(manifest).not.toContain(".m4a");

    const ptx = fakePtx();
    const { cloud, creates } = cloudWith(ptx);
    const statuses: string[] = [];
    const result = await transcribeVoiceNote({ tcw, cloud, capabilities: CAPS, sourceId: note.id, report: (s) => statuses.push(s.kind) });
    expect(result).toBe("transcribed");
    expect(statuses).toContain("uploading");

    expect(creates).toHaveLength(1);
    expect(ptx.puts).toHaveLength(1);
    const put = ptx.puts[0]!;
    expect(put.url).toBe(`${ORIGIN}/uploads/${ID}`);
    expect(put.method).toBe("PUT");
    // Only the headers PTX's CORS allows, and no redirect is followed.
    expect(put.headers).toEqual({ Authorization: `Bearer ${CAP}`, "Content-Type": "audio/wav" });
    expect(put.redirect).toBe("manual");
    expect(put.body.byteLength).toBe(creates[0]!.byte_size);
    expect(await sha256Hex(new Blob([put.body as BlobPart]))).toBe(creates[0]!.sha256);
  });
});

describe("createFetchPtxPut", () => {
  const request = { url: `${ORIGIN}/uploads/${ID}`, capability: CAP, contentType: "audio/wav", base64: btoa("RIFF"), correlationId: "cid-1" };

  test("a 201 with a JSON body", async () => {
    const ptx = fakePtx();
    expect(await createFetchPtxPut(ptx.fetchImpl)(request)).toEqual({ status: 201, body: { status: "queued" } });
    expect(Array.from(ptx.puts[0]!.body)).toEqual([82, 73, 70, 70]);
  });

  test("a non-JSON or empty body is null, the status still comes through", async () => {
    expect(await createFetchPtxPut(fakePtx(() => new Response("<html>", { status: 502 })).fetchImpl)(request)).toEqual({ status: 502, body: null });
    expect(await createFetchPtxPut(fakePtx(() => new Response(null, { status: 201 })).fetchImpl)(request)).toEqual({ status: 201, body: null });
  });

  test("a failure to get any answer is upload_outcome_unknown with our correlation id", async () => {
    const put = createFetchPtxPut((async () => { throw new TypeError("Failed to fetch"); }) as typeof fetch);
    const error = await put(request).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PrivateCloudError);
    expect(error).toMatchObject({ code: "upload_outcome_unknown", correlationId: "cid-1" });
  });

  test("a redirect that was not followed is service_misconfigured", async () => {
    const redirect = { type: "opaqueredirect", status: 0, text: async () => "" } as unknown as Response;
    const error = await createFetchPtxPut((async () => redirect) as typeof fetch)(request).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "service_misconfigured", correlationId: "cid-1" });
  });

  test("PTX's refusals map exactly as on the phone", async () => {
    rig = await createRig();
    await bootWeb(rig);
    await signIn(A, 1);
    const { tcw } = space(A);
    await VoiceNotes.start();
    await rig.chunk([1, 2, 3, 4]);
    const note = await VoiceNotes.stop();
    await createVoiceNotePipeline(tcw).reconcileAll(ctxOf(tcw));
    const ptx = fakePtx(() => new Response(JSON.stringify({ error: { code: "x" } }), { status: 413 }));
    const { cloud } = cloudWith(ptx, "awaiting_upload");
    const error = await transcribeVoiceNote({ tcw, cloud, capabilities: CAPS, sourceId: note.id, report: () => {} })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "recording_too_large" });
  });
});

const quietly = async <T>(fn: () => Promise<T>): Promise<T> => {
  const { error } = console;
  console.error = () => {};
  try { return await fn(); } finally { console.error = error; }
};

const undecodable = async (): Promise<{ durationMs: number }> => { throw new DecodeCheckError("invalid_media", "cannot decode"); };

describe("boot recovery", () => {
  test("a recording whose tab died is committed before the engine is handed back, and drains through T18", async () => {
    const first = await createRig();
    await first.engine.plugin.setCaptureDefaults({ accountDid: A, transitionGen: 1, transcriber: "private-cloud", identifySpeakers: false });
    const { id } = await first.engine.plugin.start();
    await first.chunk([9, 8, 7]);
    // The tab reloads mid-recording: nothing was stopped.
    rig = await first.reopen();
    expect((await rig.engine.plugin.listPending()).recordings).toEqual([]);

    const engine = await startWebCaptureEngine({ store: rig.store, captureEnv: () => rig.fake.env, now: rig.clock.now });
    __setVoiceNotesForTests(engine, { available: true });
    // Recovery finished before startWebCaptureEngine resolved.
    const pending = (await VoiceNotes.listPending()).recordings;
    expect(pending.map((r) => r.id)).toEqual([id]);
    expect(pending[0]).toMatchObject({ owner: A, sizeBytes: 3 });

    const { tcw } = space(A);
    await createVoiceNotePipeline(tcw).reconcileAll(ctxOf(tcw));
    expect((await VoiceNotes.listPending()).recordings[0]?.ledger?.audio.state).toBe("saved");
    expect((await VoiceNotes.readAudioChunk({ id, offset: 0, length: 3 })).size).toBe(3);
  });

  test("a recording A made is never drained under B; it uploads when A is back", async () => {
    const first = await createRig();
    await first.engine.plugin.setCaptureDefaults({ accountDid: A, transitionGen: 1, transcriber: "private-cloud", identifySpeakers: false });
    const { id } = await first.engine.plugin.start();
    await first.chunk([1, 2, 3]);
    rig = await first.reopen();
    await bootWeb(rig);

    // B signs in on this browser.
    await signIn(B, 2);
    const asB = space(B);
    await createVoiceNotePipeline(asB.tcw).reconcileAll(ctxOf(asB.tcw));
    expect(asB.sqlite.query("SELECT id FROM connector_meeting").all()).toEqual([]);
    expect((await VoiceNotes.listPending()).recordings.find((r) => r.id === id)).toMatchObject({ owner: A });
    expect((await VoiceNotes.listPending()).recordings.find((r) => r.id === id)?.ledger?.audio.state).not.toBe("saved");

    // A signs back in: now it uploads.
    await signIn(A, 3);
    const asA = space(A);
    await createVoiceNotePipeline(asA.tcw).reconcileAll(ctxOf(asA.tcw));
    expect((await VoiceNotes.listPending()).recordings.find((r) => r.id === id)?.ledger?.audio.state).toBe("saved");
    expect(asA.sqlite.query("SELECT source_id FROM connector_meeting").all()).toEqual([{ source_id: id }]);
  });

  test("an account switch while recovery runs: recovery still completes and the note stays with its owner", async () => {
    const first = await createRig();
    await first.engine.plugin.setCaptureDefaults({ accountDid: A, transitionGen: 1, transcriber: "private-cloud", identifySpeakers: false });
    const { id } = await first.engine.plugin.start();
    await first.chunk([5, 5, 5]);
    rig = await first.reopen();

    // The account changes in another tab's store write while this tab is still recovering.
    const recovering = startWebCaptureEngine({ store: rig.store, captureEnv: () => rig.fake.env, now: rig.clock.now });
    await rig.store.setCaptureDefaults({ accountDid: B, transitionGen: 2, transcriber: "private-cloud", identifySpeakers: false });
    __setVoiceNotesForTests(await recovering, { available: true });

    const note = (await VoiceNotes.listPending()).recordings.find((r) => r.id === id);
    expect(note).toBeDefined();
    expect(note!.owner).toBe(A);
    const asB = space(B);
    await createVoiceNotePipeline(asB.tcw).reconcileAll(ctxOf(asB.tcw));
    expect(asB.sqlite.query("SELECT id FROM connector_meeting").all()).toEqual([]);
  });

  test("a recording already in quarantine from an earlier run reaches the controller's recoveryFailed once", async () => {
    const first = await createRig();
    await first.engine.plugin.setCaptureDefaults({ accountDid: A, transitionGen: 1, transcriber: "private-cloud", identifySpeakers: false });
    const { id } = await first.engine.plugin.start();
    await first.chunk([1, 2, 3]);
    rig = await first.reopen({ decodeCheck: undecodable });
    // First boot quarantines it.
    const seen: unknown[] = [];
    const firstBoot = await quietly(() => startWebCaptureEngine({ store: rig.store, captureEnv: () => rig.fake.env, now: rig.clock.now }));
    await firstBoot.addListener("recoveryFailed", (event) => { seen.push(event); });
    await rig.settle();
    expect(seen).toEqual([expect.objectContaining({ id, reason: "undecodable_audio" })]);
    expect((await firstBoot.listQuarantine()).items.map((i) => i.id)).toEqual([id]);

    // The next boot has nothing left to recover but announces the quarantined item again.
    rig = await rig.reopen({ decodeCheck: undecodable });
    const secondBoot = await startWebCaptureEngine({ store: rig.store, captureEnv: () => rig.fake.env, now: rig.clock.now });
    const again: unknown[] = [];
    await secondBoot.addListener("recoveryFailed", (event) => { again.push(event); });
    await rig.settle();
    expect(again).toEqual([expect.objectContaining({ id, reason: "undecodable_audio" })]);
  });
});

describe("the controller receives boot recovery", () => {
  const transcriber = { noteSaved: () => {}, snapshot: () => ({ availability: "available" as const, consented: false, capabilities: null, jobs: new Map() }) };
  const controllerFor = (tcw: TinyCloudWeb | null) => createVoiceNoteRecorderController({
    tcw, available: true, transcriber, onDeviceReady: () => true, appleInterim: () => false,
  });
  async function until(condition: () => boolean, label: string) {
    for (let i = 0; i < 200 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
    if (!condition()) throw new Error(`Timed out waiting for ${label}`);
  }
  /** What the soft home shows for `did`: the controller's issues merged with the parked recordings it may see. */
  async function homeFor(issues: Parameters<typeof withQuarantine>[0], did: string | null) {
    const read = await readQuarantine();
    if (read.kind !== "items") throw read.caught;
    return withQuarantine(issues, quarantinedFor(read.items, did), new Set());
  }
  /** A recording of `owner` (null: recorded signed out) whose tab died and that this boot cannot decode. */
  async function bootWithParked(owner: string | null) {
    const first = await createRig();
    if (owner) await first.engine.plugin.setCaptureDefaults({ accountDid: owner, transitionGen: 1, transcriber: "private-cloud", identifySpeakers: false });
    const { id } = await first.engine.plugin.start();
    await first.chunk([1, 2, 3]);
    rig = await first.reopen({ decodeCheck: undecodable });
    const engine = await quietly(() => startWebCaptureEngine({ store: rig.store, captureEnv: () => rig.fake.env, now: rig.clock.now }));
    __setVoiceNotesForTests(engine, { available: true });
    return id;
  }
  /** A controller attached for `tcw`, as App replaces it when authentication supplies an account. */
  async function attach(tcw: TinyCloudWeb | null) {
    const recorder = controllerFor(tcw);
    const detach = recorder.attach();
    await rig.settle();
    return { recorder, detach };
  }

  test("boot signed out → sign in: the issue is rehydrated for the replacement controller, with Try again and Delete", async () => {
    const id = await bootWithParked(A);
    // The first controller attaches with no account: A's recording is not for it.
    const signedOut = await attach(null);
    expect(signedOut.recorder.getState().captureIssues[id]).toBeUndefined();
    expect(Object.keys(await homeFor(signedOut.recorder.getState().captureIssues, null))).toEqual([]);
    signedOut.detach();

    // A signs in; useVoiceNoteRecorder builds a new controller for the account.
    const asA = await attach(space(A).tcw);
    await until(() => asA.recorder.getState().captureIssues[id] !== undefined, "the recoveryFailed issue");
    expect(asA.recorder.getState().captureIssues[id]).toMatchObject({ kind: "recoveryFailed" });
    const rows = await homeFor(asA.recorder.getState().captureIssues, A);
    expect(rows[id]).toEqual({ kind: "quarantined" });
    expect(issueIsRecoverable(rows[id]!) && issueCanRetry(rows[id]!)).toBe(true);

    // The sheet's Try again reaches the engine, and so does Delete; after Delete no controller is told again.
    const retried = await quietly(() => runFailedAction(actionCall("retry", "quarantined", id)));
    expect(retried.status).toBe("ok");
    const deleted = await runFailedAction(actionCall("delete", "quarantined", id));
    expect(deleted.status === "ok" || deleted.status === "gone").toBe(true);
    asA.detach();
    const again = await attach(space(A).tcw);
    await rig.settle();
    expect(again.recorder.getState().captureIssues[id]).toBeUndefined();
    expect(Object.keys(await homeFor(again.recorder.getState().captureIssues, A))).toEqual([]);
    again.detach();
  });

  test("A → B → A: B never sees A's recording; A sees it again", async () => {
    const id = await bootWithParked(A);
    const asA = await attach(space(A).tcw);
    await until(() => asA.recorder.getState().captureIssues[id] !== undefined, "A's issue");
    asA.detach();

    const asB = await attach(space(B).tcw);
    await rig.settle();
    expect(asB.recorder.getState().captureIssues[id]).toBeUndefined();
    expect(Object.keys(await homeFor(asB.recorder.getState().captureIssues, B))).toEqual([]);
    asB.detach();

    const backAsA = await attach(space(A).tcw);
    await until(() => backAsA.recorder.getState().captureIssues[id] !== undefined, "A's issue after B");
    expect((await homeFor(backAsA.recorder.getState().captureIssues, A))[id]).toEqual({ kind: "quarantined" });
    backAsA.detach();
  });

  test("a recording made signed out is shown to anyone until the first sign-in claims it, then only to that account", async () => {
    const id = await bootWithParked(null);
    const signedOut = await attach(null);
    await until(() => signedOut.recorder.getState().captureIssues[id] !== undefined, "the signed-out issue");
    signedOut.detach();

    await signIn(A, 1);
    const asB = await attach(space(B).tcw);
    await rig.settle();
    expect(asB.recorder.getState().captureIssues[id]).toBeUndefined();
    expect(Object.keys(await homeFor({}, B))).toEqual([]);
    asB.detach();
    const asA = await attach(space(A).tcw);
    await until(() => asA.recorder.getState().captureIssues[id] !== undefined, "A's claimed issue");
    expect((await homeFor({}, A))[id]).toEqual({ kind: "quarantined" });
    asA.detach();
  });

  test("a decoder_unavailable recording that is not quarantined is announced to a later controller too", async () => {
    const first = await createRig();
    await first.engine.plugin.setCaptureDefaults({ accountDid: A, transitionGen: 1, transcriber: "private-cloud", identifySpeakers: false });
    const { id } = await first.engine.plugin.start();
    await first.chunk([1, 2, 3]);
    rig = await first.reopen({ decodeCheck: async () => { throw new DecodeCheckError("resource", "no decoder"); } });
    __setVoiceNotesForTests(await quietly(() => startWebCaptureEngine({ store: rig.store, captureEnv: () => rig.fake.env, now: rig.clock.now })), { available: true });

    const signedOut = await attach(null);
    signedOut.detach();
    const asA = await attach(space(A).tcw);
    await until(() => asA.recorder.getState().captureIssues[id] !== undefined, "the decoder_unavailable issue");
    expect(asA.recorder.getState().captureIssues[id]).toMatchObject({ kind: "recoveryFailed", detail: "decoder_unavailable" });
    asA.detach();
  });
});

describe("the saved file's extension follows the container", () => {
  test("WebM and Ogg from a browser, MP4/AAC and anything else stay .m4a", () => {
    expect(audioFileExtension("audio/webm;codecs=opus")).toBe("webm");
    expect(audioFileExtension("audio/webm")).toBe("webm");
    expect(audioFileExtension("audio/ogg;codecs=opus")).toBe("ogg");
    expect(audioFileExtension("audio/mp4")).toBe("m4a");
    expect(audioFileExtension("audio/mp4;codecs=mp4a.40.2")).toBe("m4a");
    expect(audioFileExtension("audio/aac")).toBe("m4a");
  });
});
