import { afterEach, beforeEach, expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import { VoiceNotes, __setVoiceNotesForTests, type VoiceNoteRecording, type VoiceNotesPlugin } from "./nativeVoiceNotes";
import { mountVoiceNoteAccount } from "./accountContext";
import { localStorageVoiceNotePendingStore, localStorageVoiceNotePrivateChoiceStore } from "./voiceNoteTranscription";
import { cachedAudioSize, cachedSpaceAudio, cachedSpaceAudioOffline, clearCachedAudio,
  latestSpaceAudioIdentity, localPlaybackUrl, observeSpaceAudioIdentity, trimCachedAudio } from "./audioPlaybackCache";
import { retainSource } from "./sourcePins";

const original = VoiceNotes;
const originalIdb = globalThis.indexedDB;
const saved = (id: string, state: "saved" | "pending"): VoiceNoteRecording => ({
  id, owner: "did:test", startedAt: 1, durationMs: 1000, mimeType: "audio/mp4", sizeBytes: 40,
  silencedMs: 0, silencedEvents: 0, noSignalMs: 0,
  ledger: { audio: { state, rowId: state === "saved" ? "row" : null, at: 1,
    ...(state === "saved" ? { verifiedInSpace: { sha256: "a".repeat(64), size: 40 } } : {}) },
  } as VoiceNoteRecording["ledger"],
});

let notes: VoiceNoteRecording[];
let sizes: Map<string, number>;
let evicted: string[];
let unmountAccount: () => void;
const originalStorage = (globalThis as typeof globalThis & { localStorage?: Storage }).localStorage;
let testStorage: ReturnType<typeof memoryStorage>;
beforeEach(() => {
  unmountAccount = mountVoiceNoteAccount("did:test");
  testStorage = memoryStorage();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: testStorage });
  globalThis.indexedDB = new IDBFactory() as unknown as IDBFactory;
  notes = [];
  sizes = new Map();
  evicted = [];
  __setVoiceNotesForTests({
    listPending: async () => ({ recordings: notes }),
    localAudioSize: async ({ id }: { id: string }) => ({ size: sizes.get(id) ?? 0 }),
    evictCachedAudio: async ({ id }: { id: string }) => {
      if (notes.find((note) => note.id === id)?.ledger?.audio.state !== "saved") throw new Error("not space backed");
      sizes.set(id, 0); evicted.push(id);
    },
  } as unknown as VoiceNotesPlugin, { available: true });
});
afterEach(() => {
  globalThis.indexedDB = originalIdb;
  unmountAccount();
  __setVoiceNotesForTests(original, { available: null });
  if (originalStorage === undefined) Reflect.deleteProperty(globalThis, "localStorage");
  else Object.defineProperty(globalThis, "localStorage", { configurable: true, value: originalStorage });
});

test("a complete first download is reused without a second space read", async () => {
  let reads = 0;
  const load = async () => { reads++; return new Blob(["complete audio"], { type: "audio/mp4" }); };
  expect((await cachedSpaceAudio("space", "did", "exo-voice-note", "a", "rev-1", load))?.size).toBe(14);
  expect((await cachedSpaceAudio("space", "did", "exo-voice-note", "a", "rev-1", load))?.size).toBe(14);
  expect(reads).toBe(1);
});

test("a failed or aborted download leaves no cache entry", async () => {
  const broken = async (): Promise<Blob> => { throw new Error("part 2 failed"); };
  await expect(cachedSpaceAudio("space", "did", "exo-voice-note", "partial", "rev-1", broken)).rejects.toThrow("part 2 failed");
  const controller = new AbortController();
  controller.abort();
  await cachedSpaceAudio("space", "did", "exo-voice-note", "aborted", "rev-1", async () => new Blob(["bytes"]), controller.signal);
  expect((await cachedAudioSize()).bytes).toBe(0);
});

