// Settings → Stop recordings automatically (TC-2081): a device-local choice whose default follows the layout.
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
import { DEFAULT_STOP_AFTER, readAutoStopChoice, setAutoStopPreference, setStopAfterPreference } from "@/lib/voiceNotes/transcriberPreference";
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
  // The preferences also live in module memory for storage-less runs: leave the defaults for later test files.
  setStopAfterPreference(DEFAULT_STOP_AFTER);
  setAutoStopPreference(null);
  values.clear();
  Reflect.deleteProperty(globalThis, "localStorage");
  __setVoiceNotesForTests(null, { available: null });
  if (savedStorage) Object.defineProperty(globalThis, "localStorage", savedStorage);
  restoreDom();
});

async function render() {
  await act(async () => root.render(
    <PlatformContext.Provider value="web">
      <StaticRecorderProvider value={{ signedIn: true, available: true }}>
        <VoiceNotesTranscriberSettings />
      </StaticRecorderProvider>
    </PlatformContext.Provider>,
  ));
  await act(async () => { await Promise.resolve(); });
}

const box = () => host.querySelector<HTMLInputElement>("#stop-recordings-automatically")!;
const hint = () => host.querySelector('[data-testid="voice-notes-auto-stop-hint"]')!.textContent;
const select = () => host.querySelector("#stop-recording-after");

async function setWidth(width: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  await act(async () => { window.dispatchEvent(new Event("resize")); });
}

test("on desktop it starts on, says how long, and shows the duration choice", async () => {
  await setWidth(1280);
  await render();
  expect(host.querySelector('label[for="stop-recordings-automatically"]:not(:has(input))')?.textContent).toBe("Stop recordings automatically");
  expect(box().checked).toBe(true);
  expect(hint()).toBe("Recordings stop after 1 hour.");
  expect(select()).not.toBeNull();
  expect(readAutoStopChoice()).toBeNull();
});

test("on a phone it starts off with the run-until-you-stop hint and no duration choice", async () => {
  await setWidth(390);
  await render();
  expect(box().checked).toBe(false);
  expect(hint()).toBe("The recording runs until you stop it.");
  expect(select()).toBeNull();
});

test("turning it on at a phone, and off on desktop, is stored on this device and the hint follows", async () => {
  await setWidth(390);
  await render();
  await act(async () => { box().click(); });
  expect(values.get("exo.voiceNotes.autoStop")).toBe("1");
  expect(readAutoStopChoice()).toBe(true);
  expect(box().checked).toBe(true);
  expect(hint()).toBe("Recordings stop after 1 hour.");
  expect(select()).not.toBeNull();
  await act(async () => { setStopAfterPreference("off"); });
  expect(hint()).toBe("Recordings stop after 3 hours.");

  await setWidth(1280);
  await act(async () => { box().click(); });
  expect(values.get("exo.voiceNotes.autoStop")).toBe("0");
  expect(readAutoStopChoice()).toBe(false);
  expect(hint()).toBe("The recording runs until you stop it.");
});

test("a stored choice beats the layout default, in both directions", async () => {
  values.set("exo.voiceNotes.autoStop", "0");
  await setWidth(1280);
  await render();
  expect(box().checked).toBe(false);
  await act(async () => { setAutoStopPreference(true); });
  await setWidth(390);
  await act(async () => { await Promise.resolve(); });
  expect(box().checked).toBe(true);
});
