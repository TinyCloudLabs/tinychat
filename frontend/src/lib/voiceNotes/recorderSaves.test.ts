// The shared voice-note saves: one pending run at a time (the recorder and
// PendingVoiceNotesSaver share it), saving to the space kept apart from
// removing the device copy, and the pending store the recorder views read,
// always re-listed from the phone. The plugin is a scripted fake; the store's
// save is swapped through harness/fakeVoiceNoteStore.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { fakeVoiceNoteStore } from "@/harness/fakeVoiceNoteStore";
import { __setVoiceNotesForTests, type VoiceNoteRecording, type VoiceNotesPlugin } from "./nativeVoiceNotes";

const realStore = { ...(await import("./voiceNoteStore")) };
mock.module("./voiceNoteStore", () => ({
  ...realStore,
  saveVoiceNote: (...args: Parameters<typeof realStore.saveVoiceNote>) => (fakeVoiceNoteStore.save ?? realStore.saveVoiceNote)(...args),
}));
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

const tcw = {} as TinyCloudWeb;

function recording(id: string, startedAt: number): VoiceNoteRecording {
  return { id, startedAt, durationMs: 1000, mimeType: "audio/mp4", sizeBytes: 4, silencedMs: 0, silencedEvents: 0, noSignalMs: 0 };
}

/** The phone: what is listed as pending, and how deleteAudio and listPending behave. */
const phone = {
  pending: [] as VoiceNoteRecording[],
  deleteFailures: 0,
  deletes: 0,
  lists: 0,
  holdList: null as Promise<void> | null,
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
  Object.assign(phone, { pending: [], deleteFailures: 0, deletes: 0, lists: 0, holdList: null });
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

  test("saved, but the phone keeps its copy twice: never hidden, never uploaded again, removed on the third try", async () => {
    const note = recording("kept", 1);
    phone.pending = [note];
    phone.deleteFailures = 2;

    // In the space; the copy stays and is counted, with what happened.
    const first = await saves.savePendingRecordings(tcw);
    expect(first.saved.map((r) => r.id)).toEqual(["kept"]);
    expect(first.lastError).toContain("Saved to your space, but this phone kept its copy");
    expect(saves.pendingStore.snapshot().listing).toEqual({ state: "ok", count: 1 });

    // Save now: only the copy is left to remove; it fails again and is still counted, not re-saved.
    const second = await saves.savePendingRecordings(tcw);
    expect(second.saved).toEqual([]);
    expect(second.left).toEqual([]);
    expect(second.lastError).toContain("this phone kept its copy");
    expect(saves.pendingStore.snapshot().listing).toEqual({ state: "ok", count: 1 });

    // The third time the copy goes, and the count follows the phone.
    const third = await saves.savePendingRecordings(tcw);
    expect(third.lastError).toBeNull();
    expect(saves.pendingStore.snapshot().listing).toEqual({ state: "ok", count: 0 });
    expect(saveCalls).toBe(1);
    expect(phone.deletes).toBe(3);
  });
});

describe("saveRecording", () => {
  test("a save in the space and the device copy are separate results", async () => {
    const note = recording("one", 1);
    phone.pending = [note];
    phone.deleteFailures = 1;
    const outcome = await saves.saveRecording(tcw, note);
    expect(outcome.kind).toBe("saved");
    expect(outcome.kind === "saved" && outcome.cleanupError).toContain("this phone kept its copy");
    // A late "autoStopped" for the same note: already in the space, so only the copy is removed.
    expect(await saves.saveRecording(tcw, note)).toEqual({ kind: "already-saved", cleanupError: null });
    expect(saveCalls).toBe(1);
  });
});

describe("after a reload", () => {
  test("saved, the delete failed, then a reload: the next run removes the copy only, never saves it again", async () => {
    const storage = withStorage();
    const before = await reloaded();
    const note = recording("reload", 1);
    phone.pending = [note];
    phone.deleteFailures = 1;
    const first = await before.savePendingRecordings(tcw);
    expect(first.saved.map((r) => r.id)).toEqual(["reload"]);
    expect(saveCalls).toBe(1);
    // The phone kept its copy; the note is marked as in the space, durably.
    expect(phone.pending.map((r) => r.id)).toEqual(["reload"]);
    expect(JSON.parse(storage.get(saves.VOICE_NOTE_CLOUD_SAVED_KEY)!)).toEqual(["reload"]);

    // A fresh module: its in-memory guards are gone; the phone and localStorage are not.
    const after = await reloaded();
    const second = await after.savePendingRecordings(tcw);
    expect(saveCalls).toBe(1);
    expect(second.saved).toEqual([]);
    expect(second.left).toEqual([]);
    expect(phone.pending).toEqual([]);
    expect(storage.has(saves.VOICE_NOTE_CLOUD_SAVED_KEY)).toBe(false);
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
