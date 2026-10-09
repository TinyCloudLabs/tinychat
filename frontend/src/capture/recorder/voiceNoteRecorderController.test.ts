// The recorder's controller against the fake plugin (harness/fakeVoiceNotes):
// the data-safety paths, behaviourally. Record waits until status() and the
// retained events are heard; a remount picks up a running recording; a Stop
// racing the limit's auto-stop saves exactly once; another recording's
// auto-stop (retained from before a reload, or late) is saved in the background
// without touching the one on screen; listeners go on teardown; Save now after
// a failed save lands the receipt; a discarded recording is deleted and never
// saved, even when the limit races it or the phone keeps its copy.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { createFakeVoiceNotes, type FakeVoiceNotes } from "@/harness/fakeVoiceNotes";
import { fakeVoiceNoteStore } from "@/harness/fakeVoiceNoteStore";
import { __setVoiceNotesForTests, type VoiceNoteRecording, type VoiceNotesPlugin } from "@/lib/voiceNotes/nativeVoiceNotes";
import { setDefaultTranscriber } from "@/lib/voiceNotes/transcriberPreference";
import { createVoiceNoteTranscriber, type VoiceNoteTranscriber } from "@/lib/voiceNotes/voiceNoteTranscription";
import { consentToRecordingPrivateCloud, setRecordingRoute } from "./TranscriptionRouteControl";
import { loadNote } from "@/lib/voiceNotes/recordingNotes";
import { reportRecordingNoteSyncError } from "@/lib/voiceNotes/voiceNoteStore";

const realStore = { ...(await import("@/lib/voiceNotes/voiceNoteStore")) };
mock.module("@/lib/voiceNotes/voiceNoteStore", () => ({
  ...realStore,
  saveVoiceNote: (...args: Parameters<typeof realStore.saveVoiceNote>) => (fakeVoiceNoteStore.save ?? realStore.saveVoiceNote)(...args),
}));
const { createVoiceNoteRecorderController } = await import("./voiceNoteRecorderController");
const { micRecoveryMode, readMicRecoveryMode } = await import("./MicDeniedRecovery");
const { isDiscarded, saveRecording } = await import("@/lib/voiceNotes/recorderSaves");

const tcw = { did: "did:example:alice" } as TinyCloudWeb;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

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

