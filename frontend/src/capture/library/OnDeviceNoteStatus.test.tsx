// A saved voice note with no transcript says where its on-device transcription stands
// (committed mode, the native sidecar's `stt`, the live queue, the plugin's events) instead of "No transcript.".
// Fixtures have the native shape: the sidecar says `waiting_for_model` for every mode, and iOS
// takes the active note out of the queue and reports its percent only through `progress`.
// There is no DOM in this workspace: the hook is mounted on a stub container, the view is rendered to markup.
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import { createFakeOnDeviceStt } from "@/lib/voiceNotes/fakeOnDeviceStt";
import { onDeviceSttStore } from "@/lib/voiceNotes/onDeviceSttStore";
import { __setOnDeviceSttForTests, OnDeviceStt } from "@/lib/voiceNotes/onDeviceStt";
import {
  __setVoiceNotesForTests,
  VoiceNotes,
  type LocalTranscript,
  type NoteSttState,
  type TranscriberId,
  type VoiceNoteRecording,
  type VoiceNotesPlugin,
} from "@/lib/voiceNotes/nativeVoiceNotes";
import { onDeviceNote, OnDeviceNoteStatusView, useOnDeviceNote, type OnDeviceNote } from "./OnDeviceNoteStatus";

const plugins = { voiceNotes: VoiceNotes, onDeviceStt: OnDeviceStt };
const saved = { window: (globalThis as { window?: unknown }).window, act: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT };
beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as { window?: unknown }).window = { setTimeout, clearTimeout, event: undefined, HTMLIFrameElement: class {} };
});
afterAll(() => {
  __setVoiceNotesForTests(plugins.voiceNotes, { available: null });
  __setOnDeviceSttForTests(plugins.onDeviceStt);
  (globalThis as { window?: unknown }).window = saved.window;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = saved.act;
});

const stt = (state: NoteSttState["state"], error: string | null = null): NoteSttState => ({
  state, pack: null, engine: null, segmentsDone: 0, windowsDone: 0, error,
});

const recording = (id: string, transcriber: TranscriberId | null, sttState: NoteSttState | null): VoiceNoteRecording =>
  ({
    id, startedAt: 0, durationMs: 1000, mimeType: "audio/mp4", sizeBytes: 4, silencedMs: 0, silencedEvents: 0, noSignalMs: 0,
    ...(transcriber === null ? {} : { options: { transcriber, identifySpeakers: false } }),
    ...(sttState === null ? {} : { stt: sttState }),
  }) as VoiceNoteRecording;

const transcriptOf = (outcome: LocalTranscript["outcome"]) => ({ outcome, transcriber: "on-device", segments: [] }) as unknown as LocalTranscript;

interface Native {
  recordings: () => Promise<VoiceNoteRecording[]> | VoiceNoteRecording[];
  transcript?: (id: string) => LocalTranscript | null;
}
function fakeVoiceNotes(native: Native) {
  __setVoiceNotesForTests(
    {
      listPending: async () => ({ recordings: await native.recordings() }),
      getTranscript: async ({ id }: { id: string }) => ({ transcript: native.transcript?.(id) ?? null }),
    } as unknown as VoiceNotesPlugin,
    { available: true },
  );
}

/** The plugin as iOS drives it: events through `emit`, and a queue that never holds the active note. */
async function iosStt() {
  const fake = createFakeOnDeviceStt();
  const base = await fake.plugin.status();
  const callbacks = new Map<string, Set<(event: unknown) => void>>();
  fake.plugin.addListener = ((event: string, callback: (event: unknown) => void) => {
    if (!callbacks.has(event)) callbacks.set(event, new Set());
    callbacks.get(event)!.add(callback);
    return Promise.resolve({ remove: async () => void callbacks.get(event)?.delete(callback) });
  }) as typeof fake.plugin.addListener;
  fake.plugin.status = async () => ({ ...base, queue: [] });
  __setOnDeviceSttForTests(fake.plugin);
  await onDeviceSttStore.refresh();
  return { emit: (event: string, value: unknown) => { for (const callback of callbacks.get(event) ?? []) callback(value); }, listening: (event: string) => callbacks.get(event)?.size ?? 0 };
}

