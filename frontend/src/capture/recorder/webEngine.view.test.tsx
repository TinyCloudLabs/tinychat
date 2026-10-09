// The legacy recorder overlay and the denied-microphone screen on an engine without native
// capabilities: OnDeviceStt is never touched, Local is not offered, and the browser gets guidance.
import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

import { __resetCaptureEngineForTests, installCaptureEngine, registerCaptureEngine, type CaptureCapabilities, type CaptureEngine } from "@/lib/voiceNotes/captureEngine";
import { createFakeVoiceNotes } from "@/lib/voiceNotes/fakeVoiceNotes";
import { VoiceNotes, __setVoiceNotesForTests } from "@/lib/voiceNotes/nativeVoiceNotes";
import { OnDeviceStt, __setOnDeviceSttForTests, type OnDeviceSttPlugin } from "@/lib/voiceNotes/onDeviceStt";
import { onDeviceSttStore } from "@/lib/voiceNotes/onDeviceSttStore";
import { BROWSER_MIC_GUIDANCE, MicrophoneAccessOff } from "./MicrophoneAccessOff";
import { RecordingView } from "./RecordingView";
import type { RecorderValue } from "./RecorderProvider";
import { TranscriptionRouteControl } from "./TranscriptionRouteControl";

const global = globalThis as Record<string, unknown>;
const WEB: CaptureCapabilities = {
  nativeShortcuts: false, presentRecorder: false, openSettings: false, micDeniedPresentation: false,
  background: false, localTranscription: false, offlineRecorder: false,
};
const noop = () => {};

const saved = {
  flag: process.env.VITE_EXO_RECORDER_FINAL, MediaRecorder: global.MediaRecorder, voiceNotes: VoiceNotes, onDevice: OnDeviceStt,
  mediaDevices: Object.getOwnPropertyDescriptor(navigator, "mediaDevices"),
};

afterEach(() => {
  __resetCaptureEngineForTests();
  if (saved.flag === undefined) delete process.env.VITE_EXO_RECORDER_FINAL; else process.env.VITE_EXO_RECORDER_FINAL = saved.flag;
  if (saved.MediaRecorder === undefined) delete global.MediaRecorder; else global.MediaRecorder = saved.MediaRecorder;
  if (saved.mediaDevices) Object.defineProperty(navigator, "mediaDevices", saved.mediaDevices); else delete (navigator as unknown as Record<string, unknown>).mediaDevices;
  __setVoiceNotesForTests(saved.voiceNotes, { available: null });
  __setOnDeviceSttForTests(saved.onDevice);
});

async function installWeb(): Promise<string[]> {
  const calls: string[] = [];
  __setOnDeviceSttForTests(new Proxy({}, { get: (_t, property: string) => () => {
    calls.push(property);
    throw new Error(`OnDeviceStt.${property} must not be called without localTranscription`);
  } }) as unknown as OnDeviceSttPlugin);
  process.env.VITE_EXO_RECORDER_FINAL = "true";
  __setVoiceNotesForTests(saved.voiceNotes, { available: false });
  global.MediaRecorder = class {};
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {} });
  registerCaptureEngine("web", async () => Object.assign(createFakeVoiceNotes().plugin, { capabilities: WEB }) as CaptureEngine);
  await installCaptureEngine();
  return calls;
}

const recorder = (patch: Partial<RecorderValue> = {}): RecorderValue => ({
  available: true, ready: true, phase: "recording", permissionDenied: false, mic: { state: "recording", reason: null },
  startedAt: Date.now() - 42_000, audioMs: 42_000, maxDurationMs: 3 * 60 * 60_000,
  limitNotice: null, savePercent: null, error: null, outcome: null, lastSaved: null,
  pending: { listing: { state: "ok", count: 0 }, running: false, lastError: null },
  transcription: { availability: "available", consented: true, maxSeconds: 600, jobs: new Map(), onTranscribe: noop, onConsent: noop, onTurnOff: noop, onRecheck: noop },
  signedIn: true, sheetOpen: true,
  transcriber: { id: "private-cloud", identifySpeakers: false, source: "default" },
  setTranscriber: async () => "ok",
  record: noop, stop: noop, pause: noop, resume: noop, discard: noop, retryPending: noop, openSettings: async () => {},
  dismissOutcome: noop, openSheet: noop, minimiseSheet: noop, setReceiptPlaying: noop,
  subscribeLevel: () => noop, ...patch,
});

const view = (patch: Partial<RecorderValue> = {}) => renderToStaticMarkup(
  <MemoryRouter><RecordingView recorder={recorder(patch)} /></MemoryRouter>,
);

describe("web engine, opened overlay", () => {
  test("the recording view and the saved receipt never call OnDeviceStt, and Local is not offered", async () => {
    const calls = await installWeb();
    const recording = view();
    const receipt = view({ phase: "idle", outcome: "local", startedAt: null, lastSaved: { id: "rec-1", durationMs: 42_000, at: Date.now() } });
    expect(onDeviceSttStore.snapshot().models).toEqual([]);
    expect(onDeviceSttStore.subscribe(noop)).toBeInstanceOf(Function);
    await onDeviceSttStore.refresh();
    expect(recording).toContain('data-testid="transcription-route"');
    expect(recording).not.toContain("On this phone");
    expect(receipt).toContain('data-testid="voice-note-receipt"');
    expect(calls).toEqual([]);
  });

  test("the standalone route control offers Off and Private cloud only", async () => {
    const calls = await installWeb();
    const html = renderToStaticMarkup(<MemoryRouter><TranscriptionRouteControl transcription={recorder().transcription} signedIn /></MemoryRouter>);
    expect(html).not.toContain("On this phone");
    expect(html).toContain("Private cloud");
    expect(calls).toEqual([]);
  });
});

describe("denied microphone recovery", () => {
  test("on the web engine it shows browser guidance and Try again, never Open Settings", async () => {
    await installWeb();
    const html = view({ phase: "idle", permissionDenied: true, startedAt: null });
    expect(html).toContain(BROWSER_MIC_GUIDANCE);
    expect(html).toContain('data-testid="voice-note-try-again"');
    expect(html).not.toContain("Open Settings");
    expect(html).not.toContain('data-testid="voice-note-open-settings"');
  });

  test("where the shell can open settings it still offers Open Settings", () => {
    const html = renderToStaticMarkup(<MicrophoneAccessOff onMinimise={noop} onOpenSettings={async () => {}} onTryAgain={noop} />);
    expect(html).toContain('data-testid="voice-note-open-settings"');
    expect(html).not.toContain("voice-note-try-again");
    expect(html).not.toContain(BROWSER_MIC_GUIDANCE);
  });
});

describe("signed-out web", () => {
  test("the offline recorder and signed-out local home stay off, so no Record action is offered without an account", async () => {
    await installWeb();
    const { captureCapabilities } = await import("@/lib/voiceNotes/captureEngine");
    expect(captureCapabilities().offlineRecorder).toBe(false);
  });
});
