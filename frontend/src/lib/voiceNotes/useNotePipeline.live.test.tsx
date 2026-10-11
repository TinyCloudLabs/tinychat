// The pipeline hooks mounted on the real stores, with only the native plugins faked: what the saved-note sheet, the
// receipt and the list see as the phone's reads fail, its jobs progress and end, and the user presses the blocker's action.
// There is no DOM in this workspace: the hook is mounted on a stub container, as OnDeviceNoteStatus.test.tsx does.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { StaticRecorderProvider, type RecorderValue } from "@/capture/recorder/RecorderProvider";
import type { VoiceNoteTranscriptionProps } from "@/capture/recorder/transcriptionProps";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { createFakeOnDeviceStt } from "./fakeOnDeviceStt";
import type { NotePipeline, StepKey } from "./notePipeline";
import { __setOnDeviceSttForTests, OnDeviceStt, type OnDeviceSttStatus } from "./onDeviceStt";
import { __resetOnDeviceSttStoreForTests } from "./onDeviceSttStore";
import { saveNote } from "./recordingNotes";
import {
  __setVoiceNotesForTests,
  VoiceNotes,
  type NoteSttState,
  type TranscriberId,
  type VoiceNoteRecording,
  type VoiceNotesPlugin,
} from "./nativeVoiceNotes";
import { recordingNoteSyncError } from "./voiceNoteStore";
import { useNotePipeline, useNotePipelines, type NotePipelineSource, type NotePipelineView } from "./useNotePipeline";

const plugins = { voiceNotes: VoiceNotes, onDeviceStt: OnDeviceStt };
const saved = { window: (globalThis as { window?: unknown }).window, act: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT };
beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as { window?: unknown }).window = { setTimeout, clearTimeout, event: undefined, HTMLIFrameElement: class {} };
});
afterAll(() => {
  __setVoiceNotesForTests(plugins.voiceNotes, { available: null });
  __setOnDeviceSttForTests(plugins.onDeviceStt);
  __resetOnDeviceSttStoreForTests();
  (globalThis as { window?: unknown }).window = saved.window;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = saved.act;
});

const container = { nodeType: 1, nodeName: "DIV", tagName: "DIV", ownerDocument: null, textContent: "", addEventListener() {}, removeEventListener() {} } as unknown as HTMLElement;
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

// --- The phone -----------------------------------------------------------------------------------------------------

const stt = (state: NoteSttState["state"], error: string | null = null): NoteSttState => ({ state, pack: null, engine: null, segmentsDone: 0, windowsDone: 0, error });
const recording = (id: string, transcriber: TranscriberId, sttState: NoteSttState | null = null): VoiceNoteRecording =>
  ({
    id, startedAt: 0, durationMs: 1000, mimeType: "audio/mp4", sizeBytes: 4, silencedMs: 0, silencedEvents: 0, noSignalMs: 0,
    options: { transcriber, identifySpeakers: false }, ...(sttState === null ? {} : { stt: sttState }),
  }) as VoiceNoteRecording;

const phone = {
  recordings: [] as VoiceNoteRecording[],
  listError: null as Error | null,
  quarantine: [] as { id: string; reason: string; sizeBytes: number }[],
  reads: 0,
};

/** The plugin as iOS drives it: the queue never holds a finished job, and events arrive through `emit`. */
let queue: OnDeviceSttStatus["queue"] = [];
let refuseListening = new Map<string, Error>();
const callbacks = new Map<string, Set<(event: unknown) => void>>();
const emit = (event: string, value: unknown) => { for (const callback of [...(callbacks.get(event) ?? [])]) callback(value); };
const listening = (event: string) => callbacks.get(event)?.size ?? 0;

async function installPhone() {
  const fake = createFakeOnDeviceStt();
  const base = await fake.plugin.status();
  fake.plugin.status = async () => ({ ...base, queue });
  fake.plugin.addListener = ((event: string, callback: (event: unknown) => void) => {
    const refusal = refuseListening.get(event);
    if (refusal !== undefined) return Promise.reject(refusal);
    if (!callbacks.has(event)) callbacks.set(event, new Set());
    callbacks.get(event)!.add(callback);
    return Promise.resolve({ remove: async () => void callbacks.get(event)?.delete(callback) });
  }) as typeof fake.plugin.addListener;
  __setOnDeviceSttForTests(fake.plugin);
  __setVoiceNotesForTests(
    {
      listPending: async () => { phone.reads += 1; if (phone.listError) throw phone.listError; return { recordings: phone.recordings }; },
      listQuarantine: async () => ({ items: phone.quarantine }),
    } as unknown as VoiceNotesPlugin,
    { available: true },
  );
}

