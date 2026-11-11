import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { readFileSync } from "node:fs";
import agentSetup from "./agent-setup.json";
import { UPLOAD_PENDING_STORAGE_KEY, type UploadState } from "./audioUpload";
import { SAME_TAB_CODE_PARAM, SAME_TAB_ERROR_PARAM } from "./connectors/googleOAuthReturn";
import { sameTabState } from "./connectors/googleOAuthSameTab";
import { popupOAuthState } from "./connectors/googleOAuthState";
import { createHeldResultStore } from "./voiceNotes/heldResults";
import type { LocalTranscript } from "./voiceNotes/nativeVoiceNotes";
import {
  adoptNote, deleteNote, markNoteSynced, RECORDING_NOTE_LOCAL_PREFIX, RECORDING_NOTES_DB, RECORDING_NOTES_STORE, saveNote,
} from "./voiceNotes/recordingNotes";
import {
  localStorageVoiceNoteHoldStore, localStorageVoiceNotePendingStore, localStorageVoiceNotePrivateChoiceStore,
} from "./voiceNotes/voiceNoteTranscription";
import { newIdbEnv } from "./voiceNotes/web/testing/idb";
import { memoryLocks, openWebStore, recordingFromSession, type WebStore } from "./voiceNotes/web/webStore";
import {
  CANONICAL_ORIGIN, CANONICAL_VERSION_URL, canonicalServesThisBuild, LEGACY_HOSTNAME, canonicalUrlFor, countLocalOnlyRecordingWork,
  decideOriginMove, deferOriginMove, isLegacyOrigin, isOriginMoveDeferred, moveWhenClear, originMoveExemption,
  type LocalRecordingWork,
} from "./originMove";

const legacy = { hostname: "tinycloud.chat", pathname: "/notes/abc", search: "?tab=all&x=1", hash: "#share=tc1.eyJhIjoxfQ" };
const none: LocalRecordingWork = { saving: 0, localAudio: 0 };
const receipt = { sha256: "a".repeat(64), size: 4 };
const ready = async () => true;

function memoryStorage(entries: Record<string, string> = {}) {
  const map = new Map(Object.entries(entries));
  return {
    get length() { return map.size; },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value); },
    removeItem: (key: string) => { map.delete(key); },
  };
}

/** A web voice-note store with did:a signed in: its own recordings save by themselves. */
function seededStore() {
  const env = newIdbEnv();
  const open = async () => {
    const store = await openWebStore({ env, locks: memoryLocks(), now: () => 1_000_000, decodeCheck: null });
    const defaults = await store.getCaptureDefaults();
    if (defaults.accountDid !== "did:a") {
      await store.setCaptureDefaults({ ...defaults, accountDid: "did:a", transitionGen: defaults.transitionGen + 1 });
    }
    return store;
  };
  return { env, open, count: () => countLocalOnlyRecordingWork({ factory: env.factory, storage: null }) };
}

