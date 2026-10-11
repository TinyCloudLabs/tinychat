import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { OnDeviceNoteStatusView } from "@/capture/library/OnDeviceNoteStatus";
import { localModelGuide } from "@/capture/recorder/final/localModelGuide";
import { useOnDeviceModel } from "@/capture/recorder/final/useTranscriptionChoice";
import { SavedReceipt } from "@/capture/recorder/SavedReceipt";
import { installDom } from "@/test/dom";
import { createFakeVoiceNotes } from "./fakeVoiceNotes";
import { __setVoiceNotesForTests } from "./nativeVoiceNotes";
import { __setOnDeviceSttForTests, type OnDeviceSttPlugin, type OnDeviceSttStatus } from "./onDeviceStt";
import { __resetOnDeviceSttStoreForTests, __setDownloadPollMsForTests, ensureOnDeviceModel, onDeviceSttStore } from "./onDeviceSttStore";

let cleanDom: (() => void) | undefined;
let root: Root | undefined;
let host: HTMLElement;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const MB = 1024 * 1024;

function status(): OnDeviceSttStatus {
  return {
    models: [
      { id: "parakeet-tdt-0.6b-v3-int8", state: "absent", bytes: 0, totalBytes: 640 * MB, error: null },
      { id: "silero-vad", state: "absent", bytes: 0, totalBytes: 2 * MB, error: null },
    ],
    pack: "full", autoDownload: false, download: { policy: "wifi", state: "idle" },
    engine: "none", appleSpeech: "unsupported",
    queue: [{ id: "local-note", state: "waiting_for_model", percent: null, error: null }],
  };
}
const buttons = () => Array.from(host.querySelectorAll("button")) as HTMLButtonElement[];
const button = (label: string) => buttons().find((node) => node.textContent?.trim() === label);

beforeEach(() => {
  cleanDom = installDom();
  const fake = createFakeVoiceNotes();
  __setVoiceNotesForTests(fake.plugin, { available: true });
  __resetOnDeviceSttStoreForTests();
  __setDownloadPollMsForTests(5);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  cleanDom?.();
  cleanDom = undefined;
  __setVoiceNotesForTests(null, { available: null });
  __resetOnDeviceSttStoreForTests();
  __setDownloadPollMsForTests(2000);
});

/** Native whose download is one pending promise; the test rejects it, with no status event, as a speech-detector failure does. */
function pendingNative(current: OnDeviceSttStatus) {
  let reject!: (error: Error) => void;
  let calls = 0;
  __setOnDeviceSttForTests({
    status: async () => structuredClone(current),
    addListener: async () => ({ remove: async () => {} }),
    downloadNow: async () => {
      calls++;
      current.models[1]!.state = "downloading";
      current.download.state = "running";
      await new Promise<void>((_resolve, rejectNow) => { reject = rejectNow; });
    },
  } as unknown as OnDeviceSttPlugin);
  return { calls: () => calls, fail: () => reject(new Error("Could not download the speech-detection model")) };
}

async function automaticFailureWithoutAStatusEvent() {
  const current = status();
  const native = pendingNative(current);
  await onDeviceSttStore.refresh();
  await onDeviceSttStore.refresh();
  await tick();
  expect(onDeviceSttStore.snapshot().models[1]!.state).toBe("downloading");
  native.fail();
  // Native publishes no final status, so what the app reads still says downloading.
  await tick();
  expect(onDeviceSttStore.downloadError()).toContain("speech-detection");
  return native;
}

test("a Local saved receipt shows an automatic download failure and Try again", async () => {
  const logged = spyOn(console, "error").mockImplementation(() => {});
  const native = await automaticFailureWithoutAStatusEvent();
  await act(async () => {
    root!.render(<SavedReceipt outcome="saved" saved={{ id: "local-note", durationMs: 5000, at: Date.now() }}
      transcriber="on-device" route={[]} onDone={() => {}} onSaveNow={() => {}} />);
    await tick();
  });
  expect(host.textContent).toContain("Couldn't download the on-device model");
  expect(button("Try again")).toBeDefined();
  await act(async () => { button("Try again")!.click(); await tick(); });
  expect(native.calls()).toBe(2);
  expect(host.textContent).not.toContain("Couldn't download");
  logged.mockRestore();
});

test("a saved Local note waiting for the model shows an automatic download failure and Try again", async () => {
  const logged = spyOn(console, "error").mockImplementation(() => {});
  const native = await automaticFailureWithoutAStatusEvent();
  await act(async () => {
    root!.render(<OnDeviceNoteStatusView noteId="local-note" view={{ note: { kind: "waiting_for_model" }, error: null, reload: () => {} }} fallback={<p>No transcript.</p>} />);
    await tick();
  });
  expect(host.textContent).toContain("Couldn't download the on-device model");
  expect(host.querySelector('[data-testid="voice-note-model-download-action"]')?.textContent?.trim()).toBe("Try again");
  await act(async () => { (host.querySelector('[data-testid="voice-note-model-download-action"]') as HTMLButtonElement).click(); await tick(); });
  expect(native.calls()).toBe(2);
  logged.mockRestore();
});

function PhoneModelCaption() {
  const onDevice = useOnDeviceModel();
  return <p>{localModelGuide(onDevice.model, onDevice.download).reason}</p>;
}

test("the phone recorder's Local caption follows a Wi-Fi wait and the return to progress that native publishes no event for", async () => {
  const current = status();
  current.queue = [];
  __setOnDeviceSttForTests({
    status: async () => structuredClone(current),
    addListener: async () => ({ remove: async () => {} }),
    downloadNow: async () => {
      current.models[1]!.state = "queued";
      current.download.state = "running";
      await new Promise<void>(() => {});
    },
  } as unknown as OnDeviceSttPlugin);
  await onDeviceSttStore.refresh();
  ensureOnDeviceModel();
  await act(async () => { root!.render(<PhoneModelCaption />); await wait(30); });
  expect(host.textContent).toContain("Downloading on-device model");

  current.download.state = "waiting_for_network";
  await act(async () => { await wait(50); });
  expect(host.textContent).toContain("Waiting for Wi-Fi to download the on-device model");

  current.download.state = "running";
  current.models[1]!.state = "downloading";
  current.models[1]!.bytes = 2 * MB;
  await act(async () => { await wait(50); });
  expect(host.textContent).toContain("Downloading on-device model ·");
});
