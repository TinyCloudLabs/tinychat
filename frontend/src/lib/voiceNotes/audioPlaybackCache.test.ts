import { afterEach, beforeEach, expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import { VoiceNotes, __setVoiceNotesForTests, type VoiceNoteRecording, type VoiceNotesPlugin } from "./nativeVoiceNotes";
import { cachedAudioSize, cachedSpaceAudio, clearCachedAudio, trimCachedAudio } from "./audioPlaybackCache";

const original = VoiceNotes;
const originalIdb = globalThis.indexedDB;
const saved = (id: string, state: "saved" | "pending"): VoiceNoteRecording => ({
  id, startedAt: 1, durationMs: 1000, mimeType: "audio/mp4", sizeBytes: 40,
  silencedMs: 0, silencedEvents: 0, noSignalMs: 0,
  ledger: { audio: { state, rowId: state === "saved" ? "row" : null, at: 1,
    ...(state === "saved" ? { verifiedInSpace: { sha256: "a".repeat(64), size: 40 } } : {}) } } as VoiceNoteRecording["ledger"],
});

let notes: VoiceNoteRecording[];
let sizes: Map<string, number>;
let evicted: string[];
beforeEach(() => {
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
  } as VoiceNotesPlugin, { available: true });
});
afterEach(() => {
  globalThis.indexedDB = originalIdb;
  __setVoiceNotesForTests(original, { available: null });
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

test("eviction and Clear cached audio touch only confirmed space copies", async () => {
  const localOnly = saved("local-only", "saved");
  delete localOnly.ledger!.audio.verifiedInSpace;
  notes = [saved("uploaded", "saved"), localOnly, saved("pending", "pending")];
  sizes.set("uploaded", 40);
  sizes.set("local-only", 40);
  sizes.set("pending", 40);
  await cachedSpaceAudio("space", "did", "exo-voice-note", "downloaded", "rev-1", async () => new Blob(["remote"]));
  expect((await cachedAudioSize()).bytes).toBe(46);
  await trimCachedAudio(5);
  expect(evicted).toEqual(["uploaded"]);
  expect(sizes.get("local-only")).toBe(40);
  expect(sizes.get("pending")).toBe(40);
  await cachedSpaceAudio("space", "did", "exo-voice-note", "again", "rev-1", async () => new Blob(["remote"]));
  await clearCachedAudio();
  expect((await cachedAudioSize()).bytes).toBe(0);
  expect(sizes.get("local-only")).toBe(40);
  expect(sizes.get("pending")).toBe(40);
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

test("an explicitly uploaded note joins the bounded cache after verification", async () => {
  notes = [{ ...saved("explicit", "saved"), options: { uploadAudio: false } as VoiceNoteRecording["options"] }];
  sizes.set("explicit", 40);
  expect((await cachedAudioSize()).bytes).toBe(40);
  await trimCachedAudio(0);
  expect(evicted).toEqual(["explicit"]);
});
