// The private-cloud availability check runs once the account is ready, and again when the app returns to the foreground.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { createFakeVoiceNotes } from "@/lib/voiceNotes/fakeVoiceNotes";
import { __setVoiceNotesForTests, VoiceNotes } from "@/lib/voiceNotes/nativeVoiceNotes";
import { createVoiceNoteTranscriber, voiceNoteTranscriberFor, type VoiceNoteCloud } from "@/lib/voiceNotes/voiceNoteTranscription";
import { useVoiceNoteRecorder } from "./useVoiceNoteRecorder";

type Listener = () => void;
const realVoiceNotes = VoiceNotes;
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
  __setVoiceNotesForTests(realVoiceNotes, { available: null });
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

function Probe(props: { tcw: TinyCloudWeb | null }) {
  useVoiceNoteRecorder({ tcw: props.tcw, backendUrl, sessionStore });
  return null;
}
const foreground = () => {
  for (const listener of listeners.get("visibilitychange") ?? []) listener();
};

test("the automatic check names its account's guard, which turns false when the account leaves", async () => {
  __setVoiceNotesForTests(createFakeVoiceNotes().plugin, { available: true });
  const account = { did: "did:example:check-guard", spaceId: "tinycloud:space" } as TinyCloudWeb;
  const transcriber = voiceNoteTranscriberFor(account, backendUrl, sessionStore)!;
  const seen: { automatic?: boolean; current?: () => boolean }[] = [];
  transcriber.check = (options) => {
    seen.push(options ?? {});
    return Promise.resolve();
  };
  root = createRoot(container);
  await act(async () => root!.render(<Probe tcw={account} />));
  expect(seen).toHaveLength(1);
  expect(seen[0]!.automatic).toBe(true);
  expect(seen[0]!.current!()).toBe(true);
  await act(async () => root!.render(<Probe tcw={null} />));
  expect(seen[0]!.current!()).toBe(false);
});

test("a completed account-A check does not resume A's work after the hook switches to B or signs out", async () => {
  __setVoiceNotesForTests(createFakeVoiceNotes().plugin, { available: true });
  const a = { did: "did:example:switch-A", spaceId: "space-a" } as TinyCloudWeb;
  const b = { did: "did:example:switch-B", spaceId: "space-b" } as TinyCloudWeb;
  for (const leave of [b, null]) {
    const resumed: string[] = [];
    let finish: (caps: unknown) => void = () => {};
    const real = createVoiceNoteTranscriber({
      tcw: () => a,
      cloud: { capabilities: () => new Promise((resolve) => { finish = resolve; }), pendingSourceIds: () => ["a-note"] } as unknown as VoiceNoteCloud,
      consent: { get: () => true, set() {} },
      runNote: async (args) => {
        resumed.push(args.sourceId);
        return "no_speech";
      },
    });
    const transcriber = voiceNoteTranscriberFor({ ...a, did: `${a.did}-${leave === null ? "out" : "b"}` } as TinyCloudWeb, backendUrl, sessionStore)!;
    transcriber.check = real.check;
    const account = { ...a, did: `${a.did}-${leave === null ? "out" : "b"}` } as TinyCloudWeb;
    root = createRoot(container);
    await act(async () => root!.render(<Probe tcw={account} />));
    await act(async () => root!.render(<Probe tcw={leave} />));
    await act(async () => finish({ max_bytes: 1_000_000, max_duration_seconds: 100 }));
    await act(async () => root!.unmount());
    root = null;
    expect(resumed).toEqual([]);
  }
});

test("rapid foreground returns reuse a fresh settled availability result", async () => {
  __setVoiceNotesForTests(createFakeVoiceNotes().plugin, { available: true });
  const account = { did: "did:example:check-foreground", spaceId: "tinycloud:space" } as TinyCloudWeb;
  let requests = 0;
  const real = createVoiceNoteTranscriber({
    tcw: () => account,
    cloud: { capabilities: async () => { requests += 1; return null; }, pendingSourceIds: () => [] } as unknown as VoiceNoteCloud,
    consent: { get: () => false, set() {} },
  });
  voiceNoteTranscriberFor(account, backendUrl, sessionStore)!.check = real.check;
  root = createRoot(container);
  await act(async () => root!.render(<Probe tcw={account} />));
  await act(async () => foreground());
  await act(async () => foreground());
  expect(requests).toBe(1);
});
