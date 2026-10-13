import { expect, test } from "bun:test";
import { effectiveCaptureOptions, readTranscriberPreference, readUploadAudioPreference, setUploadAudioPreference } from "./transcriberPreference";

test("audio upload is per-device, off by default, and only changes future capture options", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  } });
  try {
    expect(readUploadAudioPreference()).toBe(false);
    const first = effectiveCaptureOptions(readTranscriberPreference(), true);
    expect(first.uploadAudio).toBe(false);
    setUploadAudioPreference(true);
    expect(readUploadAudioPreference()).toBe(true);
    expect(first.uploadAudio).toBe(false);
    expect(effectiveCaptureOptions(readTranscriberPreference(), true).uploadAudio).toBe(true);
  } finally {
    setUploadAudioPreference(false);
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else delete (globalThis as { localStorage?: Storage }).localStorage;
  }
});
