import { afterEach, expect, test } from "bun:test";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { IDBFactory } from "fake-indexeddb";
import { PrivateCloudError, type PtxPutResponse } from "../privateCloud";
import { _resetConnectorSchemaMemoForTests } from "../connectors/connectorStore";
import { readTranscriptCommit } from "./voiceNoteCommits";
import { __resetCaptureEngineForTests, __setInstalledEngineForTests, captureCapabilities } from "./captureEngine";
import { mountVoiceNoteAccount } from "./accountContext";
import { __setVoiceNotesForTests, VoiceNotes } from "./nativeVoiceNotes";
import { cachedSpaceAudio, cachedSpaceAudioOffline, clearCachedAudio, trimCachedAudio } from "./audioPlaybackCache";
import { createVoiceNoteCloud, createVoiceNoteTranscriber, localStorageVoiceNoteHoldStore,
  localStorageVoiceNotePendingStore, localStorageVoiceNotePrivateChoiceStore, transcribeVoiceNote } from "./voiceNoteTranscription";
import { saveVoiceNote } from "./voiceNoteStore";
import { memoryAudioBlobs } from "./web/webTestKit";
import { newIdbEnv } from "./web/testing/idb";
import { memoryLocks, openWebStore, recordingFromSession } from "./web/webStore";
import { __resetSourcePinsForTests, accountStorageKey, isSourcePinned, retainSource,
  setLimitBlockedChoice, VOICE_NOTE_PENDING_JOBS_KEY } from "./sourcePins";
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const DID = "did:test:cache-pins";
const PTX_ID = "trn_01J8Z3K4M5N6P7Q8R9S0T1V2W3";
const CAPS = {
  max_bytes: 120_960_000, max_duration_seconds: 7_777, accepted_max_duration_seconds: 7_777,
  duration_grace_seconds: 0, content_types: ["audio/mpeg", "audio/wav"], admission: "open" as const, diarization: true,
};
const TRANSCRIPT = {
  language: "en", duration_seconds: 1, provider: "tinfoil", model: "whisper-large-v3-turbo", channels: 1,
  segments: [{ id: "segment-1", speaker_id: "channel_0", channel: 0, start: 0, end: 1, text: "synthetic" }], text: "synthetic",
};
const originalVoiceNotes = VoiceNotes;
const originalStorage = (globalThis as typeof globalThis & { localStorage?: Storage }).localStorage;
const originalIndexedDb = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  __setVoiceNotesForTests(originalVoiceNotes, { available: null });
  if (originalIndexedDb) Object.defineProperty(globalThis, "indexedDB", originalIndexedDb);
  else Reflect.deleteProperty(globalThis, "indexedDB");
  if (originalStorage === undefined) Reflect.deleteProperty(globalThis, "localStorage");
  else Object.defineProperty(globalThis, "localStorage", { configurable: true, value: originalStorage });
  __resetCaptureEngineForTests();
  _resetConnectorSchemaMemoForTests();
});

function testStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

