import { describe, expect, jest, test } from "bun:test";
import { UPLOAD_PENDING_STORAGE_KEY, type UploadState } from "./audioUpload";
import { newIdbEnv } from "./voiceNotes/web/testing/idb";
import { memoryLocks, openWebStore, recordingFromSession, type WebStore } from "./voiceNotes/web/webStore";
import {
  CANONICAL_ORIGIN, canonicalUrlFor, countLocalOnlyRecordingWork, decideOriginMove, isLegacyOrigin, moveWhenClear,
  type LocalRecordingWork,
} from "./originMove";

const legacy = { hostname: "tinycloud.chat", pathname: "/notes/abc", search: "?tab=all&x=1", hash: "#share=tc1.eyJhIjoxfQ" };
const none: LocalRecordingWork = { saving: 0, localAudio: 0 };
const receipt = { sha256: "a".repeat(64), size: 4 };

function memoryStorage(entries: Record<string, string> = {}) {
  const map = new Map(Object.entries(entries));
  return {
    get length() { return map.size; },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (key: string) => map.get(key) ?? null,
  };
}

function seededStore() {
  const env = newIdbEnv();
  const open = () => openWebStore({ env, locks: memoryLocks(), now: () => 1_000_000, decodeCheck: null });
  return { env, open, count: () => countLocalOnlyRecordingWork({ factory: env.factory, storage: null }) };
}

async function startRecording(store: WebStore, id: string) {
  await store.beginSession({
    id, startedAt: 1000, source: "in_app", owner: "did:a", transitionGen: 0,
    options: { transcriber: "assemblyai", identifySpeakers: false },
    mimeType: "audio/webm;codecs=opus", input: null, maxDurationMs: 60 * 60 * 1000,
  });
  await store.appendChunk(id, Uint8Array.from([1, 2, 3, 4]), { audioMs: 1000, firstAudioAt: 1500 });
}

async function commit(store: WebStore, id: string) {
  const note = await store.commitSession(id, (session, size) => recordingFromSession(session, size, {
    endedAt: 9000, durationMs: session.audioMs, recovered: false, endedUnexpectedly: false, exitReason: null,
  }));
  return note!;
}

