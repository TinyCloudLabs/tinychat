import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { createFakeVoiceNotes } from "./fakeVoiceNotes";
import {
  __resetCaptureEngineForTests,
  captureCapabilities,
  captureEngineAvailable,
  captureEngineInstallPending,
  captureEngineKind,
  installCaptureEngine,
  registerCaptureEngine,
  type CaptureCapabilities,
  type CaptureEngine,
  type CaptureEngineKind,
} from "./captureEngine";
import { VoiceNotes, __setVoiceNotesForTests } from "./nativeVoiceNotes";

const none: CaptureCapabilities = {
  nativeShortcuts: false, presentRecorder: false, openSettings: false, micDeniedPresentation: false,
  background: false, localTranscription: false, desktopWhisper: false, offlineRecorder: false,
};
const engine = (): CaptureEngine => ({ ...createFakeVoiceNotes().plugin, capabilities: none });

const global = globalThis as Record<string, unknown>;
const saved = {
  flag: process.env.VITE_EXO_RECORDER_FINAL,
  window: global.window,
  MediaRecorder: global.MediaRecorder,
  mediaDevices: Object.getOwnPropertyDescriptor(navigator, "mediaDevices"),
  voiceNotes: VoiceNotes,
};

interface Shell { flag: boolean; native: boolean; tauri: boolean; mediaRecorder: boolean; mediaDevices: boolean }
function setShell(shell: Shell) {
  if (shell.flag) process.env.VITE_EXO_RECORDER_FINAL = "true"; else delete process.env.VITE_EXO_RECORDER_FINAL;
  __setVoiceNotesForTests(saved.voiceNotes, { available: shell.native });
  global.window = shell.tauri ? { __TAURI_INTERNALS__: {} } : {};
  if (shell.mediaRecorder) global.MediaRecorder = class {}; else delete global.MediaRecorder;
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: shell.mediaDevices ? {} : undefined });
}

beforeEach(() => __resetCaptureEngineForTests());
afterEach(() => {
  __resetCaptureEngineForTests();
  if (saved.flag === undefined) delete process.env.VITE_EXO_RECORDER_FINAL; else process.env.VITE_EXO_RECORDER_FINAL = saved.flag;
  global.window = saved.window;
  if (saved.MediaRecorder === undefined) delete global.MediaRecorder; else global.MediaRecorder = saved.MediaRecorder;
  if (saved.mediaDevices) Object.defineProperty(navigator, "mediaDevices", saved.mediaDevices); else delete (navigator as unknown as Record<string, unknown>).mediaDevices;
  __setVoiceNotesForTests(saved.voiceNotes, { available: null });
});

describe("captureEngineKind: flag x native x tauri internals x MediaRecorder x registered", () => {
  const bools = [false, true];
  for (const flag of bools) for (const native of bools) for (const tauri of bools) for (const mediaRecorder of bools)
    for (const registeredWeb of bools) for (const registeredTauri of bools) {
      const name = `flag=${flag} native=${native} tauri=${tauri} MediaRecorder=${mediaRecorder} web=${registeredWeb} tauriEngine=${registeredTauri}`;
      test(name, () => {
        setShell({ flag, native, tauri, mediaRecorder, mediaDevices: mediaRecorder });
        if (registeredWeb) registerCaptureEngine("web", async () => engine());
        if (registeredTauri) registerCaptureEngine("tauri", async () => engine());
        const expected: CaptureEngineKind | null = native ? "native"
          : !flag ? null
          : tauri ? (registeredTauri ? "tauri" : null)
          : mediaRecorder && registeredWeb ? "web"
          : null;
        expect(captureEngineKind()).toBe(expected);
        expect(captureEngineInstallPending()).toBe(expected === "web" || expected === "tauri");
      });
    }

  test("web needs navigator.mediaDevices as well as MediaRecorder", () => {
    setShell({ flag: true, native: false, tauri: false, mediaRecorder: true, mediaDevices: false });
    registerCaptureEngine("web", async () => engine());
    expect(captureEngineKind()).toBeNull();
  });
});

