import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { StaticRecorderProvider } from "@/capture/recorder/RecorderProvider";
import { PipelineStepper } from "@/capture/pipeline/PipelineStepper";
import { PlatformContext, appPlatform } from "@/lib/platform";
import { installDom } from "@/test/dom";
import { getDesktopWhisperQueue, registerDesktopWhisperQueue, type DesktopWhisperJob, type DesktopWhisperQueue } from "./desktop/desktopWhisper";
import { nativeVoiceNotesAvailable } from "./nativeVoiceNotes";
import { onDeviceTranscriptSyncState, syncOnDeviceTranscript } from "./onDeviceTranscriber";
import { pendingStore } from "./recorderSaves";
import { useNotePipelineWithLedger, type NativeNote, type NotePipelineSource, type NotePipelineView } from "./useNotePipeline";

const ID = "mac-note-1";
const SPACE = { did: "did:test:mac-pipeline", spaceId: "space-mac-pipeline" } as TinyCloudWeb;
const uploading: NotePipelineSource = { tcw: null, rowExists: false, audioSaved: false, metadata: null };
const saved: NotePipelineSource = { tcw: null, rowExists: true, audioSaved: true, metadata: { audio: { stored: true }, capture: { options: { transcriber: "on-device" } } } };
const syncSource: NotePipelineSource = { ...saved, tcw: SPACE };

let cleanDom: (() => void) | undefined;
let root: Root | null = null;
let host: HTMLElement;
let originalSnapshot: typeof pendingStore.snapshot;
let originalSubscribe: typeof pendingStore.subscribe;
let job: DesktopWhisperJob | null;
let queueListeners = new Set<() => void>();
let retryCalls: string[] = [];

beforeEach(() => {
  cleanDom = installDom();
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
  host = document.createElement("div");
  document.body.append(host);
  job = { id: ID, state: "transcribing", progress: 37, error: null };
  queueListeners = new Set();
  retryCalls = [];
  registerDesktopWhisperQueue({
    snapshot: () => new Map(job ? [[ID, job]] : []),
    subscribe: (listener) => { queueListeners.add(listener); return () => { queueListeners.delete(listener); }; },
    retry: async (id) => { retryCalls.push(id); },
  } as DesktopWhisperQueue);
  originalSnapshot = pendingStore.snapshot;
  originalSubscribe = pendingStore.subscribe;
  const snapshot = { ...originalSnapshot(), online: true, notes: [{ id: ID, startedAt: 0, durationMs: 1000,
    upload: { state: "uploading" as const, bytes: 42, total: 100 } }] };
  pendingStore.snapshot = () => snapshot;
  pendingStore.subscribe = () => () => undefined;
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  pendingStore.snapshot = originalSnapshot;
  pendingStore.subscribe = originalSubscribe;
  registerDesktopWhisperQueue(null);
  cleanDom?.();
});

async function mount(source: NotePipelineSource) {
  let view: NotePipelineView | null = null;
  let ledger: NativeNote | null = null;
  let ledgerReady = false;
  function Probe() {
    const pipeline = useNotePipelineWithLedger(ID, source);
    view = pipeline.view;
    ledger = pipeline.ledger;
    ledgerReady = pipeline.ledgerReady;
    return view ? <PipelineStepper pipeline={view.pipeline} onAction={view.onAction} actionError={view.actionError} /> : null;
  }
  root = createRoot(host);
  await act(async () => root!.render(
    <PlatformContext.Provider value={appPlatform()}>
      <StaticRecorderProvider value={{ tcw: source.tcw, signIn: null, transcription: undefined }}><Probe /></StaticRecorderProvider>
    </PlatformContext.Provider>,
  ));
  for (let i = 0; i < 10 && view === null; i++) await act(async () => { await Bun.sleep(1); });
  return { get view() { return view; }, get ledger() { return ledger; }, get ledgerReady() { return ledgerReady; }, host };
}

test("real Tauri hook shows Whisper and upload progress without a native ledger", async () => {
  expect(appPlatform()).toBe("tauri");
  expect(nativeVoiceNotesAvailable()).toBe(false);
  const mounted = await mount(uploading);
  expect(mounted.ledgerReady).toBe(true);
  expect(mounted.ledger).toBeNull();
  expect(mounted.view?.route).toBe("on-device");
  expect(getDesktopWhisperQueue()?.snapshot().get(ID)?.progress).toBe(37);
  expect(host.textContent).toContain("Transcribing on this Mac · 37%");
  expect(host.textContent).toContain("Uploading audio to your TinyCloud space · 42%");
});

test("real Tauri hook exposes Whisper Retry without a native ledger", async () => {
  job = { id: ID, state: "failed", progress: null, error: "decoder" };
  const mounted = await mount(saved);
  expect(mounted.ledger).toBeNull();
  expect(mounted.view?.route).toBe("on-device");
  const retry = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Try again");
  expect(retry).toBeDefined();
  await act(async () => retry!.click());
  expect(retryCalls).toEqual([ID]);
});

test("a Mac row keeps its committed Local route when the queue has no job", async () => {
  job = null;
  const mounted = await mount(saved);
  expect(nativeVoiceNotesAvailable()).toBe(false);
  expect(mounted.view?.route).toBe("on-device");
});

test("real Tauri hook retries transcript sync from committed space audio without a native ledger", async () => {
  job = { id: ID, state: "done", progress: null, error: null };
  expect(nativeVoiceNotesAvailable()).toBe(false);
  await syncOnDeviceTranscript(SPACE, { id: ID, owner: SPACE.did, ledger: { audio: { state: "saved" } }, stt: { state: "done" } });
  expect(onDeviceTranscriptSyncState(SPACE, ID)?.state).toBe("failed");
  const mounted = await mount(syncSource);
  expect(mounted.ledger).toBeNull();
  expect(mounted.view?.route).toBe("on-device");
  expect(mounted.view?.pipeline.current).toBe("transcript");
  const warnings = spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    const retry = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Try again");
    expect(retry).toBeDefined();
    await act(async () => retry!.click());
    for (let i = 0; i < 10 && warnings.mock.calls.length === 0; i++) await act(async () => { await Bun.sleep(1); });
    expect(warnings.mock.calls.some(([message]) => message === "[OnDeviceStt] Could not verify local note ownership")).toBe(true);
  } finally { warnings.mockRestore(); }
});
