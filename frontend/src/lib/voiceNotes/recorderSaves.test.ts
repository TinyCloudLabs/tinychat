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
    expect(saves.pendingStore.snapshot()).toMatchObject({ count: 2, running: false, lastError: "The network connection was lost." });
  });

  test("saved, but the phone keeps its copy twice: never hidden, never uploaded again, removed on the third try", async () => {
    const note = recording("kept", 1);
    phone.pending = [note];
    phone.deleteFailures = 2;

    // In the space; the copy stays and is counted, with what happened.
    const first = await saves.savePendingRecordings(tcw);
    expect(first.saved.map((r) => r.id)).toEqual(["kept"]);
    expect(first.lastError).toContain("Saved to your space, but this phone kept its copy");
    expect(saves.pendingStore.snapshot().count).toBe(1);

    // Save now: only the copy is left to remove; it fails again and is still counted, not re-saved.
    const second = await saves.savePendingRecordings(tcw);
    expect(second.saved).toEqual([]);
    expect(second.left).toEqual([]);
    expect(second.lastError).toContain("this phone kept its copy");
    expect(saves.pendingStore.snapshot().count).toBe(1);

    // The third time the copy goes, and the count follows the phone.
    const third = await saves.savePendingRecordings(tcw);
    expect(third.lastError).toBeNull();
    expect(saves.pendingStore.snapshot().count).toBe(0);
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

describe("pendingStore", () => {
  test("refresh counts what is on the phone; a listing that fails is told, never zeroed", async () => {
    phone.pending = [recording("a", 1), recording("b", 2)];
    await saves.pendingStore.refresh(null);
    const snapshot = saves.pendingStore.snapshot();
    expect(snapshot.count).toBe(2);
    expect(saves.pendingStore.snapshot()).toBe(snapshot);
    __setVoiceNotesForTests({ ...plugin, listPending: async () => Promise.reject(new Error("no bridge")) } as VoiceNotesPlugin, { available: true });
    await saves.pendingStore.refresh(null);
    expect(saves.pendingStore.snapshot()).toMatchObject({ count: 2, lastError: "Could not list the notes on this phone: no bridge" });
  });
});