// --- The mount -----------------------------------------------------------------------------------------------------

const ID = "note-a";
const OTHER = "note-b";
const SYNC_ID = "note-with-unsynced-text";
const SPACE = { spaceId: "space-1", did: "did:test:1" } as unknown as TinyCloudWeb;
const SIGNED_OUT: NotePipelineSource = { tcw: null, saved: true, metadata: null };
const IN_SPACE: NotePipelineSource = { tcw: SPACE, saved: true, metadata: {} };

let root: Root | null = null;
let errors: ReturnType<typeof spyOn>;
let warnings: ReturnType<typeof spyOn>;

beforeEach(async () => {
  errors = spyOn(console, "error").mockImplementation(() => {});
  warnings = spyOn(console, "warn").mockImplementation(() => {});
  phone.recordings = []; phone.listError = null; phone.quarantine = []; phone.reads = 0;
  queue = []; refuseListening = new Map(); callbacks.clear();
  __resetOnDeviceSttStoreForTests();
  await installPhone();
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  Reflect.deleteProperty(globalThis, "localStorage");
  errors.mockRestore(); warnings.mockRestore();
});

const recorder = (patch: Partial<RecorderValue> = {}): Partial<RecorderValue> => ({ tcw: null, signIn: null, transcription: undefined, ...patch });

async function mountOne(source: NotePipelineSource, value: Partial<RecorderValue> = {}, id: string = ID) {
  const seen: { view: NotePipelineView | null } = { view: null };
  let renders = 0;
  function Probe() { seen.view = useNotePipeline(id, source); renders += 1; return null; }
  root = createRoot(container);
  await act(async () => root!.render(<StaticRecorderProvider value={recorder(value)}><Probe /></StaticRecorderProvider>));
  await settle();
  return { seen, renders: () => renders };
}

const checkFailing = (message: string): VoiceNoteTranscriptionProps => ({
  availability: "failed", checkError: "offline", consented: true, maxSeconds: 600,
jobs: new Map([[ID, { kind: "blocked", reason: "check-failed" }], [OTHER, { kind: "blocked", reason: "check-failed" }]]),
  onTranscribe: () => {}, onConsent: () => {}, onTurnOff: () => {}, onTurnOn: () => {},
  onRecheck: async () => { throw new Error(message); },
} as unknown as VoiceNoteTranscriptionProps);

const stepOf = (pipeline: NotePipeline, key: StepKey) => pipeline.steps.find((step) => step.key === key)!;

describe("a read that fails is shown with its cause, never read as done", () => {
  test("the phone's note list failing to open", async () => {
    phone.listError = new Error("ledger unreadable");
    const { seen } = await mountOne(SIGNED_OUT);
    const pipeline = seen.view!.pipeline;
    expect(stepOf(pipeline, "transcript").state).toBe("failed");
    expect(pipeline.blocker?.cause).toBe("Couldn't check this note's transcript · The phone's note list wouldn't open: ledger unreadable");
    expect(pipeline.blocker?.action?.kind).toBe("retry");
    expect(pipeline.done).toBe(false);
  });

  test("Try again on a failed read reads the phone again and recovers", async () => {
    phone.listError = new Error("busy");
    const { seen } = await mountOne(SIGNED_OUT);
    expect(seen.view!.pipeline.done).toBe(false);
    phone.listError = null;
    phone.recordings = [recording(ID, "off")];
    await act(async () => seen.view!.onAction("retry"));
    await settle();
    expect(seen.view!.pipeline.done).toBe(true);
    expect(seen.view!.actionError).toBeNull();
  });

  test("a listener that cannot register", async () => {
    phone.recordings = [recording(ID, "on-device", stt("queued"))];
    refuseListening.set("transcribed", new Error("bridge closed"));
    const { seen } = await mountOne(SIGNED_OUT);
    const pipeline = seen.view!.pipeline;
    expect(pipeline.blocker?.cause).toBe("Couldn't check this note's transcript · Updates from the phone failed to start: bridge closed");
    expect(pipeline.done).toBe(false);
  });

  test("the note's own text failing to open is a failed notes step", async () => {
    phone.recordings = [recording(ID, "off")];
    (globalThis as { localStorage?: unknown }).localStorage = { getItem: () => { throw new Error("storage refused"); } };
    const { seen } = await mountOne(SIGNED_OUT);
    const pipeline = seen.view!.pipeline;
    expect(stepOf(pipeline, "notes").state).toBe("failed");
    expect(pipeline.blocker?.cause).toBe("Couldn't read this note's text on this phone · The note's text wouldn't open on this phone: storage refused");
    expect(pipeline.done).toBe(false);
  });

  test("a read that worked and found no text and no ledger entry is done, not an error", async () => {
    const { seen } = await mountOne(SIGNED_OUT);
    expect(seen.view!.pipeline.done).toBe(true);
    expect(seen.view!.actionError).toBeNull();
  });
});

