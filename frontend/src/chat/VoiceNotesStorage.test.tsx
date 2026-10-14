import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { StaticRecorderProvider } from "@/capture/recorder/RecorderProvider";
import { __resetStorageStatusForTests, reportStorageError, reportStorageWriteSucceeded } from "@/lib/storageStatus";
import { setUploadAudioPreference } from "@/lib/voiceNotes/transcriberPreference";
import { installDom } from "@/test/dom";
import { VoiceNotesTranscriberSettings } from "./VoiceNotesTranscriberSettings";

const savedStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

function useMemoryStorage() {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
    },
  });
}

let root: Root | null = null;
let restoreDom: (() => void) | null = null;

async function mount(): Promise<HTMLElement> {
  restoreDom = installDom();
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root!.render(
      <StaticRecorderProvider>
        <VoiceNotesTranscriberSettings />
      </StaticRecorderProvider>,
    ),
  );
  return host;
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  restoreDom?.();
  restoreDom = null;
  await __resetStorageStatusForTests();
  if (savedStorage) Object.defineProperty(globalThis, "localStorage", savedStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

describe("Settings → Voice notes upload audio while storage is full", () => {
  test("the upload checkbox keeps its setting, and shows a paused line only while storage is read-only", async () => {
    useMemoryStorage();
    await setUploadAudioPreference(true);
    const host = await mount();
    const box = () => host.querySelector<HTMLInputElement>("#upload-audio-to-tinycloud");
    const status = () => host.querySelector('[role="status"]');
    expect(box()?.checked).toBe(true);
    expect(status()).toBeNull();
    await act(async () => reportStorageError({ code: "STORAGE_QUOTA_EXCEEDED" }));
    expect(status()).not.toBeNull();
    expect(box()?.checked).toBe(true);
    await act(async () => reportStorageWriteSucceeded());
    expect(status()).toBeNull();
    expect(box()?.checked).toBe(true);
  });
});