const container = { nodeType: 1, nodeName: "DIV", tagName: "DIV", ownerDocument: null, textContent: "", addEventListener() {}, removeEventListener() {} } as unknown as HTMLElement;
let root: Root | null = null;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
});

async function mount(noteId: string) {
  const seen: ReturnType<typeof useOnDeviceNote>[] = [];
  function Probe({ id }: { id: string }) {
    seen.push(useOnDeviceNote(id));
    return null;
  }
  root = createRoot(container);
  const render = (id: string) => act(async () => root!.render(<Probe id={id} />));
  await render(noteId);
  return { seen, latest: () => seen.at(-1)!, render };
}

const view = (note: OnDeviceNote | null, error: string | null = null) =>
  renderToStaticMarkup(<OnDeviceNoteStatusView noteId="n1" view={{ note, error, reload: () => {} }} fallback={<p>No transcript.</p>} />);

describe("a saved note's on-device state, gated by the note's committed mode", () => {
  test("Local reads as waiting for the model, with the download control", async () => {
    await iosStt();
    fakeVoiceNotes({ recordings: () => [recording("n1", "on-device", stt("waiting_for_model"))] });
    const { latest } = await mount("n1");
    expect(latest().note).toEqual({ kind: "waiting_for_model" });
    const html = view(latest().note);
    expect(html).toContain("Waiting for the on-device model");
    expect(html).toContain('data-testid="voice-note-model-download"');
    expect(html).not.toContain("No transcript.");
  });

  test("Audio only, Private and AssemblyAI notes never show Local waiting, though native writes waiting_for_model for all", async () => {
    await iosStt();
    for (const mode of ["off", "private-cloud", "assemblyai"] as const) {
      fakeVoiceNotes({ recordings: () => [recording("n1", mode, stt("waiting_for_model"))] });
      const { latest } = await mount("n1");
      expect(latest().note).toEqual({ kind: "none" });
      expect(view(latest().note)).toBe("<p>No transcript.</p>");
      await act(async () => root!.unmount());
      root = null;
    }
  });

  test("a note without committed options is not a Local note (the native queue skips it too)", async () => {
    await iosStt();
    fakeVoiceNotes({ recordings: () => [recording("n1", null, stt("waiting_for_model"))] });
    expect((await mount("n1")).latest().note).toEqual({ kind: "none" });
  });

  test("a note native no longer holds keeps what the page showed before", async () => {
    await iosStt();
    fakeVoiceNotes({ recordings: () => [] });
    expect((await mount("n1")).latest().note).toEqual({ kind: "none" });
  });

  test("a failed Local note names why and offers Retry", async () => {
    await iosStt();
    fakeVoiceNotes({ recordings: () => [recording("n1", "on-device", stt("failed", "decoder_error"))] });
    const { latest } = await mount("n1");
    expect(latest().note).toEqual({ kind: "failed", reason: "decoder_error" });
    const html = view(latest().note);
    expect(html).toContain("Couldn&#x27;t transcribe on this phone: decoder_error");
    expect(html).toContain('data-testid="voice-note-on-device-retry"');
  });
});

