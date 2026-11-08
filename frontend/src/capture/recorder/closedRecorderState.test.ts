// A closed (detached) recorder writes no reducer state: answers and events it still hears after closing change
// nothing it holds. Attached again, it starts over from what is live.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createFakeVoiceNotes } from "@/lib/voiceNotes/fakeVoiceNotes";
import { VoiceNotes, __setVoiceNotesForTests, type VoiceNotesPlugin } from "@/lib/voiceNotes/nativeVoiceNotes";
import { __resetCaptureEngineForTests, __setInstalledEngineForTests, type CaptureCapabilities } from "@/lib/voiceNotes/captureEngine";
import { __resetHomeWorkForTests } from "@/lib/homeReauthorizing";
import { installDom } from "@/test/dom";
import { __resetRecorderOwnershipForTests, __setRecorderTrackerForTests, createVoiceNoteRecorderController } from "./voiceNoteRecorderController";

const WEB: CaptureCapabilities = {
  nativeShortcuts: false, presentRecorder: false, openSettings: false, micDeniedPresentation: false,
  background: false, localTranscription: false, desktopWhisper: false, offlineRecorder: false, nativeFileUpload: false,
  scopedDiscard: true, scopedStop: true, unattendedStop: "scoped",
};
const flush = async () => { for (let turn = 0; turn < 40; turn += 1) await Promise.resolve(); };
const saved = VoiceNotes;
let restoreDom: () => void;

beforeEach(() => {
  restoreDom = installDom();
  __resetHomeWorkForTests();
  __resetRecorderOwnershipForTests();
  // Trackers left by the close stay asleep: this is about the closed recorder's own state.
  __setRecorderTrackerForTests({ sleep: () => new Promise<void>(() => {}) });
});
afterEach(() => {
  __setRecorderTrackerForTests(null);
  __resetRecorderOwnershipForTests();
  __resetCaptureEngineForTests();
  __setVoiceNotesForTests(saved, { available: null });
  __resetHomeWorkForTests();
  restoreDom();
});

test("a stop answered after the recorder closed writes nothing to it; attached again, it starts from what is live", async () => {
  const fake = createFakeVoiceNotes(undefined, { idBase: 720_000_000_000 });
  let answer = () => {};
  const engine: VoiceNotesPlugin = {
    ...fake.plugin,
    stop: (options) => new Promise((resolve, reject) => { answer = () => { void fake.plugin.stop(options).then(resolve, reject); }; }),
  };
  __setInstalledEngineForTests("web", WEB);
  __setVoiceNotesForTests(engine, { available: true });
  const recorder = createVoiceNoteRecorderController({
    tcw: null, available: true, transcriber: { check: async () => {}, noteSaved: () => {} }, onDeviceReady: () => true,
  });
  const detach = recorder.attach();
  await flush();
  await recorder.record();
  await flush();
  expect(recorder.getState().phase).toBe("recording");
  const stopping = recorder.stop();
  await flush();
  expect(recorder.getState().phase).toBe("stopping");
  detach();
  const atClose = recorder.getState();
  // The stop is answered (and its save runs) after the close.
  answer();
  await stopping;
  await flush();
  expect(recorder.getState()).toBe(atClose);
  expect((await fake.plugin.status()).state).toBe("idle");
  // Attached again: nothing of the closed stop is shown; nothing is live.
  const again = recorder.attach();
  await flush();
  expect(recorder.getState().phase).toBe("idle");
  again();
});
