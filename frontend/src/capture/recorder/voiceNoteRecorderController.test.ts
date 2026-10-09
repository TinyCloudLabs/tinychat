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

function controller() {
  return createVoiceNoteRecorderController({
    tcw,
    available: true,
    transcriber: { noteSaved: (recording) => noted.push(recording.id) },
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
      phase: "idle", error: "Recording kept on this phone. Exo will finish it automatically.",
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
      phase: "idle", error: "Recording kept on this phone. Exo will finish it automatically.",
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
