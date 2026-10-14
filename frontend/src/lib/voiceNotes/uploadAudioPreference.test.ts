import { expect, test } from "bun:test";
import { effectiveCaptureOptions, readTranscriberPreference, readUploadAudioPreference, setUploadAudioPreference } from "./transcriberPreference";
import { createFakeVoiceNotes } from "./fakeVoiceNotes";
import { __setVoiceNotesForTests } from "./nativeVoiceNotes";

test("audio upload is per-device, off by default, and only changes future capture options", async () => {
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
    await setUploadAudioPreference(true);
    expect(readUploadAudioPreference()).toBe(true);
    expect(first.uploadAudio).toBe(false);
    expect(effectiveCaptureOptions(readTranscriberPreference(), true).uploadAudio).toBe(true);
  } finally {
    await setUploadAudioPreference(false);
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else delete (globalThis as { localStorage?: Storage }).localStorage;
  }
});

test("the Mac preference reaches durable capture defaults for a native-started note", async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "window", { configurable: true, value: { __TAURI_INTERNALS__: {} } });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  } });
  const fake = createFakeVoiceNotes();
  __setVoiceNotesForTests(fake.plugin, { available: true });
  try {
    expect((await fake.plugin.getCaptureDefaults()).uploadAudio ?? false).toBe(false);
    await setUploadAudioPreference(true);
    expect((await fake.plugin.getCaptureDefaults()).uploadAudio).toBe(true);
    await fake.plugin.start();
    expect((await fake.plugin.status()).options?.uploadAudio).toBe(true);
  } finally {
    __setVoiceNotesForTests(null, { available: null });
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else delete (globalThis as { window?: Window }).window;
    if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage);
    else delete (globalThis as { localStorage?: Storage }).localStorage;
  }
});
