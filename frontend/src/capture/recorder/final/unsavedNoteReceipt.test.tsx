import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { StaticRecorderProvider } from "../RecorderProvider";
import { finishRecording, type DoneGate } from "./doneGate";
import { createNoteSaver } from "./noteSaver";
import {
  clearNotesUi,
  clearNotesUiExcept,
  dismissUnsavedNote,
  readNotesUi,
  readUnsavedNote,
  updateNotesUi,
} from "./notes/notesUiState";
import { recordingKey } from "./notes/recordingKey";
import type { ReactElement } from "react";
import {
  ReceiptNoteNotice,
  ShellNoteNotice,
  UnsavedNoteNotice,
  UnsavedNoteNoticeView,
} from "./UnsavedNoteNotice";

const LOST = "Recording saved, but the note couldn&#x27;t be saved.";

beforeEach(() => {
  clearNotesUi();
  dismissUnsavedNote();
});
afterEach(() => {
  clearNotesUi();
  dismissUnsavedNote();
});

function receipt(patch: Record<string, unknown> = {}) {
  return renderToStaticMarkup(
    <StaticRecorderProvider
      value={{ phase: "idle", outcome: "saved", recordingId: null, ...patch }}
    >
      <ReceiptNoteNotice />
    </StaticRecorderProvider>,
  );
}

// A recording at 1000 whose note writes are rejected, as PhoneRecorder wires them: the real saver, notes state and Done.
function recordingWithFailingNote() {
  const key = recordingKey({ recordingId: "rec-1000" }) as string;
  updateNotesUi(key, () => ({ draft: "- **0:08** TTL idea" }));
  const saver = createNoteSaver({
    commit: async () => {
      throw new Error("write rejected");
    },
    delayMs: 500,
    unsaved: "- **0:08** TTL idea",
    status: "ready",
    onPending: () => {},
    onError: () => {},
  });
  const gate: DoneGate = { acknowledged: null };
  const stops: string[] = [];
  const done = () =>
    finishRecording(gate, key, {
      flush: saver.flush,
      stop: () => void stops.push("stop"),
    });
  return { key, done, stops };
}

describe("a recording that ends with its note unsaved", () => {
  test("two rejected flushes end the recording, and the receipt that follows says the note was lost", async () => {
    const log = spyOn(console, "error").mockImplementation(() => {});
    const { key, done, stops } = recordingWithFailingNote();

    expect(await done()).toBe("blocked");
    expect(stops).toEqual([]);
    expect(await done()).toBe("stopped");
    expect(stops).toEqual(["stop"]);
    expect(readUnsavedNote()).toEqual({ key, md: "- **0:08** TTL idea" });

    // The recording is over: recordingId goes null, the lifecycle clears the recording's own notes state, the receipt is up.
    clearNotesUiExcept(recordingKey({ recordingId: null }));
    expect(readNotesUi(key)).toBeNull();

    const html = receipt();
    expect(html).toContain('role="alert"');
    expect(html).toContain(LOST);
    expect(html).toContain("Copy note");
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  test("the notice stays until it is dismissed, and a new recording drops it", async () => {
    const log = spyOn(console, "error").mockImplementation(() => {});
    const { done } = recordingWithFailingNote();
    await done();
    await done();
    clearNotesUiExcept(null);
    expect(receipt()).toContain(LOST);

    clearNotesUiExcept("2000");
    expect(readUnsavedNote()).toBeNull();
    expect(receipt()).toBe("");
    log.mockRestore();
  });

  test("Done that saves leaves nothing to report", async () => {
    const key = "1000";
    updateNotesUi(key, () => ({ draft: "ok" }));
    const gate: DoneGate = { acknowledged: null };
    await finishRecording(gate, key, { flush: async () => {}, stop: () => {} });
    expect(receipt()).toBe("");
  });

  test("only a receipt shows it, not a recording in progress", async () => {
    const log = spyOn(console, "error").mockImplementation(() => {});
    const { done } = recordingWithFailingNote();
    await done();
    await done();
    expect(receipt({ phase: "recording" })).toBe("");
    expect(receipt({ outcome: null })).toBe("");
    log.mockRestore();
  });

  test("a failed copy is shown, and a note with no text offers nothing to copy", () => {
    const failed = renderToStaticMarkup(
      <UnsavedNoteNoticeView
        hasText
        copy="failed"
        onCopy={() => {}}
        onDismiss={() => {}}
      />,
    );
    expect(failed).toContain("Couldn&#x27;t copy the note. Try again.");
    const empty = renderToStaticMarkup(
      <UnsavedNoteNoticeView
        hasText={false}
        copy="idle"
        onCopy={() => {}}
        onDismiss={() => {}}
      />,
    );
    expect(empty).not.toContain("Copy note");
    expect(empty).toContain("Dismiss");
  });
});

function shell(layout: "tabbar" | "beside", patch: Record<string, unknown> = {}) {
  return renderToStaticMarkup(
    <StaticRecorderProvider
      value={{ phase: "idle", outcome: null, sheetOpen: false, recordingId: null, ...patch }}
    >
      <ShellNoteNotice layout={layout} />
    </StaticRecorderProvider>,
  );
}

// Renders UnsavedNoteNotice once, inside a provider, and hands back the element it produced so its props can be pressed.
function pressableNotice(): ReactElement<{ onDismiss: () => void; onCopy: () => void }> {
  let element: ReactElement<{ onDismiss: () => void; onCopy: () => void }> | null = null;
  function Probe() {
    element = UnsavedNoteNotice({}) as typeof element;
    return null;
  }
  renderToStaticMarkup(
    <StaticRecorderProvider>
      <Probe />
    </StaticRecorderProvider>,
  );
  if (element === null) throw new Error("no notice rendered");
  return element;
}

describe("the notice after the receipt closes", () => {
  async function retainNote() {
    const log = spyOn(console, "error").mockImplementation(() => {});
    const { done } = recordingWithFailingNote();
    await done();
    await done();
    clearNotesUiExcept(null);
    log.mockRestore();
  }

  test("the shell carries it once the receipt is gone, on a phone and beside the rail, until Dismiss clears it", async () => {
    await retainNote();
    for (const layout of ["tabbar", "beside"] as const) {
      // The open receipt shows it itself, so the shell doesn't draw a second.
      expect(shell(layout, { outcome: "saved", sheetOpen: true })).toBe("");
      // Closed to the island, and then dismissed by the provider's timer: the notice is still there.
      expect(shell(layout, { outcome: "saved", sheetOpen: false })).toContain(LOST);
      const closed = shell(layout);
      expect(closed).toContain(LOST);
      expect(closed).toContain("Copy note");
      expect(closed).toContain("Dismiss");
      expect(closed).toContain('data-testid="shell-note-notice"');
    }
    pressableNotice().props.onDismiss();
    expect(readUnsavedNote()).toBeNull();
    expect(shell("tabbar")).toBe("");
    expect(shell("beside")).toBe("");
  });

  test("there is no banner without a retained note", () => {
    expect(shell("tabbar")).toBe("");
    expect(shell("beside")).toBe("");
  });
});
