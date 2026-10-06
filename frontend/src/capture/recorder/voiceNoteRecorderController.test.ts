// The recorder's controller against the fake plugin (harness/fakeVoiceNotes):
// the data-safety paths, behaviourally. Record waits until status() and the
// retained events are heard; a remount picks up a running recording; a Stop
// racing the limit's auto-stop saves exactly once; another recording's
// auto-stop (retained from before a reload, or late) is saved in the background
// without touching the one on screen; listeners go on teardown; Save now after
// a failed save lands the receipt.
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

const tcw = {} as TinyCloudWeb;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

let fake: FakeVoiceNotes;
/** Stopped recordings still on the phone, as the shells keep them until a save is confirmed. */
let onPhone: VoiceNoteRecording[];
let saves: string[];
let noted: string[];
// The save guards are module-wide and outlive a test: every recording gets its own id.
let serial = 0;
let currentId: string | null = null;

async function stopNatively(): Promise<VoiceNoteRecording> {
  const recording = { ...(await fake.plugin.stop()), id: currentId! };
  currentId = null;
  onPhone.push(recording);
  return recording;
}

/** A recording made before this one, stopped at its limit, still on the phone. */
function earlier(): VoiceNoteRecording {
  const recording = { id: `old-${++serial}`, startedAt: 1, durationMs: 60_000, mimeType: "audio/mp4", sizeBytes: 4, silencedMs: 0, silencedEvents: 0, noSignalMs: 0 };
  onPhone.push(recording);
  return recording;
}

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
  const plugin: VoiceNotesPlugin = {
    ...fake.plugin,
    async start(options) {
      const started = await fake.plugin.start(options);
      currentId = `note-${++serial}`;
      return { ...started, id: currentId };
    },
    stop: stopNatively,
    async status() {
      const status = await fake.plugin.status();
      return { ...status, id: status.id === null ? null : currentId };
    },
    async listPending() {
      return { recordings: [...onPhone] };
    },
    async deleteAudio({ id }) {
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
  test("listeners: three while attached, none after teardown", async () => {
    const { detach } = await attached();
    expect(fake.stats().active).toBe(3);
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
    expect(fake.stats().adds).toBe(6);
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
    expect(onPhone.map((recording) => recording.id)).toEqual([]);
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
    expect(recorder.getState()).toMatchObject({ phase: "saving", recordingId: old.id });
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
    expect(onPhone).toEqual([]);
  });
});
