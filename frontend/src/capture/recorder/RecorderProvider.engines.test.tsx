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
import { OnDeviceStt, __setOnDeviceSttForTests, type OnDeviceSttPlugin } from "@/lib/voiceNotes/onDeviceStt";
import { PendingVoiceNotesSaver } from "@/chat/PendingVoiceNotesSaver";
import { CaptureEngineGate } from "./CaptureEngineGate";
import { RecorderProvider, useRecorder, type RecorderValue } from "./RecorderProvider";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const global = globalThis as Record<string, unknown>;

const ALL: CaptureCapabilities = {
  nativeShortcuts: true, presentRecorder: true, openSettings: true, micDeniedPresentation: true,
  background: true, localTranscription: true, offlineRecorder: true,
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

function strictOnDeviceStt(supported: boolean) {
  const calls: string[] = [];
  const plugin = new Proxy({}, { get: (_t, property: string) => () => {
    calls.push(property);
    if (!supported) throw new Error(`${property} is unsupported`);
    return Promise.resolve({ remove: async () => {} });
  } });
  return { plugin: plugin as unknown as OnDeviceSttPlugin, calls };
}

// A DOM that accepts everything React asks of it and keeps nothing.
const node = (): unknown => new Proxy(function () {}, {
  get: (_t, key) => (key === "nodeType" ? 1 : key === "ownerDocument" ? documentStub : key === "style" ? {} : key === "firstChild" || key === "parentNode" ? null : () => node()),
  set: () => true,
});
const documentStub: Record<string, unknown> = { createElement: () => node(), createTextNode: () => node(), nodeType: 9, activeElement: null, addEventListener() {}, removeEventListener() {} };
const windowStub = (extra: object = {}) => ({ setTimeout, clearTimeout, event: undefined, HTMLIFrameElement: class {}, document: documentStub, ...extra });

const saved = {
  window: global.window, act: global.IS_REACT_ACT_ENVIRONMENT, flag: process.env.VITE_EXO_RECORDER_FINAL,
  MediaRecorder: global.MediaRecorder, voiceNotes: VoiceNotes, onDevice: OnDeviceStt,
  mediaDevices: Object.getOwnPropertyDescriptor(navigator, "mediaDevices"),
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
  __resetCaptureEngineForTests();
  global.window = saved.window;
  if (saved.flag === undefined) delete process.env.VITE_EXO_RECORDER_FINAL; else process.env.VITE_EXO_RECORDER_FINAL = saved.flag;
  if (saved.MediaRecorder === undefined) delete global.MediaRecorder; else global.MediaRecorder = saved.MediaRecorder;
  if (saved.mediaDevices) Object.defineProperty(navigator, "mediaDevices", saved.mediaDevices); else delete (navigator as unknown as Record<string, unknown>).mediaDevices;
  __setVoiceNotesForTests(saved.voiceNotes, { available: null });
  __setOnDeviceSttForTests(saved.onDevice);
});

async function mount(kind: CaptureEngineKind, capabilities: CaptureCapabilities) {
  return mountWith(kind, capabilities);
}

async function mountWith(kind: CaptureEngineKind, capabilities: CaptureCapabilities, prepare?: (plugin: VoiceNotesPlugin) => void) {
  const stt = strictOnDeviceStt(kind === "native");
  __setOnDeviceSttForTests(stt.plugin);
  const strict = strictEngine(capabilities);
  prepare?.(strict.fake.plugin);
  if (kind === "native") {
    global.window = windowStub();
    __setVoiceNotesForTests(strict.engine, { available: true });
  } else {
    process.env.VITE_EXO_RECORDER_FINAL = "true";
    __setVoiceNotesForTests(saved.voiceNotes, { available: false });
    global.window = windowStub(kind === "tauri" ? { __TAURI_INTERNALS__: {} } : {});
    global.MediaRecorder = class {};
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {} });
    registerCaptureEngine(kind, async () => strict.engine);
    await installCaptureEngine();
  }
  const tcw = { did: "did:example:alice" } as TinyCloudWeb;
  root = createRoot({ nodeType: 1, nodeName: "DIV", tagName: "DIV", ownerDocument: documentStub, textContent: "", addEventListener() {}, removeEventListener() {},
    appendChild() {}, removeChild() {}, insertBefore() {} } as unknown as HTMLElement);
  await act(async () => root!.render(
    <RecorderProvider tcw={tcw} enabled>
      <Probe />
      <PendingVoiceNotesSaver tcw={tcw} pipeline={{ resume() {}, cancelAll() {}, reconcileAll: async () => {} } as never} backendUrl="" sessionStore={{} as never} />
    </RecorderProvider>,
  ));
  await act(async () => { await tick(); await tick(); });
  return { ...strict, stt };
}

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
    process.env.VITE_EXO_RECORDER_FINAL = "true";
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

  test("native and flag-off render at once, with nothing to install", async () => {
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