async function setup(options: { length?: number; fileBacked?: boolean } = {}) {
  __resetCaptureEngineForTests();
  _resetConnectorSchemaMemoForTests();
  globalThis.indexedDB = new IDBFactory() as unknown as IDBFactory;
  cleanups.push(mountVoiceNoteAccount(DID));
  const env = newIdbEnv();
  const locks = memoryLocks();
  const blobs = memoryAudioBlobs();
  const open = () => openWebStore({ env, locks, decodeCheck: null,
    ...(options.fileBacked ? { audio: () => blobs.create() } : {}) });
  let store = await open();
  const sourceId = "synthetic-cache-note";
  const bytes = Uint8Array.from({ length: options.length ?? 32 }, (_, index) => index % 251);
  await store.setCaptureDefaults({ accountDid: DID, transitionGen: 1, transcriber: "private-cloud", identifySpeakers: false });
  await store.beginSession({ id: sourceId, startedAt: 1_000, source: "in_app", owner: DID, transitionGen: 1,
    options: { transcriber: "private-cloud", identifySpeakers: false, uploadAudio: true }, mimeType: "audio/mpeg",
    input: null, maxDurationMs: 100_000 });
  await store.appendChunk(sourceId, bytes, { audioMs: 1_000, firstAudioAt: 1_000 });
  const note = await store.commitSession(sourceId, (session, size) => recordingFromSession(session, size,
    { endedAt: 2_000, durationMs: 1_000, recovered: false, endedUnexpectedly: false, exitReason: null }));
  if (!note) throw new Error("synthetic note missing");
  const sqlite = new Database(":memory:");
  const kv = new Map<string, unknown>();
  const flags = { failAudio: false, failCommit: false, audioReads: 0 };
  const safe = (run: () => unknown) => {
    try { return { ok: true, data: run() }; }
    catch { return { ok: false, error: { code: "SQL", message: "synthetic SQL failure" } }; }
  };
  const tcw = {
    did: DID,
    sql: { db: () => ({
      query: async (sql: string, parameters: SQLQueryBindings[] = []) => safe(() => ({ rows: sqlite.query(sql).values(...parameters) })),
      execute: async (sql: string, parameters: SQLQueryBindings[] = []) => flags.failCommit && sql.includes("INSERT INTO voice_note_transcript")
        ? { ok: false, error: { code: "SQL", message: "synthetic commit failure" } }
        : safe(() => { sqlite.query(sql).run(...parameters); return { rows: [] }; }),
    }) },
    kv: {
      put: async (key: string, value: unknown, options?: { ifNoneMatch?: string }) => {
        if (options?.ifNoneMatch === "*" && kv.has(key)) return { ok: false, error: { code: "KV_PRECONDITION_FAILED", message: "already exists" } };
        kv.set(key, value);
        return { ok: true, data: { headers: {} } };
      },
      get: async (key: string) => {
        if (key.includes("/audio")) {
          flags.audioReads++;
          if (flags.failAudio) return { ok: false, error: { code: "KV_UNAVAILABLE", message: "synthetic audio offline" } };
        }
        return kv.has(key) ? { ok: true, data: { data: kv.get(key) } } : { ok: false, error: { code: "KV_NOT_FOUND", message: "missing" } };
      },
      list: async ({ path }: { path: string }) => ({ ok: true, data: { keys: [...kv.keys()].filter((key) => key.startsWith(path)) } }),
    },
  };
  const saved = await saveVoiceNote(tcw as never, note, {
    mimeType: "audio/mpeg", size: bytes.length, readPart: async (offset, length) => bytes.slice(offset, offset + length),
  }, "web");
  if (!saved.ok) throw new Error("synthetic Space save failed");
  if (!saved.data.verifiedInSpace) throw new Error("synthetic Space receipt missing");
  const receipt = saved.data.verifiedInSpace;
  await store.updateLedger({ id: sourceId, did: DID, rev: note.rev ?? 1,
    patch: { audio: { state: "saved", rowId: saved.data.id, at: 1, verifiedInSpace: receipt } } });

  let localReads = 0;
  let beforeMetadata: () => Promise<void> = async () => {};
  const bind = () => __setVoiceNotesForTests({ ...store,
    localAudioSize: async ({ id }: { id: string }) => ({ size: await store.audio.size(id) }),
    readAudioChunk: async (args: { id: string; offset: number; length: number }) => {
      localReads++;
      return store.readAudioChunk(args);
    },
    audioMetadata: async () => {
      await beforeMetadata();
      return { size: bytes.length, mimeType: "audio/mpeg", sha256: receipt!.sha256 };
    },
  } as never, { available: true });
  const createdAttempts = new Set<string>();
  let idSequence = 0;
  const newId = () => `00000000-0000-4000-8000-${String(++idSequence).padStart(12, "0")}`;
  bind();
  const pendingStorage = testStorage();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: pendingStorage });
  cleanups.push(() => {
    if (originalStorage === undefined) Reflect.deleteProperty(globalThis, "localStorage");
    else Object.defineProperty(globalThis, "localStorage", { configurable: true, value: originalStorage });
  });
  cleanups.push(() => { store.close(); sqlite.close(); });
  const reopen = async () => { store.close(); store = await open(); bind(); };
  return { sourceId, bytes, tcw, sqlite, kv, flags, get store() { return store; }, pendingStorage, createdAttempts, bind, reopen,
    newId, setMetadataGate: (gate: () => Promise<void>) => { beforeMetadata = gate; },
    localReads: () => localReads, locks, receipt };
}

function cloudFor(h: Awaited<ReturnType<typeof setup>>, options: {
  put?: () => Promise<PtxPutResponse>; completed?: boolean; holdDenied?: boolean; expired?: boolean;
} = {}) {
  const counts = { creates: 0, createRequests: 0, puts: 0, gets: 0, results: 0, cancels: 0, removes: 0 };
  let completed = options.completed ?? false;
  let expired = false;
  const storage = {
    ...h.pendingStorage,
    setItem: (key: string, value: string) => {
      if (options.holdDenied && value.includes('"held"')) throw new Error("synthetic storage quota");
      h.pendingStorage.setItem(key, value);
    },
  };
  const pending = localStorageVoiceNotePendingStore(DID, storage);
  const api = {
    backendUrl: "https://api.example", bearer: () => "synthetic", capabilities: async () => CAPS,
    list: async () => { throw new Error("unused"); },
    get: async () => {
      counts.gets++;
      if (options.expired && !expired) {
        expired = true;
        throw new PrivateCloudError("transcription_not_found", "synthetic expired job");
      }
      return { id: PTX_ID, status: completed ? "completed" : "awaiting_upload" };
    },
    result: async () => { counts.results++; return { status: "completed", transcript: TRANSCRIPT }; },
    cancel: async () => { counts.cancels++; }, remove: async () => { counts.removes++; },
  };
  const cloud = createVoiceNoteCloud({
    api: api as never, pending, origin: "https://ptx.example", newId: h.newId,
    decode: async (_audio, sampleRate) => ({ channels: [new Float32Array(sampleRate).fill(0.25)], sampleRate }),
    create: async (request) => {
      counts.createRequests++;
      if (!h.createdAttempts.has(request.attemptId)) {
        h.createdAttempts.add(request.attemptId);
        counts.creates++;
      }
      return { id: PTX_ID, status: "awaiting_upload", upload: { path: `/uploads/${PTX_ID}`, capability: "synthetic" } };
    },
    put: async (request) => {
      counts.puts++;
      if (request.nativeFileId) await VoiceNotes.readAudioChunk({ id: request.nativeFileId, offset: 0, length: h.bytes.length });
      if (options.put) return options.put();
      completed = true;
      return { status: 201, body: { status: "queued" } };
    },
    clock: { now: () => 0, sleep: async () => {}, random: () => 0.5 },
  });
  const run = () => transcribeVoiceNote({ tcw: h.tcw as never, cloud, capabilities: CAPS, sourceId: h.sourceId, explicit: true, report: () => {} });
  return { cloud, pending, counts, run };
}

