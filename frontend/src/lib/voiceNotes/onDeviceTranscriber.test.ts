// The local transcript -> space write publishes its result per note, so "Adding to this note…" cannot hang forever.
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { VoiceNotes, __setVoiceNotesForTests, type LocalTranscript, type VoiceNotesPlugin } from "./nativeVoiceNotes";

type SaveResult = { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } };
let save: () => Promise<SaveResult> = async () => ({ ok: true, data: {} });
const realStore = { ...(await import("./voiceNoteStore")) };
mock.module("./voiceNoteStore", () => ({ ...realStore, saveVoiceNoteTranscript: () => save() }));
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
  test("r2 review: an older delayed native-read failure must not replace a newer successful sync", async () => {
    const tcw = account();
    let rejectOld!: (error: Error) => void;
    getTranscript = () => new Promise((_, reject) => { rejectOld = reject; });
    const old = syncOnDeviceTranscript(tcw, SAVED);
    getTranscript = async () => ({ transcript });
    await syncOnDeviceTranscript(tcw, SAVED);
    expect(onDeviceTranscriptSyncState(tcw, "rec-1")).toEqual({ state: "synced" });
    rejectOld(new Error("older read failed"));
    await old;
    expect(onDeviceTranscriptSyncState(tcw, "rec-1")).toEqual({ state: "synced" });
  });

  test("r2 review: an older delayed revision-1 read must not hide revision-2 sync failure", async () => {
    const tcw = account();
    let resolveOld!: (result: { transcript: LocalTranscript | null }) => void;
    getTranscript = () => new Promise((resolve) => { resolveOld = resolve; });
    const old = syncOnDeviceTranscript(tcw, SAVED);
    getTranscript = async () => ({ transcript: { ...transcript, rev: 2 } });
    save = async () => ({ ok: false, error: { code: "OFFLINE", message: "revision 2 failed" } });
    await syncOnDeviceTranscript(tcw, SAVED);
    expect(onDeviceTranscriptSyncState(tcw, "rec-1")).toEqual({ state: "failed", message: "revision 2 failed" });
    save = async () => ({ ok: true, data: {} });
    resolveOld({ transcript });
    await old;
    expect(onDeviceTranscriptSyncState(tcw, "rec-1")).toEqual({ state: "failed", message: "revision 2 failed" });
  });

  test("review: an older failed attempt must not hide a newer successful sync", async () => {
    const tcw = account();
    const finishes: ((r: SaveResult) => void)[] = [];
    save = () => new Promise((resolve) => finishes.push(resolve));
    const old = syncOnDeviceTranscript(tcw, SAVED);
    await new Promise((r) => setTimeout(r, 0));
    const latest = syncOnDeviceTranscript(tcw, SAVED);
    await new Promise((r) => setTimeout(r, 0));
    finishes[1]!({ ok: true, data: {} });
    await latest;
    finishes[0]!({ ok: false, error: { code: "OFFLINE", message: "older request failed" } });
    await old;
    expect(onDeviceTranscriptSyncState(tcw, "rec-1")).toEqual({ state: "synced" });
  });

  test("review: an older revision's success must not hide the latest revision's failure", async () => {
    const tcw = account();
    const finishes: ((r: SaveResult) => void)[] = [];
    save = () => new Promise((resolve) => finishes.push(resolve));
    const old = syncOnDeviceTranscript(tcw, SAVED);
    await new Promise((r) => setTimeout(r, 0));
    getTranscript = async () => ({ transcript: { ...transcript, rev: 2 } });
    const latest = syncOnDeviceTranscript(tcw, SAVED);
    await new Promise((r) => setTimeout(r, 0));
    finishes[1]!({ ok: false, error: { code: "OFFLINE", message: "revision 2 failed" } });
    await latest;
    finishes[0]!({ ok: true, data: {} });
    await old;
    expect(onDeviceTranscriptSyncState(tcw, "rec-1")).toEqual({ state: "failed", message: "revision 2 failed" });
  });

  test("overlapping attempts: only the newest owns the state, whatever order they finish", async () => {
    const tcw = account();
    const finishes: ((r: SaveResult) => void)[] = [];
    save = () => new Promise((resolve) => finishes.push(resolve));
    const first = syncOnDeviceTranscript(tcw, SAVED);
    await new Promise((r) => setTimeout(r, 0));
    const second = syncOnDeviceTranscript(tcw, SAVED);
    await new Promise((r) => setTimeout(r, 0));
    const third = syncOnDeviceTranscript(tcw, SAVED);
    await new Promise((r) => setTimeout(r, 0));
    finishes[2]!({ ok: false, error: { code: "OFFLINE", message: "third failed" } });
    await third;
    finishes[0]!({ ok: true, data: {} });
    finishes[1]!({ ok: true, data: {} });
    await Promise.all([first, second]);
    expect(onDeviceTranscriptSyncState(tcw, "rec-1")).toEqual({ state: "failed", message: "third failed" });
  });

  test("an older write finishing while the newest still runs leaves the state syncing", async () => {
    const tcw = account();
    const finishes: ((r: SaveResult) => void)[] = [];
    save = () => new Promise((resolve) => finishes.push(resolve));
    const old = syncOnDeviceTranscript(tcw, SAVED);
    await new Promise((r) => setTimeout(r, 0));
    const latest = syncOnDeviceTranscript(tcw, SAVED);
    await new Promise((r) => setTimeout(r, 0));
    finishes[0]!({ ok: false, error: { code: "OFFLINE", message: "older failed" } });
    await old;
    expect(onDeviceTranscriptSyncState(tcw, "rec-1")).toEqual({ state: "syncing" });
    finishes[1]!({ ok: true, data: {} });
    await latest;
    expect(onDeviceTranscriptSyncState(tcw, "rec-1")).toEqual({ state: "synced" });
  });

  test("a native-read failure is the newest result: an older write finishing after it does not hide it", async () => {
    const tcw = account();
    let finish!: (r: SaveResult) => void;
    save = () => new Promise((resolve) => { finish = resolve; });
    const old = syncOnDeviceTranscript(tcw, SAVED);
    await new Promise((r) => setTimeout(r, 0));
    getTranscript = async () => { throw new Error("sidecar busy"); };
    await syncOnDeviceTranscript(tcw, SAVED);
    finish({ ok: true, data: {} });
    await old;
    expect(onDeviceTranscriptSyncState(tcw, "rec-1")).toEqual({ state: "failed", message: "Couldn't read the transcript on this phone: sidecar busy" });
  });

  test("a newer attempt with no local transcript does not strand an older write's result", async () => {
    const tcw = account();
    let finish!: (r: SaveResult) => void;
    save = () => new Promise((resolve) => { finish = resolve; });
    const old = syncOnDeviceTranscript(tcw, SAVED);
    await new Promise((r) => setTimeout(r, 0));
    getTranscript = async () => ({ transcript: null });
    await syncOnDeviceTranscript(tcw, SAVED);
    finish({ ok: true, data: {} });
    await old;
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
