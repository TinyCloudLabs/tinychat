import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  clearNotesUi,
  clearNotesUiExcept,
  patchNotesUi,
  readNotesUi,
  updateNotesUi,
  useNotesUi,
  type NotesUi,
} from "./notesUiState";
import { recordingKey } from "./recordingKey";

let handle: NotesUi;
// One mount of a layout: it reads the shared state, as the phone sheet and the desktop note view both do.
function mount(key: string | null) {
  function Layout() {
    handle = useNotesUi(key);
    return (
      <p>
        {JSON.stringify({
          open: handle.open,
          view: handle.view,
          draft: handle.draft,
          saveFailed: handle.saveFailed,
        })}
      </p>
    );
  }
  return renderToStaticMarkup(<Layout />);
}
const state = (html: string) =>
  JSON.parse(html.replace(/<\/?p>/g, "").replaceAll("&quot;", '"'));

beforeEach(clearNotesUi);
afterEach(clearNotesUi);

describe("notesUiState", () => {
  test("a recording starts with the sheet closed, in Preview, with no draft", () => {
    expect(state(mount("1"))).toEqual({
      open: false,
      view: "preview",
      draft: null,
      saveFailed: false,
    });
  });

  test("a layout switch (unmount, remount) keeps the open state, view and unsaved draft", () => {
    mount("1");
    handle.openNotes("write");
    handle.setDraft("- **0:08** TTL\n\nIdeas");
    expect(state(mount("1"))).toEqual({
      open: true,
      view: "write",
      draft: "- **0:08** TTL\n\nIdeas",
      saveFailed: false,
    });
  });

  test("Preview survives the switch too", () => {
    mount("1");
    handle.openNotes("preview");
    handle.setDraft("# Plan");
    expect(state(mount("1"))).toMatchObject({
      open: true,
      view: "preview",
      draft: "# Plan",
    });
    handle.setView("write");
    expect(state(mount("1")).view).toBe("write");
  });

  test("a failed save outlives the sheet closing", () => {
    mount("1");
    handle.openNotes("write");
    handle.setDraft("typed");
    updateNotesUi("1", () => ({ saveFailed: true }));
    handle.closeNotes();
    expect(state(mount("1"))).toMatchObject({
      open: false,
      draft: "typed",
      saveFailed: true,
    });
  });

  test("closing the sheet keeps the view for the next open", () => {
    mount("1");
    handle.openNotes("write");
    handle.closeNotes();
    expect(state(mount("1"))).toMatchObject({ open: false, view: "write" });
  });

  test("another recording never sees it, and clearing forgets everything", () => {
    mount("1");
    handle.openNotes("write");
    expect(state(mount("2"))).toEqual({
      open: false,
      view: "preview",
      draft: null,
      saveFailed: false,
    });
    clearNotesUi();
    expect(state(mount("1")).open).toBe(false);
  });

  test("with no recording in progress there is nothing to write to", () => {
    mount(null);
    handle.openNotes("write");
    handle.setDraft("late");
    expect(state(mount(null)).open).toBe(false);
    expect(state(mount("1")).draft).toBeNull();
  });

  test("a late save result does not bring back state that was cleared", () => {
    updateNotesUi("1", () => ({ draft: "x" }));
    clearNotesUi();
    patchNotesUi("1", () => ({ saveFailed: true }));
    expect(readNotesUi("1")).toBeNull();
    updateNotesUi("1", () => ({ draft: "x" }));
    patchNotesUi("1", () => ({ saveFailed: true }));
    expect(readNotesUi("1")).toMatchObject({ draft: "x", saveFailed: true });
  });

  test("a new recording clears the old one's state; the same recording keeps it", () => {
    updateNotesUi("1", () => ({ draft: "x" }));
    clearNotesUiExcept("1");
    expect(readNotesUi("1")?.draft).toBe("x");
    clearNotesUiExcept("2");
    expect(readNotesUi("1")).toBeNull();
    updateNotesUi("1", () => ({ draft: "y" }));
    clearNotesUiExcept(null);
    expect(readNotesUi("1")).toBeNull();
  });
});

describe("recordingKey", () => {
  test("is the start of the recording, and null when none is in progress", () => {
    expect(recordingKey({ startedAt: 1_700_000_000_123 })).toBe(
      "1700000000123",
    );
    expect(recordingKey({ startedAt: null })).toBeNull();
  });
});
