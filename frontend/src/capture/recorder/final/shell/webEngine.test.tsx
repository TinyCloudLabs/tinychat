// The final recorder on the web engine: mic-denied recovery in a browser, no on-device probes, Local closed,
// and the browser's own microphone list. The engine is a fake registered through registerCaptureEngine.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

import { PlatformContext, type AppPlatform } from "@/lib/platform";
import {
  __resetCaptureEngineForTests,
  installCaptureEngine,
  registerCaptureEngine,
  type CaptureCapabilities,
  type CaptureEngine,
} from "@/lib/voiceNotes/captureEngine";
import { createFakeVoiceNotes } from "@/lib/voiceNotes/fakeVoiceNotes";
import { VoiceNotes, __setVoiceNotesForTests } from "@/lib/voiceNotes/nativeVoiceNotes";
import { OnDeviceStt, __setOnDeviceSttForTests, type OnDeviceSttPlugin } from "@/lib/voiceNotes/onDeviceStt";
import { BROWSER_MIC_GUIDANCE } from "../../MicrophoneAccessOff";
import { StaticRecorderProvider, type RecorderValue } from "../../RecorderProvider";
import { DesktopRecorder } from "../desktop/DesktopRecorder";
import { FINAL_COPY } from "../finalCopy";
import { PhoneRecorder } from "../PhoneRecorder";
import { selectRecorderView } from "../recorderView";
import { initialRecorderState } from "../../recorderReducer";
import { recorderState } from "../useFinalRecorderControls";
import { nativeAudioInputs, shellAudioInputs } from "../useAudioInputs";
import { scaleStops } from "../transcriptionModes";
import { useOnDeviceModel } from "../useTranscriptionChoice";
import { browserAudioInputs } from "./browserAudioInputs";
import { installReactTestEnv, mount } from "./hookTestUtil";

const global = globalThis as Record<string, unknown>;
const WEB: CaptureCapabilities = {
  nativeShortcuts: false, presentRecorder: false, openSettings: false, micDeniedPresentation: false,
  background: false, localTranscription: false, offlineRecorder: false,
};
const noop = () => {};

const saved = {
  flag: process.env.VITE_EXO_RECORDER_FINAL,
  MediaRecorder: global.MediaRecorder,
  voiceNotes: VoiceNotes,
  onDevice: OnDeviceStt,
  mediaDevices: Object.getOwnPropertyDescriptor(navigator, "mediaDevices"),
};
let onDeviceCalls: string[] = [];

beforeEach(() => {
  onDeviceCalls = [];
  __setOnDeviceSttForTests(
    new Proxy({}, {
      get: (_target, property: string) => () => {
        onDeviceCalls.push(property);
        throw new Error(`OnDeviceStt.${property} must not be called on the web engine`);
      },
    }) as unknown as OnDeviceSttPlugin,
  );
});

afterEach(() => {
  __resetCaptureEngineForTests();
  if (saved.flag === undefined) delete process.env.VITE_EXO_RECORDER_FINAL;
  else process.env.VITE_EXO_RECORDER_FINAL = saved.flag;
  if (saved.MediaRecorder === undefined) delete global.MediaRecorder;
  else global.MediaRecorder = saved.MediaRecorder;
  if (saved.mediaDevices) Object.defineProperty(navigator, "mediaDevices", saved.mediaDevices);
  else delete (navigator as unknown as Record<string, unknown>).mediaDevices;
  __setVoiceNotesForTests(saved.voiceNotes, { available: null });
  __setOnDeviceSttForTests(saved.onDevice);
});

async function installWeb() {
  process.env.VITE_EXO_RECORDER_FINAL = "true";
  __setVoiceNotesForTests(saved.voiceNotes, { available: false });
  global.MediaRecorder = class {};
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {} });
  registerCaptureEngine("web", async () => Object.assign(createFakeVoiceNotes().plugin, { capabilities: WEB }) as CaptureEngine);
  await installCaptureEngine();
}

const LIVE: Partial<RecorderValue> = {
  phase: "recording",
  mic: { state: "recording", reason: null },
  startedAt: 1,
  audioMs: 60_000,
  elapsedMs: 60_000,
  transcriber: { id: "private-cloud", identifySpeakers: false, source: "recording" },
  sheetOpen: true,
};
const IDLE_DENIED: Partial<RecorderValue> = {
  phase: "idle", mic: { state: "idle", reason: null }, permissionDenied: true, startedAt: null, audioMs: 0, elapsedMs: 0,
};
const REVOKED: Partial<RecorderValue> = { mic: { state: "needs_user", reason: "permission_revoked" } };

const wrap = (platform: AppPlatform, patch: Partial<RecorderValue>, child: React.ReactNode) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <PlatformContext.Provider value={platform}>
        <StaticRecorderProvider value={{ ...LIVE, ...patch }}>{child}</StaticRecorderProvider>
      </PlatformContext.Provider>
    </MemoryRouter>,
  );
