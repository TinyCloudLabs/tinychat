// A closed (detached) recorder is inert: every entry point that reaches the engine or changes a recording's options
// does nothing once it has closed, including a call that was already waiting when it closed. The recording it left
// runs on, untouched.
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { createFakeVoiceNotes, type FakeVoiceNotes } from "@/lib/voiceNotes/fakeVoiceNotes";
import { VoiceNotes, __setVoiceNotesForTests, type VoiceNotesPlugin } from "@/lib/voiceNotes/nativeVoiceNotes";
import { __resetCaptureEngineForTests, __setInstalledEngineForTests, type CaptureCapabilities } from "@/lib/voiceNotes/captureEngine";
import { __resetHomeWorkForTests } from "@/lib/homeReauthorizing";
import { isDiscarded, unmarkDiscarded } from "@/lib/voiceNotes/recorderSaves";
import { installDom } from "@/test/dom";
import { __setEngineIdlePollForTests, createVoiceNoteRecorderController, type VoiceNoteRecorderController } from "./voiceNoteRecorderController";

const CAPABILITIES: CaptureCapabilities = {
  nativeShortcuts: true, presentRecorder: false, openSettings: true, micDeniedPresentation: true,
  background: false, localTranscription: false, desktopWhisper: true, offlineRecorder: false, nativeFileUpload: false,
};
const account = { did: "did:example:alice", spaceId: "space:alice" } as TinyCloudWeb;
const flush = async () => { for (let turn = 0; turn < 60; turn += 1) await Promise.resolve(); };
const saved = VoiceNotes;
let restoreDom: () => void;

beforeEach(() => {
  restoreDom = installDom();
  __resetHomeWorkForTests();
  // The closed recorder's hold on its place waits for the engine to read idle: not part of these tests.
  __setEngineIdlePollForTests(() => new Promise<void>(() => {}));
});
afterEach(() => {
  __setEngineIdlePollForTests(null);
  __resetCaptureEngineForTests();
  __setVoiceNotesForTests(saved, { available: null });
  __resetHomeWorkForTests();
  restoreDom();
});

