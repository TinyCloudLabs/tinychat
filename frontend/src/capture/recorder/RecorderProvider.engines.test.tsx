// The RecorderProvider mounted once per engine kind over a strict fake engine: any call the
// engine's capabilities rule out throws, and every call is recorded.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { createFakeVoiceNotes } from "@/lib/voiceNotes/fakeVoiceNotes";
import {
  __resetCaptureEngineForTests, installCaptureEngine, registerCaptureEngine,
  type CaptureCapabilities, type CaptureEngine, type CaptureEngineKind,
} from "@/lib/voiceNotes/captureEngine";
import { VoiceNotes, __setVoiceNotesForTests, type VoiceNotesPlugin } from "@/lib/voiceNotes/nativeVoiceNotes";
import { OnDeviceStt, __setOnDeviceSttForTests, type OnDeviceSttPlugin, type OnDeviceSttStatus } from "@/lib/voiceNotes/onDeviceStt";
import { __resetOnDeviceSttStoreForTests, onDeviceSttStore } from "@/lib/voiceNotes/onDeviceSttStore";
import { advanceAccountGeneration } from "@/lib/voiceNotes/accountContext";
import { PendingVoiceNotesSaver, schedulePendingVoiceNotesRecovery } from "@/chat/PendingVoiceNotesSaver";
import { VoiceNoteSaveDeferred } from "@/lib/voiceNotes/voiceNotePipeline";
import { CaptureEngineGate } from "./CaptureEngineGate";
import { useOnDeviceReceipt } from "./SavedReceipt";
import { RecorderProvider, useRecorder, type RecorderValue } from "./RecorderProvider";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const global = globalThis as Record<string, unknown>;

const ALL: CaptureCapabilities = {
  nativeShortcuts: true, presentRecorder: true, openSettings: true, micDeniedPresentation: true,
  background: true, localTranscription: true, desktopWhisper: false, offlineRecorder: true, nativeFileUpload: true,
};
const NONE: CaptureCapabilities = Object.fromEntries(Object.keys(ALL).map((key) => [key, false])) as unknown as CaptureCapabilities;

/** Methods only a native shell can take, and the capability that allows each. */
const GATED: Partial<Record<keyof VoiceNotesPlugin, keyof CaptureCapabilities>> = {
  dismissShortcutRecovery: "nativeShortcuts",
  consumeShortcutRecord: "nativeShortcuts",
  openSettings: "openSettings",
};