describe("while this note's mode and state are not known yet", () => {
  test("the view says it is checking, never No transcript.", () => {
    const html = view(null);
    expect(html).toContain("Checking this note&#x27;s transcription");
    expect(html).not.toContain("No transcript.");
  });

  test("the hook has no answer until the native scan returns, and then only for that note", async () => {
    await iosStt();
    let release: (recordings: VoiceNoteRecording[]) => void = () => {};
    const scan = new Promise<VoiceNoteRecording[]>((resolve) => { release = resolve; });
    fakeVoiceNotes({ recordings: () => scan });
    const { latest } = await mount("n1");
    expect(latest().note).toBeNull();
    await act(async () => release([recording("n1", "on-device", stt("queued"))]));
    expect(latest().note).toEqual({ kind: "queued" });
  });

  test("switching notes drops the first note's state at once and ignores its late scan", async () => {
    await iosStt();
    const late: Array<(recordings: VoiceNoteRecording[]) => void> = [];
    fakeVoiceNotes({
      recordings: () => new Promise<VoiceNoteRecording[]>((resolve) => { late.push(resolve); }),
    });
    const { latest, render } = await mount("a");
    await act(async () => late[0]!([recording("a", "on-device", stt("waiting_for_model")), recording("b", "off", stt("waiting_for_model"))]));
    expect(latest().note).toEqual({ kind: "waiting_for_model" });
    await render("b");
    expect(latest().note).toBeNull();
    await act(async () => late[1]!([recording("a", "on-device", stt("waiting_for_model")), recording("b", "off", stt("waiting_for_model"))]));
    expect(latest().note).toEqual({ kind: "none" });
  });

  test("a failed read is shown and logged, with Try again", async () => {
    await iosStt();
    const logged = spyOn(console, "error").mockImplementation(() => {});
    fakeVoiceNotes({ recordings: () => { throw new Error("scan failed"); } });
    const { latest } = await mount("n1");
    expect(latest().note).toBeNull();
    expect(latest().error).toBe("Couldn't check this note's on-device transcription: scan failed");
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
    const html = view(latest().note, latest().error);
    expect(html).toContain("scan failed");
    expect(html).toContain("Try again");
    expect(html).not.toContain("No transcript.");
  });
});

describe("following the real iOS events", () => {
  test("progress marks the note running with its percent although the queue omits it, and ends on transcribed", async () => {
    const events = await iosStt();
    fakeVoiceNotes({ recordings: () => [recording("n1", "on-device", stt("running"))] });
    const { latest } = await mount("n1");
    expect(latest().note).toEqual({ kind: "running", percent: null });
    await act(async () => events.emit("progress", { id: "other", percent: 90 }));
    expect(latest().note).toEqual({ kind: "running", percent: null });
    await act(async () => events.emit("progress", { id: "n1", percent: 40 }));
    expect(latest().note).toEqual({ kind: "running", percent: 40 });
    expect(view(latest().note)).toContain("Transcribing on this phone… 40%");
    await act(async () => events.emit("progress", { id: "n1", percent: 65 }));
    expect(latest().note).toEqual({ kind: "running", percent: 65 });
    await act(async () => events.emit("transcribed", { id: "n1", outcome: "transcribed" }));
    expect(latest().note).toEqual({ kind: "done" });
  });

  test("a progress tick that arrives before the scan returns is kept", async () => {
    const events = await iosStt();
    let release: (recordings: VoiceNoteRecording[]) => void = () => {};
    fakeVoiceNotes({ recordings: () => new Promise<VoiceNoteRecording[]>((resolve) => { release = resolve; }) });
    const { latest } = await mount("n1");
    await act(async () => events.emit("progress", { id: "n1", percent: 12 }));
    expect(latest().note).toEqual({ kind: "running", percent: 12 });
    await act(async () => release([recording("n1", "on-device", stt("running"))]));
    expect(latest().note).toEqual({ kind: "running", percent: 12 });
  });

  test("a failed event rescans and shows the reason", async () => {
    const events = await iosStt();
    let current = stt("running");
    fakeVoiceNotes({ recordings: () => [recording("n1", "on-device", current)] });
    const { latest } = await mount("n1");
    current = stt("failed", "out_of_memory");
    await act(async () => events.emit("failed", { id: "n1", code: "out_of_memory" }));
    expect(latest().note).toEqual({ kind: "failed", reason: "out_of_memory" });
  });

  test("the listeners are removed on unmount", async () => {
    const events = await iosStt();
    fakeVoiceNotes({ recordings: () => [] });
    await mount("n1");
    expect(events.listening("progress")).toBe(1);
    await act(async () => root!.unmount());
    root = null;
    expect(events.listening("progress")).toBe(0);
    expect(events.listening("transcribed")).toBe(0);
    expect(events.listening("failed")).toBe(0);
  });
});