/** Every engine call, by name. `hold`: calls of that name wait until released. */
function engineWithCalls(fake: FakeVoiceNotes) {
  const calls: string[] = [];
  const held = new Map<string, Array<() => void>>();
  const holding = new Set<string>();
  const engine = new Proxy(fake.plugin, {
    get(target, property: string) {
      const value = (target as unknown as Record<string, unknown>)[property];
      if (typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        calls.push(property);
        if (holding.has(property)) await new Promise<void>((resolve) => { held.set(property, [...(held.get(property) ?? []), resolve]); });
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as VoiceNotesPlugin;
  return {
    engine, calls,
    hold: (name: string) => { holding.add(name); },
    release: (name: string) => { holding.delete(name); for (const resolve of held.get(name)?.splice(0) ?? []) resolve(); },
  };
}

/** A signed-in recorder recording on Local (its own choice for this recording), and the engine it talks to. */
async function recordingOnLocal() {
  const fake = createFakeVoiceNotes(undefined, { idBase: 730_000_000_000 });
  const wrapped = engineWithCalls(fake);
  __setInstalledEngineForTests("tauri", CAPABILITIES);
  __setVoiceNotesForTests(wrapped.engine, { available: true });
  await fake.plugin.setCaptureDefaults({ accountDid: account.did!, transitionGen: 1, transcriber: "on-device", identifySpeakers: false });
  const recorder: VoiceNoteRecorderController = createVoiceNoteRecorderController({
    tcw: account, available: true, onDeviceReady: () => true,
    transcriber: { check: async () => {}, noteSaved: () => {},
      snapshot: () => ({ availability: "available", consented: true, capabilities: { max_bytes: 1_000_000, diarization: true }, jobs: new Map() }) },
  });
  const detach = recorder.attach();
  await flush();
  await recorder.record();
  await flush();
  expect(recorder.getState().phase).toBe("recording");
  expect(await recorder.setTranscriber("on-device", { scope: "recording" })).toBe("ok");
  expect((await fake.plugin.status()).options?.transcriber).toBe("on-device");
  return { fake, recorder, detach, ...wrapped };
}

/** The engine calls made after the recorder closed. */
const after = (calls: string[], from: number) => calls.slice(from);

test("a stale Private choice after the recorder closed leaves the live recording on Local", async () => {
  const { fake, recorder, detach, calls } = await recordingOnLocal();
  detach();
  const closedAt = calls.length;
  expect(await recorder.setTranscriber("private-cloud", { scope: "recording" })).toBe("unavailable");
  await flush();
  expect(after(calls, closedAt)).toEqual([]);
  expect(await fake.plugin.status()).toMatchObject({ state: "recording", options: { transcriber: "on-device" } });
  expect(recorder.getTranscriber().id).toBe("on-device");
});

test("a Local choice waiting on the desktop model check when the recorder closes changes nothing", async () => {
  const { fake, recorder, detach, calls } = await recordingOnLocal();
  await recorder.setTranscriber("off", { scope: "recording" });
  const pending = recorder.setTranscriber("on-device", { scope: "recording" });
  detach();
  const closedAt = calls.length;
  expect(await pending).toBe("unavailable");
  await flush();
  expect(after(calls, closedAt)).toEqual([]);
  expect((await fake.plugin.status()).options?.transcriber).toBe("off");
});

test("options read back after the recorder closed are not taken: its choice stays as it was at the close", async () => {
  const { fake, recorder, detach, hold, release } = await recordingOnLocal();
  hold("status");
  const choosing = recorder.setTranscriber("off", { scope: "recording" });
  await flush();
  detach();
  const atClose = recorder.getTranscriber();
  // The recording's options change on the device after the close; the held read answers with them.
  await fake.plugin.setRecordingOptions({ transcriber: "private-cloud" });
  release("status");
  await choosing;
  await flush();
  expect(recorder.getTranscriber()).toEqual(atClose);
});

test("speaker identification for the recording does nothing once the recorder closed", async () => {
  const { fake, recorder, detach, calls } = await recordingOnLocal();
  expect(await recorder.setTranscriber("private-cloud", { scope: "recording" })).toBe("ok");
  const before = (await fake.plugin.status()).options?.identifySpeakers;
  detach();
  const closedAt = calls.length;
  expect(await recorder.setIdentifySpeakers(!before, "recording")).toBe("unavailable");
  await flush();
  expect(after(calls, closedAt)).toEqual([]);
  expect((await fake.plugin.status()).options?.identifySpeakers).toBe(before);
});

test("Stop, Discard, Pause and Resume do nothing once the recorder closed", async () => {
  const { fake, recorder, detach, calls } = await recordingOnLocal();
  detach();
  const closedAt = calls.length;
  await recorder.pause();
  await recorder.resume();
  await recorder.stop();
  await recorder.discard();
  await flush();
  expect(after(calls, closedAt)).toEqual([]);
  expect(await fake.plugin.status()).toMatchObject({ state: "recording", intent: "recording" });
});

test("Record does nothing once the recorder closed", async () => {
  const fake = createFakeVoiceNotes(undefined, { idBase: 731_000_000_000 });
  const { engine, calls } = engineWithCalls(fake);
  __setInstalledEngineForTests("tauri", CAPABILITIES);
  __setVoiceNotesForTests(engine, { available: true });
  const recorder = createVoiceNoteRecorderController({ tcw: null, available: true, onDeviceReady: () => true,
    transcriber: { check: async () => {}, noteSaved: () => {} } });
  const detach = recorder.attach();
  await flush();
  expect(recorder.getState().ready).toBe(true);
  detach();
  const closedAt = calls.length;
  await recorder.record();
  await flush();
  expect(after(calls, closedAt)).toEqual([]);
  expect((await fake.plugin.status()).state).toBe("idle");
});

test("a Stop answered after the recorder closed leaves the save to the pending saves: the closed recorder calls nothing more", async () => {
  const { fake, recorder, detach, calls, hold, release } = await recordingOnLocal();
  hold("stop");
  const stopping = recorder.stop();
  await flush();
  detach();
  const closedAt = calls.length;
  release("stop");
  await stopping;
  await flush();
  expect(after(calls, closedAt)).toEqual([]);
  // Kept on the device, for the pending saves.
  expect((await fake.plugin.listPending()).recordings).toHaveLength(1);
});

test("a Discard answered after the recorder closed leaves its cleanup to the discard mark: the closed recorder calls nothing more", async () => {
  const { fake, recorder, detach, calls, hold, release } = await recordingOnLocal();
  // The limit stopped it first: an open recorder would now delete the committed audio itself.
  fake.plugin.discard = async () => { throw Object.assign(new Error("not recording"), { code: "not_recording" }); };
  hold("discard");
  const id = recorder.getState().recordingId!;
  const discarding = recorder.discard();
  await flush();
  detach();
  const closedAt = calls.length;
  release("discard");
  await discarding;
  await flush();
  try {
    expect(after(calls, closedAt)).toEqual([]);
    // The mark stays for the pending saves and the next launch to act on.
    expect(isDiscarded(id)).toBe(true);
  } finally {
    // Shared by every test in the run (the fake engine numbers its recordings the same way each time).
    unmarkDiscarded(id);
  }
});

test("dismissing the shortcut recovery, waiting on its status read when the recorder closes, dismisses nothing", async () => {
  const { fake, recorder, detach, calls, hold, release } = await recordingOnLocal();
  // The phone is showing its denied-microphone recovery: an open recorder's dismissal would reach the engine.
  const status = fake.plugin.status.bind(fake.plugin);
  fake.plugin.status = async () => ({ ...(await status()), micDeniedPresentation: true });
  hold("status");
  const pending = recorder.dismissShortcutRecovery();
  await flush();
  detach();
  release("status");
  await pending;
  await flush();
  expect(calls).not.toContain("dismissShortcutRecovery");
});

test("dismissing the shortcut recovery, waiting on its status read when the recorder closes, dismisses nothing", async () => {
  const { recorder, detach, calls, hold, release } = await recordingOnLocal();
  hold("status");
  const pending = recorder.dismissShortcutRecovery();
  await flush();
  detach();
  release("status");
  await pending;
  await flush();
  expect(calls).not.toContain("dismissShortcutRecovery");
});

test("Open settings and Save now do nothing once the recorder closed", async () => {
  const { recorder, detach, calls } = await recordingOnLocal();
  detach();
  const closedAt = calls.length;
  await recorder.openSettings();
  await recorder.retryPending();
  await flush();
  expect(after(calls, closedAt)).toEqual([]);
});