function choiceController(h: Awaited<ReturnType<typeof setup>>, choices: ReturnType<typeof localStorageVoiceNotePrivateChoiceStore>,
  capabilitiesAvailable: boolean) {
  const cloud = {
    pendingSourceIds: () => [],
    capabilities: async () => {
      if (!capabilitiesAvailable) throw new Error("synthetic capability check failure");
      return { ...CAPS, max_bytes: 16, max_duration_seconds: 100, accepted_max_duration_seconds: 100 };
    },
  };
  return createVoiceNoteTranscriber({
    cloud: cloud as never, consent: { get: () => true, set: () => {} }, choices,
    holds: localStorageVoiceNoteHoldStore(DID), tcw: () => h.tcw as never,
    runNote: async () => "transcribed", checkRetryMs: [], failedBackoffMs: [], freshMs: 0,
  });
}

for (const operation of ["trim", "clear"] as const) {
  const evict = () => operation === "trim" ? trimCachedAudio(0) : clearCachedAudio();

  for (const backend of ["idb", "desktop"] as const) {
  for (const offline of [false, true]) {
    test(`TC-1182 P1 ${operation}/${backend}, offline=${offline}: Clear or trim during PUT keeps the source leased`, async () => {
      const h = await setup({ fileBacked: backend === "desktop" });
      const entered = deferred();
      const unblock = deferred();
      const first = cloudFor(h, { put: async () => {
        entered.resolve();
        await unblock.promise;
        throw new PrivateCloudError("upload_outcome_unknown", "synthetic upload response loss");
      } });
      const firstRun = first.run().catch((error: unknown) => error);
      await entered.promise;
      expect(first.pending.read(h.sourceId)?.transcriptionId).toBe(PTX_ID);
      await evict();
      const remaining = await h.store.audio.size(h.sourceId);
      unblock.resolve();
      await firstRun;
      await h.reopen();
      h.flags.failAudio = offline;
      const retry = cloudFor(h);
      const result = await retry.run().catch((error: unknown) => error);

      expect(remaining).toBe(h.bytes.length);
      expect(result).toBe("transcribed");
      expect(retry.counts.creates).toBe(0);
      expect(retry.counts.puts).toBe(1);
      expect(retry.counts.cancels).toBe(0);
      expect((await readTranscriptCommit(h.tcw as never, h.sourceId))?.rev).toBe(1);
    });
  }
  }
  for (const backend of ["idb", "desktop"] as const) {
  for (const offline of [false, true]) {
    test(`TC-1182 P2 ${operation}/${backend}, offline=${offline}: completed PUT failure pins the source after relaunch`, async () => {
      const h = await setup({ fileBacked: backend === "desktop" });
      const first = cloudFor(h, { put: async () => {
        throw new PrivateCloudError("upload_outcome_unknown", "synthetic upload response loss");
      } });
      await first.run().catch(() => undefined);
      expect(first.pending.read(h.sourceId)?.transcriptionId).toBe(PTX_ID);
      expect((await h.store.listPending()).recordings[0]!.ledger!.remote).toEqual([]);
      await h.reopen();
      await (operation === "trim" ? trimCachedAudio(0) : clearCachedAudio());
      const remaining = await h.store.audio.size(h.sourceId);
      h.flags.failAudio = offline;
      const retry = cloudFor(h);
      const result = await retry.run();

      expect(remaining).toBe(h.bytes.length);
      expect(result).toBe("transcribed");
      expect(retry.counts.creates).toBe(0);
      expect(retry.counts.cancels).toBe(0);
      expect((await readTranscriptCommit(h.tcw as never, h.sourceId))?.rev).toBe(1);
    });
  }
  }

  for (const offline of [false, true]) {
    test(`TC-1182 P3 ${operation}, offline=${offline}: held-result retry leaves the PTX result readable`, async () => {
      const h = await setup();
      const first = cloudFor(h, { completed: true, holdDenied: true });
      first.pending.write(h.sourceId, { attemptId: "existing-attempt", transcriptionId: PTX_ID });
      h.flags.failCommit = true;
      await first.run().catch(() => undefined);
      await evict();
      const remaining = await h.store.audio.size(h.sourceId);
      await h.reopen();
      h.flags.failCommit = false;
      h.flags.failAudio = offline;
      const retry = cloudFor(h, { completed: true });
      const result = await retry.run();

      expect(remaining).toBe(h.bytes.length);
      expect(result).toBe("transcribed");
      expect(retry.counts.creates).toBe(0);
      expect(retry.counts.puts).toBe(0);
      expect(retry.counts.results).toBe(1);
      expect((await readTranscriptCommit(h.tcw as never, h.sourceId))?.rev).toBe(1);
    });
  }
}

