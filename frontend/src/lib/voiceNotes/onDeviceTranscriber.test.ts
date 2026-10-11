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
