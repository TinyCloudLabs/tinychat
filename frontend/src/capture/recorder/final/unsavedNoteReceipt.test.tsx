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
import {
  ReceiptNoteNotice,
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
      value={{ phase: "idle", outcome: "saved", startedAt: null, ...patch }}
    >
      <ReceiptNoteNotice />
    </StaticRecorderProvider>,
  );
}

// A recording at 1000 whose note writes are rejected, as PhoneRecorder wires them: the real saver, notes state and Done.
function recordingWithFailingNote() {
  const key = recordingKey({ startedAt: 1000 }) as string;
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

    // The recording is over: startedAt goes null, the lifecycle clears the recording's own notes state, the receipt is up.
    clearNotesUiExcept(recordingKey({ startedAt: null }));
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