function strictEngine(capabilities: CaptureCapabilities) {
  const fake = createFakeVoiceNotes();
  const calls: string[] = [];
  const violations: string[] = [];
  const plugin = new Proxy(fake.plugin, {
    get(target, property: string) {
      const value = (target as unknown as Record<string, unknown>)[property];
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        calls.push(property);
        const needs = GATED[property as keyof VoiceNotesPlugin];
        if (needs && !capabilities[needs]) {
          violations.push(property);
          throw Object.assign(new Error(`${property} is unsupported`), { code: "unsupported" });
        }
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  const engine = Object.assign(plugin, { capabilities }) as CaptureEngine;
  return { engine, calls, violations, fake };
}

/** What the native plugin reports: a model entry per model even when absent, so "not downloaded" differs from "not read yet". */
function sttStatus(model: "ready" | "absent"): OnDeviceSttStatus {
  return {
    models: ["parakeet-tdt-0.6b-v3-int8", "silero-vad"].map((id) => ({ id, state: model, bytes: 0, totalBytes: 1, error: null })) as OnDeviceSttStatus["models"],
    pack: "full", autoDownload: false, download: { policy: "wifi", state: "idle" }, engine: "parakeet", appleSpeech: "unsupported", queue: [],
  };
}
const EMPTY_STT: OnDeviceSttStatus = { models: [], pack: "full", autoDownload: false, download: { policy: "wifi", state: "idle" }, engine: "none", appleSpeech: "unsupported", queue: [] };

function strictOnDeviceStt(supported: boolean, model: "ready" | "absent" = "ready") {
  const calls: string[] = [];
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  const plugin = new Proxy({}, { get: (_t, property: string) => (...args: unknown[]) => {
    calls.push(property);
    if (!supported) throw new Error(`${property} is unsupported`);
    if (property === "addListener") {
      const [event, callback] = args as [string, (event: unknown) => void];
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(callback);
      return Promise.resolve({ remove: async () => { listeners.get(event)?.delete(callback); } });
    }
    return Promise.resolve(property === "status" ? sttStatus(model) : {});
  } });
  return { plugin: plugin as unknown as OnDeviceSttPlugin, calls,
    emit: (event: string, payload: unknown) => { for (const listener of [...(listeners.get(event) ?? [])]) listener(payload); } };
}

// A DOM that accepts everything React asks of it and keeps nothing.
const node = (): unknown => new Proxy(function () {}, {
  get: (_t, key) => (key === "nodeType" ? 1 : key === "ownerDocument" ? documentStub : key === "style" ? {} : key === "firstChild" || key === "parentNode" ? null : () => node()),
  set: () => true,
});
const documentStub: Record<string, unknown> = { createElement: () => node(), createTextNode: () => node(), nodeType: 9, activeElement: null, addEventListener() {}, removeEventListener() {} };
const windowStub = (extra: object = {}) => ({ setTimeout, clearTimeout, event: undefined, HTMLIFrameElement: class {}, document: documentStub,
  addEventListener: () => {}, removeEventListener: () => {}, ...extra });

const saved = {
  window: global.window, act: global.IS_REACT_ACT_ENVIRONMENT,
  MediaRecorder: global.MediaRecorder, voiceNotes: VoiceNotes, onDevice: OnDeviceStt,
  mediaDevices: Object.getOwnPropertyDescriptor(navigator, "mediaDevices"),
  online: Object.getOwnPropertyDescriptor(navigator, "onLine"),
  storage: global.localStorage,
};
beforeAll(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  global.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
});
afterAll(() => {
  global.IS_REACT_ACT_ENVIRONMENT = saved.act;
  global.localStorage = saved.storage;
});

let root: Root | null = null;
let value: RecorderValue | null = null;
function Probe() {
  value = useRecorder();
  return null;
}

beforeEach(() => { value = null; __resetCaptureEngineForTests(); });
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  // The model store is shared by every file in the run: leave it on its empty snapshot.
  __setOnDeviceSttForTests({ status: async () => EMPTY_STT } as unknown as OnDeviceSttPlugin);
  await onDeviceSttStore.refresh();
  __resetOnDeviceSttStoreForTests();
  __resetCaptureEngineForTests();
  global.window = saved.window;
  if (saved.MediaRecorder === undefined) delete global.MediaRecorder; else global.MediaRecorder = saved.MediaRecorder;
  if (saved.mediaDevices) Object.defineProperty(navigator, "mediaDevices", saved.mediaDevices); else delete (navigator as unknown as Record<string, unknown>).mediaDevices;
  if (saved.online) Object.defineProperty(navigator, "onLine", saved.online); else delete (navigator as unknown as Record<string, unknown>).onLine;
  __setVoiceNotesForTests(saved.voiceNotes, { available: null });
  __setOnDeviceSttForTests(saved.onDevice);
});

async function mount(kind: CaptureEngineKind, capabilities: CaptureCapabilities, model: "ready" | "absent" = "ready") {
  return mountWith(kind, capabilities, undefined, model);
}

