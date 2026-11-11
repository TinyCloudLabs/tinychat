import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { installDom } from "@/test/dom";
import { homeWorkBusyNow, useInFlightWork, type InFlightWork } from "./inFlightWork";
import { __resetHomeWorkForTests, admitHomeWork } from "./homeReauthorizing";
import { __resetCaptureEngineForTests, __setInstalledEngineForTests, captureCapabilities, notifyCaptureCapabilitiesChanged } from "./voiceNotes/captureEngine";
import { VoiceNotes, __setVoiceNotesForTests, type CaptureStatus, type VoiceNotesPlugin } from "./voiceNotes/nativeVoiceNotes";

const realVoiceNotes = VoiceNotes;
let restoreDom: () => void;
let root: Root;
let seen: InFlightWork = null;
beforeEach(() => {
  __resetHomeWorkForTests();
  restoreDom = installDom();
  root = createRoot(document.body.appendChild(document.createElement("div")));
  __setInstalledEngineForTests("web", captureCapabilities());
  jest.useFakeTimers();
});
afterEach(async () => {
  await act(async () => root.unmount());
  jest.useRealTimers();
  __resetCaptureEngineForTests();
  __setVoiceNotesForTests(realVoiceNotes, { available: null });
  restoreDom();
});

function Probe() {
  seen = useInFlightWork(true);
  return null;
}
/** Move the clock and let the reads it starts or ends settle. */
const advance = (ms: number) => act(async () => { jest.advanceTimersByTime(ms); await Promise.resolve(); await Promise.resolve(); });

test("a recorder status read that never answers stops counting as a recording after two seconds", async () => {
  let reads = 0;
  __setVoiceNotesForTests({
    status: () => {
      reads += 1;
      // The first read says a recording is open; every later read hangs.
      return reads === 1 ? Promise.resolve({ intent: "recording" } as CaptureStatus) : new Promise<CaptureStatus>(() => {});
    },
  } as unknown as VoiceNotesPlugin, { available: true });
  await act(async () => root.render(<Probe />));
  await advance(0);
  expect(seen).toBe("recording");
  // The next poll (1 s) hangs; it times out 2 s later.
  await advance(1_000);
  expect(seen).toBe("recording");
  await advance(2_000);
  expect(seen).toBeNull();
});

test("a failing status read does not count as a recording", async () => {
  __setVoiceNotesForTests({ status: () => Promise.reject(new Error("unavailable")) } as unknown as VoiceNotesPlugin, { available: true });
  await act(async () => root.render(<Probe />));
  await advance(0);
  expect(seen).toBeNull();
});

test("a recorder engine installed later (after Recording is allowed) is watched from then on", async () => {
  __resetCaptureEngineForTests();
  __setVoiceNotesForTests({ status: () => Promise.resolve({ intent: "recording" } as CaptureStatus) } as unknown as VoiceNotesPlugin, { available: false });
  await act(async () => root.render(<Probe />));
  await advance(0);
  expect(seen).toBeNull();
  await act(async () => { __setInstalledEngineForTests("web", captureCapabilities()); notifyCaptureCapabilitiesChanged(); });
  await advance(0);
  expect(seen).toBe("recording");
});

test("a recording or upload that has just been admitted counts at once, before the recorder or runner reports it", async () => {
  __setVoiceNotesForTests({ status: () => Promise.resolve({ intent: "stopped" } as CaptureStatus) } as unknown as VoiceNotesPlugin, { available: true });
  await act(async () => root.render(<Probe />));
  await advance(0);
  expect(seen).toBeNull();
  const releaseRecording = admitHomeWork("recording")!;
  await advance(0);
  expect(seen).toBe("recording");
  expect(homeWorkBusyNow()).toBe(true);
  await act(async () => { releaseRecording(); });
  const releaseUpload = admitHomeWork("upload")!;
  await advance(0);
  expect(seen).toBe("upload");
  await act(async () => { releaseUpload(); });
  expect(seen).toBeNull();
  expect(homeWorkBusyNow()).toBe(false);
});
