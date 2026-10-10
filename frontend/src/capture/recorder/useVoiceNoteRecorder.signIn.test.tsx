import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { createFakeVoiceNotes } from "@/lib/voiceNotes/fakeVoiceNotes";
import { __setVoiceNotesForTests } from "@/lib/voiceNotes/nativeVoiceNotes";
import type { VoiceNotePipeline } from "@/lib/voiceNotes/voiceNotePipeline";
import { useVoiceNoteRecorder, type VoiceNoteRecorder } from "./useVoiceNoteRecorder";

const previousAct = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
const previousWindow = (globalThis as { window?: unknown }).window;
beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as { window?: unknown }).window = { setTimeout, clearTimeout, event: undefined,
    HTMLIFrameElement: class {}, addEventListener() {}, removeEventListener() {} };
});
afterAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = previousAct;
  (globalThis as { window?: unknown }).window = previousWindow;
});

const container = { nodeType: 1, nodeName: "DIV", tagName: "DIV", ownerDocument: null, textContent: "",
  addEventListener() {}, removeEventListener() {} } as unknown as HTMLElement;
let root: Root | null = null;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
});

test("a fresh sign-in replaces the null-client recorder before Save now", async () => {
  const fake = createFakeVoiceNotes();
  __setVoiceNotesForTests(fake.plugin, { available: true });
  const account = { did: "did:example:fresh", spaceId: "tinycloud:space" } as TinyCloudWeb;
  let reconciled = 0;
  const pipeline: VoiceNotePipeline = {
    process: async () => {}, reconcileAll: async () => { reconciled++; },
    cancelAll: () => {}, resume: () => {}, isAccepting: () => true, quiescent: async () => true,
  };
  const seen: VoiceNoteRecorder[] = [];
  function Probe({ tcw }: { tcw: TinyCloudWeb | null }) {
    seen.push(useVoiceNoteRecorder({ tcw, pipeline }));
    return null;
  }
  root = createRoot(container);
  await act(async () => root!.render(<Probe tcw={null} />));
  const signedOutRetry = seen.at(-1)!.retryPending;
  await fake.plugin.setCaptureDefaults({ accountDid: account.did, transitionGen: 1,
    transcriber: "on-device", identifySpeakers: false });
  await act(async () => root!.render(<Probe tcw={account} />));
  expect(seen.at(-1)!.retryPending).not.toBe(signedOutRetry);
  await act(async () => { seen.at(-1)!.retryPending(); await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(reconciled).toBe(1);
});