async function mountWith(kind: CaptureEngineKind, capabilities: CaptureCapabilities, prepare?: (plugin: VoiceNotesPlugin) => void,
  model: "ready" | "absent" = "ready", recovery?: { listeners: Map<string, () => void>; pipeline: { resume(): void; cancelAll(): void; isAccepting?(): boolean; reconcileAll(): Promise<void> } },
  providerProps: { onSignIn?: () => void | Promise<void>; minimiseOnSignIn?: boolean } = {}) {
  const stt = strictOnDeviceStt(kind === "native", model);
  __setOnDeviceSttForTests(stt.plugin);
  const strict = strictEngine(capabilities);
  prepare?.(strict.fake.plugin);
  if (kind === "native") {
    global.window = windowStub(recovery ? {
      addEventListener: (name: string, listener: () => void) => recovery.listeners.set(name, listener),
      removeEventListener: (name: string) => recovery.listeners.delete(name),
    } : {});
    __setVoiceNotesForTests(strict.engine, { available: true });
    await onDeviceSttStore.refresh();
  } else {
    __setVoiceNotesForTests(saved.voiceNotes, { available: false });
    global.window = windowStub(kind === "tauri" ? { __TAURI_INTERNALS__: {} } : {});
    global.MediaRecorder = class {};
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {} });
    registerCaptureEngine(kind, async () => strict.engine);
    await installCaptureEngine();
  }
  const tcw = { did: "did:example:alice", spaceId: "space:alice" } as TinyCloudWeb;
  root = createRoot({ nodeType: 1, nodeName: "DIV", tagName: "DIV", ownerDocument: documentStub, textContent: "", addEventListener() {}, removeEventListener() {},
    appendChild() {}, removeChild() {}, insertBefore() {} } as unknown as HTMLElement);
  await act(async () => root!.render(
    <RecorderProvider tcw={tcw} enabled {...providerProps}>
      <Probe />
      <PendingVoiceNotesSaver tcw={tcw} pipeline={(recovery?.pipeline ?? { resume() {}, cancelAll() {}, reconcileAll: async () => {} }) as never} backendUrl="" sessionStore={{} as never} />
    </RecorderProvider>,
  ));
  await act(async () => { await tick(); await tick(); });
  return { ...strict, stt };
}

test("the recorder's sign-in minimises its sheet first when the app opens a sign-in screen of its own", async () => {
  const order: string[] = [];
  await mountWith("native", ALL, undefined, "ready", undefined, {
    minimiseOnSignIn: true,
    onSignIn: () => { order.push("sign-in"); },
  });
  await act(async () => value!.openSheet());
  expect(value!.sheetOpen).toBe(true);
  await act(async () => { await value!.signIn!(); });
  expect(order).toEqual(["sign-in"]);
  expect(value!.sheetOpen).toBe(false);
});

test("the recorder's sign-in leaves its sheet alone when the app starts the sign-in directly", async () => {
  let calls = 0;
  await mountWith("native", ALL, undefined, "ready", undefined, { onSignIn: () => { calls++; } });
  await act(async () => value!.openSheet());
  await act(async () => { await value!.signIn!(); });
  expect(calls).toBe(1);
  expect(value!.sheetOpen).toBe(true);
});

test("pending saver retries reconciliation when the device comes online", async () => {
  const listeners = new Map<string, () => void>();
  let reconciles = 0;
  const pipeline = { resume() {}, cancelAll() {}, reconcileAll: async () => { reconciles++; } };
  await mountWith("native", ALL, undefined, "ready", { listeners, pipeline });
  expect(reconciles).toBe(1);
  await act(async () => { listeners.get("offline")?.(); });
  expect((await import("@/lib/voiceNotes/recorderSaves")).pendingStore.snapshot().online).toBe(false);
  await act(async () => { listeners.get("online")?.(); await tick(); });
  expect(reconciles).toBe(2);
  expect((await import("@/lib/voiceNotes/recorderSaves")).pendingStore.snapshot().online).toBe(true);
});

test("pending saver reads the current navigator online state on mount", async () => {
  Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
  const listeners = new Map<string, () => void>();
  const pipeline = { resume() {}, cancelAll() {}, reconcileAll: async () => {} };
  await mountWith("native", ALL, undefined, "ready", { listeners, pipeline });
  expect((await import("@/lib/voiceNotes/recorderSaves")).pendingStore.snapshot().online).toBe(false);
});