async function startRecording(store: WebStore, id: string, owner: string | null = "did:a") {
  await store.beginSession({
    id, startedAt: 1000, source: "in_app", owner, transitionGen: 0,
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

/** A recording whose row and verified audio are in the space: on its own it keeps nobody here. */
async function savedInSpace(store: WebStore, id: string) {
  await startRecording(store, id);
  const note = await commit(store, id);
  return store.updateLedger({ id, did: "did:a", rev: note.rev!, patch: {
    audio: { state: "saved", rowId: `row-${id}`, at: 2000, verifiedInSpace: receipt },
  } });
}

/** The page's existing IndexedDB database `name`, with `rows` put into `store` (keyPath `keyPath`). */
async function seedDatabase(factory: IDBFactory, name: string, store: string, keyPath: string, rows: unknown[]) {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const open = factory.open(name, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(store, { keyPath });
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    for (const row of rows) tx.objectStore(store).put(row);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
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
    expect(await decideOriginMove({ location: legacy, canonicalReady: ready,
      countWork: () => countLocalOnlyRecordingWork({ factory: env.factory, storage: null }) }))
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
    const decide = () => decideOriginMove({ location: legacy, countWork: count, canonicalReady: ready });
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

  /** Records what moveWhenClear reports (a notice's count, or the move); `reported(n)` waits for the n-th report. */
  function watcher() {
    const replaced: string[] = [];
    const seen: LocalRecordingWork[] = [];
    let waiters: { count: number; resolve: () => void }[] = [];
    const total = () => replaced.length + seen.length;
    const report = () => {
      for (const waiter of waiters) if (total() >= waiter.count) waiter.resolve();
      waiters = waiters.filter((waiter) => total() < waiter.count);
    };
    return {
      replaced, seen,
      reported: (count: number) => {
        const { promise, resolve } = Promise.withResolvers<void>();
        waiters.push({ count, resolve });
        report();
        return promise;
      },
      location: { ...legacy, replace: (url: string) => { replaced.push(url); report(); } },
      onPending: (work: LocalRecordingWork) => { seen.push(work); report(); },
      window: new EventTarget(),
      document: Object.assign(new EventTarget(), { visibilityState: "visible" as DocumentVisibilityState }),
      opener: false,
    };
  }

  test("moveWhenClear checks at once, re-checks on online and visibility, and moves to the URL of the location at move time", async () => {
    const w = watcher();
    let work: LocalRecordingWork = { saving: 1, localAudio: 0 };
    let checks = 0;
    const stop = moveWhenClear({ location: w.location, window: w.window, document: w.document, onPending: w.onPending,
      opener: w.opener, canonicalReady: ready, upload: () => null, countWork: async () => { checks++; return work; } });
    await w.reported(1);
    expect(w.seen).toEqual([{ saving: 1, localAudio: 0 }]);
    w.window.dispatchEvent(new Event("online"));
    await w.reported(2);
    expect(w.seen).toHaveLength(2);
    expect(w.replaced).toEqual([]);

    work = none;
    w.location.pathname = "/later";
    w.location.hash = "";
    w.document.dispatchEvent(new Event("visibilitychange"));
    await w.reported(3);
    expect(w.replaced).toEqual([`${CANONICAL_ORIGIN}/later?tab=all&x=1`]);
    w.window.dispatchEvent(new Event("online"));
    expect(checks).toBe(3);
    stop();
  });

  test("moveWhenClear never moves while this tab runs an upload", async () => {
    const w = watcher();
    let live: UploadState | null = { engine: "private-cloud", fileName: "f.m4a", stage: "transcribing", uploadPct: null,
      detail: null, audio: { stage: "stored", pct: null }, error: null, savedTitle: null, cleanupPending: false };
    const stop = moveWhenClear({ location: w.location, window: w.window, document: w.document, onPending: w.onPending,
      opener: w.opener, canonicalReady: ready, upload: () => live, countWork: async () => none });
    await w.reported(1);
    expect(w.seen).toEqual([{ saving: 1, localAudio: 0 }]);

    live = { ...live!, stage: "saved", audio: { stage: "storing", pct: 50 } };
    w.window.dispatchEvent(new Event("online"));
    await w.reported(2);
    expect(w.seen).toEqual([{ saving: 1, localAudio: 0 }, { saving: 1, localAudio: 0 }]);
    expect(w.replaced).toEqual([]);

    live = { ...live, audio: { stage: "stored", pct: null } };
    w.window.dispatchEvent(new Event("online"));
    await w.reported(3);
    expect(w.replaced).toEqual([canonicalUrlFor(legacy)]);
    stop();
  });

  test("moveWhenClear re-checks every 30 s while something is saving, not while only audio kept here holds the visitor", async () => {
    jest.useFakeTimers();
    try {
      const w = watcher();
      let work: LocalRecordingWork = { saving: 1, localAudio: 0 };
      let checks = 0;
      const stop = moveWhenClear({ location: w.location, window: w.window, document: w.document, onPending: w.onPending,
        opener: w.opener, canonicalReady: ready, upload: () => null, countWork: async () => { checks++; return work; } });
      await w.reported(1);
      jest.advanceTimersByTime(29_999);
      expect(checks).toBe(1);
      jest.advanceTimersByTime(1);
      await w.reported(2);
      expect(checks).toBe(2);

      // Audio kept only here: the visitor stays, so the timer stops reading storage; events still re-check.
      work = { saving: 0, localAudio: 2 };
      jest.advanceTimersByTime(30_000);
      await w.reported(3);
      expect(w.seen.at(-1)).toEqual({ saving: 0, localAudio: 2 });
      jest.advanceTimersByTime(120_000);
      expect(checks).toBe(3);
      work = { saving: 1, localAudio: 2 };
      w.window.dispatchEvent(new Event("online"));
      await w.reported(4);
      jest.advanceTimersByTime(30_000);
      await w.reported(5);
      expect(checks).toBe(5);

      stop();
      jest.advanceTimersByTime(60_000);
      w.window.dispatchEvent(new Event("online"));
      expect(checks).toBe(5);
      expect(w.replaced).toEqual([]);
    } finally {
      jest.useRealTimers();
    }
  });

  test("an old-origin same-tab Google return stays, so its page can read its verifier; ordinary URLs still move", async () => {
    let reads = 0;
    const countWork = async () => { reads++; return none; };
    const decide = (search: string, pathname = "/chat/connectors") =>
      decideOriginMove({ location: { ...legacy, pathname, search, hash: "" }, countWork, canonicalReady: ready });
    const tab = sameTabState("/chat/connectors", "n".repeat(24), false);
    expect(tab.startsWith("tab.")).toBe(true);
    for (const search of [
      `?${new URLSearchParams({ state: tab, [SAME_TAB_CODE_PARAM]: "code" })}`,
      `?${new URLSearchParams({ state: tab, [SAME_TAB_ERROR_PARAM]: "not_completed" })}`,
      `?${new URLSearchParams({ state: sameTabState("/chat", "n".repeat(24), true), [SAME_TAB_CODE_PARAM]: "code" })}`,
    ]) {
      expect(originMoveExemption({ pathname: "/chat/connectors", search }, false)).toBe("oauth-return");
      expect(await decide(search)).toEqual({ kind: "stay" });
    }
    expect(reads).toBe(0);
    // A started flow's state without the backend's return markers, or a popup state (its return is the backend's
    // own /callback page, never this app), is an ordinary URL.
    for (const search of [`?state=${tab}`, `?${new URLSearchParams({ state: popupOAuthState("n".repeat(24), false), code: "c" })}`, "?tab=all"]) {
      expect(originMoveExemption({ pathname: "/chat", search }, false)).toBeNull();
      expect((await decide(search)).kind).toBe("move");
    }
  });

  test("a popup window stays where its opener can hear it", async () => {
    let reads = 0;
    const countWork = async () => { reads++; return none; };
    expect(await decideOriginMove({ location: legacy, opener: true, canonicalReady: ready, countWork })).toEqual({ kind: "stay" });
    expect(originMoveExemption(legacy, true)).toBe("popup");
    expect(reads).toBe(0);
  });

  test("the published /agents setup page and tarball links are never moved", async () => {
    const published = [
      agentSetup.setupUrl,
      ...readFileSync(new URL("../../public/agents/setup.md", import.meta.url), "utf8").match(/https:\/\/tinycloud\.chat\/agents\/\S+/g)!,
    ].map((url) => new URL(url));
    expect(published.length).toBeGreaterThan(1);
    expect(published.some((url) => url.pathname.endsWith(".tgz"))).toBe(true);
    for (const url of [...published, new URL("https://tinycloud.chat/agents"), new URL("https://tinycloud.chat/agents/setup.md")]) {
      expect(url.hostname).toBe("tinycloud.chat");
      expect(originMoveExemption(url, false)).toBe("agents");
      expect(await decideOriginMove({ location: url, canonicalReady: ready, countWork: async () => none })).toEqual({ kind: "stay" });
    }
    for (const pathname of ["/agentsx", "/chat/agents"]) expect(originMoveExemption({ pathname, search: "" }, false)).toBeNull();
  });

  test("the move waits until home.tinycloud.xyz serves this build", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const serving = (body: unknown, status = 200) => async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify(body), { status });
    };
    const check = (fetch: unknown, commit: string | null = "abc123") =>
      canonicalServesThisBuild({ fetch: fetch as typeof globalThis.fetch, commit, timeoutMs: 20 });
    expect(await check(serving({ commit: "abc123" }))).toBe(true);
    expect(calls[0]).toMatchObject({ url: CANONICAL_VERSION_URL, init: { cache: "no-store", credentials: "omit" } });
    expect(await check(serving({ commit: "older" }))).toBe(false);
    expect(await check(serving({}))).toBe(false);
    expect(await check(serving({ commit: "abc123" }, 404))).toBe(false);
    expect(await check(async () => { throw new TypeError("Failed to fetch"); })).toBe(false);
    expect(await check(async () => new Response("<!doctype html>"))).toBe(false);
    // Never answers: the timeout aborts it.
    expect(await check((_url: string, init: RequestInit) => new Promise((_resolve, reject) =>
      init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))))).toBe(false);
    const before = calls.length;
    expect(await check(serving({ commit: null }), null)).toBe(false);
    expect(calls.length).toBe(before);

    // Nothing local is left, yet the visitor stays (no notice) until the canonical origin serves this build.
    expect(await decideOriginMove({ location: legacy, countWork: async () => none, canonicalReady: async () => false }))
      .toEqual({ kind: "stay" });
    expect(await decideOriginMove({ location: legacy, countWork: async () => none, canonicalReady: async () => { throw new Error("x"); } }))
      .toEqual({ kind: "stay" });
    let asked = 0;
    expect(await decideOriginMove({ location: legacy, countWork: async () => ({ saving: 1, localAudio: 0 }),
      canonicalReady: async () => { asked++; return true; } })).toEqual({ kind: "hold", work: { saving: 1, localAudio: 0 } });
    expect(asked).toBe(0);
  });

  test("a held page shows no notice until home.tinycloud.xyz serves this build, and clears it while the move is blocked", async () => {
    const w = watcher();
    let servesThisBuild = false;
    let work: LocalRecordingWork = { saving: 1, localAudio: 0 };
    const stop = moveWhenClear({ location: w.location, window: w.window, document: w.document, onPending: w.onPending,
      opener: false, upload: () => null, countWork: async () => work, canonicalReady: async () => servesThisBuild });
    // Between the deploy and the domain move the notice would promise a move that cannot happen yet.
    await w.reported(1);
    w.window.dispatchEvent(new Event("online"));
    await w.reported(2);
    expect(w.seen).toEqual([none, none]);

    servesThisBuild = true;
    w.window.dispatchEvent(new Event("online"));
    await w.reported(3);
    expect(w.seen.at(-1)).toEqual({ saving: 1, localAudio: 0 });

    // Saved, but the build check fails this time: no stale count is left on screen, and no move.
    servesThisBuild = false;
    work = none;
    w.window.dispatchEvent(new Event("online"));
    await w.reported(4);
    expect(w.seen.at(-1)).toEqual(none);
    expect(w.replaced).toEqual([]);

    servesThisBuild = true;
    w.window.dispatchEvent(new Event("online"));
    await w.reported(5);
    expect(w.replaced).toEqual([canonicalUrlFor(legacy)]);
    stop();
  });

  test("a held page never moves while something defers it, clears its count, and moves once the last deferral ends", async () => {
    const w = watcher();
    let work: LocalRecordingWork = { saving: 1, localAudio: 0 };
    const stop = moveWhenClear({ location: w.location, window: w.window, document: w.document, onPending: w.onPending,
      opener: false, upload: () => null, countWork: async () => work, canonicalReady: ready });
    await w.reported(1);
    expect(w.seen).toEqual([{ saving: 1, localAudio: 0 }]);

    const chatDraft = deferOriginMove();
    const noteEdit = deferOriginMove();
    expect(isOriginMoveDeferred()).toBe(true);
    work = none;
    w.window.dispatchEvent(new Event("online"));
    await w.reported(2);
    expect(w.seen.at(-1)).toEqual(none);
    expect(w.replaced).toEqual([]);
    chatDraft();
    chatDraft();
    expect(isOriginMoveDeferred()).toBe(true);

    // The last release is enough: nothing else is dispatched.
    noteEdit();
    await w.reported(3);
    expect(isOriginMoveDeferred()).toBe(false);
    expect(w.replaced).toEqual([canonicalUrlFor(legacy)]);
    stop();
  });

  test("every build publishes version.json, and home.tinycloud.xyz lets tinycloud.chat read it uncached", () => {
    const vite = readFileSync(new URL("../../vite.config.ts", import.meta.url), "utf8");
    const plugin = vite.slice(vite.indexOf('name: "tinychat-version-json"'));
    expect(plugin).toContain('fileName: "version.json"');
    expect(plugin).toContain("JSON.stringify({ commit: exoBuildInfo.commit ?? null })");
    expect(vite).toContain("__EXO_BUILD_INFO__: JSON.stringify({ ...exoBuildInfo,");
    expect(new URL(CANONICAL_VERSION_URL).pathname).toBe("/version.json");
    const headers = readFileSync(new URL("../../public/_headers", import.meta.url), "utf8");
    const rule = headers.slice(headers.indexOf("\n/version.json\n") + 1).split(/\n(?=\S)/)[0]!;
    expect(rule).toContain("Cache-Control: no-store");
    expect(rule).toContain(`Access-Control-Allow-Origin: https://${LEGACY_HOSTNAME}`);
  });

  test("a held transcript holds the move even when the note's audio is in the space, for every account", async () => {
    const { env, open, count } = seededStore();
    const store = await open();
    await savedInSpace(store, "note-a");
    expect(await count()).toEqual(none);
    const hold = (did: string, sourceId: string) => createHeldResultStore(did, { env, isSignedIn: async () => true }).hold({
      version: 1, did, spaceId: "space-a", sourceId, engine: "private-cloud",
      transcript: { rev: 2, sentences: [{ index: 0, text: "only here", speaker_name: "Speaker 1", start_time: 0, end_time: 1 }],
        metadata: {}, speakers: [] },
      provider: null, intent: { kind: "unknown" },
    });
    await hold("did:a", "note-a");
    expect(await count()).toEqual({ saving: 1, localAudio: 0 });
    // Another account's row (its sign-out clears it, heldResults.ts `clearHeldResultsForSignOut`, unless that failed) counts too.
    await hold("did:b", "note-b");
    expect(await count()).toEqual({ saving: 2, localAudio: 0 });
    store.close();
  });

  test("a transcript made in this browser holds the move until the ledger records it saved", async () => {
    const { open, count } = seededStore();
    const store = await open();
    const { rev } = await savedInSpace(store, "note-a");
    const transcript: LocalTranscript = { version: 2, noteId: "note-a", transcriber: "on-device", rev: 1,
      engine: "whispercpp", model: null, language: "en", outcome: "transcribed", diarized: false,
      segments: [{ start: 0, end: 1000, text: "only here", speaker: null }] };
    await store.putTranscript({ id: "note-a", transcript });
    expect(await count()).toEqual({ saving: 1, localAudio: 0 });
    await store.updateLedger({ id: "note-a", did: "did:a", rev, patch: { transcriptSync: { state: "saved", rev: 1, at: 3000 } } });
    expect(await count()).toEqual(none);
    // A hosted transcript is held through its remote op instead (localWork.ts), so the copy alone keeps nobody here.
    await store.putTranscript({ id: "note-a", transcript: { ...transcript, transcriber: "assemblyai", engine: "assemblyai", rev: 2 } });
    expect(await count()).toEqual(none);
    store.close();
  });

  describe("note Markdown", () => {
    let previous: PropertyDescriptor | undefined;
    let storage = memoryStorage();
    beforeEach(() => {
      storage = memoryStorage();
      previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
      Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
    });
    afterEach(() => {
      if (previous) Object.defineProperty(globalThis, "localStorage", previous);
      else Reflect.deleteProperty(globalThis, "localStorage");
    });

    test("an edit holds the move until the space acknowledges its revision, for every account and unclaimed", async () => {
      expect(typeof indexedDB).toBe("undefined"); // recordingNotes.ts keeps notes in localStorage here.
      const count = () => countLocalOnlyRecordingWork({ factory: null, storage });
      const typed = await saveNote("note-1", "typed while recording", { owner: "did:a" });
      expect(await count()).toEqual({ saving: 1, localAudio: 0 });
      await markNoteSynced("note-1", "did:a", typed.revision);
      expect(await count()).toEqual(none);
      const edited = await saveNote("note-1", "edited after the sync", { owner: "did:a" });
      expect(await count()).toEqual({ saving: 1, localAudio: 0 });
      // An acknowledgement of an older revision never covers the newer edit.
      await markNoteSynced("note-1", "did:a", typed.revision);
      expect(await count()).toEqual({ saving: 1, localAudio: 0 });
      await markNoteSynced("note-1", "did:a", edited.revision);
      expect(await count()).toEqual(none);

      // Another account's text and a signed-out recording's text are kept for them, so they count too.
      await saveNote("note-b", "the other account's edit", { owner: "did:b" });
      await saveNote("note-unclaimed", "typed while signed out", { owner: null });
      await saveNote("note-empty", "   ", { owner: "did:a" });
      expect(await count()).toEqual({ saving: 2, localAudio: 0 });

      // The same records in IndexedDB (the browser's normal store) count the same way.
      const env = newIdbEnv();
      const rows = [...Array(storage.length).keys()].map((i) => storage.key(i)!).filter((key) => key.startsWith(RECORDING_NOTE_LOCAL_PREFIX))
        .map((key) => ({ ...JSON.parse(storage.getItem(key)!) as object, storageId: key.slice(RECORDING_NOTE_LOCAL_PREFIX.length) }));
      expect(rows).toHaveLength(4);
      await seedDatabase(env.factory, RECORDING_NOTES_DB, RECORDING_NOTES_STORE, "storageId", rows);
      expect(await countLocalOnlyRecordingWork({ factory: env.factory, storage: null })).toEqual({ saving: 2, localAudio: 0 });
    });

    test("a note adopted from the space keeps nobody here; an unsynced local edit stays counted through an adopt", async () => {
      // #638's real adoptNote (recordingNotes.ts): the adopted copy is stored with its revision acknowledged.
      const count = () => countLocalOnlyRecordingWork({ factory: null, storage });
      const at = "2026-11-01T00:00:00.000Z";
      const remote = (recordingId: string, savedEditAt: string | null = null) =>
        ({ recordingId, md: "from another device", moments: [], createdAt: at, editedAt: savedEditAt ?? at, savedEditAt, revision: 3 });
      await adoptNote(remote("remote-1"), "did:a");
      await adoptNote(remote("remote-unclaimed"), null);
      expect(await count()).toEqual(none);
      await saveNote("remote-1", "edited here", { owner: "did:a" });
      expect(await count()).toEqual({ saving: 1, localAudio: 0 });

      // A local edit made before the space copy arrives is not covered by adopting that copy, even when the
      // space's saved-edit time is newer and gets taken over.
      await saveNote("local-first", "typed here first", { owner: "did:a" });
      await adoptNote(remote("local-first", "2026-11-02T00:00:00.000Z"), "did:a");
      expect(await count()).toEqual({ saving: 2, localAudio: 0 });
    });

    test("a discarded note keeps nobody here", async () => {
      const count = () => countLocalOnlyRecordingWork({ factory: null, storage });
      await saveNote("gone-1", "typed", { owner: "did:a" });
      expect(await count()).toEqual({ saving: 1, localAudio: 0 });
      await deleteNote("gone-1", "did:a");
      expect(await count()).toEqual(none);
    });

    test("an id-only note from before account binding counts only while its recording is here to re-sync it", async () => {
      const at = "2026-11-01T00:00:00.000Z";
      const legacyNote = (recordingId: string) => ({ recordingId, storageId: recordingId, md: "old", createdAt: at, editedAt: at,
        savedEditAt: null, revision: 1 });
      const { env, open } = seededStore();
      const store = await open();
      await savedInSpace(store, "local-1");
      await seedDatabase(env.factory, RECORDING_NOTES_DB, RECORDING_NOTES_STORE, "storageId",
        [legacyNote("local-1"), legacyNote("elsewhere-1")]);
      expect(await countLocalOnlyRecordingWork({ factory: env.factory, storage: null })).toEqual({ saving: 1, localAudio: 0 });
      store.close();
    });
  });

  test("recordings that are unclaimed or bound to an account not signed in here keep the visitor, not as saving", async () => {
    const { open, count } = seededStore();
    const store = await open();
    await startRecording(store, "mine");
    await commit(store, "mine");
    await startRecording(store, "unclaimed", null);
    await commit(store, "unclaimed");
    await startRecording(store, "theirs", "did:b");
    await commit(store, "theirs");
    // A live capture is saving whoever owns it.
    await startRecording(store, "live", null);
    expect(await count()).toEqual({ saving: 2, localAudio: 2 });

    // Signed out: did:a's recording is kept for did:a, so it no longer saves by itself here.
    const defaults = await store.getCaptureDefaults();
    await store.setCaptureDefaults({ ...defaults, accountDid: null, transitionGen: defaults.transitionGen + 1 });
    expect(await count()).toEqual({ saving: 1, localAudio: 3 });
    store.close();
  });

  test("a Private transcription job holds the move until its transcript is in the space", async () => {
    const storage = memoryStorage();
    const jobs = localStorageVoiceNotePendingStore("did:a", storage);
    const count = () => countLocalOnlyRecordingWork({ factory: null, storage });
    jobs.write("running", { attemptId: "a1", transcriptionId: "t1" });
    expect(await count()).toEqual({ saving: 1, localAudio: 0 });
    const held = { rev: 1, sentences: [{ index: 0, text: "only here", speaker_name: "Speaker 1", start_time: 0, end_time: 1 }],
      speakers: ["Speaker 1"], metadata: {} };
    jobs.write("held", { attemptId: "a2", transcriptionId: "t2", held, failure: "transcript_save_failed" });
    jobs.write("retrying", { attemptId: "a3", transcriptionId: null, failure: "offline" });
    jobs.write("failed", { attemptId: "a4", transcriptionId: "t4", failure: "transcription_failed" });
    localStorageVoiceNotePendingStore("did:b", storage).write("other-account", { attemptId: "b1", transcriptionId: null });
    expect(await count()).toEqual({ saving: 4, localAudio: 0 });
    jobs.clear("running");
    expect(await count()).toEqual({ saving: 3, localAudio: 0 });
  });

  test("markers whose underlying work is elsewhere hold nothing by themselves", async () => {
    // A Private choice, a shortcut hold and a pending-save status name a note; the note and its job are what count.
    const storage = memoryStorage();
    expect(localStorageVoiceNotePrivateChoiceStore("did:a", storage).add("note-a")).toBe(true);
    localStorageVoiceNoteHoldStore("did:a", storage).write({ "note-a": "held", "note-b": "released" });
    const { env, open } = seededStore();
    const store = await open();
    await savedInSpace(store, "note-a");
    await seedDatabase(env.factory, "exo-pending-save-state", "notes", "key",
      [{ key: JSON.stringify(["did:a", "note-a"]), id: "note-a", failed: { kind: "offline", message: "Offline" } }]);
    expect(await countLocalOnlyRecordingWork({ factory: env.factory, storage })).toEqual(none);
    store.close();
  });
});
