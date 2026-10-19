import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { LocalSettings } from "@/capture/local/LocalSettings";
import { localModelGuide } from "@/capture/recorder/final/localModelGuide";
import { StaticRecorderProvider } from "@/capture/recorder/RecorderProvider";
import { VoiceNotesTranscriberSettings } from "@/chat/VoiceNotesTranscriberSettings";
import { installDom } from "@/test/dom";
import { createFakeVoiceNotes } from "./fakeVoiceNotes";
import { __setVoiceNotesForTests } from "./nativeVoiceNotes";
import { __setOnDeviceSttForTests, type OnDeviceSttPlugin, type OnDeviceSttStatus } from "./onDeviceStt";
import { __resetOnDeviceSttStoreForTests, __setDownloadPollMsForTests, ensureOnDeviceModel, onDeviceSttStore } from "./onDeviceSttStore";

let cleanDom: (() => void) | undefined;
let previousStorage: PropertyDescriptor | undefined;
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
    engine: "none", appleSpeech: "unsupported", queue: [],
  };
}
const pluginFor = (current: OnDeviceSttStatus, downloadNow: OnDeviceSttPlugin["downloadNow"]) =>
  ({ status: async () => structuredClone(current), addListener: async () => ({ remove: async () => {} }), setAutoDownload: async () => {}, downloadNow }) as unknown as OnDeviceSttPlugin;
const buttons = () => Array.from(host.querySelectorAll("button")) as HTMLButtonElement[];
const button = (label: string) => buttons().find((node) => node.textContent === label);

beforeEach(async () => {
  cleanDom = installDom();
  previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: window.localStorage });
  const fake = createFakeVoiceNotes();
  __setVoiceNotesForTests(fake.plugin, { available: true });
  await fake.plugin.setCaptureDefaults({ accountDid: null, transitionGen: 1, transcriber: "on-device", identifySpeakers: false });
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
  if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
  __setVoiceNotesForTests(null, { available: null });
  __resetOnDeviceSttStoreForTests();
  __setDownloadPollMsForTests(2000);
});

const renderSettings = () => act(async () => {
  root!.render(<StaticRecorderProvider value={{ signedIn: true }}><VoiceNotesTranscriberSettings /></StaticRecorderProvider>);
  await tick();
  await tick();
});

describe("signed-out Local settings share the one download", () => {
  test("Download now during an automatic download joins it instead of starting another native operation", async () => {
    let calls = 0;
    __setOnDeviceSttForTests(pluginFor(status(), async () => { calls++; await new Promise<void>(() => {}); }));
    await onDeviceSttStore.refresh();
    ensureOnDeviceModel();
    expect(calls).toBe(1);
    await act(async () => { root!.render(<LocalSettings onBack={() => {}} />); await tick(); });
    await act(async () => { button("Download now")!.click(); await tick(); });
    expect(calls).toBe(1);
  });

  test("while native reports the automatic download running there is nothing to press", async () => {
    const current = status();
    __setOnDeviceSttForTests(pluginFor(current, async () => {
      current.download.state = "running";
      current.models[1]!.state = "downloading";
      await new Promise<void>(() => {});
    }));
    await onDeviceSttStore.refresh();
    ensureOnDeviceModel();
    await tick();
    await onDeviceSttStore.refresh();
    await act(async () => { root!.render(<LocalSettings onBack={() => {}} />); await tick(); });
    expect(button("Download now")).toBeUndefined();
    expect(host.textContent).toContain("Downloading on-device model");
  });

  test("the button starts the shared download from idle, and a failure shows its reason with Try again that starts it again", async () => {
    const logged = spyOn(console, "error").mockImplementation(() => {});
    let calls = 0;
    const current = status();
    __setOnDeviceSttForTests(pluginFor(current, async () => {
      calls++;
      if (calls === 1) throw new Error("no space left");
      await new Promise<void>(() => {});
    }));
    await onDeviceSttStore.refresh();
    await act(async () => { root!.render(<LocalSettings onBack={() => {}} />); await tick(); });
    await act(async () => { button("Download now")!.click(); await tick(); await tick(); });
    expect(calls).toBe(1);
    expect(host.textContent).toContain("Couldn't download the on-device model: no space left");
    await act(async () => { button("Try again")!.click(); await tick(); });
    expect(calls).toBe(2);
    expect(button("Try again")).toBeUndefined();
    logged.mockRestore();
  });
});

