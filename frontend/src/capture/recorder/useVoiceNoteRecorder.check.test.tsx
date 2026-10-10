// The private-cloud availability check runs once the account is ready, and again when the app returns to the foreground.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { createFakeVoiceNotes } from "@/lib/voiceNotes/fakeVoiceNotes";
import { __setVoiceNotesForTests } from "@/lib/voiceNotes/nativeVoiceNotes";
import { voiceNoteTranscriberFor } from "@/lib/voiceNotes/voiceNoteTranscription";
import { useVoiceNoteRecorder } from "./useVoiceNoteRecorder";

type Listener = () => void;
const listeners = new Map<string, Set<Listener>>();
const visibility = { state: "visible" };
const previous = {
  act: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT,
  window: (globalThis as { window?: unknown }).window,
  document: (globalThis as { document?: unknown }).document,
};
beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as { window?: unknown }).window = {
    setTimeout, clearTimeout, event: undefined, HTMLIFrameElement: class {},
    addEventListener: (name: string, listener: Listener) => {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)!.add(listener);
    },
    removeEventListener: (name: string, listener: Listener) => void listeners.get(name)?.delete(listener),
  };
  (globalThis as { document?: unknown }).document = { get visibilityState() { return visibility.state; } };
});
afterAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = previous.act;
  (globalThis as { window?: unknown }).window = previous.window;
  (globalThis as { document?: unknown }).document = previous.document;
});

const container = { nodeType: 1, nodeName: "DIV", tagName: "DIV", ownerDocument: null, textContent: "",
  addEventListener() {}, removeEventListener() {} } as unknown as HTMLElement;
let root: Root | null = null;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
});

const sessionStore = {} as SessionStore;
const backendUrl = "http://backend.test";

test("check() runs when the account is ready, not before, and again on returning to the foreground", async () => {
  __setVoiceNotesForTests(createFakeVoiceNotes().plugin, { available: true });
  const account = { did: "did:example:check-on-ready", spaceId: "tinycloud:space" } as TinyCloudWeb;
  // The transcriber is one per account, so the hook gets this very object back.
  const transcriber = voiceNoteTranscriberFor(account, backendUrl, sessionStore)!;
  let checks = 0;
  transcriber.check = () => {
    checks += 1;
    return Promise.resolve();
  };
  function Probe({ tcw }: { tcw: TinyCloudWeb | null }) {
    useVoiceNoteRecorder({ tcw, backendUrl, sessionStore });
    return null;
  }
  root = createRoot(container);
  await act(async () => root!.render(<Probe tcw={null} />));
  expect(checks).toBe(0);

  await act(async () => root!.render(<Probe tcw={account} />));
  expect(checks).toBe(1);

  await act(async () => root!.render(<Probe tcw={account} />));
  expect(checks).toBe(1);

  visibility.state = "hidden";
  for (const listener of listeners.get("visibilitychange") ?? []) listener();
  expect(checks).toBe(1);
  visibility.state = "visible";
  for (const listener of listeners.get("visibilitychange") ?? []) listener();
  expect(checks).toBe(2);
});