describe("notes that were never synced do not wait without an action", () => {
  test("the notes step is blocked with Try again, which runs the sync and shows how it ended", async () => {
    phone.recordings = [recording(SYNC_ID, "off")];
    await saveNote(SYNC_ID, "Book the venue before Friday.");
    const { seen } = await mountOne(IN_SPACE, {}, SYNC_ID);
    expect(stepOf(seen.view!.pipeline, "notes").state).toBe("blocked");
    expect(seen.view!.pipeline.blocker?.cause).toBe("Your notes haven't reached your space yet");
    expect(seen.view!.pipeline.blocker?.action?.kind).toBe("retry");
    // The fake space has no KV, so the sync itself fails: that reason is what the blocker line shows.
    await act(async () => seen.view!.onAction("retry"));
    await settle();
    expect(recordingNoteSyncError(SPACE, SYNC_ID)).toBe("sync_failed");
    expect(seen.view!.pipeline.blocker?.action?.kind).toBe("retry");
    expect(seen.view!.actionError).not.toBeNull();
    expect(seen.view!.pipeline.done).toBe(false);
  });
});

describe("a Local note's job ending after the phone dropped it from its queue", () => {
  test("a failed job: the cause comes from the ledger the hook reads again", async () => {
    phone.recordings = [recording(ID, "on-device", stt("queued"))];
    const { seen } = await mountOne(SIGNED_OUT);
    expect(stepOf(seen.view!.pipeline, "transcript").state).not.toBe("failed");
    const reads = phone.reads;
    phone.recordings = [recording(ID, "on-device", stt("failed", "decoder crashed"))];
    await act(async () => emit("failed", { id: ID }));
    await settle();
    expect(phone.reads).toBe(reads + 1);
    expect(stepOf(seen.view!.pipeline, "transcript").state).toBe("failed");
    expect(seen.view!.pipeline.blocker?.cause).toContain("decoder crashed");
  });

  test("an event for another note does not read the phone again", async () => {
    phone.recordings = [recording(ID, "on-device", stt("queued"))];
    await mountOne(SIGNED_OUT);
    const reads = phone.reads;
    await act(async () => emit("failed", { id: "somebody-else" }));
    await settle();
    expect(phone.reads).toBe(reads);
  });
});

describe("live on-device progress", () => {
  test("the stepper's percent follows the plugin's progress events while the job runs", async () => {
    phone.recordings = [recording(ID, "on-device", stt("running"))];
    queue = [{ id: ID, state: "running", percent: 0, error: null }];
    const { seen, renders } = await mountOne(SIGNED_OUT);
    expect(stepOf(seen.view!.pipeline, "transcript").state).toBe("active");
    expect(seen.view!.pipeline.steps.find((step) => step.key === "transcript")?.progress).toBe(0);
    await act(async () => emit("progress", { id: ID, percent: 63 }));
    expect(stepOf(seen.view!.pipeline, "transcript").progress).toBeCloseTo(0.63, 5);
    expect(seen.view!.pipeline.steps.find((step) => step.key === "transcript")?.caption).toBe("Transcribing · 63%");
    const before = renders();
    await act(async () => emit("progress", { id: ID, percent: 63.4 }));
    expect(renders()).toBe(before);
    await act(async () => emit("progress", { id: ID, percent: 80 }));
    expect(stepOf(seen.view!.pipeline, "transcript").progress).toBeCloseTo(0.8, 5);
  });
});