describe("flag off is unchanged", () => {
  test("web and tauri engines are never selected, installed or available", async () => {
    setShell({ flag: false, native: false, tauri: true, mediaRecorder: true, mediaDevices: true });
    let built = 0;
    registerCaptureEngine("web", async () => { built += 1; return engine(); });
    registerCaptureEngine("tauri", async () => { built += 1; return engine(); });
    await installCaptureEngine();
    expect(built).toBe(0);
    expect(captureEngineKind()).toBeNull();
    expect(captureEngineAvailable()).toBe(false);
    expect(captureCapabilities()).toEqual(none);
    expect(VoiceNotes).toBe(saved.voiceNotes);
  });

  test("native stays native: available without an install, the binding untouched, every capability on", async () => {
    setShell({ flag: false, native: true, tauri: false, mediaRecorder: false, mediaDevices: false });
    expect(captureEngineAvailable()).toBe(true);
    expect(captureCapabilities()).toMatchObject({ localTranscription: true, desktopWhisper: false });
    await installCaptureEngine();
    expect(captureEngineKind()).toBe("native");
    expect(VoiceNotes).toBe(saved.voiceNotes);
  });

  test("native is not displaced by a registered web engine, flag on", async () => {
    setShell({ flag: true, native: true, tauri: false, mediaRecorder: true, mediaDevices: true });
    registerCaptureEngine("web", async () => { throw new Error("must not build"); });
    await installCaptureEngine();
    expect(captureEngineKind()).toBe("native");
    expect(VoiceNotes).toBe(saved.voiceNotes);
  });
});

describe("installCaptureEngine", () => {
  const webShell: Shell = { flag: true, native: false, tauri: false, mediaRecorder: true, mediaDevices: true };

  test("installs the engine into the VoiceNotes seam once, however many callers", async () => {
    setShell(webShell);
    let built = 0;
    const web: CaptureEngine = { ...engine(), capabilities: { ...none, background: true } };
    registerCaptureEngine("web", async () => { built += 1; return web; });
    expect(captureEngineAvailable()).toBe(false);
    await Promise.all([installCaptureEngine(), installCaptureEngine()]);
    await installCaptureEngine();
    expect(built).toBe(1);
    expect(VoiceNotes).toBe(web);
    expect(captureEngineAvailable()).toBe(true);
    expect(captureEngineKind()).toBe("web");
    expect(captureEngineInstallPending()).toBe(false);
    expect(captureCapabilities()).toEqual({ ...none, background: true });
  });

  test("a failed install rejects, leaves nothing installed and the native binding alone, and can be retried", async () => {
    setShell(webShell);
    let attempts = 0;
    registerCaptureEngine("web", async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("indexedDB is blocked");
      return engine();
    });
    await expect(installCaptureEngine()).rejects.toThrow("indexedDB is blocked");
    expect(captureEngineAvailable()).toBe(false);
    expect(VoiceNotes).toBe(saved.voiceNotes);
    await installCaptureEngine();
    expect(captureEngineAvailable()).toBe(true);
    expect(attempts).toBe(2);
  });

  test("tauri is chosen over web inside the desktop shell", async () => {
    setShell({ ...webShell, tauri: true });
    registerCaptureEngine("web", async () => engine());
    const tauri = engine();
    registerCaptureEngine("tauri", async () => tauri);
    await installCaptureEngine();
    expect(captureEngineKind()).toBe("tauri");
    expect(VoiceNotes).toBe(tauri);
  });
});

describe("App.tsx gates its native-only surfaces on capabilities", () => {
  const app = readFileSync(new URL("../../App.tsx", import.meta.url), "utf8");
  test("the offline recorder, the signed-out local home and MicDeniedRecovery", () => {
    expect(app).toContain("voiceNotesInApp && capabilities.offlineRecorder && !LOCAL_VALIDATION && offlineCapture");
    expect(app).toContain("voiceNotesInApp && capabilities.offlineRecorder && !LOCAL_VALIDATION && state === \"unauthenticated\"");
    expect(app).toContain("platform === \"android\" && voiceNotesInApp && capabilities.micDeniedPresentation");
  });
});
