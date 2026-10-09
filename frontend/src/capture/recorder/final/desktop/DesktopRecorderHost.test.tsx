import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot, type Root } from "react-dom/client";
import { StaticRecorderProvider, type RecorderValue } from "../../RecorderProvider";
import { clearNotesUi, dismissUnsavedNote, readNotesUi, updateNotesUi } from "../notes";
import { DesktopRecorderHost } from "./DesktopRecorderHost";
import type { DesktopRecorderProps } from "./DesktopRecorder";
import type { NoteViewProps } from "./NoteView";

const container = () =>
  ({ nodeType: 1, nodeName: "DIV", tagName: "DIV", ownerDocument: null, textContent: "", addEventListener() {}, removeEventListener() {} }) as unknown as HTMLElement;
const saved = {
  document: (globalThis as { document?: unknown }).document,
  window: (globalThis as { window?: unknown }).window,
  act: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT,
};
let root: Root | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as { document?: unknown }).document = { documentElement: { classList: { contains: () => false } }, addEventListener() {}, removeEventListener() {} };
  (globalThis as { window?: unknown }).window = { setTimeout, clearTimeout, event: undefined, HTMLIFrameElement: class {}, addEventListener() {}, removeEventListener() {} };
});
afterAll(() => {
  (globalThis as { window?: unknown }).window = saved.window;
  (globalThis as { document?: unknown }).document = saved.document;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = saved.act;
});
beforeEach(() => {
  clearNotesUi();
  dismissUnsavedNote();
});
beforeAll(async () => {
  await warm();
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  clearNotesUi();
  dismissUnsavedNote();
});

let noteView: NoteViewProps | null;
let ring: DesktopRecorderProps | null;
const loadNoteView = () =>
  Promise.resolve({
    NoteView: (props: NoteViewProps) => {
      noteView = props;
      return null;
    },
  });
const loadDesktopRecorder = () =>
  Promise.resolve({
    DesktopRecorder: (props: DesktopRecorderProps) => {
      ring = props;
      return null;
    },
  });

const calls = { stop: 0, writes: [] as string[], minimise: 0, fail: false };
const value = (): Partial<RecorderValue> => ({
  phase: "recording",
  mic: { state: "recording", reason: null },
  recordingId: "1",
  sheetOpen: true,
  noteStatus: "ready",
  note: { md: "saved text", moments: [] },
  stop: (() => void calls.stop++) as unknown as RecorderValue["stop"],
  minimiseSheet: (async () => void calls.minimise++) as unknown as RecorderValue["minimiseSheet"],
  setNoteText: (async (md: string) => {
    calls.writes.push(md);
    if (calls.fail) throw new Error("write refused");
  }) as unknown as RecorderValue["setNoteText"],
});

// A lazy component that has resolved renders at once, so the client root (a stand-in with no DOM) never draws the Suspense fallback.
async function warm() {
  for (const open of [false, true]) {
    updateNotesUi("1", () => ({ open }));
    renderToStaticMarkup(
      <StaticRecorderProvider value={value()}>
        <DesktopRecorderHost layout="desktop" loadDesktopRecorder={loadDesktopRecorder} loadNoteView={loadNoteView} />
      </StaticRecorderProvider>,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  clearNotesUi();
}

async function mount() {
  noteView = null;
  ring = null;
  root = createRoot(container());
  await act(async () => {
    root!.render(
      <StaticRecorderProvider value={value()}>
        <DesktopRecorderHost layout="desktop" loadDesktopRecorder={loadDesktopRecorder} loadNoteView={loadNoteView} />
      </StaticRecorderProvider>,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  calls.stop = 0;
  calls.writes = [];
  calls.minimise = 0;
  calls.fail = false;
});

describe("DesktopRecorderHost", () => {
  test("shows the ring view until the notes are opened, and opening them gives the saved note", async () => {
    await mount();
    expect(ring).not.toBeNull();
    expect(noteView).toBeNull();
    await act(async () => ring!.onOpenNotes!());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(noteView?.md).toBe("saved text");
    expect(noteView?.view).toBe("write");
  });

  test("Expand saves what was typed and returns to the ring view", async () => {
    updateNotesUi("1", () => ({ open: true, view: "write" }));
    await mount();
    await act(async () => noteView!.onChange("typed"));
    await act(async () => noteView!.onExpand());
    expect(calls.writes).toEqual(["typed"]);
    expect(readNotesUi("1")?.open).toBe(false);
  });

  test("Minimise saves, closes the note view and puts the sheet away", async () => {
    updateNotesUi("1", () => ({ open: true, view: "write" }));
    await mount();
    await act(async () => noteView!.onChange("typed"));
    await act(async () => noteView!.onMinimise());
    expect(calls.writes).toEqual(["typed"]);
    expect(calls.minimise).toBe(1);
  });

  test("Done waits for the note to save, then stops", async () => {
    updateNotesUi("1", () => ({ open: true, view: "write" }));
    await mount();
    await act(async () => noteView!.onChange("typed"));
    await act(async () => noteView!.onDone());
    expect(calls.writes).toEqual(["typed"]);
    expect(calls.stop).toBe(1);
  });

  test("Done with a note that cannot be saved stops at the failure; the same Done again ends the recording", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    updateNotesUi("1", () => ({ open: true, view: "write" }));
    await mount();
    calls.fail = true;
    await act(async () => noteView!.onChange("typed"));
    await act(async () => noteView!.onDone());
    expect(calls.stop).toBe(0);
    expect(noteView?.saveFailed).toBe(true);
    await act(async () => noteView!.onDone());
    expect(calls.stop).toBe(1);
    error.mockRestore();
  });

  test("the ring view hears about a failed save and Done goes through the same gate", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    updateNotesUi("1", () => ({ draft: "typed", saveFailed: true }));
    await mount();
    expect(ring?.noteSaveFailed).toBe(true);
    calls.fail = true;
    await act(async () => ring!.onDone!(() => void calls.stop++));
    expect(calls.stop).toBe(0);
    error.mockRestore();
  });
});