for (const operation of ["trim", "clear"] as const) {
  for (const backend of ["idb", "desktop"] as const) {
  for (const offline of [false, true]) {
    test(`TC-1182 P4 ${operation}/${backend}, offline=${offline} observes the lease while a chunk read is paused`, async () => {
      const h = await setup({ length: 1024 * 1024 + 32, fileBacked: backend === "desktop" });
      h.flags.failAudio = offline;
      const entered = deferred();
      const unblock = deferred();
      let reads = 0;
      const base = h.store;
      __setVoiceNotesForTests({ ...base,
        localAudioSize: async ({ id }: { id: string }) => ({ size: await base.audio.size(id) }),
        readAudioChunk: async (args: { id: string; offset: number; length: number }) => {
          const chunk = await base.readAudioChunk(args);
          reads++;
          if (reads === 1) { entered.resolve(); await unblock.promise; }
          return chunk;
        },
      } as never, { available: true });
      const cloud = cloudFor(h);
      const running = cloud.run().catch((error: unknown) => error);
      await entered.promise;
      if (operation === "trim") await trimCachedAudio(0);
      else expect((await clearCachedAudio()).inUse).toBeGreaterThan(0);
      const remaining = await h.store.audio.size(h.sourceId);
      unblock.resolve();
      const result = await running;
      expect(remaining).toBe(h.bytes.length);
      expect(result).toBe("transcribed");
      expect(cloud.counts.creates).toBe(1);
    });
  }
  }
}

for (const operation of ["trim", "clear"] as const) {
  for (const offline of [false, true]) {
    test(`TC-1182 A1 ${operation}, offline=${offline} stops after the mounted account changes during sizing`, async () => {
      const h = await setup();
      h.flags.failAudio = offline;
      const reached = deferred();
      const unblock = deferred();
      let first = true;
      const base = h.store;
      __setVoiceNotesForTests({ ...base, localAudioSize: async ({ id }: { id: string }) => {
        if (first) { first = false; reached.resolve(); await unblock.promise; }
        return { size: await base.audio.size(id) };
      } } as never, { available: true });
      const clearing = operation === "clear" ? clearCachedAudio() : trimCachedAudio(0);
      await reached.promise;
      cleanups.push(mountVoiceNoteAccount("did:test:other"));
      await base.setAccountState({ accountDid: "did:test:other", transitionGen: 2, status: "signed_in" });
      unblock.resolve();
      const report = await clearing;
      expect(await h.store.audio.size(h.sourceId)).toBe(h.bytes.length);
      if (operation === "clear") expect(report).toMatchObject({ stopped: "account_changed" });
    });
  }
}
for (const operation of ["trim", "clear"] as const) {
  for (const offline of [false, true]) {
    test(`TC-1182 P5 ${operation}, offline=${offline}: native upload keeps its file through metadata and PUT`, async () => {
      const h = await setup();
      __setInstalledEngineForTests("native", { ...captureCapabilities(), nativeFileUpload: true });
      const entered = deferred();
      const unblock = deferred();
      h.setMetadataGate(async () => { entered.resolve(); await unblock.promise; });
      h.flags.failAudio = offline;
      const cloud = cloudFor(h);
      const running = cloud.run();
      await entered.promise;
      await (operation === "trim" ? trimCachedAudio(0) : clearCachedAudio());
      expect(await h.store.audio.size(h.sourceId)).toBe(h.bytes.length);
      unblock.resolve();
      expect(await running).toBe("transcribed");
      expect(cloud.counts.puts).toBe(1);
      expect((await readTranscriptCommit(h.tcw as never, h.sourceId))?.rev).toBe(1);
    });
  }
}

for (const operation of ["trim", "clear"] as const) {
  for (const offline of [false, true]) {
    test(`TC-1182 P6 ${operation}, offline=${offline}: a Private choice keeps its source until later transcription`, async () => {
      const h = await setup();
      localStorageVoiceNotePrivateChoiceStore(DID).add(h.sourceId);
      await (operation === "trim" ? trimCachedAudio(0) : clearCachedAudio());
      const remaining = await h.store.audio.size(h.sourceId);
      h.flags.failAudio = offline;
      const cloud = cloudFor(h);

      expect(remaining).toBe(h.bytes.length);
      expect(await cloud.run()).toBe("transcribed");
      expect(cloud.counts.creates).toBe(1);
      expect((await readTranscriptCommit(h.tcw as never, h.sourceId))?.rev).toBe(1);
    });
  }
}

