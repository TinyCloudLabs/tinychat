import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import {
  __resetCaptureEngineForTests,
  __setInstalledEngineForTests,
  captureCapabilities,
  notifyCaptureCapabilitiesChanged,
  type CaptureCapabilities,
} from "@/lib/voiceNotes/captureEngine";
import {
  registerDesktopCaptureExtras,
  type DesktopCaptureExtras,
  type DownloadProgress,
  type WhisperModelInfo,
} from "@/lib/voiceNotes/desktopCaptureExtras";
import { onOpenCaptureSettings, openCaptureSettings } from "./openCaptureSettings";
import { localDesktopCaption, localDesktopExplanation, NO_DESKTOP_WHISPER, useDesktopWhisper, whisperModelName, type DesktopWhisperState } from "./useDesktopWhisper";

const LABEL = "Whisper Large Turbo (Multilingual)";
const caps: CaptureCapabilities = {
  nativeShortcuts: false, presentRecorder: false, openSettings: false, micDeniedPresentation: false,
  background: true, localTranscription: false, desktopWhisper: false, offlineRecorder: true,
};
const info = (patch: Partial<WhisperModelInfo>): WhisperModelInfo => ({
  id: "LargeTurbo" as WhisperModelInfo["id"], label: LABEL, sizeBytes: 1, downloaded: false, selected: false,
  downloading: false, progress: null, ...patch,
});

function fakeExtras() {
  const state = { selected: null as string | null, models: [info({})] };
  const listeners = new Set<(p: DownloadProgress) => void>();
  const extras = {
    models: {
      list: async () => state.models,
      get: async () => state.selected as never,
      select: async () => undefined,
      download: async () => undefined,
      onProgress: (cb: (p: DownloadProgress) => void) => { listeners.add(cb); return () => void listeners.delete(cb); },
    },
  } as unknown as DesktopCaptureExtras;
  return { state, extras, emit: (p: DownloadProgress) => listeners.forEach((l) => l(p)), listeners };
}

describe("Whisper copy", () => {
  test("names the model without repeating Whisper", () => {
    expect(whisperModelName(LABEL)).toBe("Large Turbo (Multilingual)");
    expect(localDesktopCaption(LABEL)).toBe("Whisper Large Turbo (Multilingual) on this Mac, after you stop.");
    expect(localDesktopExplanation(LABEL)).toContain("Large Turbo (Multilingual)");
    expect(localDesktopExplanation(null)).toContain("⚙︎");
  });
});

describe("openCaptureSettings", () => {
  test("opens every mounted ⚙︎, says false when none is mounted, and unregisters", () => {
    expect(openCaptureSettings()).toBe(false);
    let opened = 0;
    const off = onOpenCaptureSettings(() => void opened++);
    expect(openCaptureSettings()).toBe(true);
    expect(opened).toBe(1);
    off();
    expect(openCaptureSettings()).toBe(false);
  });
});

describe("useDesktopWhisper", () => {
  const saved = {
    window: (globalThis as { window?: unknown }).window,
    act: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT,
  };
  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    (globalThis as { window?: unknown }).window = { setTimeout, clearTimeout, event: undefined, HTMLIFrameElement: class {} };
  });
  afterAll(() => {
    (globalThis as { window?: unknown }).window = saved.window;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = saved.act;
  });
  afterEach(() => {
    __resetCaptureEngineForTests();
    registerDesktopCaptureExtras(null);
    caps.desktopWhisper = false;
  });

  const container = () => ({ nodeType: 1, nodeName: "DIV", tagName: "DIV", ownerDocument: null, textContent: "",
    addEventListener() {}, removeEventListener() {} }) as unknown as HTMLElement;

  async function mount(enabled: boolean) {
    const seen: DesktopWhisperState[] = [];
    function Probe() {
      seen.push(useDesktopWhisper(enabled));
      return null;
    }
    const root = createRoot(container());
    await act(async () => root.render(<Probe />));
    return { seen, unmount: () => act(async () => root.unmount()) };
  }

  test("disabled outside the Mac shell: never ready, reads nothing", async () => {
    __setInstalledEngineForTests("tauri", { ...caps, desktopWhisper: true });
    const { extras, listeners } = fakeExtras();
    registerDesktopCaptureExtras(extras);
    const mounted = await mount(false);
    expect(mounted.seen.at(-1)).toEqual(NO_DESKTOP_WHISPER);
    expect(listeners.size).toBe(0);
    await mounted.unmount();
  });

  test("no model: not ready; a finished download and a selection make it ready, naming the model, live", async () => {
    __setInstalledEngineForTests("tauri", caps);
    const fake = fakeExtras();
    registerDesktopCaptureExtras(fake.extras);
    const mounted = await mount(true);
    expect(mounted.seen.at(-1)).toEqual({ ready: false, modelLabel: null });

    // The model finishes downloading and is selected: the engine flips the capability and announces it.
    fake.state.models = [info({ downloaded: true, selected: true })];
    fake.state.selected = "LargeTurbo";
    await act(async () => {
      caps.desktopWhisper = true;
      notifyCaptureCapabilitiesChanged();
    });
    expect(captureCapabilities().desktopWhisper).toBe(true);
    expect(mounted.seen.at(-1)).toEqual({ ready: true, modelLabel: LABEL });

    // The user removes the selection: back to not ready.
    await act(async () => {
      caps.desktopWhisper = false;
      notifyCaptureCapabilitiesChanged();
    });
    expect(mounted.seen.at(-1)).toEqual({ ready: false, modelLabel: null });
    await mounted.unmount();
  });

  test("a download that ends re-reads the label; progress ticks do not", async () => {
    __setInstalledEngineForTests("tauri", { ...caps, desktopWhisper: true });
    const fake = fakeExtras();
    fake.state.selected = "LargeTurbo";
    fake.state.models = [info({ downloaded: true, selected: true, label: "Whisper Small" })];
    registerDesktopCaptureExtras(fake.extras);
    const mounted = await mount(true);
    expect(mounted.seen.at(-1)?.modelLabel).toBe("Whisper Small");
    fake.state.models = [info({ downloaded: true, selected: true, label: "Whisper Base" })];
    await act(async () => fake.emit({ id: "LargeTurbo" as never, fraction: 0.5, status: "downloading" }));
    expect(mounted.seen.at(-1)?.modelLabel).toBe("Whisper Small");
    await act(async () => fake.emit({ id: "LargeTurbo" as never, fraction: 1, status: "done" }));
    expect(mounted.seen.at(-1)?.modelLabel).toBe("Whisper Base");
    await mounted.unmount();
  });

  test("unsubscribes on unmount", async () => {
    __setInstalledEngineForTests("tauri", caps);
    const fake = fakeExtras();
    registerDesktopCaptureExtras(fake.extras);
    const mounted = await mount(true);
    expect(fake.listeners.size).toBe(1);
    await mounted.unmount();
    expect(fake.listeners.size).toBe(0);
  });

  test("static render starts from the engine's capability", () => {
    __setInstalledEngineForTests("tauri", { ...caps, desktopWhisper: true });
    let seen: DesktopWhisperState | undefined;
    function Probe() {
      seen = useDesktopWhisper(true);
      return null;
    }
    renderToStaticMarkup(<Probe />);
    expect(seen).toEqual({ ready: true, modelLabel: null });
  });
});