const phone = (patch: Partial<RecorderValue>) => wrap("web", patch, <PhoneRecorder />);
const desktop = (patch: Partial<RecorderValue>) => wrap("web", patch, <DesktopRecorder layout="desktop" />);

describe("mic denied on the web engine", () => {
  for (const [name, render] of [["PhoneRecorder", phone], ["DesktopRecorder", desktop]] as const) {
    test(`${name}: denied at idle is browser guidance and Try again, not Open Settings`, async () => {
      await installWeb();
      const html = render(IDLE_DENIED);
      expect(html).toContain(BROWSER_MIC_GUIDANCE);
      expect(html).toContain("Try again");
      expect(html).not.toContain("Open Settings");
      expect(html).not.toContain('aria-label="Discard recording"');
    });

    test(`${name}: a permission revoked mid-recording gets the guidance only (record() does nothing over a recording)`, async () => {
      await installWeb();
      const html = render(REVOKED);
      expect(html).toContain(BROWSER_MIC_GUIDANCE);
      expect(html).not.toContain("Try again");
      expect(html).not.toContain("Open Settings");
    });

    test(`${name}: with no web engine installed the native Open Settings is unchanged`, () => {
      const html = render(IDLE_DENIED);
      expect(html).toContain("Open Settings");
      expect(html).not.toContain(BROWSER_MIC_GUIDANCE);
    });
  }

  test("the status line no longer sends a browser to Settings", async () => {
    await installWeb();
    const view = (patch: Partial<RecorderValue>) =>
      selectRecorderView(
        { ...initialRecorderState, ...recorderState({ ...(LIVE as RecorderValue), ...patch }), maxDurationMs: 3_600_000 },
        { nowMs: 0, elapsedMs: 0, inputName: null, silencedSinceMs: null },
      );
    expect(view(IDLE_DENIED).statusLine).toBe("Microphone access is off.");
    expect(view(REVOKED).statusLine).toBe("Microphone permission was revoked.");
    __resetCaptureEngineForTests();
    expect(view(IDLE_DENIED).statusLine).toBe(FINAL_COPY.denied);
    expect(view(REVOKED).statusLine).toBe(FINAL_COPY.permissionRevoked);
  });

  test("Try again is the recorder's record()", async () => {
    await installWeb();
    const { MicDeniedAction } = await import("./MicDeniedAction");
    let tries = 0;
    const tree = MicDeniedAction({ idle: true, onOpenSettings: noop, onTryAgain: () => tries++ }) as React.ReactElement<{
      children: React.ReactElement<{ onClick?: () => void }>[];
    }>;
    const button = [tree.props.children].flat().find((child) => child && child.props?.onClick);
    button!.props.onClick!();
    expect(tries).toBe(1);
  });
});

describe("the web engine's choice", () => {
  test("Local is the closed stop, with 'needs the app'; Private is open", () => {
    const stops = scaleStops("web", null);
    const local = stops.find((stop) => stop.id === "local")!;
    expect(local.availability).toEqual({ available: false, reason: "needs the app" });
    expect(stops.find((stop) => stop.id === "private")!.availability).toEqual({ available: true });
    const html = phone({ ...LIVE });
    expect(html).toContain('data-available="false"');
  });

  describe("no on-device probes", () => {
    let restore: () => void;
    beforeEach(() => {
      restore = installReactTestEnv();
    });
    afterEach(() => restore());

    function Probe() {
      useOnDeviceModel();
      return null;
    }

    test("the web engine never touches OnDeviceStt, even where the phone plugin looks available", async () => {
      await installWeb();
      __setVoiceNotesForTests(saved.voiceNotes, { available: true });
      const view = mount();
      await view.render(<Probe />);
      await view.unmount();
      expect(onDeviceCalls).toEqual([]);
    });
  });
});

describe("shellAudioInputs", () => {
  test("the phone plugin's list natively, the browser's with the web engine, none without an engine", async () => {
    expect(shellAudioInputs()).toBeNull();
    __setVoiceNotesForTests(saved.voiceNotes, { available: true });
    expect(shellAudioInputs()).toBe(nativeAudioInputs);
    __setVoiceNotesForTests(saved.voiceNotes, { available: null });
    await installWeb();
    expect(shellAudioInputs()).toBe(browserAudioInputs);
  });

  test("with the flag off the web has no list", async () => {
    process.env.VITE_EXO_RECORDER_FINAL = "false";
    global.MediaRecorder = class {};
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {} });
    registerCaptureEngine("web", async () => Object.assign(createFakeVoiceNotes().plugin, { capabilities: WEB }) as CaptureEngine);
    expect(shellAudioInputs()).toBeNull();
  });
});
