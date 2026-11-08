// A Record the provider deferred (the Mac's system-audio check, or its disclosure) belongs to the account and recorder
// it began under: after a switch or sign-out it is dropped, and never starts the new owner's recorder.
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createFakeVoiceNotes, type FakeVoiceNotes } from "@/lib/voiceNotes/fakeVoiceNotes";
import { VoiceNotes, __setVoiceNotesForTests } from "@/lib/voiceNotes/nativeVoiceNotes";
import { registerDesktopCaptureExtras, type DesktopCaptureExtras } from "@/lib/voiceNotes/desktopCaptureExtras";
import { __resetHomeWorkForTests } from "@/lib/homeReauthorizing";
import { PlatformContext } from "@/lib/platform";
import { installDom } from "@/test/dom";
import { RecorderProvider, useRecorder, type RecorderValue } from "./RecorderProvider";
import { __resetRecorderOwnershipForTests } from "./voiceNoteRecorderController";

const alice = { did: "did:example:alice", spaceId: "space:alice" } as TinyCloudWeb;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const saved = VoiceNotes;
let restoreDom: () => void;
let root: Root;
let container: HTMLElement;
let fake: FakeVoiceNotes;
let recorder: RecorderValue | null;
let starts: number;
// The system-audio check: answered when the test releases it. System audio is on and not yet consented to.
let releaseCheck: () => void;

function Probe() { recorder = useRecorder(); return null; }
const render = (tcw: TinyCloudWeb | null) => act(async () => root.render(
  createElement(PlatformContext.Provider, { value: "tauri" },
    createElement(RecorderProvider, { tcw, children: createElement(Probe) as ReactNode }))));
const disclosure = () => container.querySelector('[data-testid="system-audio-disclosure"]');

beforeEach(async () => {
  restoreDom = installDom();
  __resetHomeWorkForTests();
  __resetRecorderOwnershipForTests();
  fake = createFakeVoiceNotes();
  starts = 0;
  __setVoiceNotesForTests({ ...fake.plugin, async start(options) { starts += 1; return fake.plugin.start(options); } }, { available: true });
  const held = new Promise<void>((resolve) => { releaseCheck = resolve; });
  const extras = {
    systemAudio: { get: async () => { await held; return true; }, set: async () => {} },
    systemAudioConsent: { get: async () => false, set: async () => {} },
  } as unknown as DesktopCaptureExtras;
  registerDesktopCaptureExtras(extras);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  recorder = null;
});
afterEach(async () => {
  await act(async () => root.unmount());
  registerDesktopCaptureExtras(null);
  __setVoiceNotesForTests(saved, { available: null });
  __resetRecorderOwnershipForTests();
  __resetHomeWorkForTests();
  restoreDom();
});

async function ready(tcw: TinyCloudWeb | null) {
  await render(tcw);
  await act(async () => { await tick(); await tick(); });
}

test("a Record waiting on the system-audio check when the account signs out shows nothing and starts nothing", async () => {
  await ready(alice);
  await act(async () => recorder!.record());
  await ready(null);
  await act(async () => { releaseCheck(); await tick(); await tick(); });
  expect(disclosure()).toBeNull();
  expect(starts).toBe(0);
  expect((await fake.plugin.status()).state).toBe("idle");
});

test("a system-audio disclosure opened for one account closes on sign-out, and the new recorder never starts from it", async () => {
  await ready(alice);
  releaseCheck();
  await act(async () => { recorder!.record(); await tick(); await tick(); });
  expect(disclosure()).not.toBeNull();
  await ready(null);
  expect(disclosure()).toBeNull();
  // Whatever is still on screen is confirmed: nothing of the old account's is.
  await act(async () => { container.querySelectorAll<HTMLButtonElement>(".dch-system-audio button").forEach((button) => button.click()); await tick(); await tick(); });
  expect(starts).toBe(0);
});

test("the same account answering its system-audio disclosure starts the recording", async () => {
  await ready(alice);
  releaseCheck();
  await act(async () => { recorder!.record(); await tick(); await tick(); });
  const record = [...container.querySelectorAll<HTMLButtonElement>(".dch-system-audio button")].at(-1)!;
  await act(async () => { record.click(); await tick(); await tick(); await tick(); });
  expect(disclosure()).toBeNull();
  expect(starts).toBe(1);
  expect((await fake.plugin.status()).state).toBe("recording");
});
