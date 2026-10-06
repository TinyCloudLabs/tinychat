// The shared voice-note saves: one pending run at a time (the single-flight the
// card, the recorder and PendingVoiceNotesSaver share), and the pending store
// the recorder views read. The plugin is a fake behind the real module's other
// exports.
import { afterEach, describe, expect, mock, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import type { VoiceNoteRecording } from "./nativeVoiceNotes";

// Copied before mocking: the mock replaces the module (and so `real`) in place.
const real = { ...(await import("./nativeVoiceNotes")) };

/** What the fake plugin does; each test sets what it needs. */
const plugin = {
  listPending: async (): Promise<{ recordings: VoiceNoteRecording[] }> => ({ recordings: [] }),
  readAudioChunk: async (): Promise<never> => {
    throw new Error("the phone could not read the recording");
  },
  deleteAudio: async () => {},
};

mock.module("./nativeVoiceNotes", () => ({
  ...real,
  VoiceNotes: {
    listPending: () => plugin.listPending(),
    readAudioChunk: () => plugin.readAudioChunk(),
    deleteAudio: () => plugin.deleteAudio(),
  },
}));

// Imported after the mock, so it binds to the fake plugin.
const saves = await import("./recorderSaves");

const tcw = {} as TinyCloudWeb;

function recording(id: string, startedAt: number): VoiceNoteRecording {
  return { id, startedAt, durationMs: 1000, mimeType: "audio/mp4", sizeBytes: 10, silencedMs: 0, silencedEvents: 0, noSignalMs: 0 };
}

afterEach(() => {
  plugin.listPending = async () => ({ recordings: [] });
});

describe("savePendingRecordings", () => {
  test("single-flight: a second call while one runs gets the same run", async () => {
    let release!: () => void;
    let lists = 0;
    plugin.listPending = () => {
      lists++;
      return new Promise((resolve) => {
        release = () => resolve({ recordings: [] });
      });
    };
    const first = saves.savePendingRecordings(tcw);
    const second = saves.savePendingRecordings(tcw);
    expect(second === first).toBe(true);
    release();
    expect(await first).toEqual({ total: 0, left: [], saved: [], lastError: null });
    expect(lists).toBe(1);
    // Once it has finished, the next call is a new run.
    plugin.listPending = async () => {
      lists++;
      return { recordings: [] };
    };
    const third = saves.savePendingRecordings(tcw);
    expect(third === first).toBe(false);
    await third;
    expect(lists).toBe(2);
  });

  test("a recording that cannot be saved stays on the phone, with the failure", async () => {
    plugin.listPending = async () => ({ recordings: [recording("b", 2), recording("a", 1)] });
    const run = await saves.savePendingRecordings(tcw);
    expect(run.total).toBe(2);
    expect(run.saved).toEqual([]);
    // Oldest first.
    expect(run.left.map((r) => r.id)).toEqual(["a", "b"]);
    expect(run.lastError).toEqual(expect.any(String));
  });
});

describe("pendingStore", () => {
  test("a pending run publishes that it is running, then what is left and why", async () => {
    let release!: () => void;
    plugin.listPending = () =>
      new Promise((resolve) => {
        release = () => resolve({ recordings: [recording("a", 1)] });
      });
    const seen: Array<ReturnType<typeof saves.pendingStore.snapshot>> = [];
    const unsubscribe = saves.pendingStore.subscribe(() => seen.push(saves.pendingStore.snapshot()));
    const run = saves.savePendingRecordings(tcw);
    expect(saves.pendingStore.snapshot().running).toBe(true);
    release();
    await run;
    unsubscribe();
    const last = saves.pendingStore.snapshot();
    expect(last.running).toBe(false);
    expect(last.count).toBe(1);
    expect(last.lastError).toEqual(expect.any(String));
    expect(seen[0].running).toBe(true);
  });

  test("refresh counts what is on the phone; the snapshot is stable between changes", async () => {
    plugin.listPending = async () => ({ recordings: [recording("a", 1), recording("b", 2)] });
    await saves.pendingStore.refresh();
    const snapshot = saves.pendingStore.snapshot();
    expect(snapshot.count).toBe(2);
    expect(saves.pendingStore.snapshot()).toBe(snapshot);
  });
});