test("trim and Clear remove playback copies while all local recordings remain", async () => {
  const localOnly = saved("local-only", "saved");
  delete localOnly.ledger!.audio.verifiedInSpace;
  notes = [saved("uploaded", "saved"), localOnly, saved("pending", "pending")];
  sizes.set("uploaded", 40);
  sizes.set("local-only", 40);
  sizes.set("pending", 40);
  await cachedSpaceAudio("space", "did", "exo-voice-note", "downloaded", "rev-1", async () => new Blob(["remote"]));
  expect((await cachedAudioSize()).bytes).toBe(6);
  await trimCachedAudio(5);
  expect(evicted).toEqual([]);
  expect(sizes.get("local-only")).toBe(40);
  expect(sizes.get("pending")).toBe(40);
  await cachedSpaceAudio("space", "did", "exo-voice-note", "again", "rev-1", async () => new Blob(["remote"]));
  await clearCachedAudio();
  expect((await cachedAudioSize()).bytes).toBe(0);
  expect((await cachedAudioSize()).pinnedBytes).toBe(120);
  expect(sizes.get("uploaded")).toBe(40);
  expect(sizes.get("local-only")).toBe(40);
  expect(sizes.get("pending")).toBe(40);
});

test("trim never selects local recordings regardless of local work state", async () => {
  const withLedger = (id: string, patch: Record<string, unknown>): VoiceNoteRecording => {
    const note = saved(id, "saved");
    return { ...note, ledger: { ...note.ledger!, ...patch } } as VoiceNoteRecording;
  };
  notes = [
    withLedger("importing", { localAudio: { state: "preparing", error: null } }),
    { ...withLedger("transcribing", {}), stt: { state: "queued" }, options: { uploadAudio: false, transcriber: "on-device" } } as VoiceNoteRecording,
    withLedger("hosted", { remote: [{ opId: "op", provider: "assemblyai", mode: "hosted", stage: "submitted", cleanup: "none" }] }),
    withLedger("finished", { remote: [{ opId: "op", provider: "assemblyai", mode: "hosted", stage: "done", cleanup: "done" }] }),
    saved("uploaded", "saved"),
  ];
  for (const note of notes) sizes.set(note.id, 40);
  await trimCachedAudio(0);
  expect(evicted).toEqual([]);
});

test("a note whose local audio is still importing or failed to import is a cache miss", async () => {
  for (const code of ["audio_preparing", "audio_preparation_failed"]) {
    __setVoiceNotesForTests({
      localAudioUrl: async () => { throw Object.assign(new Error(code), { code }); },
    } as unknown as VoiceNotesPlugin, { available: true });
    expect(await localPlaybackUrl("importing")).toBeNull();
  }
});

test("a replacement with a new manifest identity plays its new bytes", async () => {
  let reads = 0;
  const first = await cachedSpaceAudio("space", "did", "exo-voice-note", "same", "hash-1", async () => {
    reads++; return new Blob(["old"]);
  });
  const second = await cachedSpaceAudio("space", "did", "exo-voice-note", "same", "hash-2", async () => {
    reads++; return new Blob(["new"]);
  });
  expect(await first!.text()).toBe("old");
  expect(await second!.text()).toBe("new");
  expect(reads).toBe(2);
  expect((await cachedAudioSize()).bytes).toBe(3);
});

test("a failed replacement download persists its identity and cannot replay the old cache", async () => {
  const scope = ["space", "did", "exo-voice-note", "same"] as const;
  await cachedSpaceAudio(...scope, "rev-1", async () => new Blob(["old"]));
  await expect(cachedSpaceAudio(...scope, "rev-2", async () => { throw new Error("download failed"); }))
    .rejects.toThrow("download failed");
  expect((await latestSpaceAudioIdentity(...scope))?.identity).toBe("rev-2");
  expect(await cachedSpaceAudioOffline(...scope)).toBeNull();
  expect((await cachedAudioSize()).bytes).toBe(3); // The old bytes remain stored.
});

test("an explicitly uploaded note joins the bounded cache after verification", async () => {
  notes = [{ ...saved("explicit", "saved"), options: { uploadAudio: false } as VoiceNoteRecording["options"] }];
  sizes.set("explicit", 40);
  expect((await cachedAudioSize()).bytes).toBe(0);
  expect((await cachedAudioSize()).pinnedBytes).toBe(40);
  await trimCachedAudio(0);
  expect(evicted).toEqual([]);
});

test("a failing device cache never blocks space playback or an offline lookup", async () => {
  globalThis.indexedDB = { open: () => { throw new DOMException("disk full", "QuotaExceededError"); } } as unknown as IDBFactory;
  const blob = await cachedSpaceAudio("space", "did", "exo-voice-note", "a", "rev-1", async () => new Blob(["fresh"]));
  expect(await blob!.text()).toBe("fresh");
  expect(await latestSpaceAudioIdentity("space", "did", "exo-voice-note", "a")).toBeUndefined();
  expect(await cachedSpaceAudioOffline("space", "did", "exo-voice-note", "a")).toBeNull();
});