function controller(options: { tcw?: TinyCloudWeb | null; consented?: boolean | (() => boolean); onDeviceReady?: boolean;
  appleInterim?: boolean; transcriber?: VoiceNoteTranscriber; noteLoader?: typeof loadNote;
  noteRetryScheduler?: (delayMs: number, retry: () => void) => () => void } = {}) {
  return createVoiceNoteRecorderController({
    tcw: options.tcw === undefined ? tcw : options.tcw,
    available: true,
    transcriber: options.transcriber ?? { noteSaved: (recording) => noted.push(recording.id),
      snapshot: () => ({ availability: "available", consented: typeof options.consented === "function" ? options.consented() : options.consented ?? false,
        capabilities: null, jobs: new Map() }) },
    onDeviceReady: () => options.onDeviceReady ?? true,
    appleInterim: () => options.appleInterim ?? false,
    noteLoader: options.noteLoader,
    noteRetryScheduler: options.noteRetryScheduler,
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
});

async function attached() {
  const recorder = controller();
  const detach = recorder.attach();
  await tick();
  return { recorder, detach };
}

describe("voice-note recorder controller", () => {
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
    expect(recorder.getTranscriber()).toEqual({ id: "private-cloud", identifySpeakers: false, source: "recording" });
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
    expect(await first.setIdentifySpeakers(true, "recording")).toBe("ok");
    expect(first.getTranscriber().identifySpeakers).toBe(true);
    expect(await first.setTranscriber("private-cloud", { scope: "recording" })).toBe("ok");
    expect(first.getTranscriber()).toEqual({ id: "private-cloud", identifySpeakers: false, source: "recording" });
    expect(await first.setIdentifySpeakers(true, "recording")).toBe("unavailable");
    expect((await fake.plugin.getCaptureDefaults()).transcriber).toBe("on-device");
    detach();

    const second = controller({ consented: true });
    const remove = second.attach();
    await tick();
    expect(second.getTranscriber()).toEqual({ id: "private-cloud", identifySpeakers: false, source: "recording" });
    remove();
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

  test("private cloud needs consent; unavailable model and AssemblyAI report unavailable", async () => {
    await fake.plugin.setCaptureDefaults({ accountDid: tcw.did, transitionGen: 1,
      transcriber: "on-device", identifySpeakers: false });
    const recorder = controller({ onDeviceReady: false });
    const detach = recorder.attach();
    await tick();
    await recorder.record();
    expect(await recorder.setTranscriber("private-cloud", { scope: "recording" })).toBe("needs_consent");
    expect(await recorder.setTranscriber("on-device", { scope: "recording" })).toBe("unavailable");
    expect(await recorder.setTranscriber("on-device", { scope: "recording", waitForModel: true })).toBe("ok");
    expect(await recorder.setTranscriber("assemblyai", { scope: "recording" })).toBe("unavailable");
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
      expect(await recorder.setIdentifySpeakers(true, "default")).toBe("ok");
      expect(await recorder.setTranscriber("private-cloud", { scope: "default" })).toBe("ok");
      expect(recorder.getTranscriber()).toEqual({ id: "private-cloud", identifySpeakers: false, source: "default" });
      expect(await fake.plugin.getCaptureDefaults()).toMatchObject({ transitionGen: 7,
        transcriber: "private-cloud", identifySpeakers: false });
      expect(values.get("exo.voiceNotes.identifySpeakers")).toBe("1");
      expect(await recorder.setTranscriber("on-device", { scope: "default" })).toBe("ok");
      expect(recorder.getTranscriber()).toEqual({ id: "on-device", identifySpeakers: true, source: "default" });
      expect(await fake.plugin.getCaptureDefaults()).toMatchObject({ transitionGen: 7,
        transcriber: "on-device", identifySpeakers: true });
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
    expect(recorder.getState().error).toContain("Already saved on this phone");
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
      phase: "idle", error: "Kept on this phone. Exo will finish it automatically.",
    });
    expect(recorder.getState().captureIssues[currentId ?? onPhone[0].id]).toEqual({ kind: "finalization_timed_out" });
    expect(onPhone).toHaveLength(1);
  });

  test("native recovery and write failures stay attached to their recording until recovery succeeds", async () => {
    const { recorder, detach } = await attached();
    await recorder.record();
    const id = recorder.getState().recordingId!;
    fake.emit("writeFailure", { id, error: "AAC write failed" });
    expect(recorder.getState().captureIssues[id]).toEqual({ kind: "write_failed", detail: "AAC write failed" });
    fake.emit("recoveryFailed", { id, reason: "mux failed" });
    expect(recorder.getState().captureIssues[id]).toEqual({ kind: "recoveryFailed", detail: "mux failed" });
    fake.emit("recovered", { id });
    expect(recorder.getState().captureIssues[id]).toBeUndefined();
    fake.emit("recoveryFailed", { error: "scan failed" });
    expect(recorder.getState().recoveryScanFailure).toBe("scan failed");
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

  test("iOS writer failure followed by an auto-stop carrying the saved note clears its issue", async () => {
    const { recorder } = await attached();
    await recorder.record();
    const id = recorder.getState().recordingId!;
    fake.emit("writeFailure", { id, error: "writer.finish failed" });
    expect(recorder.getState().captureIssues[id]?.kind).toBe("write_failed");
    const recording = await stopNatively();
    fake.emit("autoStopped", { id, reason: "write_failed", maxDurationMs: 10_800_000, at: Date.now(), recording });
    expect(recorder.getState().captureIssues[id]).toBeUndefined();
    await tick();
    expect(saves).toEqual([id]);
  });

  test("Android writer failure followed by committed and autoStopped clears its issue", async () => {
    const { recorder } = await attached();
    await recorder.record();
    const id = recorder.getState().recordingId!;
    fake.emit("writeFailure", { id, error: "write_failed: storage full" });
    const recording = await stopNatively();
    fake.emit("committed", { id });
    expect(recorder.getState().captureIssues[id]).toBeUndefined();
    fake.emit("autoStopped", { id, reason: "write_failed", maxDurationMs: 10_800_000, at: Date.now(), recording });
    await tick();
    expect(saves).toEqual([id]);
  });

  test("Android Stop failure followed by a successful second Stop clears its issue", async () => {
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
    expect(recorder.getState().captureIssues[id]).toBeUndefined();
    expect(stops).toBe(2);
  });

  test("a timed-out limit auto-stop explains recovery instead of saying no audio", async () => {
    const { recorder } = await attached();
    await recorder.record();
    fake.emit("autoStopped", {
      reason: "max_duration", maxDurationMs: 60_000, at: Date.now(),
      recording: null, error: "finalization_timed_out",
    });
    expect(recorder.getState()).toMatchObject({
      phase: "idle", error: "Kept on this phone. Exo will finish it automatically.",
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
    expect(recorder.getState()).toMatchObject({ phase: "idle", outcome: null, error: "Discarded, but this phone kept its copy: the file is busy" });
    const kept = onPhone[0]!;
    expect(isDiscarded(kept.id)).toBe(true);

    await recorder.retryPending();
    expect(onPhone).toEqual([]);
    expect(saves).toEqual([]);
    expect(isDiscarded(kept.id)).toBe(false);
    expect(deleteCalls).toBe(2);
  });
});
