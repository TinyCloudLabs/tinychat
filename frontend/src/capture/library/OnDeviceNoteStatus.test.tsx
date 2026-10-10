// A saved voice note with no transcript says where its on-device transcription stands
// (the native sidecar's `stt`, plus the live queue) instead of "No transcript.".
// There is no DOM in this workspace: the hook is mounted on a stub container, the view is rendered to markup.
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import { createFakeOnDeviceStt } from "@/lib/voiceNotes/fakeOnDeviceStt";
import { __setOnDeviceSttForTests } from "@/lib/voiceNotes/onDeviceStt";
import { __setVoiceNotesForTests, type NoteSttState, type VoiceNoteRecording, type VoiceNotesPlugin } from "@/lib/voiceNotes/nativeVoiceNotes";
import { onDeviceNote, OnDeviceNoteStatusView, useOnDeviceNote, type OnDeviceNote } from "./OnDeviceNoteStatus";

const saved = { window: (globalThis as { window?: unknown }).window, act: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT };
beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as { window?: unknown }).window = { setTimeout, clearTimeout, event: undefined, HTMLIFrameElement: class {} };
});
afterAll(() => {
  (globalThis as { window?: unknown }).window = saved.window;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = saved.act;
});

const stt = (state: NoteSttState["state"], error: string | null = null): NoteSttState => ({
  state, pack: "full", engine: null, segmentsDone: 0, windowsDone: 0, error,
});

function fakeVoiceNotes(id: string, current: NoteSttState | null | Error) {
  const plugin = {
    listPending: async () => {
      if (current instanceof Error) throw current;
      return {
        recordings: current
          ? [{ id, startedAt: 0, durationMs: 1000, mimeType: "audio/mp4", sizeBytes: 4, silencedMs: 0, silencedEvents: 0, noSignalMs: 0, stt: current } satisfies VoiceNoteRecording]
          : [],
      };
    },
  } as unknown as VoiceNotesPlugin;
  __setVoiceNotesForTests(plugin, { available: true });
}

const container = { nodeType: 1, nodeName: "DIV", tagName: "DIV", ownerDocument: null, textContent: "", addEventListener() {}, removeEventListener() {} } as unknown as HTMLElement;
let root: Root | null = null;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
});

async function read(noteId: string) {
  __setOnDeviceSttForTests(createFakeOnDeviceStt().plugin);
  const seen: ReturnType<typeof useOnDeviceNote>[] = [];
  function Probe() {
    seen.push(useOnDeviceNote(noteId));
    return null;
  }
  root = createRoot(container);
  await act(async () => root!.render(<Probe />));
  await act(async () => {});
  return seen.at(-1)!;
}

const view = (note: OnDeviceNote | null, error: string | null = null) =>
  renderToStaticMarkup(
    <OnDeviceNoteStatusView noteId="n1" view={{ note, error, reload: () => {} }} fallback={<p>No transcript.</p>} />,
  );

describe("a saved note's on-device state", () => {
  test("a note waiting for the model reads as waiting, not as having no transcript", async () => {
    fakeVoiceNotes("n1", stt("waiting_for_model"));
    const { note, error } = await read("n1");
    expect(error).toBeNull();
    expect(note).toEqual({ kind: "waiting_for_model" });
    const html = view(note);
    expect(html).toContain("Waiting for the on-device model");
    expect(html).toContain('data-testid="voice-note-model-download"');
    expect(html).not.toContain("No transcript.");
  });

  test("a failed note names why and offers Retry", async () => {
    fakeVoiceNotes("n1", stt("failed", "decoder_error"));
    const { note } = await read("n1");
    expect(note).toEqual({ kind: "failed", reason: "decoder_error" });
    const html = view(note);
    expect(html).toContain("Couldn&#x27;t transcribe on this phone: decoder_error");
    expect(html).toContain('data-testid="voice-note-on-device-retry"');
  });

  test("a note the phone has no on-device state for keeps what the page showed before", async () => {
    fakeVoiceNotes("n1", null);
    const { note } = await read("n1");
    expect(note).toEqual({ kind: "none" });
    expect(view(note)).toBe("<p>No transcript.</p>");
  });

  test("a note whose state is still being read keeps the page's own line", () => {
    expect(view(null)).toBe("<p>No transcript.</p>");
  });

  test("a failed read is shown and logged, with Try again", async () => {
    const logged = spyOn(console, "error").mockImplementation(() => {});
    fakeVoiceNotes("n1", new Error("scan failed"));
    const { note, error } = await read("n1");
    expect(note).toBeNull();
    expect(error).toBe("Couldn't check this note's on-device transcription: scan failed");
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
    const html = view(note, error);
    expect(html).toContain("scan failed");
    expect(html).toContain("Try again");
    expect(html).not.toContain("No transcript.");
  });

  test("the live queue wins over the sidecar's last write", () => {
    expect(onDeviceNote(stt("waiting_for_model"), { id: "n1", state: "running", percent: 40, error: null })).toEqual({ kind: "running", percent: 40 });
    expect(onDeviceNote(stt("failed", "old"), { id: "n1", state: "queued", percent: null, error: null })).toEqual({ kind: "queued" });
    expect(onDeviceNote(null, { id: "n1", state: "failed", percent: null, error: "oom" })).toEqual({ kind: "failed", reason: "oom" });
    expect(onDeviceNote(null, null)).toEqual({ kind: "none" });
    expect(onDeviceNote(stt("cancelled"), null)).toEqual({ kind: "failed", reason: "it was cancelled" });
  });

  test("queued, running with progress, and done each read as themselves", () => {
    expect(view({ kind: "queued" })).toContain("Queued to transcribe on this phone");
    expect(view({ kind: "running", percent: 42.4 })).toContain("Transcribing on this phone… 42%");
    expect(view({ kind: "done" })).toContain("Transcribed on this phone");
  });
});