for (const operation of ["trim", "clear"] as const) {
  for (const offline of [false, true]) {
    test(`TC-1182 P7 ${operation}, offline=${offline}: queued source stays pinned until Private work runs`, async () => {
      const h = await setup();
      h.flags.failAudio = offline;
      const release = retainSource(DID, h.sourceId);
      await (operation === "trim" ? trimCachedAudio(0) : clearCachedAudio());
      const retainedBytes = await h.store.audio.size(h.sourceId);
      release();

      const cloud = cloudFor(h);
      expect(retainedBytes).toBe(h.bytes.length);
      expect(await cloud.run()).toBe("transcribed");
      expect(cloud.counts.creates).toBe(1);
      expect((await readTranscriptCommit(h.tcw as never, h.sourceId))?.rev).toBe(1);
    });
  }
}

for (const operation of ["trim", "clear"] as const) {
  for (const offline of [false, true]) {
    test(`TC-1182 P8 ${operation}, offline=${offline}: Retry reads local audio for a terminal marker`, async () => {
      const h = await setup();
      const pending = localStorageVoiceNotePendingStore(DID);
      pending.write(h.sourceId, { attemptId: "terminal-attempt", transcriptionId: null, failure: "transcript_incomplete" });
      await (operation === "trim" ? trimCachedAudio(0) : clearCachedAudio());
      const remaining = await h.store.audio.size(h.sourceId);
      h.flags.failAudio = offline;
      const cloud = cloudFor(h);

      expect(remaining).toBe(h.bytes.length);
      expect(await cloud.run()).toBe("transcribed");
      expect(cloud.counts.creates).toBe(1);
      expect((await readTranscriptCommit(h.tcw as never, h.sourceId))?.rev).toBe(1);
    });
  }
}

for (const operation of ["trim", "clear"] as const) {
  for (const offline of [false, true]) {
    test(`TC-1182 P3 ${operation}, offline=${offline}: expired PTX result re-creates from retained local audio`, async () => {
      const h = await setup();
      h.flags.failCommit = true;
      const failed = cloudFor(h, { completed: true, holdDenied: true });
      await failed.run().catch(() => undefined);
      expect(failed.counts.results).toBe(1);
      h.flags.failCommit = false;
      h.flags.failAudio = offline;
      await (operation === "trim" ? trimCachedAudio(0) : clearCachedAudio());
      expect(await h.store.audio.size(h.sourceId)).toBe(h.bytes.length);

      const recovered = cloudFor(h, { expired: true });
      expect(await recovered.run()).toBe("transcribed");
      expect(recovered.counts.creates).toBe(1);
      expect(recovered.counts.puts).toBe(1);
      expect((await readTranscriptCommit(h.tcw as never, h.sourceId))?.rev).toBe(1);
    });
  }
}

for (const operation of ["trim", "clear"] as const) {
  for (const offline of [false, true]) {
    test(`TC-1182 G1 ${operation}, offline=${offline}: successful commit leaves the local original available`, async () => {
      const h = await setup();
      h.flags.failAudio = offline;
      const cloud = cloudFor(h);
      expect(await cloud.run()).toBe("transcribed");
      await (operation === "trim" ? trimCachedAudio(0) : clearCachedAudio());

      expect((await readTranscriptCommit(h.tcw as never, h.sourceId))?.rev).toBe(1);
      expect(await h.store.audio.size(h.sourceId)).toBe(h.bytes.length);
    });
  }
}
for (const operation of ["trim", "clear"] as const) {
  for (const offline of [false, true]) {
    test(`TC-1182 G3 ${operation}, offline=${offline}: releaseUnsent clears the job but cache keeps local audio`, async () => {
      const h = await setup();
      h.flags.failAudio = offline;
      const cloud = cloudFor(h);
      cloud.pending.write(h.sourceId, { attemptId: "release-attempt", transcriptionId: PTX_ID });

      await cloud.cloud.releaseUnsent();
      const report = operation === "trim" ? await trimCachedAudio(0) : await clearCachedAudio();

      expect(cloud.pending.read(h.sourceId)).toBeNull();
      if (operation === "clear") expect(report).toMatchObject({ cleared: 0, inUse: 1, pinnedBytes: h.bytes.length });
      expect(await h.store.audio.size(h.sourceId)).toBe(h.bytes.length);
    });
  }
}

test("TC-1182 G3 turning Private off clears the choice and job while retaining local audio", async () => {
  const h = await setup();
  const cloud = cloudFor(h);
  const choices = localStorageVoiceNotePrivateChoiceStore(DID);
  choices.add(h.sourceId);
  cloud.pending.write(h.sourceId, { attemptId: "off-attempt", transcriptionId: PTX_ID });
  const transcriber = createVoiceNoteTranscriber({
    cloud: cloud.cloud, consent: { get: () => true, set: () => {} }, choices,
    holds: localStorageVoiceNoteHoldStore(DID), tcw: () => h.tcw as never, checkRetryMs: [],
  });

  await transcriber.turnOff();
  const report = await clearCachedAudio();

  expect(cloud.pending.read(h.sourceId)).toBeNull();
  expect(choices.has(h.sourceId)).toBe(false);
  expect(report).toMatchObject({ cleared: 0, inUse: 1, pinnedBytes: h.bytes.length });
  expect(await h.store.audio.size(h.sourceId)).toBe(h.bytes.length);
});

