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
  const select = stopAfter.querySelector("select")!;
  expect(select.value).toBe("60");
  expect(stopAfter.querySelector('label[for="stop-recording-after"]')?.textContent).toBe("Stop recording after");
  expect(select.id).toBe("stop-recording-after");
  expect([...select.options].map((option) => option.textContent)).toEqual(["15 min", "30 min", "1 h", "2 h", "Off (3-hour limit)"]);

  await act(async () => {
    select.value = "15";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(values.get("exo.voiceNotes.stopAfter")).toBe("15");
  expect(readStopAfterPreference()).toBe("15");
  expect(stopAfter.querySelector("select")!.value).toBe("15");
});

test("the upload help is one line that follows the platform's device", async () => {
  const helpFor = async (platform: "web" | "tauri" | "ios") => {
    await act(async () => root.render(
      <PlatformContext.Provider value={platform}>
        <StaticRecorderProvider value={{ signedIn: true, available: true }}>
          <VoiceNotesTranscriberSettings />
        </StaticRecorderProvider>
      </PlatformContext.Provider>,
    ));
    await act(async () => { await Promise.resolve(); });
    const lines = host.querySelectorAll('[data-testid="voice-notes-upload-help"]');
    expect(lines).toHaveLength(1);
    expect(host.textContent!.match(/Audio stays/g)?.length ?? 0).toBe(1);
    return lines[0]!.textContent!;
  };
  expect(await helpFor("web")).toStartWith("Audio stays in this browser, and browsers can delete it. Turn this on to keep a copy in TinyCloud.");
  expect(await helpFor("tauri")).toStartWith("Audio stays on this Mac. Turn this on");
  expect(await helpFor("ios")).toStartWith("Audio stays on this phone. Turn this on");
});

test("ticking the box swaps the single help line, and the (i) sits in the label row", async () => {
  await act(async () => root.render(
    <PlatformContext.Provider value="web">
      <StaticRecorderProvider value={{ signedIn: true, available: true }}>
        <VoiceNotesTranscriberSettings />
      </StaticRecorderProvider>
    </PlatformContext.Provider>,
  ));
  await act(async () => { await Promise.resolve(); });
  const box = host.querySelector<HTMLInputElement>("#upload-audio-to-tinycloud")!;
  const help = () => host.querySelector('[data-testid="voice-notes-upload-help"]')!.textContent!;
  expect(box.checked).toBe(false);
  expect(help()).toStartWith("Audio stays in this browser");
  await act(async () => { box.click(); });
  expect(box.checked).toBe(true);
  expect(help()).toStartWith("A copy of the audio is kept");
  expect(host.textContent).not.toContain("Audio stays");
  const text = [...host.querySelectorAll('label[for="upload-audio-to-tinycloud"]')].find((label) => label.textContent === "Upload audio to TinyCloud")!;
  const tip = host.querySelector('button[aria-label="About audio storage"]')!;
  expect(tip.parentElement).toBe(text.parentElement);
  expect(box.closest("label")!.parentElement).toBe(text.parentElement);
  // The preference it stored is untouched in kind.
  expect(values.get("exo.voiceNotes.uploadAudio")).toBe("1");
  await act(async () => { box.click(); });
  expect(values.get("exo.voiceNotes.uploadAudio")).toBe("0");
});
