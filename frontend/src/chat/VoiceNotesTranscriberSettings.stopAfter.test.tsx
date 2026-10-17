import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { StaticRecorderProvider } from "@/capture/recorder/RecorderProvider";
import { createFakeVoiceNotes } from "@/harness/fakeVoiceNotes";
import { PlatformContext } from "@/lib/platform";
import { createFakeOnDeviceStt } from "@/lib/voiceNotes/fakeOnDeviceStt";
import { __setVoiceNotesForTests } from "@/lib/voiceNotes/nativeVoiceNotes";
import { __setOnDeviceSttForTests } from "@/lib/voiceNotes/onDeviceStt";
import { __resetOnDeviceSttStoreForTests } from "@/lib/voiceNotes/onDeviceSttStore";
import { DEFAULT_STOP_AFTER, readStopAfterPreference, setStopAfterPreference } from "@/lib/voiceNotes/transcriberPreference";
import { installDom } from "@/test/dom";
import { VoiceNotesTranscriberSettings } from "./VoiceNotesTranscriberSettings";

let restoreDom: () => void;
let root: Root;
let host: HTMLElement;
let values: Map<string, string>;
const savedStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

beforeEach(() => {
  restoreDom = installDom();
  values = new Map();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  } });
  __setVoiceNotesForTests(createFakeVoiceNotes().plugin, { available: true });
  __setOnDeviceSttForTests(createFakeOnDeviceStt().plugin);
  __resetOnDeviceSttStoreForTests();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  // The preference also lives in module memory for storage-less runs: leave the default for later test files.
  setStopAfterPreference(DEFAULT_STOP_AFTER);
  __setVoiceNotesForTests(null, { available: null });
  if (savedStorage) Object.defineProperty(globalThis, "localStorage", savedStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
  restoreDom();
});

test("on a phone the Stop recording after row sits above the default transcriber, and a choice is stored for this device", async () => {
  values.set("exo.voiceNotes.stopAfter", "not-a-choice");
  await act(async () => root.render(
    <PlatformContext.Provider value="ios">
      <StaticRecorderProvider value={{ signedIn: true, available: true }}>
        <VoiceNotesTranscriberSettings />
      </StaticRecorderProvider>
    </PlatformContext.Provider>,
  ));
  await act(async () => { await Promise.resolve(); });
  const stopAfter = host.querySelector('[data-testid="voice-notes-stop-after"]')!;
  const transcriber = host.querySelector('[aria-label="Default transcriber"]')!;
  expect(transcriber).not.toBeNull();
  expect(stopAfter.compareDocumentPosition(transcriber) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(stopAfter.textContent).toContain("New recordings stop by themselves after this long. Recordings never run longer than 3 hours.");
  // An unknown stored value shows the 1-hour default.
  expect(stopAfter.querySelector('[data-state="on"]')?.textContent).toBe("1 h");

  const quarter = [...stopAfter.querySelectorAll("button")].find((option) => option.textContent === "15 min")!;
  await act(async () => { quarter.click(); });
  expect(values.get("exo.voiceNotes.stopAfter")).toBe("15");
  expect(readStopAfterPreference()).toBe("15");
  expect(stopAfter.querySelector('[data-state="on"]')?.textContent).toBe("15 min");
});