test("TC-1182 G3 manual Retry ending in a release code clears the job but retains local audio", async () => {
  const h = await setup();
  const cloud = cloudFor(h);
  const choices = localStorageVoiceNotePrivateChoiceStore(DID);
  const scheduled: { callback: () => void; delayMs: number }[] = [];
  let attempts = 0;
  const transcriber = createVoiceNoteTranscriber({
    cloud: cloud.cloud, consent: { get: () => true, set: () => {} }, choices,
    holds: localStorageVoiceNoteHoldStore(DID), tcw: () => h.tcw as never,
    checkRetryMs: [], failedBackoffMs: [60_000], now: () => 0,
    timer: {
      schedule: (callback, delayMs) => { scheduled.push({ callback, delayMs }); return scheduled.length; },
      cancel: () => {},
    },
    runNote: async () => {
      attempts++;
      if (attempts === 1) throw new PrivateCloudError("service_paused", "synthetic admission pause");
      throw new PrivateCloudError("decode_failed", "synthetic release code");
    },
  });
  const settle = async () => {
    for (let i = 0; i < 40 && transcriber.snapshot().jobs.get(h.sourceId)?.kind === "active"; i++)
      await new Promise((resolve) => setTimeout(resolve, 0));
  };
  await transcriber.check();
  transcriber.transcribePrivately(h.sourceId, 1);
  await settle();
  expect(transcriber.snapshot().jobs.get(h.sourceId)).toMatchObject({ kind: "failed", code: "service_paused" });
  expect(scheduled).toHaveLength(1);

  transcriber.transcribePrivately(h.sourceId, 1);
  await settle();
  const report = await clearCachedAudio();

  expect(attempts).toBe(2);
  expect(transcriber.snapshot().jobs.get(h.sourceId)).toMatchObject({ kind: "failed", code: "decode_failed" });
  expect(choices.has(h.sourceId)).toBe(false);
  expect(cloud.pending.sourceIds()).toEqual([]);
  expect(report).toMatchObject({ cleared: 0, inUse: 1, pinnedBytes: h.bytes.length });
  expect(await h.store.audio.size(h.sourceId)).toBe(h.bytes.length);
});


test("TC-1182 a removed and re-added choice receives a fresh permanent-pin age", async () => {
  const h = await setup();
  const originalNow = Date.now;
  let now = Date.parse("2026-01-01T00:00:00.000Z");
  Date.now = () => now;
  try {
    const choices = localStorageVoiceNotePrivateChoiceStore(DID);
    choices.add(h.sourceId);
    await clearCachedAudio();
    now += 31 * 24 * 60 * 60 * 1_000;
    await trimCachedAudio(h.bytes.length);

    choices.remove(h.sourceId);
    choices.add(h.sourceId);
    await clearCachedAudio();

    expect(choices.has(h.sourceId)).toBe(true);
    expect(await h.store.audio.size(h.sourceId)).toBe(h.bytes.length);
  } finally {
    Date.now = originalNow;
  }
});

test("TC-1182 an ordinary Private choice remains pinned beyond 30 days", async () => {
  const h = await setup();
  const originalNow = Date.now;
  let now = Date.parse("2026-01-01T00:00:00.000Z");
  Date.now = () => now;
  try {
    localStorageVoiceNotePrivateChoiceStore(DID).add(h.sourceId);
    await clearCachedAudio();
    now += 31 * 24 * 60 * 60 * 1_000;
    await clearCachedAudio();
    expect(await h.store.audio.size(h.sourceId)).toBe(h.bytes.length);
  } finally {
    Date.now = originalNow;
  }
});

test("TC-1182 a limit-blocked Private choice remains retained after 30 days", async () => {
  const h = await setup();
  const originalNow = Date.now;
  let now = Date.parse("2026-01-01T00:00:00.000Z");
  Date.now = () => now;
  try {
    const cloud = cloudFor(h);
    const choices = localStorageVoiceNotePrivateChoiceStore(DID);
    const transcriber = createVoiceNoteTranscriber({
      cloud: cloud.cloud, consent: { get: () => true, set: () => {} }, choices,
      holds: localStorageVoiceNoteHoldStore(DID), tcw: () => h.tcw as never, checkRetryMs: [],
    });
    await transcriber.check();
    expect(transcriber.transcribePrivately(h.sourceId, CAPS.max_duration_seconds + 1)).not.toBe(null);
    expect(choices.has(h.sourceId)).toBe(true);
    await clearCachedAudio();
    now += 31 * 24 * 60 * 60 * 1_000;
    await clearCachedAudio();
    expect(await h.store.audio.size(h.sourceId)).toBe(h.bytes.length);
  } finally {
    Date.now = originalNow;
  }
});

