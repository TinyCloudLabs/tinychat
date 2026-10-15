import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  __resetSourcePinsForTests,
  accountStorageKey,
  evictUnlessPinned,
  isSourcePinned,
  registerExtraPins,
  retainSource,
  VOICE_NOTE_PENDING_JOBS_KEY,
  VOICE_NOTE_PRIVATE_CHOICES_KEY,
  withSourceLease,
} from "./sourcePins";
import { localStorageVoiceNotePendingStore, localStorageVoiceNotePrivateChoiceStore } from "./voiceNoteTranscription";

const DID = "did:test:source-pins";
const ID = "note-1";
const originalStorage = (globalThis as typeof globalThis & { localStorage?: Storage }).localStorage;
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
let storage: Storage;

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  __resetSourcePinsForTests();
  storage = memoryStorage();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
});

afterEach(() => {
  __resetSourcePinsForTests();
  if (originalStorage === undefined) Reflect.deleteProperty(globalThis, "localStorage");
  else Object.defineProperty(globalThis, "localStorage", { configurable: true, value: originalStorage });
  if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
  else Reflect.deleteProperty(globalThis, "navigator");
});

test("durable PTX pins are account-scoped", async () => {
  storage.setItem(accountStorageKey(VOICE_NOTE_PENDING_JOBS_KEY, DID), JSON.stringify({ [ID]: {
    attemptId: "attempt-1", transcriptionId: "ptx-1",
  } }));
  expect(await isSourcePinned(DID, ID)).toBe(true);
  expect(await isSourcePinned("did:test:other", ID)).toBe(false);
});

test("corrupt pending and choice JSON fail closed", async () => {
  storage.setItem(accountStorageKey(VOICE_NOTE_PENDING_JOBS_KEY, DID), "{");
  expect(await isSourcePinned(DID, ID)).toBe(true);
  storage.removeItem(accountStorageKey(VOICE_NOTE_PENDING_JOBS_KEY, DID));
  storage.setItem(accountStorageKey(VOICE_NOTE_PRIVATE_CHOICES_KEY, DID), "not-json");
  expect(await isSourcePinned(DID, ID)).toBe(true);
});

test("missing local storage fails closed for source eviction", async () => {
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: undefined });
  expect(await isSourcePinned(DID, ID)).toBe(true);
  const result = await evictUnlessPinned(DID, ID, () => true, async () => "deleted");
  expect(result.kind).toBe("pinned");
});

test("extra pin lookup is awaited and a lookup error fails closed", async () => {
  const entered = deferred();
  const unblock = deferred();
  const unregister = registerExtraPins(async (owner, id) => {
    expect([owner, id]).toEqual([DID, ID]);
    entered.resolve();
    await unblock.promise;
    return true;
  });
  const lookup = isSourcePinned(DID, ID);
  await entered.promise;
  unblock.resolve();
  expect(await lookup).toBe(true);
  unregister();
  const unregisterFailure = registerExtraPins(async () => { throw new Error("synthetic unavailable"); });
  expect(await isSourcePinned(DID, ID)).toBe(true);
  unregisterFailure();
});

test("eviction rechecks account identity after an awaited pin lookup", async () => {
  const entered = deferred();
  const unblock = deferred();
  let current = true;
  let deleted = false;
  const unregister = registerExtraPins(async () => {
    entered.resolve();
    await unblock.promise;
    return false;
  });
  const eviction = evictUnlessPinned(DID, ID, () => current, async () => { deleted = true; });
  await entered.promise;
  current = false;
  unblock.resolve();
  expect(await eviction).toEqual({ kind: "account_changed" });
  expect(deleted).toBe(false);
  unregister();
});

test("malformed held data remains pinned rather than aging out", async () => {
  const now = Date.parse("2026-01-01T00:00:00.000Z");
  storage.setItem(accountStorageKey(VOICE_NOTE_PENDING_JOBS_KEY, DID), JSON.stringify({
    [ID]: { attemptId: "attempt-1", held: null },
  }));
  expect(await isSourcePinned(DID, ID, now)).toBe(true);
  expect(await isSourcePinned(DID, ID, now + 31 * 24 * 60 * 60 * 1000)).toBe(true);
});