test("a transcribed event captures the current generation after a same-account generation bump", async () => {
  const did = "did:example:alice";
  let reads = 0;
  const { stt } = await mountWith("native", ALL, (plugin) => {
    Object.assign(plugin, {
      listPending: async () => ({ recordings: [{ id: "local-note", owner: did,
        ledger: { audio: { state: "saved" } }, stt: { state: "done" } }] }),
      getTranscript: async () => { reads++; return { transcript: null }; },
    });
  });

  // App can advance this during a cancelled/failed sign-out without remounting the saver.
  advanceAccountGeneration();
  await act(async () => { stt.emit("transcribed", { id: "local-note" }); await tick(); await tick(); });
  expect(reads).toBe(1);
});

test("a transcribed event whose pending read crosses a generation bump does not start sync", async () => {
  const did = "did:example:alice";
  let finishList!: (result: { recordings: { id: string; owner: string; ledger: { audio: { state: string } }; stt: { state: string } }[] }) => void;
  let listStarted!: () => void;
  const started = new Promise<void>((resolve) => { listStarted = resolve; });
  let transcriptReads = 0;
  const { stt } = await mountWith("native", ALL, (plugin) => {
    Object.assign(plugin, {
      listPending: () => { listStarted(); return new Promise((resolve) => { finishList = resolve; }); },
      getTranscript: async () => { transcriptReads++; return { transcript: null }; },
    });
  });

  await act(async () => { stt.emit("transcribed", { id: "local-note" }); });
  await started;
  advanceAccountGeneration();
  finishList({ recordings: [{ id: "local-note", owner: did, ledger: { audio: { state: "saved" } }, stt: { state: "done" } }] });
  await act(async () => { await tick(); await tick(); });
  expect(transcriptReads).toBe(0);
});

test("a transcribed event after sign-out pauses the pipeline does no phone read or write", async () => {
  const did = "did:example:alice";
  let phoneReads = 0;
  let transcriptReads = 0;
  let writes = 0;
  let accepting = true;
  const pipeline = {
    resume() { accepting = true; },
    cancelAll() { accepting = false; },
    isAccepting() { return accepting; },
    reconcileAll: async () => {},
  };
  const { stt } = await mountWith("native", ALL, (plugin) => {
    Object.assign(plugin, {
      listPending: async () => { phoneReads++; return { recordings: [{ id: "local-note", owner: did,
        ledger: { audio: { state: "saved" } }, stt: { state: "done" } }] }; },
      getTranscript: async () => { transcriptReads++; return { transcript: null }; },
      updateLedger: async () => { writes++; return {}; },
    });
  }, "ready", { listeners: new Map(), pipeline });

  // Recorder setup may inspect the phone before the event under test.
  phoneReads = 0;
  transcriptReads = 0;
  writes = 0;
  pipeline.cancelAll();
  await act(async () => { stt.emit("transcribed", { id: "local-note" }); await tick(); });
  expect(phoneReads).toBe(0);
  expect(transcriptReads).toBe(0);
  expect(writes).toBe(0);
});

test("forced session-swap recovery queues one trailing reconcile while a run is active", async () => {
  const listeners = new Map<string, () => void>();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const { pendingStore } = await import("@/lib/voiceNotes/recorderSaves");
  let finishSave: (() => void) | undefined;
  let reconciles = 0;
  let active = 0;
  let maximumActive = 0;
  const pipeline = { resume() {}, cancelAll() {}, reconcileAll: async () => {
    reconciles++;
    active++;
    maximumActive = Math.max(maximumActive, active);
    try {
      if (reconciles === 1) {
        finishSave = pendingStore.beginAutomaticSave();
        await gate;
        finishSave();
        finishSave = undefined;
      }
    } finally { active--; }
  } };
  await mountWith("native", ALL, undefined, "ready", { listeners, pipeline });
  expect(reconciles).toBe(1);
  await act(async () => { schedulePendingVoiceNotesRecovery(); await tick(); });
  expect(reconciles).toBe(1);
  release();
  await act(async () => { await tick(); await tick(); });
  expect(reconciles).toBe(2);
  expect(maximumActive).toBe(1);
  release();
});

