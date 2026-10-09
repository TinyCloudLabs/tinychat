// useOnDeviceReceipt, mounted (TC-836 round-2 finding 1): the sidecar's durable `stt.state`
// (read via `VoiceNotes.listPending()`) is the source of truth for a note's on-device failure,
// not an accumulated `transcribed`/`failed` event — a `failed` note must still show "failed" on a
// fresh mount that never received that event, and Retry must clear the failure display the
// instant it starts, not just once a new terminal event arrives.
//
// There is no DOM in this workspace: react-dom/client mounts the hook on a stub container (as
// useLibrary.test.tsx does).
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { createFakeOnDeviceStt } from "@/lib/voiceNotes/fakeOnDeviceStt";
import { __setOnDeviceSttForTests } from "@/lib/voiceNotes/onDeviceStt";
import { __setVoiceNotesForTests, type LocalTranscript, type NoteSttState, type VoiceNoteRecording, type VoiceNotesPlugin } from "@/lib/voiceNotes/nativeVoiceNotes";
import { useOnDeviceReceipt } from "./SavedReceipt";

const saved = { window: (globalThis as { window?: unknown }).window, act: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT };
beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as { window?: unknown }).window = { setTimeout, clearTimeout, event: undefined, HTMLIFrameElement: class {} };
});
afterAll(() => {
  (globalThis as { window?: unknown }).window = saved.window;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = saved.act;
});

/** A minimal native-plugin stand-in whose `listPending()`/`getTranscript()` reflect a durable
 * sidecar the test controls directly — the on-device analogue of a persisted note surviving a
 * process restart, independent of any retained event. `setStt` mirrors how native always writes
 * the sidecar before it emits `transcribed`/`failed` (TranscriptionQueue's `fail()`/`process()`),
 * so a test can fire both together, the way the real plugin does. */
function fakeVoiceNotesWithSidecar(id: string, stt: NoteSttState | null, transcript: LocalTranscript | null = null) {
  let currentStt = stt;
  const plugin = {
    getTranscript: async () => ({ transcript }),
    listPending: async () => ({
      recordings: currentStt
        ? [{ id, startedAt: 0, durationMs: 1000, mimeType: "audio/mp4", sizeBytes: 4, silencedMs: 0, silencedEvents: 0, noSignalMs: 0, stt: currentStt } satisfies VoiceNoteRecording]
        : [],
    }),
  } as unknown as VoiceNotesPlugin;
  __setVoiceNotesForTests(plugin, { available: true });
  return { plugin, setStt: (next: NoteSttState | null) => { currentStt = next; } };
}

function Probe(props: { id: string; onDevice: boolean; seen: ReturnType<typeof useOnDeviceReceipt>[] }) {
  props.seen.push(useOnDeviceReceipt(props.id, props.onDevice));
  return null;
}
const container = { nodeType: 1, nodeName: "DIV", tagName: "DIV", ownerDocument: null, textContent: "", addEventListener() {}, removeEventListener() {} } as unknown as HTMLElement;
let root: Root | null = null;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
});
async function render(id: string, seen: ReturnType<typeof useOnDeviceReceipt>[]) {
  root = createRoot(container);
  await act(async () => root!.render(<Probe id={id} onDevice seen={seen} />));
  await act(async () => {});
}

describe("useOnDeviceReceipt, mounted", () => {
  test("a fresh mount with a persisted failed note shows failed, with no transcribed/failed event ever fired", async () => {
    const fake = createFakeOnDeviceStt();
    __setOnDeviceSttForTests(fake.plugin); // the queue has already dropped this note (it is no longer pending), as a real crash-looped note would be
    fakeVoiceNotesWithSidecar("note-1", { state: "failed", pack: "full", engine: "parakeet", segmentsDone: 0, windowsDone: 0, error: "too_many_attempts" });

    const seen: ReturnType<typeof useOnDeviceReceipt>[] = [];
    await render("note-1", seen);

    expect(seen.at(-1)!.kind).toBe("failed");
  });

  test("Retry clears the failed display the instant it starts, before any new terminal event", async () => {
    const fake = createFakeOnDeviceStt();
    __setOnDeviceSttForTests(fake.plugin);
    const sidecar = fakeVoiceNotesWithSidecar("note-1", { state: "failed", pack: "full", engine: "parakeet", segmentsDone: 0, windowsDone: 0, error: "too_many_attempts" });
    // Native's real `enqueue()` writes the sidecar to `queued` as part of the same call
    // (TranscriptionQueue.enqueue): model that coupling so the fakes agree with each other.
    const realEnqueue = fake.plugin.enqueue;
    fake.plugin.enqueue = (options) => {
      sidecar.setStt({ state: "queued", pack: "full", engine: "parakeet", segmentsDone: 0, windowsDone: 0, error: null });
      return realEnqueue(options);
    };

    const seen: ReturnType<typeof useOnDeviceReceipt>[] = [];
    await render("note-1", seen);
    expect(seen.at(-1)!.kind).toBe("failed");

    await act(async () => seen.at(-1)!.retry());
    expect(seen.at(-1)!.kind).not.toBe("failed");
    expect(seen.at(-1)!.kind).toBe("pending");
  });

  test("a failed event triggers a fresh read that picks up the now-failed persisted state", async () => {
    const fake = createFakeOnDeviceStt();
    __setOnDeviceSttForTests(fake.plugin);
    const sidecar = fakeVoiceNotesWithSidecar("note-1", null);

    const seen: ReturnType<typeof useOnDeviceReceipt>[] = [];
    await render("note-1", seen);
    expect(seen.at(-1)!.kind).toBe("pending");

    await act(async () => fake.plugin.enqueue({ id: "note-1" }));
    // Native always writes the sidecar before it emits `failed` (TranscriptionQueue.fail()).
    sidecar.setStt({ state: "failed", pack: "full", engine: "parakeet", segmentsDone: 0, windowsDone: 0, error: "decode_failed" });
    await act(async () => fake.controls.fail("note-1", "decode_failed", "boom"));
    expect(seen.at(-1)!.kind).toBe("failed");
  });
});