test("ordinary Private choice remains pinned while only a blocked choice can expire", async () => {
  const now = Date.parse("2026-01-01T00:00:00.000Z");
  const choices = localStorageVoiceNotePrivateChoiceStore(DID, storage);
  choices.add(ID);
  expect(await isSourcePinned(DID, ID, now)).toBe(true);
  expect(await isSourcePinned(DID, ID, now + 31 * 24 * 60 * 60 * 1000)).toBe(true);
  choices.remove(ID);
  choices.add(ID);
  expect(await isSourcePinned(DID, ID, now + 31 * 24 * 60 * 60 * 1000)).toBe(true);
});


test("a released fallback lease leaves no retained source", async () => {
  const result = await withSourceLease(DID, ID, async () => "read");
  expect(result).toBe("read");
  let evicted = false;
  const eviction = await evictUnlessPinned(DID, ID, () => true, async () => { evicted = true; });
  expect(eviction.kind).toBe("evicted");
  expect(evicted).toBe(true);
});

test("the fallback lease grants concurrent readers and refuses eviction until both release", async () => {
  const gate = deferred();
  const entered = deferred();
  const read = (sourceId: string) => withSourceLease(DID, sourceId, async () => {
    entered.resolve();
    await gate.promise;
  });
  const first = read(ID);
  await entered.promise;
  const second = read(ID);
  await Promise.resolve();
  const busy = await evictUnlessPinned(DID, ID, () => true, async () => "deleted");
  expect(busy.kind).toBe("in_use");
  gate.resolve();
  await Promise.all([first, second]);
  const available = await evictUnlessPinned(DID, ID, () => true, async () => "deleted");
  expect(available.kind).toBe("evicted");
});

test("the cross-tab Web Lock makes Clear skip an active source reader", async () => {
  const held = new Map<string, { readers: number; writer: boolean }>();
  const manager = {
    request: async (name: string, options: { mode: "shared" | "exclusive"; ifAvailable?: boolean }, callback: (lock: object | null) => Promise<unknown>) => {
      const state = held.get(name) ?? { readers: 0, writer: false };
      held.set(name, state);
      const conflict = state.writer || options.mode === "exclusive" && state.readers > 0;
      if (conflict && options.ifAvailable) return callback(null);
      if (conflict) throw new Error("unexpected blocking lock request in synthetic probe");
      if (options.mode === "exclusive") state.writer = true;
      else state.readers++;
      try { return await callback({}); }
      finally {
        if (options.mode === "exclusive") state.writer = false;
        else state.readers--;
      }
    },
  };
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { locks: manager } });
  const entered = deferred();
  const unblock = deferred();
  const reader = withSourceLease(DID, ID, async () => { entered.resolve(); await unblock.promise; });
  await entered.promise;
  const result = await evictUnlessPinned(DID, ID, () => true, async () => "deleted");
  expect(result.kind).toBe("in_use");
  unblock.resolve();
  await reader;
});

test("queued source retains are reference counted", async () => {
  const releaseFirst = retainSource(DID, ID);
  const releaseSecond = retainSource(DID, ID);
  releaseFirst();
  expect(await isSourcePinned(DID, ID)).toBe(true);
  releaseSecond();
  expect(await isSourcePinned(DID, ID)).toBe(false);
});
test("relaunch rerun cleanup removes the attempt-only source pin", async () => {
  const pending = localStorageVoiceNotePendingStore(DID, storage);
  pending.write(ID, { attemptId: "rerun-attempt", transcriptionId: null, explicitRerun: true, rerunBase: { rev: 1, hash: "base-hash" } });
  expect(await isSourcePinned(DID, ID)).toBe(true);

  pending.clearExplicitReruns?.();
  expect(await isSourcePinned(DID, ID)).toBe(false);
  const result = await evictUnlessPinned(DID, ID, () => true, async () => "deleted");
  expect(result.kind).toBe("evicted");
});
