// The shared voice-note saves: one pending run at a time (the recorder and
// PendingVoiceNotesSaver share it), saving to the space kept apart from
// removing the device copy, the pending store the recorder views read, always
// re-listed from the phone, and the discard guard (PR5): a discarded recording
// is deleted, never saved, even after a relaunch. The plugin is a scripted
// fake; the store's save is swapped through harness/fakeVoiceNoteStore.
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { fakeVoiceNoteStore } from "@/harness/fakeVoiceNoteStore";
import { __setVoiceNotesForTests, type VoiceNoteRecording, type VoiceNotesPlugin } from "./nativeVoiceNotes";
import { currentAccountGeneration } from "./accountContext";

const realStore = { ...(await import("./voiceNoteStore")) };
mock.module("./voiceNoteStore", () => ({
  ...realStore,
  saveVoiceNote: (...args: Parameters<typeof realStore.saveVoiceNote>) => (fakeVoiceNoteStore.save ?? realStore.saveVoiceNote)(...args),
}));
afterAll(() => mock.module("./voiceNoteStore", () => realStore));
const saves = await import("./recorderSaves");

/** A fresh copy of the module, as after a WebView reload: its in-memory guards and store are new. */
let instances = 0;
const reloaded = () => import(`./recorderSaves.ts?reload=${++instances}`) as Promise<typeof saves>;

/** localStorage for one test (bun has none), as the WebView keeps it across reloads. */
function withStorage(): Map<string, string> {
  const items = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  };
  return items;
}

const tcw = { did: "did:example:alice" } as TinyCloudWeb;

function recording(id: string, startedAt: number): VoiceNoteRecording {
  return { id, startedAt, durationMs: 1000, mimeType: "audio/mp4", sizeBytes: 4, silencedMs: 0, silencedEvents: 0, noSignalMs: 0,
    version: 2, owner: tcw.did, rev: 1 };
}

/** The phone: what is listed as pending, and how deleteAudio and listPending behave. */
const phone = {
  pending: [] as VoiceNoteRecording[],
  deleteFailures: 0,
  deletes: 0,
  lists: 0,
  holdList: null as Promise<void> | null,
  ledgerUpdates: [] as unknown[],
  ledgerConflicts: 0,
};

const plugin = {
  async listPending() {
    phone.lists++;
    if (phone.holdList) await phone.holdList;
    return { recordings: [...phone.pending] };
  },
  async deleteAudio({ id }: { id: string }) {
    phone.deletes++;
    if (phone.deleteFailures > 0) {
      phone.deleteFailures--;
      throw new Error("the file is busy");
    }
    phone.pending = phone.pending.filter((r) => r.id !== id);
  },
  async readAudioChunk({ id, offset, length }: { id: string; offset: number; length: number }) {
    return { id, offset, base64: btoa("\u0000".repeat(length)), bytesRead: length, size: 4, eof: true };
  },
  async updateLedger(options: unknown) {
    phone.ledgerUpdates.push(options);
    if (phone.ledgerConflicts > 0) {
      phone.ledgerConflicts--;
      phone.pending = phone.pending.map((note) => ({ ...note, rev: 2 }));
      throw Object.assign(new Error("ledger changed"), { code: "rev_conflict" });
    }
    return { rev: 3 };
  },
} as unknown as VoiceNotesPlugin;

let saveCalls = 0;
const ok = async () => {
  saveCalls++;
  return { ok: true, data: { inserted: true } } as never;
};
const fails = async () => {
  saveCalls++;
  return { ok: false, error: { code: "NETWORK", message: "The network connection was lost." } } as never;
};

