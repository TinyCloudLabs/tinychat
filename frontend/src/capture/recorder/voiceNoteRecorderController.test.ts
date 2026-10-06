// The recorder's controller against the fake plugin (harness/fakeVoiceNotes):
// the data-safety paths, behaviourally. A remount picks up a running recording
// through status(); a Stop racing the limit's auto-stop saves exactly once;
// listeners go on teardown; Save now after a failed save lands the receipt.
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
// The save guards are module-wide and outlive a test; every stopped recording gets its own id.
let serial = 0;
async function stopNatively(): Promise<VoiceNoteRecording> {
  const recording = { ...(await fake.plugin.stop()), id: `note-${++serial}` };
  onPhone.push(recording);
  return recording;
}
/** Stopped recordings still on the phone, as the shells keep them until a save is confirmed. */
let onPhone: VoiceNoteRecording[];
let saves: string[];
let noted: string[];

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
  const plugin: VoiceNotesPlugin = {
    ...fake.plugin,
    stop: stopNatively,
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

describe("voice-note recorder controller", () => {
  test("listeners: three while attached, none after teardown", async () => {
    const recorder = controller();
    const detach = recorder.attach();
    await tick();
    expect(fake.stats().active).toBe(3);
    detach();
    await tick();
    expect(fake.stats().active).toBe(0);
  });

  test("a remount picks up the running recording through status(), never starting another", async () => {
    const first = controller();
    const detachFirst = first.attach();
    await first.record();
    expect(first.getState().phase).toBe("recording");
    const id = first.getState().recordingId;
    detachFirst();

    const second = controller();
    second.attach();
    await tick();
    expect(second.getState()).toMatchObject({ phase: "recording", recordingId: id });
    expect(fake.stats().adds).toBe(6);
  });

  test("Stop racing the limit's auto-stop saves exactly once, whichever arrives first", async () => {
    for (const order of ["stop-first", "auto-first"] as const) {
      saves = [];
      const recorder = controller();
      const detach = recorder.attach();
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

  test("a failed save keeps the note; Save now lands it and the receipt says so", async () => {
    fakeVoiceNoteStore.save = fails;
    const recorder = controller();
    recorder.attach();
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
