// The local transcript -> space write publishes its result per note, so "Adding to this note…" cannot hang forever.
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { VoiceNotes, __setVoiceNotesForTests, type LocalTranscript, type VoiceNotesPlugin } from "./nativeVoiceNotes";
import { setVoiceNoteSaveDeadlineForTests } from "./saveDeadline";

type SaveResult = { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } };
let save: (saved: { rev: number }) => Promise<SaveResult> = async () => ({ ok: true, data: {} });
const realStore = { ...(await import("./voiceNoteStore")) };
mock.module("./voiceNoteStore", () => ({ ...realStore, saveVoiceNoteTranscript: (_tcw: unknown, _id: string, saved: { rev: number }) => save(saved) }));
afterAll(() => mock.module("./voiceNoteStore", () => realStore));
const { onDeviceTranscriptSyncState, subscribeOnDeviceTranscriptSync, syncOnDeviceTranscript } = await import("./onDeviceTranscriber");

const SAVED = { id: "rec-1", ledger: { audio: { state: "saved" } } };
const transcript: LocalTranscript = {
  version: 1, noteId: "rec-1", transcriber: "on-device", rev: 1, engine: "parakeet-tdt-0.6b-v3", model: null, language: "en",
  outcome: "transcribed", diarized: false, segments: [{ start: 0, end: 1000, text: "hi", speaker: null }], createdAt: "2026-10-11T00:00:00Z",
} as LocalTranscript;
let seq = 0;
const account = () => ({ did: `did:test:${++seq}`, spaceId: "space" }) as unknown as TinyCloudWeb;
let getTranscript: () => Promise<{ transcript: LocalTranscript | null }>;
const warn = console.warn;
const realPlugin = VoiceNotes;

beforeEach(() => {
  save = async () => ({ ok: true, data: {} });
  getTranscript = async () => ({ transcript });
  __setVoiceNotesForTests({ getTranscript: () => getTranscript() } as unknown as VoiceNotesPlugin, { available: true });
  console.warn = () => {};
});
afterEach(() => {
  console.warn = warn;
  __setVoiceNotesForTests(realPlugin, { available: null });
});

