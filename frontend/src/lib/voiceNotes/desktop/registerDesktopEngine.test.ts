import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { __resetCaptureEngineForTests, captureEngineKind } from "../captureEngine";
import { __setVoiceNotesForTests, VoiceNotes } from "../nativeVoiceNotes";
import { registerDesktopCaptureEngine } from "./registerDesktopEngine";

const global = globalThis as Record<string, unknown>;
const saved = { flag: process.env.VITE_EXO_RECORDER_FINAL, window: global.window, voiceNotes: VoiceNotes };

beforeEach(() => {
  __resetCaptureEngineForTests();
  __setVoiceNotesForTests(saved.voiceNotes, { available: false });
  global.window = { __TAURI_INTERNALS__: {} };
});
afterEach(() => {
  __resetCaptureEngineForTests();
  if (saved.flag === undefined) delete process.env.VITE_EXO_RECORDER_FINAL; else process.env.VITE_EXO_RECORDER_FINAL = saved.flag;
  global.window = saved.window;
  __setVoiceNotesForTests(saved.voiceNotes, { available: null });
});

describe("registerDesktopCaptureEngine", () => {
  test("registers the Tauri engine only when the recorder flag is on", () => {
    process.env.VITE_EXO_RECORDER_FINAL = "true";
    expect(captureEngineKind()).toBeNull();
    registerDesktopCaptureEngine();
    expect(captureEngineKind()).toBe("tauri");
  });

  test("registers nothing with the flag off, even if the flag flips afterwards", () => {
    delete process.env.VITE_EXO_RECORDER_FINAL;
    registerDesktopCaptureEngine();
    process.env.VITE_EXO_RECORDER_FINAL = "true";
    expect(captureEngineKind()).toBeNull();
  });
});
