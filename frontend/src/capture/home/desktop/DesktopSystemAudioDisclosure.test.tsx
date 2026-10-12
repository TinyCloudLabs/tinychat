import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PlatformContext } from "@/lib/platform";
import { createFakeDesktopCaptureExtras } from "@/lib/voiceNotes/fakeDesktopCaptureExtras";
import { registerDesktopCaptureExtras } from "@/lib/voiceNotes/desktopCaptureExtras";
import { StaticRecorderProvider } from "@/capture/recorder/RecorderProvider";
import { installDom } from "@/test/dom";

let cleanupDom: (() => void) | null = null;
let root: Root | null = null;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  registerDesktopCaptureExtras(null);
  cleanupDom?.();
  cleanupDom = null;
});

async function mount(consented: boolean) {
  cleanupDom = installDom();
  const { SystemAudioStart } = await import("./SystemAudioStart");
  const fake = createFakeDesktopCaptureExtras({ systemAudio: true, systemAudioConsent: consented });
  registerDesktopCaptureExtras(fake.extras);
  let started = 0;
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(
    <PlatformContext.Provider value="tauri">
      <StaticRecorderProvider value={{ ready: true, record: () => { started += 1; } }}>
        <SystemAudioStart />
      </StaticRecorderProvider>
    </PlatformContext.Provider>,
  ));
  const click = async (selector: string) => act(async () => {
    const element = document.querySelector<HTMLElement>(selector);
    expect(element).not.toBeNull();
    element!.click();
  });
  return { fake, click, started: () => started };
}

test("a fresh Mac asks before recording and Mic only saves a mic-only choice", async () => {
  const { fake, click, started } = await mount(false);
  await click('[data-testid="voice-note-record"]');
  expect(started()).toBe(0);
  expect(document.querySelector('[data-testid="system-audio-disclosure"]')?.textContent).toContain("Changes apply when you start or resume a recording.");
  await click('[data-testid="system-audio-disclosure"] button:first-of-type');
  expect(started()).toBe(1);
  expect(await fake.extras.systemAudio.get()).toBe(false);
  expect(await fake.extras.systemAudioConsent.get()).toBe(true);
  await click('[data-testid="voice-note-record"]');
  expect(started()).toBe(2);
  expect(document.querySelector('[data-testid="system-audio-disclosure"]')).toBeNull();
});

test("an existing Mac with consent keeps system audio on without another sheet", async () => {
  const { fake, click, started } = await mount(true);
  await click('[data-testid="voice-note-record"]');
  expect(started()).toBe(1);
  expect(await fake.extras.systemAudio.get()).toBe(true);
  expect(document.querySelector('[data-testid="system-audio-disclosure"]')).toBeNull();
});

test("an existing Mac with system audio permission still sees the sheet once", async () => {
  const { fake, click, started } = await mount(false);
  await click('[data-testid="voice-note-record"]');
  expect(started()).toBe(0);
  expect(document.querySelector('[data-testid="system-audio-disclosure"]')).not.toBeNull();
  await click('[data-testid="system-audio-disclosure"] button:last-of-type');
  expect(started()).toBe(1);
  expect(await fake.extras.systemAudio.get()).toBe(true);
  expect(await fake.extras.systemAudioConsent.get()).toBe(true);
  await click('[data-testid="voice-note-record"]');
  expect(started()).toBe(2);
  expect(document.querySelector('[data-testid="system-audio-disclosure"]')).toBeNull();
});