describe("syncOnDeviceTranscript publishes the result", () => {
  test("r4 review: a stalled native read times out so a queued retry can run", async () => {
    const tcw = account();
    let release!: (result: { transcript: LocalTranscript | null }) => void;
    let reads = 0;
    let retryDone = false;
    getTranscript = () => {
      reads++;
      return reads === 1 ? new Promise((resolve) => { release = resolve; }) : Promise.resolve({ transcript });
    };
    setVoiceNoteSaveDeadlineForTests(10);
    try {
      const first = syncOnDeviceTranscript(tcw, SAVED);
      const retry = syncOnDeviceTranscript(tcw, SAVED).then(() => { retryDone = true; });
      await new Promise((resolve) => setTimeout(resolve, 40));
      const observed = { reads, retryDone, state: onDeviceTranscriptSyncState(tcw, "rec-1") };
      // Release the fake native call after observing the stall, keeping this test's chain clean.
      release({ transcript: null });
      await Promise.all([first, retry]);
      expect(observed).toMatchObject({ reads: 2, retryDone: true, state: { state: "synced" } });
    } finally {
      setVoiceNoteSaveDeadlineForTests(null);
    }
  });

  const tick = () => new Promise((r) => setTimeout(r, 0));
  const note = (rev: number) => ({ ...transcript, rev });

  test("attempts for one note run one after another: the second does not read or write until the first settles", async () => {
    const tcw = account();
    const finishes: ((r: SaveResult) => void)[] = [];
    let reads = 0;
    getTranscript = async () => { reads++; return { transcript }; };
    save = () => new Promise((resolve) => finishes.push(resolve));
    const first = syncOnDeviceTranscript(tcw, SAVED);
    const second = syncOnDeviceTranscript(tcw, SAVED);
    const third = syncOnDeviceTranscript(tcw, SAVED);
    await tick();
    expect([reads, finishes.length]).toEqual([1, 1]);
    finishes[0]!({ ok: true, data: {} });
    await first;
    await tick();
    expect([reads, finishes.length]).toEqual([2, 2]);
    finishes[1]!({ ok: true, data: {} });
    await second;
    await tick();
    expect([reads, finishes.length]).toEqual([3, 3]);
    finishes[2]!({ ok: false, error: { code: "OFFLINE", message: "third failed" } });
    await third;
    expect(onDeviceTranscriptSyncState(tcw, "rec-1")).toEqual({ state: "failed", message: "third failed" });
  });

  test("r1: an older failed write does not hide a newer successful sync; the state follows the attempts in order", async () => {
    const tcw = account();
    const finishes: ((r: SaveResult) => void)[] = [];
    save = () => new Promise((resolve) => finishes.push(resolve));
    const old = syncOnDeviceTranscript(tcw, SAVED);
    await tick();
    const latest = syncOnDeviceTranscript(tcw, SAVED);
    finishes[0]!({ ok: false, error: { code: "OFFLINE", message: "older request failed" } });
    await old;
    await tick();
    expect(onDeviceTranscriptSyncState(tcw, "rec-1")).toEqual({ state: "syncing" });
    finishes[1]!({ ok: true, data: {} });
    await latest;
    expect(onDeviceTranscriptSyncState(tcw, "rec-1")).toEqual({ state: "synced" });
  });

  test("r1: an older revision's success does not hide the latest revision's failure", async () => {
    const tcw = account();
    const finishes: ((r: SaveResult) => void)[] = [];
    save = () => new Promise((resolve) => finishes.push(resolve));
    const old = syncOnDeviceTranscript(tcw, SAVED);
    await tick();
    getTranscript = async () => ({ transcript: note(2) });
    const latest = syncOnDeviceTranscript(tcw, SAVED);
    finishes[0]!({ ok: true, data: {} });
    await old;
    await tick();
    finishes[1]!({ ok: false, error: { code: "OFFLINE", message: "revision 2 failed" } });
    await latest;
    expect(onDeviceTranscriptSyncState(tcw, "rec-1")).toEqual({ state: "failed", message: "revision 2 failed" });
  });

  test("r2: an older delayed native-read failure does not replace a newer successful sync", async () => {
    const tcw = account();
    let rejectOld!: (error: Error) => void;
    getTranscript = () => new Promise((_, reject) => { rejectOld = reject; });
    const old = syncOnDeviceTranscript(tcw, SAVED);
    await tick();
    getTranscript = async () => ({ transcript });
    const latest = syncOnDeviceTranscript(tcw, SAVED);
    rejectOld(new Error("older read failed"));
    await Promise.all([old, latest]);
    expect(onDeviceTranscriptSyncState(tcw, "rec-1")).toEqual({ state: "synced" });
  });

  test("r2: an older delayed revision-1 read does not hide revision-2's sync failure", async () => {
    const tcw = account();
    let resolveOld!: (result: { transcript: LocalTranscript | null }) => void;
    const written: number[] = [];
    getTranscript = () => new Promise((resolve) => { resolveOld = resolve; });
    save = async (saved) => {
      written.push(saved.rev);
      return written.length === 1 ? { ok: true, data: {} } : { ok: false, error: { code: "OFFLINE", message: "revision 2 failed" } };
    };
    const old = syncOnDeviceTranscript(tcw, SAVED);
    await tick();
    getTranscript = async () => ({ transcript: note(2) });
    const latest = syncOnDeviceTranscript(tcw, SAVED);
    resolveOld({ transcript });
    await Promise.all([old, latest]);
    expect(written).toEqual([1, 2]);
    expect(onDeviceTranscriptSyncState(tcw, "rec-1")).toEqual({ state: "failed", message: "revision 2 failed" });
  });

  test("r3: a newer read failure does not cancel an older usable transcript's space write", async () => {
    const tcw = account();
    let resolveOld!: (result: { transcript: LocalTranscript | null }) => void;
    let writes = 0;
    save = async () => { writes++; return { ok: true, data: {} }; };
    getTranscript = () => new Promise((resolve) => { resolveOld = resolve; });
    const old = syncOnDeviceTranscript(tcw, SAVED);
    await tick();
    getTranscript = async () => { throw new Error("sidecar busy"); };
    const latest = syncOnDeviceTranscript(tcw, SAVED);
    resolveOld({ transcript });
    await Promise.all([old, latest]);
    expect(writes).toBe(1);
    expect(onDeviceTranscriptSyncState(tcw, "rec-1")).toEqual({ state: "failed", message: "Couldn't read the transcript on this phone: sidecar busy" });
  });

  test("a native-read failure after an older write is the result, and does not undo the write", async () => {
    const tcw = account();
    let finish!: (r: SaveResult) => void;
    let writes = 0;
    save = () => { writes++; return new Promise((resolve) => { finish = resolve; }); };
    const old = syncOnDeviceTranscript(tcw, SAVED);
    await tick();
    getTranscript = async () => { throw new Error("sidecar busy"); };
    const latest = syncOnDeviceTranscript(tcw, SAVED);
    finish({ ok: true, data: {} });
    await Promise.all([old, latest]);
    expect(writes).toBe(1);
    expect(onDeviceTranscriptSyncState(tcw, "rec-1")).toEqual({ state: "failed", message: "Couldn't read the transcript on this phone: sidecar busy" });
  });

  test("a later attempt with no local transcript publishes nothing, so an earlier result stands", async () => {
    const tcw = account();
    let finish!: (r: SaveResult) => void;
    save = () => new Promise((resolve) => { finish = resolve; });
    const old = syncOnDeviceTranscript(tcw, SAVED);
    await tick();
    getTranscript = async () => ({ transcript: null });
    const latest = syncOnDeviceTranscript(tcw, SAVED);
    finish({ ok: true, data: {} });
    await Promise.all([old, latest]);
    expect(onDeviceTranscriptSyncState(tcw, "rec-1")).toEqual({ state: "synced" });
  });

  test("an attempt that rejects does not break the chain for later attempts", async () => {
    const tcw = account();
    let boom = true;
    const unsubscribe = subscribeOnDeviceTranscriptSync(() => {
      if (boom) { boom = false; throw new Error("listener blew up"); }
    });
    getTranscript = async () => { throw new Error("sidecar busy"); };
    const rejected = syncOnDeviceTranscript(tcw, SAVED);
    getTranscript = async () => ({ transcript });
    const next = syncOnDeviceTranscript(tcw, SAVED);
    await expect(rejected).rejects.toThrow("listener blew up");
    await next;
    unsubscribe();
    expect(onDeviceTranscriptSyncState(tcw, "rec-1")).toEqual({ state: "synced" });
    await syncOnDeviceTranscript(tcw, SAVED);
    expect(onDeviceTranscriptSyncState(tcw, "rec-1")).toEqual({ state: "synced" });
  });

  test("syncing while the write runs, then synced; subscribers hear both", async () => {
    const tcw = account();
    let finish!: (r: SaveResult) => void;
    save = () => new Promise((resolve) => { finish = resolve; });
    const heard: (string | undefined)[] = [];
    const unsubscribe = subscribeOnDeviceTranscriptSync(() => heard.push(onDeviceTranscriptSyncState(tcw, "rec-1")?.state));
    expect(onDeviceTranscriptSyncState(tcw, "rec-1")).toBeNull();
    const running = syncOnDeviceTranscript(tcw, SAVED);
    await new Promise((r) => setTimeout(r, 0));
    expect(onDeviceTranscriptSyncState(tcw, "rec-1")).toEqual({ state: "syncing" });
    finish({ ok: true, data: {} });
    await running;
    unsubscribe();
    expect(onDeviceTranscriptSyncState(tcw, "rec-1")).toEqual({ state: "synced" });
    expect(heard).toEqual(["syncing", "synced"]);
  });

  test("a write that comes back not ok is failed with its message, and logged", async () => {
    const tcw = account();
    const warned: unknown[][] = [];
    console.warn = (...args: unknown[]) => { warned.push(args); };
    save = async () => ({ ok: false, error: { code: "VOICE_NOTE_NOT_FOUND", message: "the voice note no longer exists" } });
    await syncOnDeviceTranscript(tcw, SAVED);
    expect(onDeviceTranscriptSyncState(tcw, "rec-1")).toEqual({ state: "failed", message: "the voice note no longer exists" });
    expect(warned.some((args) => String(args[0]).includes("Could not save the on-device transcript"))).toBe(true);
  });

  test("a write that throws is failed with the error's message", async () => {
    const tcw = account();
    save = async () => { throw new Error("space offline"); };
    await syncOnDeviceTranscript(tcw, SAVED);
    expect(onDeviceTranscriptSyncState(tcw, "rec-1")).toEqual({ state: "failed", message: "space offline" });
  });

  test("a failed read of the local transcript is failed too, and a retry that works ends in synced", async () => {
    const tcw = account();
    getTranscript = async () => { throw new Error("sidecar busy"); };
    await syncOnDeviceTranscript(tcw, SAVED);
    expect(onDeviceTranscriptSyncState(tcw, "rec-1")).toEqual({ state: "failed", message: "Couldn't read the transcript on this phone: sidecar busy" });
    getTranscript = async () => ({ transcript });
    await syncOnDeviceTranscript(tcw, SAVED);
    expect(onDeviceTranscriptSyncState(tcw, "rec-1")).toEqual({ state: "synced" });
  });

  test("nothing is published without a space row or without a local transcript", async () => {
    const tcw = account();
    await syncOnDeviceTranscript(tcw, { id: "rec-1", ledger: { audio: { state: "pending" } } });
    await syncOnDeviceTranscript(tcw, { id: "rec-1" });
    getTranscript = async () => ({ transcript: null });
    await syncOnDeviceTranscript(tcw, SAVED);
    expect(onDeviceTranscriptSyncState(tcw, "rec-1")).toBeNull();
  });

  test("state is per account and per note", async () => {
    const one = account();
    const two = account();
    await syncOnDeviceTranscript(one, SAVED);
    expect(onDeviceTranscriptSyncState(one, "rec-1")).toEqual({ state: "synced" });
    expect(onDeviceTranscriptSyncState(two, "rec-1")).toBeNull();
    expect(onDeviceTranscriptSyncState(one, "rec-2")).toBeNull();
  });
});