beforeEach(() => {
  __setVoiceNotesForTests(plugin, { available: true });
  Object.assign(phone, { pending: [], deleteFailures: 0, deletes: 0, lists: 0, holdList: null, ledgerUpdates: [], ledgerConflicts: 0 });
  saveCalls = 0;
  fakeVoiceNoteStore.save = ok;
});
afterEach(() => {
  fakeVoiceNoteStore.save = null;
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe("savePendingRecordings", () => {
  test("single-flight: a second call while one runs gets the same run", async () => {
    let release!: () => void;
    phone.holdList = new Promise((resolve) => {
      release = resolve;
    });
    const first = saves.savePendingRecordings(tcw);
    const second = saves.savePendingRecordings(tcw);
    expect(second === first).toBe(true);
    expect(saves.pendingStore.snapshot().running).toBe(true);
    release();
    phone.holdList = null;
    expect(await first).toEqual({ total: 0, left: [], saved: [], lastError: null });
    expect(saves.pendingStore.snapshot().running).toBe(false);
    // Once it has finished, the next call is a new run.
    const third = saves.savePendingRecordings(tcw);
    expect(third === first).toBe(false);
    await third;
  });

  test("a recording that cannot be saved stays on the phone, oldest first, with the failure", async () => {
    phone.pending = [recording("b", 2), recording("a", 1)];
    fakeVoiceNoteStore.save = fails;
    const run = await saves.savePendingRecordings(tcw);
    expect(run.saved).toEqual([]);
    expect(run.left.map((r) => r.id)).toEqual(["a", "b"]);
    expect(run.lastError).toBe("The network connection was lost.");
    expect(saves.pendingStore.snapshot()).toMatchObject({
      listing: { state: "ok", count: 2 },
      running: false,
      lastError: "The network connection was lost.",
    });
  });

  test("an uploaded note remains on the phone and is never uploaded twice", async () => {
    const note = recording("kept", 1);
    phone.pending = [note];
    const first = await saves.savePendingRecordings(tcw);
    expect(first.saved.map((r) => r.id)).toEqual(["kept"]);
    expect(first.lastError).toBeNull();
    expect(saves.pendingStore.snapshot().listing).toEqual({ state: "ok", count: 0 });
    const second = await saves.savePendingRecordings(tcw);
    expect(second.saved).toEqual([]);
    expect(second.left).toEqual([]);
    expect(second.lastError).toBeNull();
    expect(saves.pendingStore.snapshot().listing).toEqual({ state: "ok", count: 0 });
    expect(saveCalls).toBe(1);
    expect(phone.deletes).toBe(0);
    expect(phone.pending).toEqual([note]);
  });
});

describe("saveRecording", () => {
  test("renewal's save-idle waiter resolves when an account pipeline save fails", async () => {
    const note = recording("account-save-idle", 1);
    const accountTcw = { ...tcw, spaceId: "space" } as TinyCloudWeb;
    let finish!: () => void;
    fakeVoiceNoteStore.save = async () => {
      await new Promise<void>((resolve) => { finish = resolve; });
      return fails();
    };
    const saving = saves.saveNoteForAccount(accountTcw,
      { did: tcw.did, spaceId: "space", generation: currentAccountGeneration() }, note);
    expect(saves.voiceNoteSaveBusy()).toBe(true);
    let idle = false;
    const waiting = saves.whenVoiceNoteSavesIdle().then(() => { idle = true; });
    await Promise.resolve();
    expect(idle).toBe(false);
    finish();
    expect(await saving).toEqual({ kind: "failed", failure: "The network connection was lost." });
    await waiting;
    expect(idle).toBe(true);
    expect(saves.voiceNoteSaveBusy()).toBe(false);
  });

  test("a save in the space leaves the device copy for local playback", async () => {
    const note = recording("one", 1);
    phone.pending = [note];
    const outcome = await saves.saveRecording(tcw, note);
    expect(outcome.kind).toBe("saved");
    expect(outcome.kind === "saved" && outcome.cleanupError).toBeNull();
    expect(await saves.saveRecording(tcw, note)).toEqual({ kind: "already-saved", cleanupError: null });
    expect(saveCalls).toBe(1);
    expect(phone.deletes).toBe(0);
    expect(phone.pending).toEqual([note]);
  });

  test("every v1 note, including one missing ownerUnknown, is held by the sign-in saver", async () => {
    const bareV1: VoiceNoteRecording = {
      id: "bare-v1", startedAt: 0, durationMs: 1000, mimeType: "audio/mp4", sizeBytes: 4,
      silencedMs: 0, silencedEvents: 0, noSignalMs: 0,
    };
    phone.pending = [bareV1];
    expect(await saves.savePendingRecordings(tcw)).toMatchObject({ total: 1, left: [bareV1], saved: [] });
    expect(saveCalls).toBe(0);
    expect(phone.deletes).toBe(0);
  });

  test("legacy and unowned v2 notes never reach saveVoiceNote", async () => {
    const legacy = { ...recording("legacy-held", 1), ownerUnknown: true };
    const unowned = { ...recording("unowned-held", 2), version: 2 as const, owner: null };
    const other = { ...recording("other-account", 3), version: 2 as const, owner: "did:example:bob" };
    phone.pending = [legacy, unowned, other];
    expect(await saves.saveRecording(tcw, legacy)).toEqual({ kind: "held", reason: "legacy" });
    expect(await saves.saveRecording(tcw, unowned)).toEqual({ kind: "held", reason: "unowned" });
    expect(await saves.saveRecording(tcw, other)).toEqual({ kind: "held", reason: "other-account" });
    expect(saveCalls).toBe(0);
    expect(phone.deletes).toBe(0);
    expect(phone.pending).toHaveLength(3);
  });

  test("owned v2 upload updates the native audio ledger and retains local audio", async () => {
    const note = { ...recording("owned-v2", 3), version: 2 as const, owner: "did:example:alice", rev: 2 };
    phone.pending = [note];
    fakeVoiceNoteStore.save = async () => ({ ok: true, data: { id: "actual-row", inserted: true, createdAt: "2026-10-07T00:00:00Z" } }) as never;
    expect((await saves.saveRecording(tcw, note)).kind).toBe("saved");
    expect(phone.ledgerUpdates).toEqual([{ id: note.id, did: note.owner, rev: 2,
      patch: { audio: { state: "saved", rowId: "actual-row", at: expect.any(Number) } } }]);
    expect(phone.pending).toEqual([note]);
    expect(phone.deletes).toBe(0);
  });

  test("a changed ledger rev is re-read and patched once without another upload", async () => {
    const note = recording("owned-rev-conflict", 4);
    phone.pending = [note];
    phone.ledgerConflicts = 1;
    const result = await saves.saveRecording(tcw, note);
    expect(result).toMatchObject({ kind: "saved", cleanupError: null });
    expect(saveCalls).toBe(1);
    expect(phone.ledgerUpdates).toMatchObject([{ rev: 1 }, { rev: 2 }]);
    expect(phone.deletes).toBe(0);
  });
});

describe("after a reload", () => {
  test("after a reload, an old localStorage marker cannot suppress a pending native ledger", async () => {
    const storage = withStorage();
    const before = await reloaded();
    const note = recording("reload", 1);
    phone.pending = [note];
    const first = await before.savePendingRecordings(tcw);
    expect(first.saved.map((r) => r.id)).toEqual(["reload"]);
    expect(saveCalls).toBe(1);
    // The phone kept its copy; the note is marked as in the space, durably.
    expect(phone.pending.map((r) => r.id)).toEqual(["reload"]);
    expect(JSON.parse(storage.get(saves.VOICE_NOTE_CLOUD_SAVED_KEY)!)).toEqual(["reload"]);

    // A fresh module: its in-memory guards are gone; the phone and localStorage are not.
    const after = await reloaded();
    const second = await after.savePendingRecordings(tcw);
    expect(saveCalls).toBe(2);
    expect(second.saved.map((r) => r.id)).toEqual(["reload"]);
    expect(second.left).toEqual([]);
    expect(phone.pending).toEqual([note]);
    expect(storage.has(saves.VOICE_NOTE_CLOUD_SAVED_KEY)).toBe(true);
    expect(after.pendingStore.snapshot().listing).toEqual({ state: "ok", count: 0 });
  });

  test("a cold start whose listing fails says so, never \"nothing pending\"", async () => {
    const cold = await reloaded();
    expect(cold.pendingStore.snapshot().listing).toEqual({ state: "unknown" });
    __setVoiceNotesForTests({ ...plugin, listPending: async () => Promise.reject(new Error("no bridge")) } as VoiceNotesPlugin, { available: true });
    const run = await cold.savePendingRecordings(tcw);
    expect(run).toEqual({ total: 0, left: [], saved: [], lastError: "Could not check this phone for unsaved notes: no bridge" });
    expect(cold.pendingStore.snapshot()).toEqual({
      listing: { state: "error", message: "Could not check this phone for unsaved notes: no bridge" },
      running: false,
      lastError: null,
    });
    expect(cold.pendingCount(cold.pendingStore.snapshot())).toBe(0);
  });
});

describe("pendingStore", () => {
  test("refresh lists the phone; a listing that fails is an error state, never a cached count", async () => {
    phone.pending = [recording("a", 1), recording("b", 2)];
    await saves.pendingStore.refresh(null);
    const snapshot = saves.pendingStore.snapshot();
    expect(snapshot.listing).toEqual({ state: "ok", count: 2 });
    expect(saves.pendingStore.snapshot()).toBe(snapshot);
    __setVoiceNotesForTests({ ...plugin, listPending: async () => Promise.reject(new Error("no bridge")) } as VoiceNotesPlugin, { available: true });
    await saves.pendingStore.refresh(null);
    expect(saves.pendingStore.snapshot().listing).toEqual({ state: "error", message: "Could not check this phone for unsaved notes: no bridge" });
  });
});

describe("discard guard", () => {
  test("saveRecording deletes a discarded recording instead of saving it", async () => {
    const storage = withStorage();
    const note = recording("discard-one", 1);
    phone.pending = [note];
    saves.markDiscarded(note.id);
    expect(storage.get(saves.VOICE_NOTE_DISCARDED_KEY)).toBe('["discard-one"]');
    expect(await saves.saveRecording(tcw, note)).toEqual({ kind: "discarded", cleanupError: null });
    expect(saveCalls).toBe(0);
    expect(phone.pending).toEqual([]);
    // Gone from the phone: nothing is left to guard.
    expect(saves.isDiscarded(note.id)).toBe(false);
    expect(storage.has(saves.VOICE_NOTE_DISCARDED_KEY)).toBe(false);
  });

  test("a pending run deletes a discarded recording and saves the rest", async () => {
    phone.pending = [recording("discard-keep", 2), recording("discard-drop", 1)];
    saves.markDiscarded("discard-drop");
    const run = await saves.savePendingRecordings(tcw);
    expect(run.saved.map((r) => r.id)).toEqual(["discard-keep"]);
    expect(run.left).toEqual([]);
    expect(run.lastError).toBeNull();
    expect(saveCalls).toBe(1);
    expect(phone.pending.map((r) => r.id)).toEqual(["discard-keep"]);
    expect(saves.pendingStore.snapshot().listing).toEqual({ state: "ok", count: 0 });
  });

  test("the mark survives a reload: the stored id still deletes the recording", async () => {
    withStorage();
    saves.markDiscarded("discard-reload");
    // A fresh module: nothing in memory; only localStorage kept the id.
    const after = await reloaded();
    expect(after.isDiscarded("discard-reload")).toBe(true);
    phone.pending = [recording("discard-reload", 1)];
    const run = await after.savePendingRecordings(tcw);
    expect(run.saved).toEqual([]);
    expect(saveCalls).toBe(0);
    expect(phone.pending).toEqual([]);
    expect(after.isDiscarded("discard-reload")).toBe(false);
  });

  test("discarded and also marked as in the space: deleted, never saved, and both marks cleared", async () => {
    // A reload with both marks on one note still on the phone; the discard check runs first.
    const storage = withStorage();
    storage.set(saves.VOICE_NOTE_DISCARDED_KEY, '["discard-saved"]');
    storage.set(saves.VOICE_NOTE_CLOUD_SAVED_KEY, '["discard-saved"]');
    const after = await reloaded();
    const note = recording("discard-saved", 1);
    phone.pending = [note];
    expect(await after.saveRecording(tcw, note)).toEqual({ kind: "discarded", cleanupError: null });
    expect(phone.pending).toEqual([]);
    expect(saveCalls).toBe(0);
    expect(after.isDiscarded(note.id)).toBe(false);
    expect(storage.has(saves.VOICE_NOTE_DISCARDED_KEY)).toBe(false);
    expect(storage.has(saves.VOICE_NOTE_CLOUD_SAVED_KEY)).toBe(false);
    // Met again (a late "autoStopped"): nothing to save or delete.
    expect(await after.saveRecording(tcw, note)).toEqual({ kind: "already-saved", cleanupError: null });
    expect(saveCalls).toBe(0);
  });

  test("a failed delete keeps the id marked, and the next run deletes it", async () => {
    const storage = withStorage();
    phone.pending = [recording("discard-busy", 1)];
    phone.deleteFailures = 1;
    saves.markDiscarded("discard-busy");
    const first = await saves.savePendingRecordings(tcw);
    expect(first.saved).toEqual([]);
    expect(first.lastError).toBe("Discarded, but this phone kept its copy: the file is busy");
    expect(saves.isDiscarded("discard-busy")).toBe(true);
    expect(storage.get(saves.VOICE_NOTE_DISCARDED_KEY)).toBe('["discard-busy"]');
    // Still on the phone, and counted.
    expect(saves.pendingStore.snapshot().listing).toEqual({ state: "ok", count: 1 });

    const second = await saves.savePendingRecordings(tcw);
    expect(second.lastError).toBeNull();
    expect(saves.isDiscarded("discard-busy")).toBe(false);
    expect(phone.pending).toEqual([]);
    expect(saveCalls).toBe(0);
  });

  test("without localStorage the guard still holds for this session", async () => {
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: () => {
        throw new Error("storage disabled");
      },
      setItem: () => {
        throw new Error("storage disabled");
      },
      removeItem: () => {
        throw new Error("storage disabled");
      },
    };
    const note = recording("discard-no-storage", 1);
    phone.pending = [note];
    saves.markDiscarded(note.id);
    expect(saves.isDiscarded(note.id)).toBe(true);
    expect((await saves.saveRecording(tcw, note)).kind).toBe("discarded");
    expect(saveCalls).toBe(0);
  });
});
