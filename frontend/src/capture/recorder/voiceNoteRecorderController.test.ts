// The recorder's controller against the fake plugin (harness/fakeVoiceNotes):
// the data-safety paths, behaviourally. Record waits until status() and the
// retained events are heard; a remount picks up a running recording; a Stop
// racing the limit's auto-stop saves exactly once; another recording's
// auto-stop (retained from before a reload, or late) is saved in the background
// without touching the one on screen; listeners go on teardown; Save now after
// a failed save lands the receipt; a discarded recording is deleted and never
// saved, even when the limit races it or the phone keeps its copy.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";

import { captureEvents } from "@/capture/captureEvents";
import { registerPlayback } from "@/lib/audio/playback";
import { installDom } from "@/test/dom";
import { RecorderProvider, useRecorder, type RecorderValue } from "./RecorderProvider";
import type { VoiceNoteRecorder } from "./useVoiceNoteRecorder";
import { createFakeVoiceNotes, type FakeVoiceNotes } from "@/harness/fakeVoiceNotes";
import { fakeVoiceNoteStore } from "@/harness/fakeVoiceNoteStore";
import { memoryHoldStore } from "@/harness/memoryHoldStore";
import { __setVoiceNotesForTests, type CaptureSource, type VoiceNoteRecording, type VoiceNotesPlugin } from "@/lib/voiceNotes/nativeVoiceNotes";
import { readDefaultTranscriber, refreshEffectiveTranscriber, setDefaultIdentifySpeakers as setDefaultIdentifySpeakersForTest, setDefaultTranscriber, writeAccountDefaults } from "@/lib/voiceNotes/transcriberPreference";
import { createVoiceNoteTranscriber, HELD_NOTE_MESSAGE, type VoiceNoteTranscriber } from "@/lib/voiceNotes/voiceNoteTranscription";
import { createVoiceNotePipeline, VoiceNoteSaveDeferred, type VoiceNotePipeline } from "@/lib/voiceNotes/voiceNotePipeline";
import { advanceAccountGeneration } from "@/lib/voiceNotes/accountContext";
import { CONNECTORS_SQL_DB_NAME } from "@/lib/connectors/connectorStore";
import { consentToRecordingPrivateCloud, setRecordingRoute } from "./TranscriptionRouteControl";
import { loadNote } from "@/lib/voiceNotes/recordingNotes";
import { reportRecordingNoteSyncError } from "@/lib/voiceNotes/voiceNoteStore";
import { runOnSpaceLane, setSpaceLaneAbortGraceForTests, setSpaceLaneQueueWaitForTests } from "@/lib/spaceWriteLane";
import { setVoiceNoteSaveDeadlineForTests } from "@/lib/voiceNotes/saveDeadline";
import { createFakeOnDeviceStt } from "@/lib/voiceNotes/fakeOnDeviceStt";
import { __setOnDeviceSttForTests, isOnDeviceReady, type OnDeviceSttPlugin } from "@/lib/voiceNotes/onDeviceStt";
import { __resetOnDeviceSttStoreForTests, onDeviceSttStore } from "@/lib/voiceNotes/onDeviceSttStore";

const realStore = { ...(await import("@/lib/voiceNotes/voiceNoteStore")) };
mock.module("@/lib/voiceNotes/voiceNoteStore", () => ({
  ...realStore,
  saveVoiceNote: (...args: Parameters<typeof realStore.saveVoiceNote>) => (fakeVoiceNoteStore.save ?? realStore.saveVoiceNote)(...args),
}));
// Import after mock.module: both controller and hook must see the fake save path.
const { createVoiceNoteRecorderController } = await import("./voiceNoteRecorderController");
const { micRecoveryMode, readMicRecoveryMode } = await import("./MicDeniedRecovery");
const { isDiscarded, pendingStore, saveRecording } = await import("@/lib/voiceNotes/recorderSaves");
const { useVoiceNoteRecorder } = await import("./useVoiceNoteRecorder");