test("trim and Clear drop identities whose bytes left the device, so offline is a plain miss", async () => {
  const scope = ["space", "did", "exo-voice-note", "played"] as const;
  await cachedSpaceAudio(...scope, "rev-1", async () => new Blob(["bytes"]));
  await trimCachedAudio(0);
  expect(await latestSpaceAudioIdentity(...scope)).toBeUndefined();
  expect(await cachedSpaceAudioOffline(...scope)).toBeNull();
  await cachedSpaceAudio(...scope, "rev-2", async () => new Blob(["again"]));
  await clearCachedAudio();
  expect(await latestSpaceAudioIdentity(...scope)).toBeUndefined();
  expect(await cachedSpaceAudioOffline(...scope)).toBeNull();
});

test("playback identity is pruned when its downloaded blob is cleared, even if local audio remains", async () => {
  notes = [saved("local", "pending")];
  sizes.set("local", 40);
  const scope = ["space", "did", "exo-voice-note", "local"] as const;
  await observeSpaceAudioIdentity(...scope, "rev-1");
  await cachedSpaceAudio(...scope, "rev-1", async () => new Blob(["remote"]));
  await trimCachedAudio(0);
  expect(await latestSpaceAudioIdentity(...scope)).toBeUndefined();
  expect(await cachedSpaceAudioOffline(...scope)).toBeNull();
  expect(sizes.get("local")).toBe(40);
});

test("local recording bytes stay retained for signed-in and signed-out accounts", async () => {
  notes = [saved("mine", "saved"), { ...saved("theirs", "saved"), owner: "did:test:other" }];
  sizes.set("mine", 40);
  sizes.set("theirs", 40);
  await trimCachedAudio(0);
  expect((await cachedAudioSize()).pinnedBytes).toBe(80);
  expect(sizes.get("mine")).toBe(40);
  expect(sizes.get("theirs")).toBe(40);
  unmountAccount();
  await trimCachedAudio(0);
  expect(sizes.get("mine")).toBe(40);
  expect(sizes.get("theirs")).toBe(40);
});

// Pin tests exercise the durable PTX and consent stores consumed by trim and Clear.

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

for (const operation of ["trim", "clear"] as const) {
  const evict = () => operation === "trim" ? trimCachedAudio(0) : clearCachedAudio();

  test(`TC-1182 P1/P2 ${operation} keeps an awaiting-upload job without a ledger remote op`, async () => {
    const note = saved("private-awaiting", "saved");
    notes = [note];
    sizes.set(note.id, 40);
    localStorageVoiceNotePendingStore("did:test", testStorage).write(note.id, {
      attemptId: "attempt-1", transcriptionId: "ptx-1",
    });

    await evict();

    expect(sizes.get(note.id)).toBe(40);
  });

  test(`TC-1182 P3 ${operation} keeps the source while a held result is pending`, async () => {
    const note = saved("private-held", "saved");
    notes = [note];
    sizes.set(note.id, 40);
    localStorageVoiceNotePendingStore("did:test", testStorage).write(note.id, {
      attemptId: "attempt-2", transcriptionId: "ptx-2",
      held: { rev: 2, sentences: [], speakers: [], metadata: {} } as never,
    });

    await evict();

    expect(sizes.get(note.id)).toBe(40);
  });

  test(`TC-1182 P6 ${operation} keeps a source selected for Private without a remote job`, async () => {
    const note = saved("private-choice", "saved");
    notes = [note];
    sizes.set(note.id, 40);
    localStorageVoiceNotePrivateChoiceStore("did:test", testStorage).add(note.id);

    await evict();

    expect(sizes.get(note.id)).toBe(40);
  });

  test(`TC-1182 P8 ${operation} keeps a terminal marker source available for Retry`, async () => {
    const note = saved("private-terminal", "saved");
    notes = [note];
    sizes.set(note.id, 40);
    localStorageVoiceNotePendingStore("did:test", testStorage).write(note.id, {
      attemptId: "attempt-3", transcriptionId: null, failure: "transcript_incomplete",
    });

    await evict();

    expect(sizes.get(note.id)).toBe(40);
  });
}
test("TC-1182 Clear removes playback candidates and reports all retained local bytes", async () => {
  const active = saved("active", "saved");
  const free = saved("free", "saved");
  notes = [active, free];
  sizes.set(active.id, 40);
  sizes.set(free.id, 40);
  localStorageVoiceNotePendingStore("did:test", testStorage).write(active.id, {
    attemptId: "active-attempt", transcriptionId: "ptx-active",
  });

  const report = await clearCachedAudio();

  expect(evicted).toEqual([]);
  expect(report).toMatchObject({ cleared: 0, inUse: 2, pinnedBytes: 80 });
  expect((await cachedAudioSize()).pinnedBytes).toBe(80);
});