test("online during an offline backoff queues one trailing reconcile", async () => {
  const listeners = new Map<string, () => void>();
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let reconciles = 0;
  let active = 0;
  let maximumActive = 0;
  const pipeline = { resume() {}, cancelAll() {}, reconcileAll: async () => {
    reconciles++;
    active++;
    maximumActive = Math.max(maximumActive, active);
    try {
      if (reconciles === 1) { entered(); await gate; throw Object.assign(new Error("offline backoff ended"), { code: "NETWORK_ERROR" }); }
    } finally { active--; }
  } };
  await mountWith("native", ALL, undefined, "ready", { listeners, pipeline });
  await started;
  expect(reconciles).toBe(1);
  await act(async () => { listeners.get("online")?.(); await tick(); });
  expect(reconciles).toBe(1);
  release();
  await act(async () => { await tick(); await tick(); });
  expect(reconciles).toBe(2);
  expect(maximumActive).toBe(1);
  release();
});

test("unmount during a dirty reconcile prevents the trailing pass and deferred error", async () => {
  const listeners = new Map<string, () => void>();
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const { pendingStore } = await import("@/lib/voiceNotes/recorderSaves");
  let reconciles = 0;
  const pipeline = { resume() {}, cancelAll() {}, reconcileAll: async () => {
    reconciles++;
    if (reconciles === 1) { entered(); await gate; throw new VoiceNoteSaveDeferred(); }
  } };
  await mountWith("native", ALL, undefined, "ready", { listeners, pipeline });
  await started;
  await act(async () => { listeners.get("online")?.(); await tick(); });
  expect(reconciles).toBe(1);
  await act(async () => { root!.unmount(); root = null; });
  release();
  await act(async () => { await tick(); await tick(); });
  expect(reconciles).toBe(1);
  expect(pendingStore.snapshot().accountDid).toBeNull();
  expect(pendingStore.snapshot().lastError).toBeNull();
});

for (const kind of ["web", "tauri"] as const) {
  describe(`${kind} engine without native capabilities`, () => {
    test("mounts, installs into the seam, and never reaches a native-only method", async () => {
      const { engine, calls, violations, stt } = await mount(kind, NONE);
      expect(VoiceNotes).toBe(engine);
      expect(value?.available).toBe(true);
      expect(value?.ready).toBe(true);
      expect(calls).toContain("getCaptureDefaults");
      expect(calls).toContain("setCaptureDefaults");
      expect(calls).toContain("status");
      expect(stt.calls).not.toContain("addListener");

      // Mic denied at start, then the sheet is minimised: no shortcut recovery call.
      await act(async () => { await value!.dismissOutcome(); });
      await act(async () => { await value!.minimiseSheet(); });
      // Settings can't be opened here, and the engine is not asked.
      await expect(value!.openSettings()).rejects.toMatchObject({ code: "unsupported" });
      // On-device transcription isn't offered.
      expect(await value!.setTranscriber("on-device", { scope: "default" })).toBe("unavailable");
      expect(await value!.setIdentifySpeakers(true, "default")).toBe("unavailable");
      expect(violations).toEqual([]);
      expect(calls).not.toContain("openSettings");
      expect(calls).not.toContain("dismissShortcutRecovery");
      expect(calls).not.toContain("consumeShortcutRecord");
      expect(stt.calls).toEqual([]);
    });

    test("dismissing a denied microphone clears it without asking the engine to dismiss a shortcut", async () => {
      const { calls, violations, fake } = await mount(kind, NONE);
      fake.plugin.start = async () => { throw Object.assign(new Error("denied"), { code: "permission_denied" }); };
      await act(async () => { value!.record(); await tick(); });
      expect(value?.permissionDenied).toBe(true);
      await act(async () => { await value!.minimiseSheet(); });
      expect(value?.permissionDenied).toBe(false);
      expect(violations).toEqual([]);
      expect(calls).not.toContain("dismissShortcutRecovery");
    });
  });
}

