// The legacy "How this got here" footer on a saved note's sheet says the route the stepper already says: it stays out
// while the stepper is up and comes back when the pipeline is done.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { StaticRecorderProvider } from "@/capture/recorder/RecorderProvider";
import { installDom } from "@/test/dom";
import { createFakeOnDeviceStt } from "@/lib/voiceNotes/fakeOnDeviceStt";
import { __setVoiceNotesForTests, VoiceNotes, type VoiceNoteRecording, type VoiceNotesPlugin } from "@/lib/voiceNotes/nativeVoiceNotes";
import { __setOnDeviceSttForTests, OnDeviceStt } from "@/lib/voiceNotes/onDeviceStt";
import { __resetOnDeviceSttStoreForTests } from "@/lib/voiceNotes/onDeviceSttStore";
import { __resetAutoNoteSyncForTests } from "@/lib/voiceNotes/useNotePipeline";
import type { LibraryItem } from "../LibraryRow";
import SavedNote from "./SavedNote";
import type { SavedNoteStore } from "./savedNoteStore";

const plugins = { voiceNotes: VoiceNotes, onDeviceStt: OnDeviceStt };
const ITEM: LibraryItem = { id: "row-1", source: "exo-voice-note", sourceId: "rec-1", title: "Voice note", startedAt: "2026-10-06T09:28:00.000Z", durationSecs: 42 };
const store: SavedNoteStore = {
  load: async () => ({ md: "hi", savedEditAt: "2026-10-09T10:00:00Z" }),
  save: async (_id, md) => ({ record: { md, savedEditAt: "2026-10-09T10:00:00Z" }, synced: Promise.resolve() }),
};
const recording = (transcriber: "on-device" | "off", stt: unknown): VoiceNoteRecording =>
  ({ id: "rec-1", startedAt: 0, durationMs: 1000, mimeType: "audio/mp4", sizeBytes: 4, silencedMs: 0, silencedEvents: 0, noSignalMs: 0, options: { transcriber, identifySpeakers: false }, ...(stt === null ? {} : { stt }) }) as VoiceNoteRecording;

let cleanupDom: (() => void) | undefined;
let root: Root | null = null;
let recordings: VoiceNoteRecording[] = [];
let errors: ReturnType<typeof spyOn>;
let warnings: ReturnType<typeof spyOn>;

beforeAll(async () => {
  const fake = createFakeOnDeviceStt();
  __setOnDeviceSttForTests(fake.plugin);
});
beforeEach(() => {
  cleanupDom = installDom();
  errors = spyOn(console, "error").mockImplementation(() => {});
  warnings = spyOn(console, "warn").mockImplementation(() => {});
  __resetOnDeviceSttStoreForTests();
  __resetAutoNoteSyncForTests();
  __setVoiceNotesForTests(
    { listPending: async () => ({ recordings }), listQuarantine: async () => ({ items: [] }) } as unknown as VoiceNotesPlugin,
    { available: true },
  );
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  errors.mockRestore(); warnings.mockRestore();
  cleanupDom?.();
});
afterAll(() => {
  __setVoiceNotesForTests(plugins.voiceNotes, { available: null });
  __setOnDeviceSttForTests(plugins.onDeviceStt);
  __resetOnDeviceSttStoreForTests();
});

async function mount() {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(
    <StaticRecorderProvider value={{ tcw: null, signIn: null, transcription: undefined }}>
      <SavedNote
        item={ITEM}
        metadata={{ status: "ok", metadata: {} }}
        audio={null}
        tcw={null as never}
        store={store}
        layout="page"
        onBack={() => {}}
        transcript={<p>transcript</p>}
        footer={<p data-testid="how-this-got-here">route line</p>}
      />
    </StaticRecorderProvider>,
  ));
  for (let turn = 0; turn < 10; turn++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return container;
}

describe("the saved note's footer", () => {
  test("while the stepper shows, the legacy route line is not drawn", async () => {
    recordings = [recording("on-device", { state: "queued", pack: null, engine: null, segmentsDone: 0, windowsDone: 0, error: null })];
    const container = await mount();
    expect(container.querySelector('[data-testid="voice-note-pipeline"], [aria-label="Where this note is"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="how-this-got-here"]')).toBeNull();
  });

  test("once the pipeline is done the footer is drawn", async () => {
    recordings = [recording("off", null)];
    const container = await mount();
    expect(container.querySelector('[aria-label="Where this note is"]')).toBeNull();
    expect(container.querySelector('[data-testid="how-this-got-here"]')).not.toBeNull();
  });
});