describe("Voice notes settings start the download only from a Local choice", () => {
  test("opening Settings downloads nothing; choosing Local does", async () => {
    let calls = 0;
    __setOnDeviceSttForTests(pluginFor(status(), async () => { calls++; await new Promise<void>(() => {}); }));
    await onDeviceSttStore.refresh();
    const fake = createFakeVoiceNotes();
    __setVoiceNotesForTests(fake.plugin, { available: true });
    await fake.plugin.setCaptureDefaults({ accountDid: "did:example:A", transitionGen: 2, transcriber: "private-cloud", identifySpeakers: false });
    await renderSettings();
    expect(calls).toBe(0);
    const local = (Array.from(host.querySelectorAll('[role="radio"]')) as HTMLElement[]).find((node) => node.textContent?.includes("Local"));
    await act(async () => { local!.click(); await tick(); await tick(); await tick(); });
    expect(calls).toBe(1);
  });
});

describe("Voice notes settings show an automatic download's state", () => {
  test("an automatic speech-detection failure is shown with Try again", async () => {
    const logged = spyOn(console, "error").mockImplementation(() => {});
    const current = status();
    __setOnDeviceSttForTests(pluginFor(current, async () => {
      current.models[1]!.state = "failed";
      current.models[1]!.error = "network failed";
      current.download.state = "failed";
      throw new Error("Could not download the speech-detection model");
    }));
    await onDeviceSttStore.refresh();
    ensureOnDeviceModel();
    await tick();
    await tick();
    await onDeviceSttStore.refresh();
    expect(onDeviceSttStore.downloadError()).toContain("speech-detection");
    await renderSettings();
    expect(host.textContent).toContain("Couldn't download");
    expect(host.textContent).toContain("Try again");
    logged.mockRestore();
  });

  test("a ready model with the speech detector missing still offers the download", async () => {
    const current = status();
    current.models[0]!.state = "ready";
    __setOnDeviceSttForTests(pluginFor(current, async () => { await new Promise<void>(() => {}); }));
    await onDeviceSttStore.refresh();
    await renderSettings();
    expect(host.textContent).not.toContain("Ready");
    expect(host.textContent).toContain("isn't downloaded");
    expect(button("Get model")).toBeDefined();
  });

  test("a Wi-Fi wait in the speech-detection stage is shown, not the primary model's state", async () => {
    const current = status();
    current.models[1]!.state = "queued";
    current.download.state = "waiting_for_network";
    __setOnDeviceSttForTests(pluginFor(current, async () => { await new Promise<void>(() => {}); }));
    await onDeviceSttStore.refresh();
    await renderSettings();
    expect(host.textContent).toContain("Waiting for Wi-Fi to download the on-device model");
  });
});

describe("a native state change that publishes no event still reaches the progress UI", () => {
  test("Android's Wi-Fi wait after the first status shows as Waiting for Wi-Fi, and the download resumes after it", async () => {
    const current = status();
    current.queue.push({ id: "local-note", state: "waiting_for_model", percent: null, error: null });
    __setOnDeviceSttForTests(pluginFor(current, async () => {
      current.models[1]!.state = "queued";
      current.download.state = "running";
      await new Promise<void>(() => {});
    }));
    await onDeviceSttStore.refresh();
    await wait(30);
    expect(localModelGuide(onDeviceSttStore.snapshot(), { start: () => {}, error: null }).reason).toStartWith("Downloading on-device model");
    current.download.state = "waiting_for_network";
    await wait(60);
    expect(onDeviceSttStore.snapshot().download.state).toBe("waiting_for_network");
    expect(localModelGuide(onDeviceSttStore.snapshot(), { start: () => {}, error: null }).reason).toContain("Waiting for Wi-Fi");

    current.download.state = "running";
    current.models[1]!.state = "downloading";
    current.models[1]!.bytes = MB;
    await wait(60);
    expect(localModelGuide(onDeviceSttStore.snapshot(), { start: () => {}, error: null }).reason).toStartWith("Downloading on-device model ·");
  });
});
