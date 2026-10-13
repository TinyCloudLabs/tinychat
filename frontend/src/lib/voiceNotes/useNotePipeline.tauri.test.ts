import { afterEach, expect, test } from "bun:test";
import { appPlatform } from "@/lib/platform";
import { getDesktopWhisperQueue, registerDesktopWhisperQueue, type DesktopWhisperQueue } from "./desktop/desktopWhisper";
import { nativeVoiceNotesAvailable } from "./nativeVoiceNotes";
import { onDevicePipelineAvailable } from "./useNotePipeline";

const originalWindow = globalThis.window;
afterEach(() => {
  registerDesktopWhisperQueue(null);
  globalThis.window = originalWindow;
});

test("real Tauri detection enables the desktop Whisper pipeline without a Capacitor plugin", () => {
  globalThis.window = { __TAURI_INTERNALS__: {}, setTimeout, clearTimeout } as unknown as Window & typeof globalThis;
  const job = { id: "note-1", state: "transcribing" as const, error: null, progress: 37 };
  registerDesktopWhisperQueue({ snapshot: () => new Map([[job.id, job]]) } as DesktopWhisperQueue);
  expect(appPlatform()).toBe("tauri");
  expect(nativeVoiceNotesAvailable()).toBe(false);
  expect(onDevicePipelineAvailable(appPlatform())).toBe(true);
  expect(getDesktopWhisperQueue()?.snapshot().get(job.id)).toMatchObject({ state: "transcribing", progress: 37 });
});