describe("origin move", () => {
  test("canonical URL keeps the path, query and hash exactly", () => {
    expect(canonicalUrlFor(legacy)).toBe(`${CANONICAL_ORIGIN}/notes/abc?tab=all&x=1#share=tc1.eyJhIjoxfQ`);
    expect(canonicalUrlFor({ pathname: "/", search: "", hash: "" })).toBe(`${CANONICAL_ORIGIN}/`);
  });

  test("only the exact legacy hostname counts as legacy", () => {
    expect(isLegacyOrigin({ hostname: "tinycloud.chat" })).toBe(true);
    expect(isLegacyOrigin({ hostname: "www.tinycloud.chat" })).toBe(false);
    expect(isLegacyOrigin({ hostname: "home.tinycloud.xyz" })).toBe(false);
  });

  test("a non-legacy host stays without reading storage", async () => {
    let reads = 0;
    const countWork = async () => { reads++; return none; };
    expect(await decideOriginMove({ location: { ...legacy, hostname: "home.tinycloud.xyz" }, countWork })).toEqual({ kind: "stay" });
    expect(await decideOriginMove({ location: { ...legacy, hostname: "localhost" }, countWork })).toEqual({ kind: "stay" });
    expect(reads).toBe(0);
  });

  test("a legacy host with no voice-note database moves, and the check creates no database", async () => {
    const env = newIdbEnv();
    expect(await decideOriginMove({ location: legacy, countWork: () => countLocalOnlyRecordingWork({ factory: env.factory, storage: null }) }))
      .toEqual({ kind: "move", url: canonicalUrlFor(legacy) });
    expect(await env.factory.databases()).toEqual([]);
  });

  test("without databases() the probe aborts its upgrade, so webStore still creates its schema", async () => {
    const env = newIdbEnv();
    const factory = env.factory;
    const noListing = { open: factory.open.bind(factory), deleteDatabase: factory.deleteDatabase.bind(factory),
      cmp: factory.cmp.bind(factory) } as unknown as IDBFactory;
    expect(await countLocalOnlyRecordingWork({ factory: noListing, storage: null })).toEqual(none);
    expect(await factory.databases()).toEqual([]);
    const store = await openWebStore({ env, locks: memoryLocks(), decodeCheck: null });
    await startRecording(store, "rec");
    expect(await countLocalOnlyRecordingWork({ factory: noListing, storage: null })).toEqual({ saving: 1, localAudio: 0 });
    store.close();
  });

  test("a pending recording holds the move until its row and verified audio are in the space", async () => {
    const { open, count } = seededStore();
    const store = await open();
    await startRecording(store, "rec");
    const decide = () => decideOriginMove({ location: legacy, countWork: count });
    expect(await decide()).toEqual({ kind: "hold", work: { saving: 1, localAudio: 0 } });

    const note = await commit(store, "rec");
    expect(await decide()).toEqual({ kind: "hold", work: { saving: 1, localAudio: 0 } });

    const { rev } = await store.updateLedger({ id: "rec", did: "did:a", rev: note.rev!, patch: {
      audio: { state: "saved", rowId: "row-1", at: 2000 },
    } });
    // Saved without uploading the audio (web audio upload is off by default): the audio is only here.
    expect(await decide()).toEqual({ kind: "hold", work: { saving: 0, localAudio: 1 } });

    await store.updateLedger({ id: "rec", did: "did:a", rev, patch: {
      audio: { state: "saved", rowId: "row-1", at: 2000, verifiedInSpace: receipt },
    } });
    expect(await decide()).toEqual({ kind: "move", url: canonicalUrlFor(legacy) });
    store.close();
  });

  test("a pending outbox entry holds the move until it completes", async () => {
    const { open, count } = seededStore();
    const store = await open();
    await store.beginRemoteOp({ id: "gone", did: "did:a", opId: "op1", provider: "assemblyai", mode: "hosted",
      kind: "hosted_create", fingerprint: "fp", startedAt: 1 });
    expect(await count()).toEqual({ saving: 1, localAudio: 0 });
    await store.completeOutbox({ entryId: "gone:op1", result: "done" });
    expect(await count()).toEqual(none);
    store.close();
  });

  test("an unsaved Upload-sheet job holds the move; saved and discarded jobs do not", async () => {
    const job = (extra: object) => JSON.stringify({ engine: "private-cloud", meetingId: "m", attemptId: "a", jobId: null,
      diarize: false, file: { name: "f.m4a", type: "audio/mp4", size: 4, lastModified: 1 }, owner: "did:a", saved: false, ...extra });
    const storage = memoryStorage({
      [`${UPLOAD_PENDING_STORAGE_KEY}:did:a`]: job({}),
      [`${UPLOAD_PENDING_STORAGE_KEY}:did:b`]: job({ saved: true }),
      [`${UPLOAD_PENDING_STORAGE_KEY}:did:c`]: job({ discarding: true }),
      [`${UPLOAD_PENDING_STORAGE_KEY}:did:d`]: "{not json",
      "exo.other": job({}),
    });
    const countWork = () => countLocalOnlyRecordingWork({ factory: null, storage });
    expect(await countWork()).toEqual({ saving: 1, localAudio: 0 });
    expect(await decideOriginMove({ location: legacy, countWork })).toEqual({ kind: "hold", work: { saving: 1, localAudio: 0 } });
  });

  test("an unreadable store or failing count blocks the move", async () => {
    const broken = { databases: async () => { throw new Error("denied"); } } as unknown as IDBFactory;
    expect(await countLocalOnlyRecordingWork({ factory: broken, storage: null })).toEqual({ saving: Number.POSITIVE_INFINITY, localAudio: 0 });
    expect(await decideOriginMove({ location: legacy, countWork: async () => { throw new Error("x"); } }))
      .toEqual({ kind: "hold", work: { saving: Number.POSITIVE_INFINITY, localAudio: 0 } });
  });

  /** Resolves once moveWhenClear reports a held count or replaces the location. */
  function watcher() {
    const replaced: string[] = [];
    const seen: LocalRecordingWork[] = [];
    let next = Promise.withResolvers<void>();
    const report = () => { next.resolve(); next = Promise.withResolvers<void>(); };
    return {
      replaced, seen, settled: () => next.promise,
      location: { ...legacy, replace: (url: string) => { replaced.push(url); report(); } },
      onPending: (work: LocalRecordingWork) => { seen.push(work); report(); },
      window: new EventTarget(),
      document: Object.assign(new EventTarget(), { visibilityState: "visible" as DocumentVisibilityState }),
    };
  }

  test("moveWhenClear re-checks on online and visibility, and moves to the URL of the location at move time", async () => {
    const w = watcher();
    let work: LocalRecordingWork = { saving: 1, localAudio: 0 };
    let checks = 0;
    const stop = moveWhenClear({ location: w.location, window: w.window, document: w.document, onPending: w.onPending,
      upload: () => null, countWork: async () => { checks++; return work; } });
    let settled = w.settled();
    w.window.dispatchEvent(new Event("online"));
    await settled;
    expect(w.seen).toEqual([{ saving: 1, localAudio: 0 }]);
    expect(w.replaced).toEqual([]);

    work = none;
    w.location.pathname = "/later";
    w.location.hash = "";
    settled = w.settled();
    w.document.dispatchEvent(new Event("visibilitychange"));
    await settled;
    expect(w.replaced).toEqual([`${CANONICAL_ORIGIN}/later?tab=all&x=1`]);
    w.window.dispatchEvent(new Event("online"));
    expect(checks).toBe(2);
    stop();
  });

  test("moveWhenClear never moves while this tab runs an upload", async () => {
    const w = watcher();
    let live: UploadState | null = { engine: "private-cloud", fileName: "f.m4a", stage: "transcribing", uploadPct: null,
      detail: null, audio: { stage: "stored", pct: null }, error: null, savedTitle: null, cleanupPending: false };
    const stop = moveWhenClear({ location: w.location, window: w.window, document: w.document, onPending: w.onPending,
      upload: () => live, countWork: async () => none });
    let settled = w.settled();
    w.window.dispatchEvent(new Event("online"));
    await settled;
    expect(w.seen).toEqual([{ saving: 1, localAudio: 0 }]);

    live = { ...live!, stage: "saved", audio: { stage: "storing", pct: 50 } };
    settled = w.settled();
    w.window.dispatchEvent(new Event("online"));
    await settled;
    expect(w.seen).toHaveLength(2);
    expect(w.replaced).toEqual([]);

    live = { ...live, audio: { stage: "stored", pct: null } };
    settled = w.settled();
    w.window.dispatchEvent(new Event("online"));
    await settled;
    expect(w.replaced).toEqual([canonicalUrlFor(legacy)]);
    stop();
  });

  test("moveWhenClear re-checks every 30 s and stops when asked", async () => {
    jest.useFakeTimers();
    try {
      const w = watcher();
      let checks = 0;
      const stop = moveWhenClear({ location: w.location, window: w.window, document: w.document, onPending: w.onPending,
        upload: () => null, countWork: async () => { checks++; return { saving: 0, localAudio: 2 }; } });
      jest.advanceTimersByTime(29_999);
      expect(checks).toBe(0);
      const settled = w.settled();
      jest.advanceTimersByTime(1);
      await settled;
      expect(w.seen).toEqual([{ saving: 0, localAudio: 2 }]);
      stop();
      jest.advanceTimersByTime(60_000);
      w.window.dispatchEvent(new Event("online"));
      expect(checks).toBe(1);
      expect(w.replaced).toEqual([]);
    } finally {
      jest.useRealTimers();
    }
  });
});