test("TC-1182 a malformed held:null pending row fails closed beyond 30 days", async () => {
  const h = await setup();
  const originalNow = Date.now;
  let now = Date.parse("2026-01-01T00:00:00.000Z");
  Date.now = () => now;
  try {
    h.pendingStorage.setItem(accountStorageKey(VOICE_NOTE_PENDING_JOBS_KEY, DID), JSON.stringify({
      [h.sourceId]: { attemptId: "malformed-held", transcriptionId: null, held: null },
    }));
    await clearCachedAudio();
    now += 31 * 24 * 60 * 60 * 1_000;
    await clearCachedAudio();
    expect(await h.store.audio.size(h.sourceId)).toBe(h.bytes.length);
  } finally {
    Date.now = originalNow;
  }
});

for (const fileBacked of [false, true]) {
  for (const operation of ["clear", "trim"] as const) {
    for (const mode of ["age-remove-throws", "metadata-remove-throws", "metadata-remove-noop", "limit-remove-throws", "limit-remove-noop"] as const) {
      test(`TC-1182 fresh Private choice survives ${mode}: ${operation}, fileBacked=${fileBacked}`, async () => {
        const h = await setup({ fileBacked });
        const originalNow = Date.now;
        let now = Date.parse("2026-01-01T00:00:00.000Z");
        Date.now = () => now;
        try {
          const choices = localStorageVoiceNotePrivateChoiceStore(DID);
          choices.add(h.sourceId);
          setLimitBlockedChoice(DID, h.sourceId, true);
          expect(await isSourcePinned(DID, h.sourceId)).toBe(true);
          now += 31 * 24 * 60 * 60 * 1_000;
          expect(await isSourcePinned(DID, h.sourceId)).toBe(false);

          const removeItem = h.pendingStorage.removeItem;
          h.pendingStorage.removeItem = (key) => {
            const age = key.startsWith("exo.voiceNotes.privateSourcePinAge");
            const limit = key.startsWith("exo.voiceNotes.limitBlockedPrivateChoices");
            const denied = mode === "age-remove-throws" ? age
              : mode === "metadata-remove-throws" || mode === "metadata-remove-noop" ? age || limit : limit;
            if (!denied) return removeItem(key);
            if (mode.endsWith("-noop")) return;
            throw new Error("synthetic metadata removal denied");
          };
          choices.remove(h.sourceId);
          expect(choices.has(h.sourceId)).toBe(false);
          now++;
          choices.add(h.sourceId);
          expect(choices.has(h.sourceId)).toBe(true);
          if (mode === "age-remove-throws") setLimitBlockedChoice(DID, h.sourceId, true);
          if (mode.startsWith("limit-remove-")) {
            expect(await isSourcePinned(DID, h.sourceId)).toBe(true);
            now += 31 * 24 * 60 * 60 * 1_000;
          }

          expect(await localStorageVoiceNotePrivateChoiceStore(DID, h.pendingStorage).has(h.sourceId)).toBe(true);
          __resetSourcePinsForTests();
          expect(await isSourcePinned(DID, h.sourceId)).toBe(true);
          if (operation === "trim") await trimCachedAudio(0);
          else await clearCachedAudio();
          expect(await h.store.audio.size(h.sourceId)).toBe(h.bytes.length);
        } finally {
          Date.now = originalNow;
        }
      });
    }
  }
}

for (const fileBacked of [false, true]) {
  for (const operation of ["clear", "trim"] as const) {
    for (const writeFault of ["throws", "no-op"] as const) {
      test(`TC-1182 failed fresh intent write pins across reconstruction (${writeFault}): ${operation}, fileBacked=${fileBacked}`, async () => {
        const h = await setup({ fileBacked });
        const originalNow = Date.now;
        let now = Date.parse("2026-01-01T00:00:00.000Z");
        Date.now = () => now;
        try {
          const choices = localStorageVoiceNotePrivateChoiceStore(DID);
          const initial = choiceController(h, choices, true);
          await initial.check();
          expect(initial.transcribePrivately(h.sourceId, 1, h.bytes.length)).toEqual({
            kind: "bytes", limitBytes: 16, sizeBytes: h.bytes.length,
          });
          expect(await isSourcePinned(DID, h.sourceId)).toBe(true);
          now += 31 * 24 * 60 * 60 * 1_000;
          expect(await isSourcePinned(DID, h.sourceId)).toBe(false);

          const setItem = h.pendingStorage.setItem;
          h.pendingStorage.setItem = (key, value) => {
            if (key.includes("privateChoiceIntents")) {
              if (writeFault === "no-op") return;
              throw new Error("synthetic intent write failure");
            }
            setItem(key, value);
          };
          const retry = choiceController(h, choices, false);
          await retry.check();
          retry.transcribePrivately(h.sourceId, 1, h.bytes.length);
          expect(choices.has(h.sourceId)).toBe(true);

          __resetSourcePinsForTests();
          expect(localStorageVoiceNotePrivateChoiceStore(DID, h.pendingStorage).has(h.sourceId)).toBe(true);
          expect(await isSourcePinned(DID, h.sourceId)).toBe(true);
          if (operation === "trim") await trimCachedAudio(0);
          else await clearCachedAudio();
          expect(await h.store.audio.size(h.sourceId)).toBe(h.bytes.length);
        } finally {
          Date.now = originalNow;
        }
      });
    }
  }
}