describe("the native transcript outcome", () => {
  test("no_speech shows as no speech when the note is reopened before the space catches up", async () => {
    await iosStt();
    fakeVoiceNotes({ recordings: () => [recording("n1", "on-device", stt("done"))], transcript: () => transcriptOf("no_speech") });
    const { latest } = await mount("n1");
    expect(latest().note).toEqual({ kind: "no_speech" });
    const html = view(latest().note);
    expect(html).toContain("No speech was found in this note.");
    expect(html).not.toContain("No transcript.");
  });

  test("no_speech arriving on the transcribed event shows without waiting for the rescan", async () => {
    const events = await iosStt();
    fakeVoiceNotes({ recordings: () => [recording("n1", "on-device", stt("running"))], transcript: () => null });
    const { latest } = await mount("n1");
    await act(async () => events.emit("transcribed", { id: "n1", outcome: "no_speech" }));
    expect(latest().note).toEqual({ kind: "no_speech" });
  });

  test("done with speech says it is being added to the note", async () => {
    await iosStt();
    fakeVoiceNotes({ recordings: () => [recording("n1", "on-device", stt("done"))], transcript: () => transcriptOf("transcribed") });
    const { latest } = await mount("n1");
    expect(latest().note).toEqual({ kind: "done" });
    expect(view(latest().note)).toContain("It&#x27;s being added to this note.");
  });

  test("a transcript read that fails is shown, not guessed", async () => {
    await iosStt();
    const logged = spyOn(console, "error").mockImplementation(() => {});
    fakeVoiceNotes({ recordings: () => [recording("n1", "on-device", stt("done"))], transcript: () => { throw new Error("sidecar unreadable"); } });
    const { latest } = await mount("n1");
    expect(latest().error).toContain("sidecar unreadable");
    logged.mockRestore();
  });
});

describe("the state itself", () => {
  const job = (state: "queued" | "running" | "failed" | "waiting_for_model", percent: number | null = null, error: string | null = null) => ({ id: "n1", state, percent, error }) as never;
  const scan = (mode: "on-device" | "off", sttState: NoteSttState | null, outcome: "transcribed" | "no_speech" | null = null) => ({ noteId: "n1", local: mode === "on-device", stt: sttState, outcome });

  test("nothing known is null, not none", () => {
    expect(onDeviceNote(null, null, null)).toBeNull();
  });

  test("the live queue wins over the event, and the event over the sidecar", () => {
    expect(onDeviceNote(scan("on-device", stt("waiting_for_model")), null, job("running", 40))).toEqual({ kind: "running", percent: 40 });
    expect(onDeviceNote(scan("on-device", stt("failed", "old")), null, job("queued"))).toEqual({ kind: "queued" });
    expect(onDeviceNote(scan("on-device", stt("running")), { noteId: "n1", kind: "running", percent: 30 }, job("running", null))).toEqual({ kind: "running", percent: 30 });
    expect(onDeviceNote(null, null, job("failed", null, "oom"))).toEqual({ kind: "failed", reason: "oom" });
    expect(onDeviceNote(scan("on-device", stt("cancelled")), null, null)).toEqual({ kind: "failed", reason: "it was cancelled" });
  });

  test("a mode other than Local has no state of its own", () => {
    expect(onDeviceNote(scan("off", stt("waiting_for_model")), null, null)).toEqual({ kind: "none" });
  });

  test("queued, running with progress, and done each read as themselves", () => {
    expect(view({ kind: "queued" })).toContain("Queued to transcribe on this phone");
    expect(view({ kind: "running", percent: 42.4 })).toContain("Transcribing on this phone… 42%");
    expect(view({ kind: "done" })).toContain("Transcribed on this phone");
  });
});