for (const operation of ["trim", "clear"] as const) {
  for (const offline of [false, true]) {
    for (const pinKind of ["terminal", "held"] as const) {
      test(`TC-1182 ${pinKind} marker local audio remains after 30 days; ${operation}, offline=${offline}`, async () => {
        const originalNow = Date.now;
        let now = new Date("2026-01-01T00:00:00.000Z").getTime();
        Date.now = () => now;
        try {
          const id = `permanent-${operation}-${offline}-${pinKind}`;
          notes = [saved(id, "saved")];
          sizes.set(id, 40);
          localStorageVoiceNotePendingStore("did:test", testStorage).write(id, {
            attemptId: "permanent-attempt", transcriptionId: null,
            ...(pinKind === "terminal" ? { failure: "transcript_incomplete" } : {}),
            ...(pinKind === "held" ? { held: { rev: 2, sentences: [], speakers: [], metadata: {} } as never } : {}),
          });
          const evict = () => operation === "trim" ? trimCachedAudio(0) : clearCachedAudio();
          await evict();
          now = new Date("2026-02-01T00:00:00.001Z").getTime();
          await evict();
          expect(sizes.get(id)).toBe(40);
        } finally {
          Date.now = originalNow;
        }
      });
    }
  }
  for (const offline of [false, true]) {
    test(`TC-1182 ordinary Private choice stays pinned past 30 days with ${operation}, offline=${offline}`, async () => {
      const originalNow = Date.now;
      let now = new Date("2026-01-01T00:00:00.000Z").getTime();
      Date.now = () => now;
      try {
        const id = `ordinary-choice-${operation}-${offline}`;
        notes = [saved(id, "saved")];
        sizes.set(id, 40);
        localStorageVoiceNotePrivateChoiceStore("did:test", testStorage).add(id);
        const evict = () => operation === "trim" ? trimCachedAudio(0) : clearCachedAudio();

        await evict();
        now += 31 * 24 * 60 * 60 * 1_000;
        await evict();
        expect(sizes.get(id)).toBe(40);
      } finally {
        Date.now = originalNow;
      }
    });
  }
}

for (const operation of ["trim", "clear"] as const) {
  test(`TC-1182 retryable and in-flight work does not expire with ${operation}`, async () => {
    const originalNow = Date.now;
    let now = new Date("2026-01-01T00:00:00.000Z").getTime();
    Date.now = () => now;
    try {
      const retryable = saved(`retryable-${operation}`, "saved");
      const active = saved(`active-${operation}`, "saved");
      notes = [retryable, active];
      sizes.set(retryable.id, 40);
      sizes.set(active.id, 40);
      const pending = localStorageVoiceNotePendingStore("did:test", testStorage);
      pending.write(retryable.id, { attemptId: "retryable-attempt", transcriptionId: null, failure: "service_paused" });
      pending.write(active.id, { attemptId: "active-attempt", transcriptionId: "ptx-active" });
      const evict = () => operation === "trim" ? trimCachedAudio(0) : clearCachedAudio();
      await evict();
      now = new Date("2026-02-02T00:00:00.000Z").getTime();
      await evict();

      expect(sizes.get(retryable.id)).toBe(40);
      expect(sizes.get(active.id)).toBe(40);
    } finally {
      Date.now = originalNow;
    }
  });
}

for (const operation of ["trim", "clear"] as const) {
  for (const offline of [false, true]) {
    test(`TC-1182 local recording stays retained after queued work settles; ${operation}, offline=${offline}`, async () => {
      const note = saved(`queued-${operation}-${offline}`, "saved");
      notes = [note];
      sizes.set(note.id, 40);
      const release = retainSource("did:test", note.id);

      await (operation === "trim" ? trimCachedAudio(0) : clearCachedAudio());
      expect(sizes.get(note.id)).toBe(40);

      release();
      await (operation === "trim" ? trimCachedAudio(0) : clearCachedAudio());
      expect(sizes.get(note.id)).toBe(40);
    });
  }
}