for (const fileBacked of [false, true]) {
  for (const operation of ["clear", "trim"] as const) {
    test(`TC-1182 limit update after a failed fresh intent does not reuse its old generation: ${operation}, fileBacked=${fileBacked}`, async () => {
      const h = await setup({ fileBacked });
      const originalNow = Date.now;
      let now = Date.parse("2026-01-01T00:00:00.000Z");
      Date.now = () => now;
      try {
        const choices = localStorageVoiceNotePrivateChoiceStore(DID);
        const transcriber = choiceController(h, choices, true);
        await transcriber.check();
        expect(transcriber.transcribePrivately(h.sourceId, 1, h.bytes.length)).toEqual({
          kind: "bytes", limitBytes: 16, sizeBytes: h.bytes.length,
        });
        expect(await isSourcePinned(DID, h.sourceId)).toBe(true);
        now += 31 * 24 * 60 * 60 * 1_000;
        expect(await isSourcePinned(DID, h.sourceId)).toBe(false);

        const setItem = h.pendingStorage.setItem;
        let failedFirstIntentWrite = false;
        h.pendingStorage.setItem = (key, value) => {
          if (!failedFirstIntentWrite && key.includes("privateChoiceIntents")) {
            failedFirstIntentWrite = true;
            throw new Error("synthetic first intent write failure");
          }
          setItem(key, value);
        };
        expect(transcriber.transcribePrivately(h.sourceId, 1, h.bytes.length)).toBe("choice-persistence-failed");
        expect(failedFirstIntentWrite).toBe(true);

        expect(await isSourcePinned(DID, h.sourceId)).toBe(true);
        if (operation === "trim") await trimCachedAudio(0);
        else await clearCachedAudio();
        expect(await h.store.audio.size(h.sourceId)).toBe(h.bytes.length);
      } finally {
        Date.now = originalNow;
      }
    });
  }
}

for (const fileBacked of [false, true]) {
  for (const operation of ["clear", "trim"] as const) {
    for (const reconstructed of [false, true]) {
      test(`TC-1182 concurrent choice lifetimes for separate notes do not overwrite (${operation}, fileBacked=${fileBacked}, reconstructed=${reconstructed})`, async () => {
        const h = await setup({ fileBacked });
        const originalNow = Date.now;
        let now = Date.parse("2026-01-01T00:00:00.000Z");
        Date.now = () => now;
        try {
          const choices = localStorageVoiceNotePrivateChoiceStore(DID);
          const initial = choiceController(h, choices, true);
          await initial.check();
          expect(initial.transcribePrivately(h.sourceId, 1, h.bytes.length)).toEqual({
            kind: "bytes", limitBytes: 16, sizeBytes: h.bytes.length,
          });
          expect(await isSourcePinned(DID, h.sourceId)).toBe(true);
          now += 31 * 24 * 60 * 60 * 1_000;
          expect(await isSourcePinned(DID, h.sourceId)).toBe(false);

          const setItem = h.pendingStorage.setItem;
          const secondTabStorage = {
            getItem: (key: string) => h.pendingStorage.getItem(key),
            setItem: (key: string, value: string) => h.pendingStorage.setItem(key, value),
            removeItem: (key: string) => h.pendingStorage.removeItem(key),
          } as Storage;
          const targetChoices = localStorageVoiceNotePrivateChoiceStore(DID, secondTabStorage);
          let interleaved = false;
          h.pendingStorage.setItem = (key, value) => {
            if (!interleaved && key.includes("privateChoiceIntents")) {
              interleaved = true;
              targetChoices.add(h.sourceId);
            }
            setItem(key, value);
          };
          localStorageVoiceNotePrivateChoiceStore(DID).add("synthetic-other-note");
          expect(interleaved).toBe(true);
          if (reconstructed) __resetSourcePinsForTests();
          expect(await isSourcePinned(DID, h.sourceId)).toBe(true);
          if (operation === "trim") await trimCachedAudio(0);
          else await clearCachedAudio();
          expect(await h.store.audio.size(h.sourceId)).toBe(h.bytes.length);
        } finally {
          Date.now = originalNow;
        }
      });
    }
  }
}
for (const operation of ["trim", "clear"] as const) {
  for (const backend of ["idb", "desktop"] as const) {
    test(`TC-1182 ${operation}/${backend} clears remote playback cache but keeps local recording audio`, async () => {
      const h = await setup({ fileBacked: backend === "desktop" });
      await cachedSpaceAudio("space", DID, "exo-voice-note", h.sourceId, "space-revision",
        async () => new Blob(["remote-playback"]));

      if (operation === "trim") await trimCachedAudio(0);
      else await clearCachedAudio();

      expect(await h.store.audio.size(h.sourceId)).toBe(h.bytes.length);
      expect(await cachedSpaceAudioOffline("space", DID, "exo-voice-note", h.sourceId)).toBeNull();
    });
  }
}