describe("a parked recording", () => {
  test("reads as Couldn't recover with its audio kept, on the sheet and receipt (no home provider)", async () => {
    phone.recordings = [recording(ID, "off")];
    phone.quarantine = [{ id: ID, reason: "recovery_failed", sizeBytes: 10 }];
    const { seen } = await mountOne({ tcw: null, saved: false });
    const pipeline = seen.view!.pipeline;
    expect(stepOf(pipeline, "phone").state).toBe("failed");
    expect(pipeline.blocker?.cause).toBe("Couldn't recover · audio kept");
    expect(stepOf(pipeline, "space").state).toBe("upcoming");
  });

  test("another note's parked audio does not touch this one", async () => {
    phone.recordings = [recording(ID, "off")];
    phone.quarantine = [{ id: OTHER, reason: "recovery_failed", sizeBytes: 10 }];
    const { seen } = await mountOne(SIGNED_OUT);
    expect(stepOf(seen.view!.pipeline, "phone").state).toBe("done");
  });
});

describe("actions", () => {
  test("a rejected action shows as the note's actionError", async () => {
    phone.recordings = [recording(ID, "private-cloud")];
    const { seen } = await mountOne(SIGNED_OUT, { transcription: checkFailing("the service is down") });
    expect(seen.view!.pipeline.blocker?.action?.kind).toBe("check-again");
    await act(async () => seen.view!.onAction("check-again"));
    await settle();
    expect(seen.view!.actionError).toBe("the service is down");
  });
});

describe("the list hook", () => {
  const entries = [{ id: ID, source: SIGNED_OUT }, { id: OTHER, source: SIGNED_OUT }];
  let views: ReadonlyMap<string, NotePipelineView> = new Map();

  async function mountList(value: Partial<RecorderValue> = {}) {
    function Probe() { views = useNotePipelines(entries); return null; }
    root = createRoot(container);
    await act(async () => root!.render(<StaticRecorderProvider value={recorder(value)}><Probe /></StaticRecorderProvider>));
    await settle();
  }

  test("each note carries its own action, run against the state it was drawn from; a rejection shows on that note only", async () => {
    phone.recordings = [recording(ID, "private-cloud"), recording(OTHER, "private-cloud")];
    await mountList({ transcription: checkFailing("the service is down") });
    expect([...views.keys()].sort()).toEqual([ID, OTHER]);
    expect(views.get(ID)!.pipeline.blocker?.action?.kind).toBe("check-again");
    await act(async () => views.get(ID)!.onAction("check-again"));
    await settle();
    expect(views.get(ID)!.actionError).toBe("the service is down");
    expect(views.get(OTHER)!.actionError).toBeNull();
  });

  test("a batch shares one set of subscriptions, and unmounting removes them", async () => {
    phone.recordings = [recording(ID, "on-device", stt("queued")), recording(OTHER, "on-device", stt("queued"))];
    await mountList();
    for (const event of ["transcribed", "failed", "status", "progress"]) expect(listening(event)).toBe(1);
    await act(async () => root!.unmount());
    root = null;
    await settle();
    for (const event of ["transcribed", "failed"]) expect(listening(event)).toBe(0);
  });

  test("a caller that passes no row metadata is not read as null: the hook reads the row itself, and a failed read is shown", async () => {
    phone.recordings = [recording(ID, "off")];
    const seen: NotePipelineView[] = [];
    const source: NotePipelineSource = { tcw: SPACE, saved: true };
    function Probe() { const view = useNotePipeline(ID, source); if (view) seen.push(view); return null; }
    root = createRoot(container);
    await act(async () => root!.render(<StaticRecorderProvider value={recorder()}><Probe /></StaticRecorderProvider>));
    await settle();
    const pipeline = seen.at(-1)!.pipeline;
    expect(pipeline.done).toBe(false);
    expect(pipeline.blocker?.cause).toContain("Your space's copy of this note wouldn't open");
  });
});