describe("web engine, status carries native-only fields", () => {
  test("a shortcut offer or mic-denied presentation from status() is ignored: no consume call, no denied screen", async () => {
    const { calls, violations, fake } = await mountWith("web", NONE, (plugin) => {
      const status = plugin.status.bind(plugin);
      plugin.status = async () => ({ ...(await status()), micDeniedPresentation: true, shortcutRecordPending: true, microphonePermissionGranted: true });
    });
    void fake;
    expect(value?.permissionDenied).toBe(false);
    expect(calls).not.toContain("consumeShortcutRecord");
    expect(violations).toEqual([]);
  });
});

describe("CaptureEngineGate", () => {
  const webShell = () => {
    __setVoiceNotesForTests(saved.voiceNotes, { available: false });
    global.window = windowStub();
    global.MediaRecorder = class {};
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {} });
  };
  const container = () => ({ nodeType: 1, nodeName: "DIV", tagName: "DIV", ownerDocument: documentStub, textContent: "", addEventListener() {}, removeEventListener() {},
    appendChild() {}, removeChild() {}, insertBefore() {} }) as unknown as HTMLElement;
  let rendered = 0;
  const Child = () => { rendered += 1; return null; };

  test("holds the app back until the engine is installed", async () => {
    webShell();
    rendered = 0;
    let release!: () => void;
    registerCaptureEngine("web", () => new Promise((resolve) => { release = () => resolve(strictEngine(NONE).engine); }));
    root = createRoot(container());
    await act(async () => root!.render(<CaptureEngineGate><Child /></CaptureEngineGate>));
    expect(rendered).toBe(0);
    await act(async () => { release(); await tick(); });
    expect(rendered).toBeGreaterThan(0);
  });

  test("a failed install is logged and the app renders without a recorder, not on the native binding", async () => {
    webShell();
    rendered = 0;
    const errors: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { errors.push(args); };
    try {
      registerCaptureEngine("web", async () => { throw new Error("indexedDB is blocked"); });
      root = createRoot(container());
      await act(async () => { root!.render(<CaptureEngineGate><Child /></CaptureEngineGate>); await tick(); });
    } finally {
      console.error = original;
    }
    expect(rendered).toBeGreaterThan(0);
    expect(errors.some((args) => String(args[0]).includes("Could not start the recorder engine"))).toBe(true);
    const { captureEngineAvailable } = await import("@/lib/voiceNotes/captureEngine");
    expect(captureEngineAvailable()).toBe(false);
    expect(VoiceNotes).toBe(saved.voiceNotes);
  });

  test("native renders at once, with nothing to install", async () => {
    rendered = 0;
    __setVoiceNotesForTests(saved.voiceNotes, { available: true });
    global.window = windowStub();
    root = createRoot(container());
    await act(async () => root!.render(<CaptureEngineGate><Child /></CaptureEngineGate>));
    expect(rendered).toBeGreaterThan(0);
  });
});

describe("native engine with every capability", () => {
  test("keeps taking the native-only calls", async () => {
    const { calls, violations, stt } = await mount("native", ALL);
    expect(value?.available).toBe(true);
    await act(async () => { await value!.openSettings(); });
    await act(async () => { await value!.minimiseSheet(); });
    expect(calls).toContain("openSettings");
    expect(violations).toEqual([]);
    expect(stt.calls).toContain("addListener");
  });

  test("a denied microphone is dismissed through the engine", async () => {
    const { calls, fake } = await mount("native", ALL);
    const status = fake.plugin.status.bind(fake.plugin);
    fake.plugin.status = async () => ({ ...(await status()), micDeniedPresentation: true });
    fake.plugin.start = async () => { throw Object.assign(new Error("denied"), { code: "permission_denied" }); };
    await act(async () => { value!.record(); await tick(); });
    expect(value?.permissionDenied).toBe(true);
    await act(async () => { await value!.minimiseSheet(); });
    expect(calls).toContain("dismissShortcutRecovery");
  });
});

