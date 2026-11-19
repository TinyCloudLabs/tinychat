// The legacy "How this got here" footer on a saved note's sheet says the route the stepper already says: it stays out
// while the stepper is up and comes back when the pipeline is done.
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { StaticRecorderProvider } from "@/capture/recorder/RecorderProvider";
import { PlatformContext, appPlatform, type AppPlatform } from "@/lib/platform";
import { registerDesktopWhisperQueue } from "@/lib/voiceNotes/desktop/desktopWhisper";
import { installDom } from "@/test/dom";
import { createFakeOnDeviceStt } from "@/lib/voiceNotes/fakeOnDeviceStt";
import { __setVoiceNotesForTests, VoiceNotes, type VoiceNoteRecording, type VoiceNotesPlugin } from "@/lib/voiceNotes/nativeVoiceNotes";
import { __setOnDeviceSttForTests, OnDeviceStt } from "@/lib/voiceNotes/onDeviceStt";
import { __resetOnDeviceSttStoreForTests } from "@/lib/voiceNotes/onDeviceSttStore";
import { __resetAutoNoteSyncForTests } from "@/lib/voiceNotes/useNotePipeline";
import type { MeetingMetadataRead } from "@/lib/connectors/meetingExplorer";
import { HowThisGotHere } from "../HowThisGotHere";
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
  ({ id: "rec-1", startedAt: 0, durationMs: 1000, mimeType: "audio/mp4", sizeBytes: 4, silencedMs: 0, silencedEvents: 0, noSignalMs: 0,
    owner: "did:test:1", rev: 1, ledger: {
      audio: { state: "saved", rowId: "row-1", at: 1 },
      transcript: { state: "pending", outcome: null, reason: null, attempts: 0, nextAttemptAt: null },
      transcriptSync: { state: "pending", rev: 0, at: null }, landed: { state: "none", eventId: null }, remote: [],
    },
    options: { transcriber, identifySpeakers: false }, ...(stt === null ? {} : { stt }) }) as VoiceNoteRecording;

let cleanupDom: (() => void) | undefined;
let root: Root | null = null;
let recordings: VoiceNoteRecording[] = [];
let errors: ReturnType<typeof spyOn>;
let warnings: ReturnType<typeof spyOn>;

beforeEach(() => {
  cleanupDom = installDom();
  errors = spyOn(console, "error").mockImplementation(() => {});
  warnings = spyOn(console, "warn").mockImplementation(() => {});
  __resetOnDeviceSttStoreForTests();
  __resetAutoNoteSyncForTests();
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  registerDesktopWhisperQueue(null);
  __setVoiceNotesForTests(plugins.voiceNotes, { available: null });
  __setOnDeviceSttForTests(plugins.onDeviceStt);
  errors.mockRestore(); warnings.mockRestore();
  cleanupDom?.();
});
afterAll(() => {
  __setVoiceNotesForTests(plugins.voiceNotes, { available: null });
  __setOnDeviceSttForTests(plugins.onDeviceStt);
  __resetOnDeviceSttStoreForTests();
});

// Bun prints a failed matcher's DOM operand, and a React-attached element is cyclic: compare plain booleans only.
const present = (scope: ParentNode, selector: string): boolean => scope.querySelector(selector) !== null;

async function mount(options: { metadata?: MeetingMetadataRead; layout?: "page" | "sheet"; onRetry?: () => void; platform?: AppPlatform } = {}) {
  if (options.platform === "tauri") Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
  else {
    __setOnDeviceSttForTests(createFakeOnDeviceStt().plugin);
    __setVoiceNotesForTests(
      { listPending: async () => ({ recordings }), listQuarantine: async () => ({ items: [] }) } as unknown as VoiceNotesPlugin,
      { available: true },
    );
  }
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(
    <PlatformContext.Provider value={options.platform === "tauri" ? appPlatform() : options.platform ?? "web"}><StaticRecorderProvider value={{ tcw: null, signIn: null, transcription: undefined }}>
      <SavedNote
        item={ITEM}
        metadata={options.metadata ?? { status: "ok", metadata: {} }}
        audio={null}
        tcw={null as never}
        store={store}
        layout={options.layout ?? "page"}
        onBack={() => {}}
        transcript={<p>transcript</p>}
        footer={<HowThisGotHere source="exo-voice-note" read={options.metadata ?? { status: "ok", metadata: {} }} onRetry={options.onRetry ?? (() => {})} />}
      />
    </StaticRecorderProvider></PlatformContext.Provider>,
  ));
  for (let turn = 0; turn < 10; turn++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return container;
}

describe("the saved note's footer", () => {
  test("a queued transcription is the Transcript section's status, not the header's, and the legacy route line is not drawn", async () => {
    recordings = [recording("on-device", { state: "queued", pack: null, engine: null, segmentsDone: 0, windowsDone: 0, error: null })];
    const container = await mount();
    expect(present(container, '[data-testid="note-detail-status"]')).toBe(false);
    expect(present(container, '[data-testid="how-this-got-here"]')).toBe(false);
  });

  test("a failed metadata read keeps its Try again", async () => {
    recordings = [recording("on-device", { state: "queued", pack: null, engine: null, segmentsDone: 0, windowsDone: 0, error: null })];
    let retries = 0;
    const container = await mount({ metadata: { status: "failed", message: "boom" } as MeetingMetadataRead, onRetry: () => { retries += 1; } });
    expect(present(container, '[data-testid="note-detail-status"]')).toBe(false);
    const retry = container.querySelector<HTMLButtonElement>('[data-testid="how-this-got-here-retry"]');
    expect(retry !== null).toBe(true);
    await act(async () => retry!.click());
    expect(retries).toBe(1);
  });

  test("a durable pending transcript stays visible after the pipeline is done and the footer returns", async () => {
    recordings = [recording("off", null)];
    const container = await mount();
    expect(container.querySelector('[data-testid="note-detail-status"]')?.textContent).toContain("Transcript Pending");
    expect(present(container, '[data-testid="how-this-got-here"]')).toBe(true);
  });

  test("the saved note status leaves a durable coverage explanation to the transcript", async () => {
    recordings = [recording("off", null)];
    const container = await mount({ metadata: { status: "ok", metadata: {
      transcription_outcome: "failed", transcription_error_code: "transcript_incomplete",
    } } });
    const status = container.querySelector('[data-testid="note-detail-status"]')?.textContent;
    expect(status).toContain("Transcript Failed");
    expect(status).not.toContain("may be incomplete");
  });
});