const tcw = { did: "did:example:alice", spaceId: "tinycloud:space" } as TinyCloudWeb;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Waits for a save to settle without assuming how many macrotasks it takes (CI and local runs differ). */
async function settled(done: () => boolean, what: string) {
  for (let attempt = 0; attempt < 400 && !done(); attempt++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  if (!done()) throw new Error(`Timed out waiting for ${what}`);
}

let fake: FakeVoiceNotes;
/** Stopped recordings still on the phone, as the shells keep them until a save is confirmed. */
let onPhone: VoiceNoteRecording[];
let saves: string[];
let noted: string[];
// The save guards are module-wide and outlive a test: every recording gets its own id.
let serial = 0;
let currentId: string | null = null;
let paused = false;
let plugin: VoiceNotesPlugin;

async function stopNatively(): Promise<VoiceNoteRecording> {
  const recording = { ...(await fake.plugin.stop()), id: currentId!, version: 2 as const, owner: tcw.did, rev: 1 };
  currentId = null;
  paused = false;
  onPhone.push(recording);
  return recording;
}

/** A recording made before this one, stopped at its limit, still on the phone. */
function earlier(): VoiceNoteRecording {
  const recording = { id: `old-${++serial}`, startedAt: 1, durationMs: 60_000, mimeType: "audio/mp4", sizeBytes: 4, silencedMs: 0, silencedEvents: 0, noSignalMs: 0, version: 2 as const, owner: tcw.did, rev: 1 };
  onPhone.push(recording);
  return recording;
}

/** deleteAudio calls that fail before the phone lets a copy go. */
let deleteFailures: number;
let deleteCalls: number;
let nativeDiscards: number;
let settingsOpens: number;
let micDenied: boolean;
let shortcutPending: boolean;
let microphoneGranted: boolean;

function controller(options: { tcw?: TinyCloudWeb | null; pipeline?: VoiceNotePipeline; consented?: boolean | (() => boolean); onDeviceReady?: boolean;
  diarization?: boolean;
  appleInterim?: boolean; transcriber?: VoiceNoteTranscriber; noteLoader?: typeof loadNote;
  noteRetryScheduler?: (delayMs: number, retry: () => void) => () => void;
  subscribeAppActive?: (listener: () => void) => Promise<{ remove(): Promise<void> }> } = {}) {
  return createVoiceNoteRecorderController({
    tcw: options.tcw === undefined ? tcw : options.tcw,
    pipeline: options.pipeline,
    available: true,
    transcriber: options.transcriber ?? { check: async () => {}, noteSaved: (recording) => noted.push(recording.id),
      snapshot: () => ({ availability: "available", consented: typeof options.consented === "function" ? options.consented() : options.consented ?? false,
        capabilities: { max_bytes: 120_960_000, diarization: options.diarization ?? true }, jobs: new Map() }) },
    onDeviceReady: () => options.onDeviceReady ?? true,
    appleInterim: () => options.appleInterim ?? false,
    noteLoader: options.noteLoader,
    noteRetryScheduler: options.noteRetryScheduler,
    subscribeAppActive: options.subscribeAppActive,
  });
}

const ok = async (_tcw: unknown, recording: VoiceNoteRecording) => {
  saves.push(recording.id);
  return { ok: true, data: { inserted: true } } as never;
};
const fails = async (_tcw: unknown, recording: VoiceNoteRecording) => {
  saves.push(recording.id);
  return { ok: false, error: { code: "NETWORK", message: "offline" } } as never;
};

beforeEach(() => {
  fake = createFakeVoiceNotes();
  onPhone = [];
  saves = [];
  noted = [];
  currentId = null;
  deleteFailures = 0;
  deleteCalls = 0;
  nativeDiscards = 0;
  settingsOpens = 0;
  micDenied = false;
  shortcutPending = false;
  microphoneGranted = true;
  plugin = {
    ...fake.plugin,
    async openSettings() { settingsOpens++; },
    async dismissShortcutRecovery() { micDenied = false; shortcutPending = false; },
    async consumeShortcutRecord() { shortcutPending = false; },
    async start(options) {
      const started = await fake.plugin.start(options);
      currentId = `note-${++serial}`;
      return { ...started, id: currentId };
    },
    stop: stopNatively,
    async status() {
      const status = await fake.plugin.status();
      return { ...status, state: paused ? "paused" as const : status.state, id: status.id === null ? null : currentId,
        audioMs: 42_000, micDeniedPresentation: micDenied, shortcutRecordPending: shortcutPending,
        microphonePermissionGranted: microphoneGranted };
    },
    async pause() { paused = true; },
    async resume() { paused = false; },
    async discard() {
      nativeDiscards++;
      if (!currentId) throw Object.assign(new Error("Not recording"), { code: "not_recording" });
      const id = currentId;
      await fake.plugin.stop();
      currentId = null;
      onPhone = onPhone.filter((recording) => recording.id !== id);
      return { id };
    },
    async listPending() {
      return { recordings: [...onPhone] };
    },
    async updateLedger() { return { rev: 2 }; },
    async deleteAudio({ id }) {
      deleteCalls++;
      if (deleteFailures > 0) {
        deleteFailures--;
        throw new Error("the file is busy");
      }
      onPhone = onPhone.filter((recording) => recording.id !== id);
    },
  };
  __setVoiceNotesForTests(plugin, { available: true });
  fakeVoiceNoteStore.save = ok;
});
afterEach(() => {
  fakeVoiceNoteStore.save = null;
  __setVoiceNotesForTests(plugin, { available: null });
});

async function attached() {
  const recorder = controller();
  const detach = recorder.attach();
  await tick();
  return { recorder, detach };
}

describe("voice-note recorder controller", () => {
  test("starting and resuming silence a playing note before native capture", async () => {
    const cleanupDom = installDom();
    const { recorder, detach } = await attached();
    const audio = document.createElement("audio");
    document.body.append(audio);
    let stops = 0;
    const unregister = registerPlayback(audio, () => { stops++; });
    const beforeStart = stops;
    await recorder.record();
    expect(stops).toBeGreaterThan(beforeStart);
    await recorder.pause();
    const beforeResume = stops;
    await recorder.resume();
    expect(stops).toBeGreaterThan(beforeResume);
    unregister();
    detach();
    cleanupDom();
  });
  test("Starting detaches the previous note until the new recording starts", async () => {
    const { recorder, detach } = await attached();
    await recorder.record();
    await tick();
    await recorder.setNoteText("Previous recording notes");
    await recorder.stop();
    await tick();
    expect(recorder.getState().lastSaved?.id).not.toBeNull();
    expect(recorder.getNote()?.md).toBe("Previous recording notes");
    recorder.dismissOutcome();

    const nativeStart = fake.plugin.start;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    fake.plugin.start = async (options) => { await gate; return nativeStart(options); };
    const starting = recorder.record();
    expect(recorder.getState().phase).toBe("starting");
    expect(recorder.getState().lastSaved?.id).not.toBeNull();
    expect(recorder.getNote()).toBeNull();
    release();
    await starting;
    detach();
  });

  test("maps linear native RMS once for every level subscriber; silence stays below the activity gate", async () => {
    const { recorder, detach } = await attached();
    const received: number[] = [];
    const unsubscribe = recorder.subscribeLevel((level) => received.push(level));
    fake.emit("level", { level: 10 ** (-25 / 20), peak: 10 ** (-10 / 20) });
    expect(received.at(-1)).toBeCloseTo(0.623, 2);
    fake.emit("level", { level: 0, peak: 0 });
    expect(received.at(-1)).toBe(0);
    unsubscribe();
    detach();
  });

  test("a signed-out recording keeps its Markdown local without starting a space sync", async () => {
    const recorder = controller({ tcw: null });
    const detach = recorder.attach();
    await tick();
    await recorder.record();
    const id = currentId!;
    await tick();
    await recorder.setNoteText("Signed-out draft");
    await recorder.stop();
    await tick();
    expect((await loadNote(id))?.md).toBe("Signed-out draft");
    expect(saves).toEqual([]);
    expect(recorder.getNoteSyncError()).toBeNull();
    detach();
  });

  test("note autosave survives a controller reload during native capture", async () => {
    const first = controller();
    const detach = first.attach();
    await tick();
    await first.record();
    const id = currentId!;
    await tick();
    await first.setNoteText("# Draft\n- **0:07** hallway");
    expect((await loadNote(id))?.md).toBe("# Draft\n- **0:07** hallway");
    detach();

    const reopened = controller();
    const remove = reopened.attach();
    await tick();
    await tick();
    expect(reopened.getState().recordingId).toBe(id);
    expect(reopened.getNote()).toEqual({ md: "# Draft\n- **0:07** hallway",
      moments: [{ atMs: 7_000, label: "hallway" }] });
    remove();
  });

  test("an edit during a reload's pending note read cannot replace the stored draft", async () => {
    const first = controller();
    const detach = first.attach();
    await tick();
    await first.record();
    await tick();
    const id = currentId!;
    await first.setNoteText("# Ten lines of work\nKeep this draft");
    detach();

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const reopened = controller({ noteLoader: async (noteId) => { await gate; return loadNote(noteId); } });
    const remove = reopened.attach();
    await tick();
    expect(reopened.getNoteStatus()).toBe("loading");
    await expect(reopened.setNoteText("x")).rejects.toMatchObject({ code: "note_not_loaded" });
    expect((await loadNote(id))?.md).toBe("# Ten lines of work\nKeep this draft");
    release();
    await tick();
    expect(reopened.getNoteStatus()).toBe("ready");
    expect(reopened.getNote()?.md).toBe("# Ten lines of work\nKeep this draft");
    remove();
  });

  test("note-load errors stay visible and retry at 1, 2, 4 … 30 seconds without mic-event retries", async () => {
    const first = controller();
    const detach = first.attach();
    await tick();
    await first.record();
    await tick();
    const id = currentId!;
    await first.setNoteText("Do not overwrite");
    detach();

    let available = false;
    let reads = 0;
    const timers: { ms: number; run: () => void; cancelled: boolean }[] = [];
    const readFailure = new Error("IndexedDB open failed");
    const reopened = controller({
      noteLoader: (noteId) => { reads++; return available ? loadNote(noteId) : Promise.reject(readFailure); },
      noteRetryScheduler: (ms, run) => {
        const timer = { ms, run, cancelled: false };
        timers.push(timer);
        return () => { timer.cancelled = true; };
      },
    });
    const remove = reopened.attach();
    await tick();
    expect(reopened.getNoteStatus()).toBe("error");
    await expect(reopened.setNoteText("x")).rejects.toBe(readFailure);
    expect((await loadNote(id))?.md).toBe("Do not overwrite");
    expect(timers.map((timer) => timer.ms)).toEqual([1_000]);
    fake.emit("micState", { id, state: "recording", reason: null, elapsedMs: 2_000 });
    await tick();
    expect(reads).toBe(1);
    expect(timers).toHaveLength(1);
    for (const delay of [2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
      timers.at(-1)!.run();
      await tick();
      expect(reopened.getNoteStatus()).toBe("error");
      expect(timers.at(-1)!.ms).toBe(delay);
    }
    available = true;
    timers.at(-1)!.run();
    await tick();
    expect(reopened.getNoteStatus()).toBe("ready");
    expect(reopened.getNote()?.md).toBe("Do not overwrite");
    expect((await loadNote(id))?.md).toBe("Do not overwrite");
    remove();
  });

  test("a recording change cancels the old note retry and starts the next at one second", async () => {
    const timers: { ms: number; run: () => void; cancelled: boolean }[] = [];
    const recorder = controller({ noteLoader: () => Promise.reject(new Error("offline local storage")),
      noteRetryScheduler: (ms, run) => {
        const timer = { ms, run, cancelled: false };
        timers.push(timer);
        return () => { timer.cancelled = true; };
      } });
    const detach = recorder.attach();
    await tick();
    await recorder.record();
    await tick();
    expect(recorder.getNoteStatus()).toBe("error");
    expect(timers.at(-1)?.ms).toBe(1_000);
    const old = timers.at(-1)!;
    await recorder.discard();
    expect(old.cancelled).toBe(true);
    await recorder.record();
    await tick();
    expect(recorder.getNoteStatus()).toBe("error");
    expect(timers.at(-1)?.ms).toBe(1_000);
    detach();
  });

  test("a Markdown sync failure has a short separate status that a successful sync clears", async () => {
    const account = { did: tcw.did, spaceId: "space:note-status" } as TinyCloudWeb;
    fakeVoiceNoteStore.save = async () => ({ ok: true, data: { id: "row", inserted: true,
      createdAt: new Date().toISOString(), noteSyncError: "sync_failed" } }) as never;
    const recorder = controller({ tcw: account });
    const detach = recorder.attach();
    await tick();
    await recorder.record();
    const id = currentId!;
    await recorder.stop();
    await tick();
    expect(recorder.getState().outcome).toBe("saved");
    expect(recorder.getNoteSyncError()).toBe("sync_failed");
    expect(recorder.getState().error).toBeNull();
    reportRecordingNoteSyncError(account, id, null);
    expect(recorder.getNoteSyncError()).toBeNull();
    detach();
  });

  test("discard deletes the local note with its native recording", async () => {
    const { recorder, detach } = await attached();
    await recorder.record();
    const id = currentId!;
    await tick();
    await recorder.setNoteText("To discard");
    await recorder.discard();
    expect(await loadNote(id)).toBeNull();
    expect(recorder.getNote()).toBeNull();
    detach();
  });

  test("a moment reads the native recorded clock across a long user pause and writes nothing", async () => {
    const originalNow = Date.now;
    let now = 100_000;
    Date.now = () => now;
    try {
      const { recorder, detach } = await attached();
      await recorder.record();
      const id = currentId!;
      fake.emit("micState", { id, state: "recording", reason: null, elapsedMs: 20_000 });
      now += 5_000;
      expect(recorder.markMoment()).toBe(25_000);
      fake.emit("micState", { id, state: "paused", reason: "user", elapsedMs: 25_000 });
      now += 40_000;
      expect(recorder.markMoment()).toBe(25_000);
      fake.emit("micState", { id, state: "recording", reason: null, elapsedMs: 25_000 });
      expect(recorder.markMoment()).toBe(25_000);
      expect(await loadNote(id)).toBeNull();
      detach();
    } finally { Date.now = originalNow; }
  });

  test("the recorder route control journals Private cloud after first-use consent", async () => {
    await fake.plugin.setCaptureDefaults({ accountDid: tcw.did, transitionGen: 1,
      transcriber: "on-device", identifySpeakers: false });
    let consented = false;
    const recorder = controller({ consented: () => consented });
    const detach = recorder.attach();
    await tick();
    await recorder.record();
    expect(await setRecordingRoute(recorder, "private-cloud")).toBe("needs_consent");
    expect((await fake.plugin.status()).options?.transcriber).toBe("on-device");

    expect(await consentToRecordingPrivateCloud(recorder, () => { consented = true; })).toBe("ok");
    expect((await fake.plugin.status()).options?.transcriber).toBe("private-cloud");
    expect(recorder.getTranscriber()).toEqual({ id: "private-cloud", identifySpeakers: true, source: "recording" });
    expect((await fake.plugin.getCaptureDefaults()).transcriber).toBe("on-device");
    const saved = await stopNatively();
    expect(saved.options?.transcriber).toBe("private-cloud");
    detach();
  });

  test("a saved native Private cloud note starts the JS cloud job", async () => {
    await fake.plugin.setCaptureDefaults({ accountDid: tcw.did, transitionGen: 1,
      transcriber: "private-cloud", identifySpeakers: false });
    const started: string[] = [];
    const transcriber = createVoiceNoteTranscriber({
      cloud: {
        capabilities: async () => ({ max_bytes: 120_960_000, max_duration_seconds: 7_200, content_types: ["audio/mp4"] }),
        pendingSourceIds: () => [],
        transcribe: async () => { throw new Error("runNote is injected"); },
        finish: async () => {},
        releaseUnsent: async () => {},
      },
      consent: { get: () => true, set: () => {} },
      tcw: () => tcw,
          holds: memoryHoldStore(),
      runNote: async ({ sourceId }) => { started.push(sourceId); return "transcribed"; },
    });
    await transcriber.check();
    const recorder = controller({ transcriber });
    const detach = recorder.attach();
    await tick();
    await recorder.record();
    expect((await fake.plugin.status()).options?.transcriber).toBe("private-cloud");
    await recorder.stop();
    await tick();
    expect(onPhone[0]?.options?.transcriber).toBe("private-cloud");
    expect(started).toEqual([onPhone[0]!.id]);
    expect(transcriber.snapshot().jobs.get(onPhone[0]!.id)).toMatchObject({ kind: "done" });
    detach();
  });

  test("native options own a live recording across a mid-recording change and WebView reload", async () => {
    await fake.plugin.setCaptureDefaults({ accountDid: tcw.did, transitionGen: 1,
      transcriber: "on-device", identifySpeakers: false });
    const first = controller({ consented: true });
    const detach = first.attach();
    await tick();
    await first.record();
    expect(first.getTranscriber()).toEqual({ id: "on-device", identifySpeakers: false, source: "recording" });
    expect(await first.setIdentifySpeakers(true, "recording")).toBe("unavailable");
    expect(first.getTranscriber().identifySpeakers).toBe(false);
    expect(await first.setTranscriber("private-cloud", { scope: "recording" })).toBe("ok");
    expect(first.getTranscriber()).toEqual({ id: "private-cloud", identifySpeakers: true, source: "recording" });
    expect(await first.setIdentifySpeakers(true, "recording")).toBe("ok");
    expect((await fake.plugin.getCaptureDefaults()).transcriber).toBe("on-device");
    detach();

    const second = controller({ consented: true });
    const remove = second.attach();
    await tick();
    expect(second.getTranscriber()).toEqual({ id: "private-cloud", identifySpeakers: true, source: "recording" });
    remove();
  });

  test("Private keeps speaker detection off when PTX reports no diarization", async () => {
    await fake.plugin.setCaptureDefaults({ accountDid: tcw.did, transitionGen: 1,
      transcriber: "private-cloud", identifySpeakers: true });
    const recorder = controller({ consented: true, diarization: false });
    const detach = recorder.attach();
    await tick();
    await recorder.record();
    expect((await fake.plugin.status()).options).toMatchObject({ transcriber: "private-cloud", identifySpeakers: false });
    expect(await recorder.setIdentifySpeakers(true, "recording")).toBe("unavailable");
    detach();
  });

  test("signed-out capture locks other modes and Off does not revoke private-cloud consent", async () => {
    const signedOut = controller({ tcw: {} as TinyCloudWeb, consented: true });
    const detach = signedOut.attach();
    await tick();
    await signedOut.record();
    expect(signedOut.getTranscriber()).toEqual({ id: "on-device", identifySpeakers: false, source: "recording" });
    expect(await signedOut.setTranscriber("off", { scope: "recording" })).toBe("locked_signed_out");
    expect(await signedOut.setTranscriber("private-cloud", { scope: "default" })).toBe("locked_signed_out");
    detach();

    await fake.plugin.setCaptureDefaults({ accountDid: tcw.did, transitionGen: 1,
      transcriber: "on-device", identifySpeakers: false });
    const signedIn = controller({ consented: true });
    const remove = signedIn.attach();
    await tick();
    expect(await signedIn.setTranscriber("off", { scope: "recording" })).toBe("ok");
    expect(signedIn.getTranscriber().id).toBe("off");
    expect((await fake.plugin.status()).options?.transcriber).toBe("off");
    remove();
  });

  test("private cloud and Powerful need separate consent; Local is allowed without its model", async () => {
    await fake.plugin.setCaptureDefaults({ accountDid: tcw.did, transitionGen: 1,
      transcriber: "on-device", identifySpeakers: false });
    const recorder = controller({ onDeviceReady: false });
    const detach = recorder.attach();
    await tick();
    await recorder.record();
    expect(await recorder.setTranscriber("private-cloud", { scope: "recording" })).toBe("needs_consent");
    expect(await recorder.setTranscriber("on-device", { scope: "recording" })).toBe("ok");
    expect(await recorder.setTranscriber("assemblyai", { scope: "recording" })).toBe("needs_consent");
    detach();
  });

  test("Apple interim refuses speaker identification without changing the saved preference", async () => {
    await fake.plugin.setCaptureDefaults({ accountDid: tcw.did, transitionGen: 3,
      transcriber: "on-device", identifySpeakers: false });
    const recorder = controller({ appleInterim: true });
    const detach = recorder.attach();
    await tick();
    await recorder.record();
    expect(await recorder.setIdentifySpeakers(true, "recording")).toBe("unavailable");
    expect(await recorder.setIdentifySpeakers(true, "default")).toBe("unavailable");
    expect((await fake.plugin.status()).options?.identifySpeakers).toBe(false);
    expect((await fake.plugin.getCaptureDefaults()).identifySpeakers).toBe(false);
    detach();
  });

  test("default changes keep the transition generation and speaker preference across a disabled mode", async () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    const values = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    } });
    try {
      await fake.plugin.setCaptureDefaults({ accountDid: tcw.did, transitionGen: 7,
        transcriber: "on-device", identifySpeakers: false });
      const recorder = controller({ consented: true });
      const detach = recorder.attach();
      await tick();
      expect(await recorder.setTranscriber("private-cloud", { scope: "default" })).toBe("ok");
      expect(recorder.getTranscriber()).toEqual({ id: "private-cloud", identifySpeakers: true, source: "default" });
      expect(await fake.plugin.getCaptureDefaults()).toMatchObject({ transitionGen: 7,
        transcriber: "private-cloud", identifySpeakers: true });
      expect(values.get("exo.voiceNotes.identifySpeakers")).toBe("1");
      expect(await recorder.setTranscriber("on-device", { scope: "default" })).toBe("ok");
      expect(recorder.getTranscriber()).toEqual({ id: "on-device", identifySpeakers: false, source: "default" });
      expect(await fake.plugin.getCaptureDefaults()).toMatchObject({ transitionGen: 7,
        transcriber: "on-device", identifySpeakers: false });
      await setDefaultTranscriber("off"); // Settings uses the same preference store.
      expect(recorder.getTranscriber()).toEqual({ id: "off", identifySpeakers: false, source: "default" });
      detach();
    } finally {
      if (previous) Object.defineProperty(globalThis, "localStorage", previous);
      else Reflect.deleteProperty(globalThis, "localStorage");
    }
  });

  test("listeners: eight while attached, none after teardown", async () => {
    const { detach } = await attached();
    expect(fake.stats().active).toBe(8);
    detach();
    await tick();
    expect(fake.stats().active).toBe(0);
  });

  test("Record waits until status() and the retained events have been heard", async () => {
    const recorder = controller();
    recorder.attach();
    expect(recorder.getState().ready).toBe(false);
    await recorder.record();
    expect(fake.stats().recording).toBe(false);
    await tick();
    expect(recorder.getState().ready).toBe(true);
    await recorder.record();
    expect(recorder.getState().phase).toBe("recording");
  });

  test("an unsupported or stalled sidecar scan cannot delay the first Record", async () => {
    __setVoiceNotesForTests({ ...plugin, listPending: () => new Promise(() => {}) }, { available: true });
    const stalled = controller();
    const detachStalled = stalled.attach();
    await tick();
    expect(stalled.getState().ready).toBe(true);
    detachStalled();

    __setVoiceNotesForTests({ ...plugin, listPending: undefined as never }, { available: true });
    const unsupported = controller();
    const detachUnsupported = unsupported.attach();
    await tick();
    expect(unsupported.getState().ready).toBe(true);
    detachUnsupported();
  });

  test("an invalid account space is logged after construction without blanking the recorder", async () => {
    const errors: unknown[][] = [];
    const original = console.error;
    console.error = (...args) => { errors.push(args); };
    try {
      const badAccount = { did: tcw.did, spaceId: {} } as TinyCloudWeb;
      const recorder = controller({ tcw: badAccount });
      expect(errors).toEqual([]); // The controller is constructed during render.
      const detach = recorder.attach();
      await tick();
      expect(recorder.getState().ready).toBe(true);
      expect(errors.some(([message]) => String(message).includes("Invalid account identifiers"))).toBe(true);
      detach();
    } finally { console.error = original; }
  });

  test("a remount picks up the running recording through status(), never starting another", async () => {
    const first = await attached();
    await first.recorder.record();
    const id = first.recorder.getState().recordingId;
    expect(id).not.toBeNull();
    first.detach();

    const second = await attached();
    expect(second.recorder.getState()).toMatchObject({ phase: "recording", recordingId: id });
    expect(fake.stats().adds).toBe(16);
  });

  test("Stop shows a phone receipt before cloud upload resolves", async () => {
    let release!: () => void;
    fakeVoiceNoteStore.save = async (_tcw, recording) => {
      saves.push(recording.id);
      await new Promise<void>((resolve) => { release = resolve; });
      return { ok: true, data: { inserted: true } } as never;
    };
    const { recorder } = await attached();
    await recorder.record();
    await recorder.stop();
    await tick();
    expect(recorder.getState()).toMatchObject({ phase: "idle", outcome: "local" });
    expect(onPhone).toHaveLength(1);
    release();
    await tick();
    expect(recorder.getState().outcome).toBe("saved");
    expect(onPhone).toHaveLength(1);
    expect(deleteCalls).toBe(0);
  });

  test("a WebKit network failure shows one friendly message and logs once", async () => {
    fakeVoiceNoteStore.save = async () => { throw new TypeError("Load failed"); };
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args); };
    const { recorder, detach } = await attached();
    try {
      await recorder.record();
      await recorder.stop();
      await tick();
      const friendly = "Waiting for a connection · syncs by itself";
      expect(recorder.getState().error).toBe(friendly);
      expect(warnings.filter(([message]) => String(message).includes("TinyCloud network failure"))).toHaveLength(1);
    } finally {
      detach();
      console.warn = originalWarn;
    }
  });

  test("Stop during sign-out keeps the receipt held even when a cancelled save rejects after re-arm", async () => {
    const account = { ...tcw, spaceId: "tinycloud:space" } as TinyCloudWeb;
    let attempted = 0;
    const pipeline: VoiceNotePipeline = {
      process: async () => { attempted++; throw new VoiceNoteSaveDeferred(); },
      reconcileAll: async () => {}, cancelAll: () => {}, resume: () => {},
      isAccepting: () => true, quiescent: async () => true,
    };
    const recorder = controller({ tcw: account, pipeline });
    const detach = recorder.attach();
    await tick();
    await recorder.record();
    await recorder.stop();
    await tick();
    expect(attempted).toBe(1);
    expect(recorder.getState()).toMatchObject({ phase: "idle", outcome: "local", localUpload: "held", error: null });
    expect(onPhone).toHaveLength(1);
    expect(saves).toEqual([]);
    detach();
  });

  test("an upload already in flight cannot erase the phone receipt", async () => {
    let release!: () => void;
    fakeVoiceNoteStore.save = async (_tcw, recording) => {
      saves.push(recording.id);
      await new Promise<void>((resolve) => { release = resolve; });
      return { ok: true, data: { inserted: true } } as never;
    };
    const { recorder } = await attached();
    await recorder.record();
    const id = recorder.getState().recordingId!;
    const competing = saveRecording(tcw, {
      id, startedAt: 1, durationMs: 42_000, mimeType: "audio/mp4", sizeBytes: 4,
      silencedMs: 0, silencedEvents: 0, noSignalMs: 0,
    });
    await tick();
    await recorder.stop();
    await tick();
    expect(recorder.getState()).toMatchObject({ phase: "idle", outcome: "local", lastSaved: { id } });
    expect(saves).toEqual([id]);
    release();
    await competing;
  });

  test("Pause and Resume follow native state and keep audio time", async () => {
    const { recorder } = await attached();
    await recorder.record();
    await recorder.pause();
    expect(recorder.getState()).toMatchObject({ phase: "recording", mic: { state: "paused" }, audioMs: 42_000 });
    await recorder.resume();
    expect(recorder.getState()).toMatchObject({ phase: "recording", mic: { state: "recording" }, audioMs: 42_000 });
  });

  test("presentRecorder opens only for the live native recording", async () => {
    const { recorder } = await attached();
    let presented = 0;
    recorder.setOnPresent(() => presented++);
    const emit = fake.emit as unknown as (event: string, payload: { id: string }) => void;
    emit("presentRecorder", { id: "stale" });
    await tick();
    expect(presented).toBe(0);
    await recorder.record();
    emit("presentRecorder", { id: recorder.getState().recordingId! });
    await tick();
    expect(presented).toBe(1);
    await recorder.stop();
    emit("presentRecorder", { id: "stale" });
    await tick();
    expect(presented).toBe(1);
  });

  test("shortcut denial opens the recorder without a recording and grant clears it", async () => {
    const { recorder } = await attached();
    let presented = 0;
    recorder.setOnPresent(() => presented++);
    const emit = fake.emit as unknown as (event: string, payload: { id: null; reason: string }) => void;
    micDenied = true;
    shortcutPending = true;
    microphoneGranted = false;
    emit("presentRecorder", { id: null, reason: "permission_denied" });
    await tick();
    expect(recorder.getState()).toMatchObject({ phase: "idle", recordingId: null, permissionDenied: true });
    expect(presented).toBe(1);
    await recorder.openSettings();
    expect(settingsOpens).toBe(1);
    micDenied = false;
    microphoneGranted = true;
    emit("presentRecorder", { id: null, reason: "permission_granted" });
    await tick();
    expect(recorder.getState().permissionDenied).toBe(false);
    await recorder.record();
    expect(recorder.getState().phase).toBe("recording");
  });

  test("app-active recheck clears a missed grant event without relaunch", async () => {
    let appActive: () => void = () => {};
    const recorder = controller({ subscribeAppActive: async (listener) => {
      appActive = listener;
      return { remove: async () => { appActive = () => {}; } };
    } });
    const detach = recorder.attach();
    await tick();
    micDenied = true;
    microphoneGranted = false;
    fake.emit("presentRecorder", { id: null, reason: "permission_denied" });
    await tick();
    expect(recorder.getState().permissionDenied).toBe(true);
    appActive();
    await tick();
    expect(recorder.getState().permissionDenied).toBe(true);
    // The native grant event was missed while Settings covered the WebView.
    micDenied = false;
    microphoneGranted = true;
    appActive();
    await tick();
    expect(recorder.getState().permissionDenied).toBe(false);
    await recorder.record();
    expect(recorder.getState().phase).toBe("recording");
    detach();
  });

  test("a cold shortcut's retained event reaches the controller's first listener", async () => {
    const started = await plugin.start();
    fake.retainPresentRecorder({ id: started.id });
    const listenersBeforeRead = fake.stats().adds;
    expect(await readMicRecoveryMode()).toBeNull();
    expect(fake.stats().adds).toBe(listenersBeforeRead);
    const recorder = controller();
    let presented = 0;
    recorder.setOnPresent(() => presented++);
    const detach = recorder.attach();
    await tick();
    expect(recorder.getState()).toMatchObject({ phase: "recording", recordingId: started.id });
    expect(presented).toBeGreaterThan(0);
    detach();
  });

  test("a signed-out iOS cold quick action opens after the provider installs its callback", async () => {
    const started = await plugin.start();
    __setVoiceNotesForTests({ ...plugin, status: async () => ({ ...await plugin.status(), source: "quick_action" }) },
      { available: true });
    const recorder = controller({ tcw: null });
    const detach = recorder.attach();
    await tick(); // Native status arrives before RecorderProvider's setOnPresent effect.
    expect(recorder.getState()).toMatchObject({ phase: "recording", recordingId: started.id });
    let presented = 0;
    recorder.setOnPresent(() => presented++);
    expect(presented).toBe(1);
    recorder.setOnPresent(() => presented++);
    expect(presented).toBe(1);
    detach();
  });

  test("every cold external capture source opens above the sign-in gate", async () => {
    const started = await plugin.start();
    const base = plugin;
    for (const source of ["app_shortcut", "quick_action", "notification", "intent", "control", "widget", "tile"] satisfies CaptureSource[]) {
      __setVoiceNotesForTests({ ...base, status: async () => ({ ...await base.status(), source }) }, { available: true });
      const recorder = controller({ tcw: null });
      let presented = 0;
      recorder.setOnPresent(() => presented++);
      const detach = recorder.attach();
      await tick();
      expect(recorder.getState().recordingId).toBe(started.id);
      expect(presented).toBe(1);
      detach();
    }
  });

  test("signed-out recovery explains a grant while the Record intent is held", async () => {
    const status = await plugin.status();
    expect(micRecoveryMode({ ...status, micDeniedPresentation: true, shortcutRecordPending: true })).toBe("denied");
    expect(micRecoveryMode({ ...status, micDeniedPresentation: false, shortcutRecordPending: true,
      microphonePermissionGranted: true })).toBe("sign-in");
    expect(micRecoveryMode({ ...status, shortcutRecordPending: false })).toBeNull();
  });

  test("a retained denial already dismissed at the sign-in gate stays dismissed", async () => {
    fake.retainPresentRecorder({ id: null, reason: "permission_denied" });
    const recorder = controller();
    let presented = 0;
    recorder.setOnPresent(() => presented++);
    const detach = recorder.attach();
    await tick();
    expect(recorder.getState().permissionDenied).toBe(false);
    expect(presented).toBe(0);
    detach();
  });

  test("minimising a denied recorder clears native recovery before another resume", async () => {
    const { recorder } = await attached();
    let presented = 0;
    recorder.setOnPresent(() => presented++);
    micDenied = true;
    shortcutPending = true;
    microphoneGranted = false;
    const emit = fake.emit as unknown as (event: string, payload: { id: null; reason: string }) => void;
    emit("presentRecorder", { id: null, reason: "permission_denied" });
    await tick();
    expect(recorder.getState().permissionDenied).toBe(true);
    await recorder.dismissShortcutRecovery();
    expect(micDenied).toBe(false);
    expect(shortcutPending).toBe(false);
    emit("presentRecorder", { id: null, reason: "permission_denied" });
    await tick();
    expect(recorder.getState().permissionDenied).toBe(false);
    expect(presented).toBe(1);
  });

  test("a denied shortcut during a receipt shows microphone recovery", async () => {
    const { recorder } = await attached();
    let presented = 0;
    recorder.setOnPresent(() => presented++);
    await recorder.record();
    await recorder.stop();
    await tick();
    expect(["local", "saved"]).toContain(recorder.getState().outcome);
    const emit = fake.emit as unknown as (event: string, payload: { id: null; reason: string }) => void;
    micDenied = true;
    microphoneGranted = false;
    emit("presentRecorder", { id: null, reason: "permission_denied" });
    await tick();
    expect(recorder.getState().permissionDenied).toBe(true);
    expect(presented).toBe(1);
  });

  test("Stop racing the limit's auto-stop saves exactly once, whichever arrives first", async () => {
    for (const order of ["stop-first", "auto-first"] as const) {
      saves = [];
      const { recorder, detach } = await attached();
      await recorder.record();
      // The native recorder stops itself at the limit: stop() now answers not_recording.
      const recording = await stopNatively();
      const autoStopped = { reason: "max_duration" as const, maxDurationMs: 60_000, at: Date.now(), recording };
      if (order === "stop-first") {
        await recorder.stop();
        fake.emit("autoStopped", autoStopped);
      } else {
        fake.emit("autoStopped", autoStopped);
        await recorder.stop();
      }
      await tick();
      await tick();
      expect(saves).toEqual([recording.id]);
      expect(recorder.getState()).toMatchObject({ phase: "idle", outcome: "saved", limitNotice: "Stopped at the 1-minute limit." });
      detach();
    }
  });

  test("a retained auto-stop for an earlier recording, heard while another records: that one keeps recording, the earlier one is saved", async () => {
    const { recorder } = await attached();
    await recorder.record();
    const live = recorder.getState().recordingId;
    const old = earlier();
    fake.emit("autoStopped", { reason: "max_duration", maxDurationMs: 60_000, at: Date.now(), recording: old });
    await tick();
    await tick();
    expect(recorder.getState()).toMatchObject({ phase: "recording", recordingId: live, outcome: null, limitNotice: null });
    expect(saves).toEqual([old.id]);
    expect(noted).toEqual([old.id]);
    expect(onPhone.map((recording) => recording.id)).toEqual([old.id]);
    expect(fake.stats().recording).toBe(true);
  });

  test("a save that lands while availability is still being checked is handed to the transcriber once the answer is in", async () => {
    let answer!: () => void;
    const checked = new Promise<void>((resolve) => { answer = resolve; });
    const transcriber = { check: () => checked, noteSaved: (recording: VoiceNoteRecording) => noted.push(recording.id) } as unknown as VoiceNoteTranscriber;
    const recorder = controller({ transcriber });
    const detach = recorder.attach();
    await tick();
    await recorder.record();
    const old = earlier();
    fake.emit("autoStopped", { reason: "max_duration", maxDurationMs: 60_000, at: Date.now(), recording: old });
    await tick();
    await tick();
    expect(saves).toEqual([old.id]);
    expect(noted).toEqual([]);
    answer();
    await tick();
    expect(noted).toEqual([old.id]);
    detach();
  });

  test("an earlier recording's save landing late never resets the recording now under way", async () => {
    let release!: () => void;
    fakeVoiceNoteStore.save = async (_tcw, recording) => {
      saves.push(recording.id);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { ok: true, data: { inserted: true } } as never;
    };
    const { recorder } = await attached();
    // The retained auto-stop arrives while nothing is under way: its save is shown...
    const old = earlier();
    fake.emit("autoStopped", { reason: "max_duration", maxDurationMs: 60_000, at: Date.now(), recording: old });
    await tick();
    expect(recorder.getState()).toMatchObject({ phase: "idle", outcome: "local", lastSaved: { id: old.id } });
    // ...a second copy of the event (heard again after a remount) is not another save...
    fake.emit("autoStopped", { reason: "max_duration", maxDurationMs: 60_000, at: Date.now(), recording: old });
    await tick();
    expect(saves).toEqual([old.id]);
    release();
    await tick();
    await tick();
    expect(recorder.getState()).toMatchObject({ phase: "idle", outcome: "saved" });
    expect(recorder.getState().lastSaved?.id).toBe(old.id);
  });

  test("a failed save keeps the note; Save now lands it and the receipt says so", async () => {
    fakeVoiceNoteStore.save = fails;
    const { recorder } = await attached();
    await recorder.record();
    await recorder.stop();
    await tick();
    const failed = recorder.getState();
    expect(failed.outcome).toBe("failed");
    expect(failed.failedRecording?.id).toBe(onPhone[0]?.id);
    // A receipt still showing never starts another recording.
    await recorder.record();
    expect(recorder.getState().phase).toBe("idle");

    fakeVoiceNoteStore.save = ok;
    await recorder.retryPending();
    expect(recorder.getState()).toMatchObject({ outcome: "saved", error: null, failedRecording: null });
    expect(recorder.getState().lastSaved?.id).toBe(failed.failedRecording!.id);
    expect(noted).toEqual([failed.failedRecording!.id]);
    expect(onPhone.map((recording) => recording.id)).toEqual([failed.failedRecording!.id]);
  });

  test("Save now reclaims a fresh sign-in note and resumes its account pipeline", async () => {
    const account = { did: tcw.did, spaceId: "tinycloud:space" } as TinyCloudWeb;
    const note = { ...earlier(), owner: null };
    onPhone = [note];
    let claimed = 0;
    let accepting = false;
    const base = plugin;
    __setVoiceNotesForTests({ ...base,
      getCaptureDefaults: async () => ({ status: "signed_in", accountDid: account.did, transitionGen: 1,
        transcriber: "on-device", identifySpeakers: false }),
      async setCaptureDefaults() {
        for (const pending of onPhone) if (!pending.owner) { pending.owner = account.did; claimed++; }
        return { claimed: onPhone.map((pending) => pending.id) };
      } }, { available: true });
    const pipeline: VoiceNotePipeline = {
      process: async () => {}, cancelAll: () => { accepting = false; },
      resume: () => { accepting = true; }, isAccepting: () => accepting, quiescent: async () => true,
      reconcileAll: async (_ctx, trigger) => {
        expect(trigger).toBe("manual");
        expect(accepting).toBe(true);
        expect(onPhone[0]?.owner).toBe(account.did);
        const result = await saveRecording(account, onPhone[0]!);
        expect(result.kind).toBe("saved");
      },
    };
    const recorder = controller({ tcw: account, pipeline });
    const detach = recorder.attach();
    await tick();
    await recorder.retryPending();
    expect(claimed).toBe(1);
    expect(saves).toEqual([note.id]);
    expect(recorder.getState().ready).toBe(true);
    expect(accepting).toBe(true);
    detach();
  });

  test("fresh sign-in then Done starts the automatic upload and shows it saving", async () => {
    const signedOut = controller({ tcw: null });
    const detachSignedOut = signedOut.attach();
    await tick();
    detachSignedOut();
    await fake.plugin.setCaptureDefaults({ accountDid: tcw.did, transitionGen: 1,
      transcriber: "on-device", identifySpeakers: false });
    let release!: () => void;
    const uploadWaiting = new Promise<void>((resolve) => { release = resolve; });
    const processed: string[] = [];
    const pipeline: VoiceNotePipeline = {
      process: async (_ctx, id) => {
        processed.push(id);
        await uploadWaiting;
        onPhone.find((note) => note.id === id)!.ledger = {
          audio: { state: "saved", rowId: `vn-${id}`, at: Date.now() },
        } as VoiceNoteRecording["ledger"];
      },
      reconcileAll: async () => {}, cancelAll: () => {}, resume: () => {},
      isAccepting: () => true, quiescent: async () => true,
    };
    const recorder = controller({ pipeline });
    const detach = recorder.attach();
    await tick();
    await recorder.record();
    await recorder.stop();
    await tick();
    expect(processed).toEqual([onPhone[0]!.id]);
    expect(recorder.getState()).toMatchObject({ outcome: "local", localUpload: "uploading" });
    expect(pendingStore.snapshot().running).toBe(true);
    release();
    await tick();
    expect(recorder.getState()).toMatchObject({ outcome: "saved", error: null });
    expect(pendingStore.snapshot().running).toBe(false);
    detach();
  });

  test("Save now reports an unavailable fresh sign-in client instead of silently refreshing", async () => {
    const recorder = controller({ tcw: null });
    const detach = recorder.attach();
    await tick();
    onPhone = [earlier()];
    await recorder.retryPending();
    expect(recorder.getState().ready).toBe(true);
    expect(pendingStore.snapshot().lastError)
      .toContain("account space is not ready");
    expect(saves).toEqual([]);
    detach();
  });

  test("Save now keeps saving past 20 seconds and clears the row on success", async () => {
    const base = plugin;
    __setVoiceNotesForTests({ ...base,
      getCaptureDefaults: async () => ({ status: "signed_in", accountDid: tcw.did, transitionGen: 1,
        transcriber: "on-device", identifySpeakers: false }),
      setCaptureDefaults: async () => ({ claimed: [] }),
    }, { available: true });
    const note = earlier();
    let settled = false;
    let reconcileRuns = 0;
    const pipeline: VoiceNotePipeline = {
      process: async () => {}, cancelAll: () => {}, resume: () => {},
      isAccepting: () => true, quiescent: async () => true,
      reconcileAll: async () => {
        reconcileRuns++;
        await new Promise((resolve) => setTimeout(resolve, 20_100));
        settled = true;
        note.ledger = { audio: { state: "saved", rowId: "row", at: Date.now() } } as VoiceNoteRecording["ledger"];
      },
    };
    const recorder = controller({ pipeline });
    const detach = recorder.attach();
    await tick();
    const saving = recorder.retryPending();
    const doubleTap = recorder.retryPending();
    await tick();
    expect(pendingStore.snapshot().running).toBe(true);
    expect(settled).toBe(false);
    await Promise.all([saving, doubleTap]);
    expect(reconcileRuns).toBe(1);
    expect(settled).toBe(true);
    expect(pendingStore.snapshot()).toMatchObject({ running: false, lastError: null, listing: { state: "ok", count: 0 } });
    detach();
  }, 35_000);

  test("Save now reports a call timeout after refresh and clears saving without a second pass", async () => {
    __setVoiceNotesForTests({ ...plugin,
      getCaptureDefaults: async () => ({ status: "signed_in", accountDid: tcw.did, transitionGen: 1,
        transcriber: "on-device", identifySpeakers: false }),
      setCaptureDefaults: async () => ({ claimed: [] }),
    }, { available: true });
    const note = earlier();
    let reconcileRuns = 0;
    const pipeline: VoiceNotePipeline = {
      process: async () => {}, cancelAll: () => {}, resume: () => {},
      isAccepting: () => true, quiescent: async () => true,
      reconcileAll: async () => {
        reconcileRuns++;
        try {
          await runOnSpaceLane((signal) => new Promise((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          }), { operation: `KV put controller-test/${note.id}` });
        } catch (error) {
          pendingStore.reportNoteFailure(note.id, error instanceof Error ? error.message : String(error));
        }
      },
    };
    setVoiceNoteSaveDeadlineForTests(20);
    const recorder = controller({ pipeline });
    const detach = recorder.attach();
    await tick();
    pendingStore.setAccount(tcw.did!);
    const first = recorder.retryPending();
    const doubleTap = recorder.retryPending();
    await tick();
    expect(pendingStore.snapshot().running).toBe(true);
    await Promise.all([first, doubleTap]);
    expect(reconcileRuns).toBe(1);
    expect(pendingStore.snapshot()).toMatchObject({ running: false, listing: { state: "ok", count: 1 } });
    expect(pendingStore.snapshot().lastError).toContain("Saving to your TinyCloud space is slow");
    setVoiceNoteSaveDeadlineForTests(null);
    pendingStore.setAccount(null);
    detach();
  });

  test("Save now settles visibly when a stuck SQL call is ahead of it in the lane", async () => {
    __setVoiceNotesForTests({ ...plugin,
      getCaptureDefaults: async () => ({ status: "signed_in", accountDid: tcw.did, transitionGen: 1,
        transcriber: "on-device", identifySpeakers: false }),
      setCaptureDefaults: async () => ({ claimed: [] }),
    }, { available: true });
    const note = earlier();
    setVoiceNoteSaveDeadlineForTests(100);
    setSpaceLaneAbortGraceForTests(500);
    setSpaceLaneQueueWaitForTests(20);
    let sqlSignal: AbortSignal | undefined;
    const stuckSqlDb = { execute: (_sql: string, _params: unknown[], options: { signal?: AbortSignal }) => {
      sqlSignal = options.signal;
      // Simulate SQL execute ignoring its SDK abort signal and never settling.
      return new Promise<never>(() => {});
    } };
    const stuckSql = runOnSpaceLane((signal) => stuckSqlDb.execute(
      "INSERT INTO connector_meeting (...) VALUES (...)", [], { signal }),
    { operation: `SQL execute: INSERT stuck controller-test/${note.id}` }).catch((error: unknown) => error);
    const initialTimeout = await stuckSql;
    expect(initialTimeout).toMatchObject({ code: "VOICE_NOTE_OPERATION_TIMEOUT" });
    expect(sqlSignal?.aborted).toBe(true);

    let queuedSqlDispatches = 0;
    const queuedSqlDb = { execute: async (_sql: string, _params: unknown[], _options: { signal?: AbortSignal }) => {
      queuedSqlDispatches++;
      return { ok: true };
    } };
    const pipeline: VoiceNotePipeline = {
      process: async () => {}, cancelAll: () => {}, resume: () => {},
      isAccepting: () => true, quiescent: async () => true,
      reconcileAll: () => runOnSpaceLane((signal) => queuedSqlDb.execute(
        "UPDATE connector_meeting SET metadata = ?", [], { signal }),
      { operation: `SQL execute: Save now ${note.id}` }).then(() => undefined),
    };
    const recorder = controller({ pipeline });
    const detach = recorder.attach();
    try {
      await tick();
      pendingStore.setAccount(tcw.did!);
      const saving = recorder.retryPending();
      await tick();
      expect(pendingStore.snapshot().running).toBe(true);
      await saving;
      expect(pendingStore.snapshot()).toMatchObject({ running: false, listing: { state: "ok", count: 1 } });
      expect(pendingStore.snapshot().lastError).toContain("waiting for another sync to finish");
      expect(pendingStore.snapshot().lastError).not.toContain("connection");
      expect(queuedSqlDispatches).toBe(0);
      // Let the post-abort grace release the intentionally unresolved SQL request
      // before the next test enqueues work on this module-level lane.
      await new Promise((resolve) => setTimeout(resolve, 450));
    } finally {
      setVoiceNoteSaveDeadlineForTests(null);
      setSpaceLaneAbortGraceForTests(null);
      setSpaceLaneQueueWaitForTests(null);
      pendingStore.setAccount(null);
      detach();
    }
  });

  test("a Save now still running when another account signs in never touches that account's pending row", async () => {
    __setVoiceNotesForTests({ ...plugin,
      getCaptureDefaults: async () => ({ status: "signed_in", accountDid: tcw.did, transitionGen: 1,
        transcriber: "on-device", identifySpeakers: false }),
      setCaptureDefaults: async () => ({ claimed: [] }),
    }, { available: true });
    const outcomes: Array<{ resolve(): void; reject(error: Error): void }> = [];
    const pipeline: VoiceNotePipeline = {
      process: async () => {}, cancelAll: () => {}, resume: () => {},
      isAccepting: () => true, quiescent: async () => true,
      reconcileAll: () => new Promise<void>((resolve, reject) => { outcomes.push({ resolve, reject }); }),
    };
    const recorder = controller({ pipeline });
    const detach = recorder.attach();
    await tick();
    for (const finish of ["reject", "resolve"] as const) {
      pendingStore.setAccount(tcw.did!);
      const saving = recorder.retryPending();
      while (outcomes.length === 0) await tick();
      pendingStore.setAccount("did:example:bob");
      pendingStore.reportError("Bob's save failed");
      const outcome = outcomes.shift()!;
      if (finish === "reject") outcome.reject(new Error("A's space timed out"));
      else outcome.resolve();
      await saving;
      expect(pendingStore.snapshot()).toMatchObject({ accountDid: "did:example:bob", lastError: "Bob's save failed" });
    }
    pendingStore.setAccount(null);
    detach();
  });

  test("a Save now that starts before the saver registers its account still shows its result", async () => {
    __setVoiceNotesForTests({ ...plugin,
      getCaptureDefaults: async () => ({ status: "signed_in", accountDid: tcw.did, transitionGen: 1,
        transcriber: "on-device", identifySpeakers: false }),
      setCaptureDefaults: async () => ({ claimed: [] }),
    }, { available: true });
    const outcomes: Array<{ reject(error: Error): void }> = [];
    const pipeline: VoiceNotePipeline = {
      process: async () => {}, cancelAll: () => {}, resume: () => {},
      isAccepting: () => true, quiescent: async () => true,
      reconcileAll: () => new Promise<void>((_resolve, reject) => { outcomes.push({ reject }); }),
    };
    const recorder = controller({ pipeline });
    const detach = recorder.attach();
    await tick();
    pendingStore.setAccount(null);
    const saving = recorder.retryPending();
    while (outcomes.length === 0) await tick();
    pendingStore.setAccount(tcw.did!);
    outcomes.shift()!.reject(new Error("space timed out"));
    await saving;
    expect(pendingStore.snapshot()).toMatchObject({ accountDid: tcw.did,
      lastError: "Saving to your TinyCloud space is slow. The note is safe on this browser. Try again." });
    pendingStore.setAccount(null);
    detach();
  });

  test("Save now cannot re-arm an account cancelled during the native claim", async () => {
    const base = plugin;
    __setVoiceNotesForTests({ ...base,
      getCaptureDefaults: async () => ({ status: "signed_in", accountDid: tcw.did, transitionGen: 1,
        transcriber: "on-device", identifySpeakers: false }),
      setCaptureDefaults: async () => { advanceAccountGeneration(); return { claimed: [] }; },
    }, { available: true });
    let resumed = 0;
    let reconciled = 0;
    const pipeline: VoiceNotePipeline = {
      process: async () => {}, cancelAll: () => {}, resume: () => { resumed++; },
      isAccepting: () => false, quiescent: async () => true,
      reconcileAll: async () => { reconciled++; },
    };
    const recorder = controller({ pipeline });
    const detach = recorder.attach();
    await tick();
    await recorder.retryPending();
    expect({ resumed, reconciled }).toEqual({ resumed: 0, reconciled: 0 });
    detach();
  });