describe("engine-aware transcription default", () => {
  const withStorage = (stored: Record<string, string>, writes: string[] = []) => {
    global.localStorage = { getItem: (key: string) => stored[key] ?? null, setItem: (key: string, v: string) => { writes.push(`${key}=${v}`); }, removeItem: () => {} };
  };
  afterEach(() => { global.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }; });

  test("a fresh profile on the web engine journals private-cloud, not on-device", async () => {
    withStorage({});
    const { fake } = await mount("web", NONE);
    expect((await fake.plugin.getCaptureDefaults()).transcriber).toBe("private-cloud");
  });

  test("an existing on-device preference journals private-cloud on web and is not rewritten", async () => {
    const writes: string[] = [];
    withStorage({ "exo.voiceNotes.transcriber": "on-device" }, writes);
    const { fake } = await mount("web", NONE);
    expect((await fake.plugin.getCaptureDefaults()).transcriber).toBe("private-cloud");
    expect(writes.filter((write) => write.startsWith("exo.voiceNotes.transcriber"))).toEqual([]);
    expect(value?.transcriber.id).toBe("private-cloud");
  });

  test("Off stays Off on web", async () => {
    withStorage({ "exo.voiceNotes.transcriber": "off" });
    const { fake } = await mount("web", NONE);
    expect((await fake.plugin.getCaptureDefaults()).transcriber).toBe("off");
  });

  test("native keeps on-device for a fresh profile and an existing preference", async () => {
    withStorage({});
    const fresh = await mount("native", ALL);
    expect((await fresh.fake.plugin.getCaptureDefaults()).transcriber).toBe("on-device");
    await act(async () => root!.unmount());
    root = null;
    __resetCaptureEngineForTests();
    withStorage({ "exo.voiceNotes.transcriber": "on-device" });
    const existing = await mount("native", ALL);
    expect((await existing.fake.plugin.getCaptureDefaults()).transcriber).toBe("on-device");
  });

  test("a fresh signed-in profile with the model absent stays on the engine's default: nothing is swapped for Audio only", async () => {
    withStorage({});
    const { fake } = await mount("native", ALL, "absent");
    expect((await fake.plugin.getCaptureDefaults()).transcriber).toBe("on-device");
    expect(value?.transcriber).toMatchObject({ id: "on-device" });
  });

  test("a stored Local choice stays Local, never swapped for Private or Audio only", async () => {
    withStorage({ "exo.voiceNotes.transcriber": "on-device" });
    const { fake } = await mount("native", ALL, "absent");
    expect((await fake.plugin.getCaptureDefaults()).transcriber).toBe("on-device");
    expect(value?.transcriber).toMatchObject({ id: "on-device", source: "default" });
  });
});

describe("web engine: no OnDeviceStt calls", () => {
  test("the saved-receipt hook never subscribes to or reads OnDeviceStt", async () => {
    const { stt } = await mount("web", NONE);
    function ReceiptProbe() { useOnDeviceReceipt("rec-1", true, null); return null; }
    await act(async () => root!.render(<ReceiptProbe />));
    await act(async () => { await tick(); });
    expect(stt.calls).toEqual([]);
  });

  test("a denied microphone is recovered by calling record() again", async () => {
    const { fake } = await mount("web", NONE);
    const start = fake.plugin.start.bind(fake.plugin);
    fake.plugin.start = async (...args) => { throw Object.assign(new Error("denied"), { code: "permission_denied" }); void args; };
    await act(async () => { value!.record(); await tick(); });
    expect(value?.permissionDenied).toBe(true);
    fake.plugin.start = start;
    await act(async () => { value!.record(); await tick(); });
    expect(value?.permissionDenied).toBe(false);
  });
});