// RecorderProvider renders an announcer; give React the same inert host DOM as its engine tests.
const hostNode = (): unknown => new Proxy(function () {}, {
  get: (_target, key) => key === "nodeType" ? 1 : key === "ownerDocument" ? hostDocument
    : key === "style" ? {} : key === "firstChild" || key === "parentNode" ? null : () => hostNode(),
  set: () => true,
});
const hostDocument = { createElement: () => hostNode(), createTextNode: () => hostNode(),
  nodeType: 9, activeElement: null, addEventListener() {}, removeEventListener() {} };
const hostContainer = () => ({ nodeType: 1, nodeName: "DIV", tagName: "DIV", ownerDocument: hostDocument,
  textContent: "", addEventListener() {}, removeEventListener() {}, appendChild() {}, removeChild() {}, insertBefore() {} }) as unknown as HTMLElement;
const hostWindow = () => ({ HTMLIFrameElement: class {}, document: hostDocument,
  addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout });

  test("RecorderProvider with the App pipeline emits once for Save now and once for a new Stop", async () => {
    const previousWindow = globalThis.window;
    const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    Reflect.set(globalThis, "window", hostWindow());
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    const sqlite = new Database(":memory:");
    const values = new Map<string, string>();
    const account = { did: tcw.did, spaceId: tcw.spaceId,
      sql: { db(name: string) {
        expect(name).toBe(CONNECTORS_SQL_DB_NAME);
        return {
          async query(statement: string, params: unknown[] = []) {
            try { return { ok: true, data: { rows: sqlite.query(statement).values(...params as never[]) } }; }
            catch (error) { return { ok: false, error: { code: "SQL_ERROR", message: String(error) } }; }
          },
          async execute(statement: string, params: unknown[] = []) {
            try { return { ok: true, data: { changes: sqlite.query(statement).run(...params as never[]).changes } }; }
            catch (error) { return { ok: false, error: { code: "SQL_ERROR", message: String(error) } }; }
          },
        };
      } },
      kv: {
        async put(key: string, value: string) { values.set(key, value); return { ok: true, data: {} }; },
        async get(key: string) { return values.has(key) ? { ok: true, data: { data: values.get(key) } }
          : { ok: false, error: { code: "KV_NOT_FOUND", message: "missing" } }; },
        async list({ path }: { path: string }) {
          return { ok: true, data: { keys: [...values.keys()].filter((key) => key.startsWith(path)), truncated: false } };
        },
      },
    } as unknown as TinyCloudWeb;
    const base = plugin;
    __setVoiceNotesForTests({ ...base, async updateLedger({ id, patch }) {
      const note = onPhone.find((item) => item.id === id)!;
      note.ledger = { ...note.ledger, ...patch } as VoiceNoteRecording["ledger"];
      note.rev = (note.rev ?? 0) + 1;
      return { rev: note.rev };
    } }, { available: true });
    const pipeline = createVoiceNotePipeline(account);
    const root = createRoot(hostContainer());
    const changed: Array<{ source: string; sourceId: string } | undefined> = [];
    const unsubscribe = captureEvents.on("library-changed", (detail) => changed.push(detail));
    let recorder: RecorderValue | null = null;
    function Probe() { recorder = useRecorder(); return null; }
    try {
      fakeVoiceNoteStore.save = fails;
      await act(async () => root.render(createElement(RecorderProvider, { tcw: account, pipeline }, createElement(Probe))));
      await act(async () => { await tick(); await tick(); });
      await act(async () => recorder!.record());
      await act(async () => { await tick(); });
      await act(async () => recorder!.stop());
      await settled(() => recorder!.outcome === "failed", "the failed Stop to settle");
      expect(recorder!.outcome).toBe("failed");
      expect(changed).toEqual([]);
      const failedId = onPhone[0]!.id;

      fakeVoiceNoteStore.save = ok;
      await act(async () => { recorder!.retryPending(); await tick(); await tick(); });
      await settled(() => onPhone[0]?.ledger?.audio.state === "saved", "Save now to save the note");
      expect(onPhone[0]?.ledger?.audio.state).toBe("saved");
      expect(changed).toEqual([{ source: "exo-voice-note", sourceId: failedId }]);
      await act(async () => { recorder!.retryPending(); await tick(); await tick(); });
      expect(changed).toHaveLength(1);

      await act(async () => recorder!.dismissOutcome());
      await act(async () => recorder!.record());
      await act(async () => { await tick(); });
      await act(async () => recorder!.stop());
      await settled(() => onPhone[1] !== undefined && recorder!.lastSaved?.id === onPhone[1].id, "the new Stop to save");
      expect(recorder!.lastSaved?.id).toBe(onPhone[1]?.id);
      expect(changed).toEqual([{ source: "exo-voice-note", sourceId: failedId },
        { source: "exo-voice-note", sourceId: onPhone[1]!.id }]);
    } finally {
      await act(async () => root.unmount());
      unsubscribe();
      sqlite.close();
      Reflect.set(globalThis, "window", previousWindow);
      Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
    }
  });

  test("RecorderProvider defaults to one identified Library event after a successful save, including a retry", async () => {
    const previousWindow = globalThis.window;
    const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    Reflect.set(globalThis, "window", hostWindow());
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    const container = hostContainer();
    const root = createRoot(container);
    const changed: Array<{ source: string; sourceId: string } | undefined> = [];
    const unsubscribe = captureEvents.on("library-changed", (detail) => changed.push(detail));
    let recorder: RecorderValue | null = null;
    const overridden: string[] = [];
    function Probe() {
      recorder = useRecorder();
      return null;
    }
    try {
      fakeVoiceNoteStore.save = fails;
      await act(async () => root.render(createElement(RecorderProvider, { tcw }, createElement(Probe))));
      await act(async () => { await tick(); await tick(); });
      await act(async () => recorder!.record());
      await tick();
      await act(async () => recorder!.stop());
      await tick();
      expect(changed).toEqual([]);

      fakeVoiceNoteStore.save = ok;
      await act(async () => recorder!.retryPending());
      await tick();
      expect(recorder!.lastSaved).toBeTruthy();
      expect(changed).toEqual([{ source: "exo-voice-note", sourceId: recorder!.lastSaved!.id }]);
      await act(async () => root.render(createElement(RecorderProvider, {
        tcw, onSaved: (recording: VoiceNoteRecording) => overridden.push(recording.id),
      }, createElement(Probe))));
      await act(async () => recorder!.dismissOutcome());
      await act(async () => recorder!.record());
      await tick();
      await act(async () => recorder!.stop());
      await tick();
      expect(overridden).toEqual([recorder!.lastSaved!.id]);
      expect(changed).toHaveLength(1);
    } finally {
      await act(async () => root.unmount());
      await tick();
      unsubscribe();
      Reflect.set(globalThis, "window", previousWindow);
      Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
    }
  });

  test("the app and harness default recorder callback fires for a save, but not after unmount", async () => {
    const previousWindow = globalThis.window;
    const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    Reflect.set(globalThis, "window", hostWindow());
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    const container = hostContainer();
    const root = createRoot(container);
    const changed: Array<{ source: string; sourceId: string } | undefined> = [];
    const unsubscribe = captureEvents.on("library-changed", (detail) => changed.push(detail));
    let recorder: VoiceNoteRecorder | null = null;
    function Probe() {
      recorder = useVoiceNoteRecorder({ tcw });
      return null;
    }
    let unmounted = false;
    try {
      await act(async () => root.render(createElement(Probe)));
      await act(async () => { recorder!.record(); });
      await tick();
      await act(async () => { recorder!.stop(); });
      await tick();
      expect(changed).toEqual([{ source: "exo-voice-note", sourceId: recorder!.state.lastSaved!.id }]);
      await act(async () => recorder!.dismissOutcome());
      const pending = Promise.withResolvers<{ ok: true; data: { inserted: true } }>();
      const started = Promise.withResolvers<void>();
      fakeVoiceNoteStore.save = async () => { started.resolve(); return pending.promise as never; };
      await act(async () => { recorder!.record(); });
      await tick();
      await act(async () => { recorder!.stop(); });
      await started.promise;
      await act(async () => root.unmount());
      unmounted = true;
      pending.resolve({ ok: true, data: { inserted: true } });
      await tick();
      expect(changed).toHaveLength(1);
    } finally {
      if (!unmounted) await act(async () => root.unmount());
      await tick();
      unsubscribe();
      Reflect.set(globalThis, "window", previousWindow);
      Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
    }
  });

  test("changing accounts detaches the previous recorder callback before its save finishes", async () => {
    const previousWindow = globalThis.window;
    const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    Reflect.set(globalThis, "window", hostWindow());
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    const container = hostContainer();
    const root = createRoot(container);
    const changed: Array<{ source: string; sourceId: string } | undefined> = [];
    const unsubscribe = captureEvents.on("library-changed", (detail) => changed.push(detail));
    let recorder: VoiceNoteRecorder | null = null;
    function Probe({ account }: { account: TinyCloudWeb }) {
      recorder = useVoiceNoteRecorder({ tcw: account });
      return null;
    }
    const pending = Promise.withResolvers<{ ok: true; data: { inserted: true } }>();
    const started = Promise.withResolvers<void>();
    fakeVoiceNoteStore.save = async () => { started.resolve(); return pending.promise as never; };
    try {
      await act(async () => root.render(createElement(Probe, { account: tcw })));
      await tick();
      await act(async () => recorder!.record());
      await tick();
      await act(async () => recorder!.stop());
      await started.promise;
      await act(async () => root.render(createElement(Probe, {
        account: { ...tcw, did: "did:example:bob" } as TinyCloudWeb,
      })));
      pending.resolve({ ok: true, data: { inserted: true } });
      await tick();
      expect(changed).toEqual([]);
    } finally {
      await act(async () => root.unmount());
      await tick();
      unsubscribe();
      Reflect.set(globalThis, "window", previousWindow);
      Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
    }
  });

  test("discard stops the recording and deletes it; nothing is saved", async () => {
    const { recorder } = await attached();
    await recorder.record();
    const discarding = recorder.discard();
    expect(recorder.getState().phase).toBe("discarding");
    // A second tap while it runs does nothing.
    await recorder.discard();
    await discarding;
    expect(recorder.getState()).toMatchObject({ phase: "idle", outcome: null, error: null, recordingId: null });
    expect(fake.stats().recording).toBe(false);
    expect(onPhone).toEqual([]);
    expect(saves).toEqual([]);
    expect(noted).toEqual([]);
    expect(nativeDiscards).toBe(1);
    expect(deleteCalls).toBe(0);
  });

  test("a failed Discard clears its mark; Stop keeps and saves the recording", async () => {
    const base = plugin;
    __setVoiceNotesForTests({ ...base, async discard() {
      throw Object.assign(new Error("engine busy"), { code: "engine_busy" });
    } }, { available: true });
    const { recorder } = await attached();
    await recorder.record();
    const id = recorder.getState().recordingId!;
    await recorder.discard();
    expect(recorder.getState()).toMatchObject({ phase: "recording", recordingId: id, error: "Could not discard the recording: engine busy" });
    expect(isDiscarded(id)).toBe(false);
    await recorder.stop();
    await tick();
    expect(onPhone.map((recording) => recording.id)).toEqual([id]);
    expect(saves).toEqual([id]);
    expect(deleteCalls).toBe(0);
  });

  test("already_committed keeps the note and reports that it was saved", async () => {
    const base = plugin;
    __setVoiceNotesForTests({ ...base, async discard() {
      await stopNatively();
      throw Object.assign(new Error("Already committed"), { code: "already_committed" });
    } }, { available: true });
    const { recorder } = await attached();
    await recorder.record();
    const id = recorder.getState().recordingId!;
    await recorder.discard();
    expect(onPhone.map((recording) => recording.id)).toEqual([id]);
    expect(isDiscarded(id)).toBe(false);
    expect(recorder.getState().error).toContain("Already saved on this browser");
  });

  test("a failed Stop checks native status before showing a live recorder", async () => {
    const base = plugin;
    let checks = 0;
    __setVoiceNotesForTests({ ...base,
      async stop() {
        await stopNatively();
        throw new Error("write failed");
      },
      async status() { checks++; return base.status(); },
    }, { available: true });
    const { recorder } = await attached();
    await recorder.record();
    await recorder.stop();
    expect(checks).toBeGreaterThan(1);
    expect(recorder.getState()).toMatchObject({ phase: "idle", recordingId: null, error: "Could not stop: write failed" });
    expect(onPhone).toHaveLength(1);
  });

  test("a timed-out native Stop explains that audio is being recovered", async () => {
    const base = plugin;
    __setVoiceNotesForTests({ ...base, async stop() {
      await stopNatively();
      throw Object.assign(new Error("Recording finalization timed out at finish_writing"),
        { code: "finalization_timed_out" });
    } }, { available: true });
    const { recorder } = await attached();
    await recorder.record();
    await recorder.stop();
    expect(recorder.getState()).toMatchObject({
      phase: "idle", error: "Kept on this browser. Exo will finish it automatically.",
    });
    expect(recorder.getState().captureIssues[currentId ?? onPhone[0].id]).toEqual({ kind: "finalization_timed_out" });
    expect(onPhone).toHaveLength(1);
  });

  test("writeFailure followed by recoveryFailed and recovered retains partial audio", async () => {
    const { recorder, detach } = await attached();
    await recorder.record();
    const id = recorder.getState().recordingId!;
    fake.emit("writeFailure", { id, error: "AAC write failed" });
    expect(recorder.getState().captureIssues[id]).toEqual({ kind: "write_failed", detail: "AAC write failed" });
    fake.emit("recoveryFailed", { id, reason: "mux failed" });
    expect(recorder.getState().captureIssues[id]).toEqual({ kind: "recoveryFailed", detail: "mux failed" });
    expect(recorder.dismissCaptureIssue(id)).toBe(false);
    expect(recorder.getState().captureIssues[id]?.kind).toBe("recoveryFailed");
    fake.emit("recovered", { id });
    expect(recorder.getState().captureIssues[id]).toEqual({ kind: "partial_audio" });
    fake.emit("recoveryFailed", { error: "scan failed" });
    expect(recorder.getState().recoveryScanFailure).toBe("scan failed");
    detach();
  });

  test("iOS Stop-time writeFailure, recovered, committed ends with partial audio", async () => {
    const { recorder, detach } = await attached();
    const recording = earlier();
    fake.emit("writeFailure", { id: recording.id, error: "writer.finish failed" });
    fake.emit("recovered", { id: recording.id });
    expect(recorder.getState().captureIssues[recording.id]).toEqual({ kind: "partial_audio" });
    fake.emit("committed", { id: recording.id });
    expect(recorder.getState().captureIssues[recording.id]).toEqual({ kind: "partial_audio" });
    detach();
  });

  test("retained failure events replay before retained success after a WebView reload", async () => {
    const committed = earlier().id;
    const recovered = earlier().id;
    fake.emit("writeFailure", { id: committed, error: "AAC write failed" });
    fake.emit("recoveryFailed", { id: recovered, reason: "mux failed" });
    fake.emit("recovered", { id: recovered });
    fake.emit("committed", { id: committed });

    const { recorder, detach } = await attached();
    expect(recorder.getState().captureIssues[committed]).toBeUndefined();
    expect(recorder.getState().captureIssues[recovered]).toBeUndefined();
    detach();
  });

  test("iOS writer failure followed by an auto-stop carrying the saved note retains a partial-audio notice", async () => {
    const { recorder } = await attached();
    await recorder.record();
    const id = recorder.getState().recordingId!;
    fake.emit("writeFailure", { id, error: "writer.finish failed" });
    expect(recorder.getState().captureIssues[id]?.kind).toBe("write_failed");
    const recording = await stopNatively();
    fake.emit("autoStopped", { id, reason: "write_failed", maxDurationMs: 10_800_000, at: Date.now(), recording });
    expect(recorder.getState().limitNotice).toBe("Recording stopped because audio could not be written.");
    expect(recorder.getState().captureIssues[id]).toEqual({ kind: "partial_audio" });
    await tick();
    expect(saves).toEqual([id]);
  });

  test("Android writer failure followed by committed and autoStopped retains a partial-audio notice", async () => {
    const { recorder } = await attached();
    await recorder.record();
    const id = recorder.getState().recordingId!;
    fake.emit("writeFailure", { id, error: "write_failed: storage full" });
    const recording = await stopNatively();
    fake.emit("committed", { id });
    expect(recorder.getState().captureIssues[id]).toEqual({ kind: "partial_audio" });
    fake.emit("autoStopped", { id, reason: "write_failed", maxDurationMs: 10_800_000, at: Date.now(), recording });
    await tick();
    expect(saves).toEqual([id]);
  });

  test("Android Stop drain failure followed by a successful second Stop retains the notice", async () => {
    let stops = 0;
    __setVoiceNotesForTests({ ...plugin, async stop() {
      if (++stops === 1) {
        fake.emit("writeFailure", { id: currentId!, error: "AAC drain failed" });
        throw new Error("Stop failed");
      }
      const recording = await stopNatively();
      fake.emit("committed", { id: recording.id });
      return recording;
    } }, { available: true });
    const { recorder } = await attached();
    await recorder.record();
    const id = recorder.getState().recordingId!;
    await recorder.stop();
    expect(recorder.getState().captureIssues[id]?.kind).toBe("write_failed");
    expect(recorder.getState().phase).toBe("recording");
    await recorder.stop();
    expect(recorder.getState().captureIssues[id]).toEqual({ kind: "partial_audio" });
    expect(stops).toBe(2);
  });

  test("web commit before writeFailure also leaves a partial-audio notice", async () => {
    const { recorder } = await attached();
    const recording = earlier();
    fake.emit("committed", { id: recording.id });
    fake.emit("writeFailure", { id: recording.id, error: "AAC write failed" });
    fake.emit("autoStopped", { id: recording.id, reason: "write_failed", maxDurationMs: 10_800_000,
      at: Date.now(), recording });
    expect(recorder.getState().captureIssues[recording.id]).toEqual({ kind: "partial_audio" });
  });

  test("a normal commit clears recovery and finalization issues", async () => {
    const { recorder } = await attached();
    const recovered = earlier().id;
    const finalized = earlier().id;
    fake.emit("recoveryFailed", { id: recovered, reason: "retry failed" });
    fake.emit("autoStopped", { id: finalized, reason: "max_duration", maxDurationMs: 10_800_000,
      at: Date.now(), recording: null, error: "finalization_timed_out" });
    fake.emit("committed", { id: recovered });
    fake.emit("committed", { id: finalized });
    expect(recorder.getState().captureIssues[recovered]).toBeUndefined();
    expect(recorder.getState().captureIssues[finalized]).toBeUndefined();
  });

  test("writer-stall spans alone re-derive partial audio but calls and interruptions do not", async () => {
    const stalled = earlier();
    stalled.startedAt = 100_000;
    stalled.spans = [{ kind: "omitted", reason: "writer_stalled", startedAt: 102_000,
      endedAt: 105_000, atAudioMs: 2_000, audioMs: 0 }];
    const interrupted = earlier();
    interrupted.spans = [{ kind: "omitted", reason: "call", startedAt: 102_000,
      endedAt: 105_000, atAudioMs: 2_000, audioMs: 0 },
    { kind: "omitted", reason: "interruption", startedAt: 106_000,
      endedAt: 108_000, atAudioMs: 2_000, audioMs: 0 }];
    const otherOwner = earlier();
    otherOwner.owner = "did:example:bob";
    otherOwner.spans = stalled.spans;
    const { recorder, detach } = await attached();
    expect(recorder.getState().captureIssues[stalled.id]).toEqual({ kind: "partial_audio",
      missingMs: 3_000, spans: [{ startMs: 2_000, endMs: 5_000, reason: "writer_stalled" }] });
    expect(recorder.getState().captureIssues[interrupted.id]).toBeUndefined();
    expect(recorder.getState().captureIssues[otherOwner.id]).toBeUndefined();
    detach();
  });

  test("Android launch recovery restores a real write failure across reload and scopes it to this account", async () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    const values = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    } });
    try {
      const recording = earlier();
      const first = await attached();
      fake.emit("writeFailure", { id: recording.id, error: "AAC write failed" });
      expect(first.recorder.getState().captureIssues[recording.id]?.kind).toBe("write_failed");
      first.detach();
      const second = await attached();
      fake.emit("recovered", { id: recording.id, recording });
      expect(second.recorder.getState().captureIssues[recording.id]?.kind).toBe("partial_audio");
      second.detach();
      onPhone = []; // Upload removed the native sidecar; the notice is still local.
      const other = controller({ tcw: { did: "did:example:bob", spaceId: "space-b" } as TinyCloudWeb });
      const detachOther = other.attach();
      await tick();
      expect(other.getState().captureIssues[recording.id]).toBeUndefined();
      detachOther();
      const third = await attached();
      expect(third.recorder.getState().captureIssues[recording.id]?.kind).toBe("partial_audio");
      expect(third.recorder.dismissCaptureIssue(recording.id)).toBe(true);
      expect(third.recorder.getState().captureIssues[recording.id]).toBeUndefined();
      expect(third.recorder.dismissCaptureIssue(recording.id)).toBe(false);
      fake.emit("writeFailure", { id: recording.id, error: "late replay" });
      expect(third.recorder.getState().captureIssues[recording.id]).toBeUndefined();
      third.detach();
      const fourth = await attached();
      expect(fourth.recorder.getState().captureIssues[recording.id]).toBeUndefined();
      fourth.detach();
    } finally {
      if (previous) Object.defineProperty(globalThis, "localStorage", previous);
      else Reflect.deleteProperty(globalThis, "localStorage");
    }
  });

  test("a timed-out limit auto-stop explains recovery instead of saying no audio", async () => {
    const { recorder } = await attached();
    await recorder.record();
    fake.emit("autoStopped", {
      reason: "max_duration", maxDurationMs: 60_000, at: Date.now(),
      recording: null, error: "finalization_timed_out",
    });
    expect(recorder.getState()).toMatchObject({
      phase: "idle", error: "Kept on this browser. Exo will finish it automatically.",
    });
    expect(saves).toEqual([]);
  });

  test("a double tap sends only one native Pause and Resume", async () => {
    const base = plugin;
    let pauseCalls = 0;
    let resumeCalls = 0;
    let releasePause!: () => void;
    let releaseResume!: () => void;
    const pauseGate = new Promise<void>((resolve) => { releasePause = resolve; });
    const resumeGate = new Promise<void>((resolve) => { releaseResume = resolve; });
    __setVoiceNotesForTests({ ...base,
      async pause() { pauseCalls++; await pauseGate; paused = true; },
      async resume() { resumeCalls++; await resumeGate; paused = false; },
    }, { available: true });
    const { recorder } = await attached();
    await recorder.record();
    const firstPause = recorder.pause();
    await recorder.pause();
    expect(pauseCalls).toBe(1);
    releasePause();
    await firstPause;
    const firstResume = recorder.resume();
    await recorder.resume();
    expect(resumeCalls).toBe(1);
    releaseResume();
    await firstResume;
  });

  test("a mic event cannot hide a failed Resume", async () => {
    const base = plugin;
    __setVoiceNotesForTests({ ...base, async resume() {
      fake.emit("micState", { id: currentId, state: "needs_user", reason: "resume_blocked" });
      throw Object.assign(new Error("microphone busy"), { code: "resume_failed" });
    } }, { available: true });
    const { recorder } = await attached();
    await recorder.record();
    await recorder.pause();
    await recorder.resume();
    fake.emit("micState", { id: currentId, state: "needs_user", reason: "resume_blocked" });
    expect(recorder.getState()).toMatchObject({ mic: { state: "needs_user" }, error: "Could not resume: microphone busy" });
  });

  test("discard racing the limit's auto-stop: discard first deletes it, the limit first saves it", async () => {
    for (const order of ["discard-first", "auto-first"] as const) {
      saves = [];
      const { recorder, detach } = await attached();
      await recorder.record();
      // The native recorder stops itself at the limit: stop() now answers not_recording.
      const recording = await stopNatively();
      const autoStopped = { reason: "max_duration" as const, maxDurationMs: 60_000, at: Date.now(), recording };
      if (order === "discard-first") {
        const discarding = recorder.discard();
        fake.emit("autoStopped", autoStopped);
        await discarding;
      } else {
        fake.emit("autoStopped", autoStopped);
        await recorder.discard();
      }
      await tick();
      await tick();
      if (order === "discard-first") {
        expect(saves).toEqual([]);
        expect(onPhone).toEqual([]);
        expect(isDiscarded(recording.id)).toBe(false);
        expect(recorder.getState()).toMatchObject({ phase: "idle", outcome: null, limitNotice: null });
      } else {
        expect(saves).toEqual([recording.id]);
        expect(recorder.getState()).toMatchObject({ phase: "idle", outcome: "saved" });
      }
      detach();
    }
  });

  test("a failed delete keeps the recording marked; Save now deletes it, never saves it", async () => {
    deleteFailures = 1;
    const { recorder } = await attached();
    await recorder.record();
    await stopNatively();
    await recorder.discard();
    expect(recorder.getState()).toMatchObject({ phase: "idle", outcome: null, error: "Discarded, but this browser kept its copy: the file is busy" });
    const kept = onPhone[0]!;
    expect(isDiscarded(kept.id)).toBe(true);

    await recorder.retryPending();
    expect(onPhone).toEqual([]);
    expect(saves).toEqual([]);
    expect(isDiscarded(kept.id)).toBe(false);
    expect(deleteCalls).toBe(2);
  });
  describe("a mid-recording mode change applies to that note", () => {
    type Mode = "on-device" | "private-cloud" | "assemblyai" | "off";
    const cases: Array<[Mode, Mode]> = [
      ["on-device", "private-cloud"],
      ["private-cloud", "on-device"],
      ["assemblyai", "on-device"],
      ["private-cloud", "off"],
      ["on-device", "off"],
      ["assemblyai", "off"],
    ];
    for (const [from, to] of cases) {
      test(`${from} -> ${to}: the screen keeps ${to} while stopping, the note is committed as ${to}, and ${to === "private-cloud" ? "only then" : "no"} audio goes to the enclave`, async () => {
        await fake.plugin.setCaptureDefaults({ accountDid: tcw.did, transitionGen: 1, transcriber: from, identifySpeakers: false });
        const enclaveJobs: string[] = [];
        const transcriber = createVoiceNoteTranscriber({
          cloud: {
            capabilities: async () => ({ max_bytes: 120_960_000, max_duration_seconds: 7_200, content_types: ["audio/mp4"] }),
            pendingSourceIds: () => [],
            transcribe: async () => { throw new Error("runNote is injected"); },
            finish: async () => {},
            releaseUnsent: async () => {},
          },
          consent: { get: () => true, set: () => {} },
          tcw: () => tcw,
          holds: memoryHoldStore(),
          runNote: async ({ sourceId }) => { enclaveJobs.push(sourceId); return "transcribed"; },
        });
        await transcriber.check();
        const recorder = controller({ transcriber });
        const detach = recorder.attach();
        await tick();
        await recorder.record();
        expect(recorder.getTranscriber().id).toBe(from);

        expect(await recorder.setTranscriber(to, { scope: "recording" })).toBe("ok");
        expect(recorder.getTranscriber()).toMatchObject({ id: to, source: "recording" });
        expect((await fake.plugin.status()).options?.transcriber).toBe(to);
        expect((await fake.plugin.getCaptureDefaults()).transcriber).toBe(from);

        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        __setVoiceNotesForTests({ ...plugin, stop: async () => { await gate; return stopNatively(); } }, { available: true });
        const stopping = recorder.stop();
        await tick();
        expect(recorder.getState().phase).toBe("stopping");
        expect(recorder.getTranscriber()).toMatchObject({ id: to, source: "recording" });
        release();
        await stopping;
        await tick();

        expect(onPhone).toHaveLength(1);
        expect(onPhone[0]!.options?.transcriber).toBe(to);
        expect(enclaveJobs).toEqual(to === "private-cloud" ? [onPhone[0]!.id] : []);
        expect(recorder.getTranscriber().source).toBe("default");
        detach();
      });
    }
  });

  describe("Local without the on-device model", () => {
    let values: Map<string, string>;
    let previousStorage: PropertyDescriptor | undefined;
    beforeEach(() => {
      previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
      values = new Map();
      Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => { values.set(key, value); },
      } });
    });
    afterEach(() => {
      if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage);
      else Reflect.deleteProperty(globalThis, "localStorage");
    });

    /** A transcriber whose offer the test can change, as the account's private-cloud route does. */
    function offer(initial: { availability: "available" | "unavailable"; consented: boolean }) {
      let current = initial;
      const listeners = new Set<() => void>();
      const stub = {
        noteSaved: (recording: VoiceNoteRecording) => noted.push(recording.id),
        snapshot: () => ({ ...current, capabilities: null, jobs: new Map() }),
        subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
      } as unknown as VoiceNoteTranscriber;
      return { stub, change(next: typeof initial) { current = next; for (const listener of [...listeners]) listener(); } };
    }
    const nativeDefault = async () => (await fake.plugin.getCaptureDefaults()).transcriber;
    const seedNative = () => fake.plugin.setCaptureDefaults({ accountDid: tcw.did, transitionGen: 1, transcriber: "on-device", identifySpeakers: false });

    test("an explicit Local stays Local without the model: nothing is changed silently", async () => {
      await seedNative();
      await setDefaultTranscriber("on-device");
      const recorder = controller({ transcriber: offer({ availability: "available", consented: true }).stub, onDeviceReady: false });
      const detach = recorder.attach();
      await tick();
      expect(recorder.getTranscriber()).toEqual({ id: "on-device", identifySpeakers: false, source: "default" });
      expect(await nativeDefault()).toBe("on-device");
      await recorder.record();
      expect((await fake.plugin.status()).options?.transcriber).toBe("on-device");
      detach();
    });

    /** A phone whose model is absent and whose download is one pending promise, as the native one is. */
    async function phoneDownloading() {
      const sttFake = createFakeOnDeviceStt();
      const calls = { downloadNow: 0 };
      const stt = { ...sttFake.plugin, downloadNow: async () => { calls.downloadNow++; await new Promise<void>(() => {}); } } as OnDeviceSttPlugin;
      __setOnDeviceSttForTests(stt);
      __resetOnDeviceSttStoreForTests();
      await onDeviceSttStore.refresh();
      return calls;
    }
    afterEach(() => {
      __setOnDeviceSttForTests(createFakeOnDeviceStt().plugin);
      __resetOnDeviceSttStoreForTests();
    });

    test("choosing Local starts the on-device model download", async () => {
      const calls = await phoneDownloading();
      await fake.plugin.setCaptureDefaults({ accountDid: tcw.did, transitionGen: 1, transcriber: "off", identifySpeakers: false });
      await setDefaultTranscriber("off");
      const recorder = controller({ transcriber: offer({ availability: "available", consented: true }).stub, onDeviceReady: false });
      const detach = recorder.attach();
      await tick();
      expect(recorder.getTranscriber().id).toBe("off");
      expect(calls.downloadNow).toBe(0);
      expect(await recorder.setTranscriber("private-cloud", { scope: "default" })).toBe("ok");
      expect(calls.downloadNow).toBe(0);
      expect(await recorder.setTranscriber("on-device", { scope: "default" })).toBe("ok");
      expect(calls.downloadNow).toBe(1);
      detach();
    });

    test("on iOS, a Local default fetches the OS-managed speech assets at launch; Android's model download still waits", async () => {
      const sttFake = createFakeOnDeviceStt();
      sttFake.controls.useAppleSpeech("asset_missing");
      const installs = { count: 0 };
      const stt = { ...sttFake.plugin, installSpeechAssets: async () => { installs.count++; await sttFake.plugin.installSpeechAssets(); } } as OnDeviceSttPlugin;
      __setOnDeviceSttForTests(stt);
      __resetOnDeviceSttStoreForTests();
      await seedNative();
      const recorder = controller({ tcw: null, onDeviceReady: false });
      const detach = recorder.attach();
      try {
        await tick();
        await tick();
        expect(recorder.getTranscriber().id).toBe("on-device");
        expect(installs.count).toBe(1);
        expect(isOnDeviceReady(onDeviceSttStore.snapshot())).toBe(true);
      } finally { detach(); }
    });

    test("review r4: a speaker preference write on untouched Local does not request a model download", async () => {
      const calls = await phoneDownloading();
      await seedNative();
      const recorder = controller({ tcw: null, onDeviceReady: false });
      const detach = recorder.attach();
      try {
        await tick();
        expect(calls.downloadNow).toBe(0);
        await setDefaultIdentifySpeakersForTest(false);
        await tick();
        expect(calls.downloadNow).toBe(0);
      } finally { detach(); }
    });

    test("review r4: a failed Private preference write does not request a Local model download", async () => {
      const calls = await phoneDownloading();
      await seedNative();
      const recorder = controller({ transcriber: offer({ availability: "available", consented: true }).stub, onDeviceReady: false });
      const detach = recorder.attach();
      try {
        await tick();
        expect(calls.downloadNow).toBe(0);
        Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
          getItem: (key: string) => values.get(key) ?? null,
          setItem: (key: string, value: string) => {
            if (key === "exo.voiceNotes.transcriber" && value === "private-cloud") throw new Error("storage write failed");
            values.set(key, value);
          },
          removeItem: (key: string) => { values.delete(key); },
        } });
        await expect(recorder.setTranscriber("private-cloud", { scope: "default" })).rejects.toThrow("storage write failed");
        await tick();
        expect(recorder.getTranscriber().id).toBe("on-device");
        expect(calls.downloadNow).toBe(0);
      } finally { detach(); }
    });

    test("being on Local by default, without a choice or a recording, downloads nothing", async () => {
      const calls = await phoneDownloading();
      await seedNative();
      await setDefaultTranscriber("on-device");
      const recorder = controller({ transcriber: offer({ availability: "available", consented: true }).stub, onDeviceReady: false });
      const detach = recorder.attach();
      await tick();
      await onDeviceSttStore.refresh();
      await tick();
      expect(recorder.getTranscriber().id).toBe("on-device");
      expect(calls.downloadNow).toBe(0);
      detach();
    });

    test("recording on Local is allowed while the model downloads, and the note stays on Local", async () => {
      const calls = await phoneDownloading();
      await seedNative();
      await setDefaultTranscriber("on-device");
      const recorder = controller({ transcriber: offer({ availability: "available", consented: true }).stub, onDeviceReady: false });
      const detach = recorder.attach();
      await tick();
      expect(calls.downloadNow).toBe(0);
      await recorder.record();
      await tick();
      expect(calls.downloadNow).toBe(1);
      expect((await fake.plugin.status()).state).toBe("recording");
      expect((await fake.plugin.status()).options?.transcriber).toBe("on-device");
      detach();
    });

    /** The mode on screen and the mode the engine will start the next recording with are one and the same. */
    const agree = async (recorder: { getTranscriber(): { id: string } }) =>
      expect(recorder.getTranscriber().id).toBe(await nativeDefault());

    describe("an explicit choice made after the controller is attached reaches the engine as that choice", () => {
      test("a refresh landing while the choice is being written cannot put the fallback back over it", async () => {
        await seedNative();
        const recorder = controller({ transcriber: offer({ availability: "available", consented: true }).stub, onDeviceReady: false });
        const detach = recorder.attach();
        await tick();
        // The engine takes the choice, then holds the reply back while a refresh reads it.
        let release!: () => void;
        const held = new Promise<void>((resolve) => { release = resolve; });
        __setVoiceNotesForTests({ ...plugin, async setCaptureDefaults(defaults) {
          const result = await plugin.setCaptureDefaults(defaults);
          if (defaults.transcriber === "on-device") await held;
          return result;
        } }, { available: true });
        const choosing = recorder.setTranscriber("on-device", { scope: "default" });
        await tick();
        const refreshing = refreshEffectiveTranscriber();
        await tick();
        release();
        await Promise.all([choosing, refreshing]);
        await tick();
        __setVoiceNotesForTests(plugin, { available: true });
        expect(await nativeDefault()).toBe("on-device");
        await agree(recorder);
        detach();
      });

      test("every explicit change in turn, with the model absent: the screen, the engine and the settings default agree after each", async () => {
        await seedNative();
        const recorder = controller({ transcriber: offer({ availability: "available", consented: true }).stub, onDeviceReady: false });
        const detach = recorder.attach();
        await tick();
        await agree(recorder);
        for (const id of ["on-device", "private-cloud", "off", "on-device", "off", "private-cloud"] as const) {
          expect(await recorder.setTranscriber(id, { scope: "default" })).toBe("ok");
          expect(recorder.getTranscriber()).toMatchObject({ id, source: "default" });
          expect(await nativeDefault()).toBe(id);
          expect(await readDefaultTranscriber()).toBe(id);
        }
        detach();
      });

      test("Identify speakers on the untouched Local default leaves the engine and the choice on Local", async () => {
        await seedNative();
        const recorder = controller({ transcriber: offer({ availability: "available", consented: true }).stub, onDeviceReady: false });
        const detach = recorder.attach();
        await tick();
        await setDefaultIdentifySpeakersForTest(true);
        await tick();
        expect(await nativeDefault()).toBe("on-device");
        expect(values.has("exo.voiceNotes.transcriber")).toBe(false);
        expect(recorder.getTranscriber()).toMatchObject({ id: "on-device" });
        detach();
      });
    });

    describe("one preference, one source: nothing queued earlier can write back an older value", () => {
      for (const [from, to] of [["private-cloud", "on-device"], ["private-cloud", "off"]] as const) {
        test(`${from} -> ${to} with Identify speakers changed while the choice is still being written: the engine, the screen, the store and the next note all say ${to}`, async () => {
          await seedNative();
          const enclaveJobs: string[] = [];
          const transcriber = createVoiceNoteTranscriber({
            cloud: {
              capabilities: async () => ({ max_bytes: 120_960_000, max_duration_seconds: 7_200, content_types: ["audio/mp4"] }),
              pendingSourceIds: () => [],
              transcribe: async () => { throw new Error("runNote is injected"); },
              finish: async () => {},
              releaseUnsent: async () => {},
            },
            consent: { get: () => true, set: () => {} },
            tcw: () => tcw,
          holds: memoryHoldStore(),
            runNote: async ({ sourceId }) => { enclaveJobs.push(sourceId); return "transcribed"; },
          });
          await transcriber.check();
          const recorder = controller({ transcriber, onDeviceReady: true });
          const detach = recorder.attach();
          await tick();
          expect(await recorder.setTranscriber(from, { scope: "default" })).toBe("ok");
          expect(await nativeDefault()).toBe(from);

          // The engine takes the new mode, then holds the reply back while Identify speakers is requested.
          let release!: () => void;
          const held = new Promise<void>((resolve) => { release = resolve; });
          __setVoiceNotesForTests({ ...plugin, async setCaptureDefaults(defaults) {
            const result = await plugin.setCaptureDefaults(defaults);
            if (defaults.transcriber === to) await held;
            return result;
          } }, { available: true });
          const choosing = recorder.setTranscriber(to, { scope: "default" });
          await tick();
          const speakers = setDefaultIdentifySpeakersForTest(true);
          await tick();
          release();
          await Promise.all([choosing, speakers]);
          await tick();
          __setVoiceNotesForTests(plugin, { available: true });

          expect(values.get("exo.voiceNotes.transcriber")).toBe(to);
          expect(await nativeDefault()).toBe(to);
          expect(recorder.getTranscriber()).toMatchObject({ id: to, source: "default" });
          await recorder.record();
          expect((await fake.plugin.status()).options?.transcriber).toBe(to);
          await recorder.stop();
          await tick();
          expect(onPhone[0]!.options?.transcriber).toBe(to);
          expect(enclaveJobs).toEqual([]);
          detach();
        });
      }
    });

    test("a sign-in landing while a mode choice is still being written applies the account and keeps the chosen mode", async () => {
      await fake.plugin.setCaptureDefaults({ accountDid: "did:key:previous", transitionGen: 1, transcriber: "private-cloud", identifySpeakers: false });
      const recorder = controller({ transcriber: offer({ availability: "available", consented: true }).stub, onDeviceReady: true });
      const detach = recorder.attach();
      await tick();
      expect(await recorder.setTranscriber("private-cloud", { scope: "default" })).toBe("ok");

      // The engine takes On this browser, then holds the reply while the sign-in default write arrives.
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      __setVoiceNotesForTests({ ...plugin, async setCaptureDefaults(defaults) {
        const result = await plugin.setCaptureDefaults(defaults);
        if (defaults.transcriber === "on-device") await held;
        return result;
      } }, { available: true });
      const choosing = recorder.setTranscriber("on-device", { scope: "default" });
      await tick();
      const signingIn = writeAccountDefaults((native) => ({ accountDid: tcw.did, transitionGen: native.transitionGen + 1 }));
      await tick();
      release();
      const [, account] = await Promise.all([choosing, signingIn]);
      await tick();
      __setVoiceNotesForTests(plugin, { available: true });

      expect(account).toEqual({ accountDid: tcw.did, transitionGen: 2 });
      expect(await fake.plugin.getCaptureDefaults()).toMatchObject({ accountDid: tcw.did, transitionGen: 2, transcriber: "on-device" });
      expect(values.get("exo.voiceNotes.transcriber")).toBe("on-device");
      expect(recorder.getTranscriber()).toMatchObject({ id: "on-device", source: "default" });
      await recorder.record();
      expect((await fake.plugin.status()).options?.transcriber).toBe("on-device");
      await recorder.stop();
      await tick();
      expect(onPhone[0]!.options?.transcriber).toBe("on-device");
      detach();
    });

    describe("failure matrix: the screen, the stored choice and the engine agree after every outcome", () => {
      const TRANSCRIBER_KEY = "exo.voiceNotes.transcriber";
      const SPEAKERS_KEY = "exo.voiceNotes.identifySpeakers";
      const REACH = { off: 0, "on-device": 1, "private-cloud": 2, assemblyai: 3 } as const;
      let down = true;

      const engines = {
        "engine takes it": () => plugin,
        "engine refuses": () => ({ ...plugin, setCaptureDefaults: async () => { throw new Error("engine is busy"); } }),
        "engine applies it, loses the ack, then works again": () => {
          let calls = 0;
          return { ...plugin, async setCaptureDefaults(defaults) {
            const result = await plugin.setCaptureDefaults(defaults);
            if (calls++ === 0) throw new Error("ack lost");
            return result;
          } } as VoiceNotesPlugin;
        },
        "engine applies it, loses the ack, and stays down": () => {
          let calls = 0;
          return { ...plugin, async setCaptureDefaults(defaults) {
            if (calls++ === 0) {
              await plugin.setCaptureDefaults(defaults);
              throw new Error("ack lost");
            }
            if (down) throw new Error("engine is down");
            return plugin.setCaptureDefaults(defaults);
          } } as VoiceNotesPlugin;
        },
      } as const;

      const stores = {
        "storage takes it": () => ({
          getItem: (key: string) => values.get(key) ?? null,
          setItem: (key: string, value: string) => { values.set(key, value); },
          removeItem: (key: string) => { values.delete(key); },
        }),
        "storage refuses every write, restores included": () => ({
          getItem: (key: string) => values.get(key) ?? null,
          setItem: () => { throw new Error("persistent storage refusal"); },
          removeItem: () => { throw new Error("persistent storage refusal"); },
        }),
        "the second key fails, restores work": () => ({
          getItem: (key: string) => values.get(key) ?? null,
          setItem: (key: string, value: string) => {
            if (key === SPEAKERS_KEY && value === "0" && values.get(TRANSCRIBER_KEY) === "private-cloud") throw new Error("storage is full");
            values.set(key, value);
          },
          removeItem: (key: string) => { values.delete(key); },
        }),
        "the second key fails, and the first cannot be put back": () => {
          let transcriberWrites = 0;
          return {
            getItem: (key: string) => values.get(key) ?? null,
            setItem: (key: string, value: string) => {
              if (key === SPEAKERS_KEY) throw new Error("storage is full");
              if (transcriberWrites++ > 0) throw new Error("storage is full");
              values.set(key, value);
            },
            removeItem: (key: string) => { values.delete(key); },
          };
        },
      } as const;

      const jobsFor = () => {
        const jobs: string[] = [];
        const real = createVoiceNoteTranscriber({
          cloud: {
            capabilities: async () => ({ max_bytes: 120_960_000, max_duration_seconds: 7_200, content_types: ["audio/mp4"] }),
            pendingSourceIds: () => [],
            transcribe: async () => { throw new Error("runNote is injected"); },
            finish: async () => {},
            releaseUnsent: async () => {},
          },
          consent: { get: () => true, set: () => {} },
          tcw: () => tcw,
          holds: memoryHoldStore(),
          runNote: async ({ sourceId }) => { jobs.push(sourceId); return "transcribed"; },
        });
        return { real, jobs };
      };

      test("a failed save never leaves the engine reaching further than what is stored, even if the engine was already ahead of it", async () => {
        values.set(TRANSCRIBER_KEY, "on-device");
        values.set(SPEAKERS_KEY, "0");
        await fake.plugin.setCaptureDefaults({ accountDid: tcw.did, transitionGen: 1, transcriber: "private-cloud", identifySpeakers: false });
        const recorder = controller({ transcriber: offer({ availability: "available", consented: true }).stub, onDeviceReady: true });
        const detach = recorder.attach();
        await tick();
        Object.defineProperty(globalThis, "localStorage", { configurable: true, value: stores["storage refuses every write, restores included"]() });
        await expect(recorder.setTranscriber("off", { scope: "default" })).rejects.toThrow("persistent storage refusal");
        expect(await nativeDefault()).toBe("on-device");
        expect(values.get(TRANSCRIBER_KEY)).toBe("on-device");
        expect(recorder.getTranscriber().id).toBe("on-device");
        detach();
      });

      for (const [engineName, engine] of Object.entries(engines)) {
        for (const [storeName, store] of Object.entries(stores)) {
          test(`explicit Local, then Private: ${engineName}; ${storeName}`, async () => {
            down = true;
            const succeeds = engineName === "engine takes it" && storeName === "storage takes it";
            const staysDown = engineName.endsWith("stays down");
            const partlyStored = storeName.endsWith("cannot be put back") && engineName === "engine takes it";
            values.set(TRANSCRIBER_KEY, "on-device");
            values.set(SPEAKERS_KEY, "0");
            await seedNative();
            const { real, jobs } = jobsFor();
            await real.check();
            const recorder = controller({ transcriber: real, onDeviceReady: true });
            const detach = recorder.attach();
            await tick();
            expect(recorder.getTranscriber()).toMatchObject({ id: "on-device", source: "default" });

            __setVoiceNotesForTests(engine(), { available: true });
            Object.defineProperty(globalThis, "localStorage", { configurable: true, value: store() });
            const choosing = recorder.setTranscriber("private-cloud", { scope: "default" });
            if (succeeds) expect(await choosing).toBe("ok");
            else await expect(choosing).rejects.toThrow();
            await tick();
            Object.defineProperty(globalThis, "localStorage", { configurable: true, value: stores["storage takes it"]() });

            const native = await nativeDefault();
            const shown = recorder.getTranscriber().id;
            const stored = values.get(TRANSCRIBER_KEY) ?? null;
            if (succeeds) {
              expect({ shown, stored, native }).toEqual({ shown: "private-cloud", stored: "private-cloud", native: "private-cloud" });
            } else if (partlyStored) {
              // The first key could not be put back: the engine sits at the old default, never beyond what the screen shows.
              expect({ shown, stored }).toEqual({ shown: "private-cloud", stored: "private-cloud" });
              expect(REACH[native]).toBeLessThanOrEqual(REACH[shown]);
              expect(native).toBe("on-device");
            } else if (!staysDown) {
              expect({ shown, stored, native }).toEqual({ shown: "on-device", stored: "on-device", native: "on-device" });
            } else {
              // The engine could not be put back: it holds what was never saved, so recording is held, visibly.
              expect({ shown, stored }).toEqual({ shown: "on-device", stored: "on-device" });
              expect(native).toBe("private-cloud");
              await recorder.record();
              expect(recorder.getState().phase).toBe("idle");
              expect(recorder.getState().error).toContain("recording is held");
              expect((await fake.plugin.status()).id).toBeNull();
              expect(await nativeDefault()).toBe("private-cloud");
              down = false;
              await recorder.record();
              expect(recorder.getState().phase).toBe("recording");
            }
            __setVoiceNotesForTests(plugin, { available: true });

            if (!succeeds) {
              if (recorder.getState().phase !== "recording") await recorder.record();
              expect(recorder.getState().phase).toBe("recording");
              expect((await fake.plugin.status()).options?.transcriber).toBe("on-device");
              await recorder.stop();
              await tick();
              expect(onPhone.at(-1)!.options?.transcriber).toBe("on-device");
              expect(jobs).toEqual([]);
              expect(await nativeDefault()).toBe("on-device");
            }

            if (!succeeds && !partlyStored) {
              // Retry once everything works: all three say Private.
              down = false;
              expect(await recorder.setTranscriber("private-cloud", { scope: "default" })).toBe("ok");
              expect({ shown: recorder.getTranscriber().id, stored: values.get(TRANSCRIBER_KEY), native: await nativeDefault() })
                .toEqual({ shown: "private-cloud", stored: "private-cloud", native: "private-cloud" });
            }
            detach();
          });
        }
      }
    });

    describe("a note that did not begin in the app is held, whatever the defaults say", () => {
      const TRANSCRIBER_KEY = "exo.voiceNotes.transcriber";
      const SOURCES = ["quick_action", "intent", "widget"] as const satisfies readonly CaptureSource[];
      let holds: ReturnType<typeof memoryHoldStore>;
      beforeEach(() => { holds = memoryHoldStore(); });

      /** A transcriber over the shared hold store: a new one over the same store is a relaunch. */
      const jobsOf = () => {
        const jobs: string[] = [];
        const real = createVoiceNoteTranscriber({
          cloud: {
            capabilities: async () => ({ max_bytes: 120_960_000, max_duration_seconds: 7_200, content_types: ["audio/mp4"] }),
            pendingSourceIds: () => [],
            transcribe: async () => { throw new Error("runNote is injected"); },
            finish: async () => {},
            releaseUnsent: async () => {},
          },
          consent: { get: () => true, set: () => {} },
          tcw: () => tcw,
          holds,
          runNote: async ({ sourceId }) => { jobs.push(sourceId); return "transcribed"; },
        });
        return { real, jobs };
      };

      /** A shortcut, intent or widget starts native capture itself, with no options override. */
      const startNatively = async (source: CaptureSource) => {
        await fake.startFromSource(source);
        currentId = `note-${++serial}`;
        return currentId;
      };

      /** A new controller and transcriber (a relaunch) pick up the native recording and stop it. */
      const relaunchAndStop = async (id: string) => {
        const next = jobsOf();
        await next.real.check();
        const recorder = controller({ transcriber: next.real, onDeviceReady: true });
        const detach = recorder.attach();
        await tick();
        expect(recorder.getState().recordingId).toBe(id);
        await recorder.stop();
        await tick();
        detach();
        return next;
      };

      /** The engine applied Private, lost the ack and cannot be put back; the stored choice (or none) says otherwise. */
      const engineAheadOfStored = async (stored: "on-device" | null) => {
        if (stored) values.set(TRANSCRIBER_KEY, stored); else values.delete(TRANSCRIBER_KEY);
        values.set("exo.voiceNotes.identifySpeakers", "0");
        await seedNative();
        const first = jobsOf();
        await first.real.check();
        const recorder = controller({ transcriber: first.real, onDeviceReady: true });
        const detach = recorder.attach();
        await tick();
        let calls = 0;
        __setVoiceNotesForTests({ ...plugin, async setCaptureDefaults(defaults) {
          if (calls++ === 0) { await plugin.setCaptureDefaults(defaults); throw new Error("ack lost"); }
          throw new Error("engine is down");
        } } as VoiceNotesPlugin, { available: true });
        await expect(recorder.setTranscriber("private-cloud", { scope: "default" })).rejects.toThrow();
        await tick();
        expect(await nativeDefault()).toBe("private-cloud");
        detach();
      };

      const expectHeld = (run: ReturnType<typeof jobsOf>, id: string) => {
        expect(run.jobs).toEqual([]);
        expect(run.real.snapshot().jobs.get(id)).toEqual({ kind: "held", message: HELD_NOTE_MESSAGE });
        expect(holds.held).toContain(id);
      };

      for (const source of SOURCES) {
        test(`Sol r4: ${source} while Local is stored and the engine is ahead on Private: committed Private, but held and not sent`, async () => {
          await engineAheadOfStored("on-device");
          const id = await startNatively(source);
          const run = await relaunchAndStop(id);
          expect(onPhone.at(-1)!.options?.transcriber).toBe("private-cloud");
          expect(onPhone.at(-1)!.source).toBe(source);
          expectHeld(run, id);
        });

        test(`Sol r5 (1): ${source} with the key untouched, native Local, the model ready and Private offered: a failed default write cannot get the note sent`, async () => {
          await engineAheadOfStored(null);
          const id = await startNatively(source);
          const run = await relaunchAndStop(id);
          expect(onPhone.at(-1)!.options?.transcriber).toBe("private-cloud");
          expectHeld(run, id);
        });
      }

      test("Sol r5 (1): explicit Local stored, consent known, then storage reads fail: the shortcut note is held, not sent", async () => {
        values.set(TRANSCRIBER_KEY, "on-device");
        values.set("exo.voiceNotes.identifySpeakers", "0");
        await seedNative();
        await fake.plugin.setCaptureDefaults({ accountDid: tcw.did, transitionGen: 1, transcriber: "private-cloud", identifySpeakers: false });
        const id = await startNatively("quick_action");
        const next = jobsOf();
        await next.real.check();
        const recorder = controller({ transcriber: next.real, onDeviceReady: true });
        const detach = recorder.attach();
        await tick();
        Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
          getItem: () => { throw new Error("storage cannot be read"); },
          setItem: (key: string, value: string) => { values.set(key, value); },
        } });
        await recorder.stop();
        await tick();
        detach();
        expect(onPhone.at(-1)!.options?.transcriber).toBe("private-cloud");
        expectHeld(next, id);
      });

      test("Sol r5 (2): changing the default to Private later does not release it: a replayed save on a fresh controller and transcriber still sends nothing", async () => {
        await engineAheadOfStored("on-device");
        const id = await startNatively("quick_action");
        const run = await relaunchAndStop(id);
        expectHeld(run, id);

        __setVoiceNotesForTests(plugin, { available: true });
        const settings = jobsOf();
        await settings.real.check();
        const recorder = controller({ transcriber: settings.real, onDeviceReady: true });
        const detach = recorder.attach();
        await tick();
        expect(await recorder.setTranscriber("private-cloud", { scope: "default" })).toBe("ok");
        expect(values.get(TRANSCRIBER_KEY)).toBe("private-cloud");
        detach();

        const replay = jobsOf();
        await replay.real.check();
        expect(replay.real.snapshot().jobs.get(id)).toEqual({ kind: "held", message: HELD_NOTE_MESSAGE });
        replay.real.noteSaved({ id, durationMs: 5_000, source: "quick_action", options: { transcriber: "private-cloud", identifySpeakers: false } });
        replay.real.noteSaved({ id, durationMs: 5_000, source: "quick_action" });
        await tick();
        expect(replay.jobs).toEqual([]);
        expect(replay.real.snapshot().jobs.get(id)?.kind).toBe("held");
      });

      for (const stored of ["private-cloud", null] as const) {
        test(`a ${stored ?? "untouched"} stored choice does not let a shortcut note go either: it is held`, async () => {
          if (stored) values.set(TRANSCRIBER_KEY, stored); else values.delete(TRANSCRIBER_KEY);
          await fake.plugin.setCaptureDefaults({ accountDid: tcw.did, transitionGen: 1, transcriber: "private-cloud", identifySpeakers: false });
          const id = await startNatively("quick_action");
          const run = await relaunchAndStop(id);
          expect(onPhone.at(-1)!.options?.transcriber).toBe("private-cloud");
          expectHeld(run, id);
        });
      }

      test("only that note's own Transcribe sends it, and a later launch no longer shows it held", async () => {
        values.set(TRANSCRIBER_KEY, "private-cloud");
        await fake.plugin.setCaptureDefaults({ accountDid: tcw.did, transitionGen: 1, transcriber: "private-cloud", identifySpeakers: false });
        const id = await startNatively("widget");
        const run = await relaunchAndStop(id);
        expectHeld(run, id);

        run.real.transcribe(id);
        await tick();
        expect(run.jobs).toEqual([id]);
        expect(holds.held).toEqual([]);
        expect(jobsOf().real.snapshot().jobs.get(id)).toBeUndefined();
      });

      test("a note recorded in the app is not held: the mode the user saw on the recorder decides, including a mid-recording Private", async () => {
        values.set(TRANSCRIBER_KEY, "on-device");
        await seedNative();
        const { real, jobs } = jobsOf();
        await real.check();
        const recorder = controller({ transcriber: real, onDeviceReady: true });
        const detach = recorder.attach();
        await tick();
        await recorder.record();
        expect(await recorder.setTranscriber("private-cloud", { scope: "recording" })).toBe("ok");
        await recorder.stop();
        await tick();
        expect(onPhone[0]!.options?.transcriber).toBe("private-cloud");
        expect(onPhone[0]!.source).toBe("in_app");
        expect(jobs).toEqual([onPhone[0]!.id]);
        expect(holds.held).toEqual([]);
        detach();
      });

      test("an in-app note on the untouched default (no model, Private offered) is recorded as Local and not sent to private cloud", async () => {
        await seedNative();
        const { real, jobs } = jobsOf();
        await real.check();
        const recorder = controller({ transcriber: real, onDeviceReady: false });
        const detach = recorder.attach();
        await tick();
        await recorder.record();
        await recorder.stop();
        await tick();
        expect(onPhone[0]!.options?.transcriber).toBe("on-device");
        expect(jobs).toEqual([]);
        detach();
      });
    });

    describe("a failed engine write is shown and changes nothing", () => {
      test("the engine refuses: the choice throws, nothing is stored, and screen and engine keep the old default", async () => {
        await seedNative();
        const recorder = controller({ transcriber: offer({ availability: "available", consented: true }).stub, onDeviceReady: false });
        const detach = recorder.attach();
        await tick();
        __setVoiceNotesForTests({ ...plugin, setCaptureDefaults: async () => { throw new Error("engine is busy"); } }, { available: true });
        await expect(recorder.setTranscriber("off", { scope: "default" })).rejects.toThrow("engine is busy");
        __setVoiceNotesForTests(plugin, { available: true });
        expect(values.has("exo.voiceNotes.transcriber")).toBe(false);
        expect(recorder.getTranscriber()).toMatchObject({ id: "on-device" });
        await agree(recorder);
        detach();
      });

      test("the choice cannot be stored: the engine is put back, the choice throws, and screen and engine agree", async () => {
        await seedNative();
        const recorder = controller({ transcriber: offer({ availability: "available", consented: true }).stub, onDeviceReady: false });
        const detach = recorder.attach();
        await tick();
        Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
          getItem: (key: string) => values.get(key) ?? null,
          setItem: () => { throw new Error("storage is full"); },
          removeItem: (key: string) => { values.delete(key); },
        } });
        await expect(recorder.setTranscriber("on-device", { scope: "default" })).rejects.toThrow("storage is full");
        expect(await nativeDefault()).toBe("on-device");
        expect(recorder.getTranscriber()).toMatchObject({ id: "on-device" });
        await agree(recorder);
        detach();
      });

      for (const prior of [null, "private-cloud"] as const) {
        test(`the second stored key fails (${prior === null ? "first save" : `previous choice ${prior}`}): both keys and the engine go back, and a fresh controller sees the old choice`, async () => {
          await seedNative();
          if (prior) { values.set("exo.voiceNotes.transcriber", prior); await fake.plugin.setCaptureDefaults({ accountDid: tcw.did, transitionGen: 1, transcriber: prior, identifySpeakers: false }); }
          const route = offer({ availability: "available", consented: true });
          const recorder = controller({ transcriber: route.stub, onDeviceReady: false });
          const detach = recorder.attach();
          await tick();
          const before = { transcriber: await nativeDefault(), shown: recorder.getTranscriber() };
          Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
            getItem: (key: string) => values.get(key) ?? null,
            setItem: (key: string, value: string) => {
              if (key === "exo.voiceNotes.identifySpeakers") throw new Error("storage is full");
              values.set(key, value);
            },
            removeItem: (key: string) => { values.delete(key); },
          } });
          await expect(recorder.setTranscriber("on-device", { scope: "default" })).rejects.toThrow("storage is full");
          expect(values.get("exo.voiceNotes.transcriber") ?? null).toBe(prior);
          expect(await nativeDefault()).toBe(before.transcriber);
          expect(recorder.getTranscriber()).toEqual(before.shown);
          await agree(recorder);
          detach();

          const remounted = controller({ transcriber: route.stub, onDeviceReady: false });
          const detachRemounted = remounted.attach();
          await tick();
          expect(remounted.getTranscriber()).toEqual(before.shown);
          expect(await nativeDefault()).toBe(before.transcriber);
          detachRemounted();
        });
      }
    });

    test("signed out stays Local, and a ready model keeps Local for a signed-in default", async () => {
      await seedNative();
      const signedOut = controller({ tcw: null, transcriber: offer({ availability: "available", consented: true }).stub, onDeviceReady: false });
      const detachOut = signedOut.attach();
      await tick();
      expect(signedOut.getTranscriber()).toEqual({ id: "on-device", identifySpeakers: false, source: "default" });
      detachOut();

      const ready = controller({ transcriber: offer({ availability: "available", consented: true }).stub, onDeviceReady: true });
      const detachReady = ready.attach();
      await tick();
      expect(ready.getTranscriber()).toEqual({ id: "on-device", identifySpeakers: false, source: "default" });
      detachReady();
    });
  });
});
