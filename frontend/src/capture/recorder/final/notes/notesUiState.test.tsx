import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { clearNotesUi, useNotesUi, type NotesUi } from "./notesUiState";

let handle: NotesUi;
// One mount of a layout: it reads the shared state, as the phone sheet and the desktop note view both do.
function mount(key: number | null) {
  function Layout() {
    handle = useNotesUi(key);
    return (
      <p>
        {JSON.stringify({
          open: handle.open,
          view: handle.view,
          draft: handle.draft,
          noteMd: handle.noteMd,
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
    expect(state(mount(1))).toEqual({
      open: false,
      view: "preview",
      draft: null,
      noteMd: null,
    });
  });

  test("a layout switch (unmount, remount) keeps the open state, view and unsaved draft", () => {
    mount(1);
    handle.setNoteMd("- **0:08** TTL");
    handle.openNotes("write");
    handle.setDraft("- **0:08** TTL\n\nIdeas");
    expect(state(mount(1))).toEqual({
      open: true,
      view: "write",
      draft: "- **0:08** TTL\n\nIdeas",
      noteMd: "- **0:08** TTL",
    });
  });

  test("Preview survives the switch too", () => {
    mount(1);
    handle.openNotes("preview");
    handle.setDraft("# Plan");
    expect(state(mount(1))).toMatchObject({
      open: true,
      view: "preview",
      draft: "# Plan",
    });
    handle.setView("write");
    expect(state(mount(1)).view).toBe("write");
  });

  test("the autosave settles the draft unless newer text was typed since", () => {
    mount(1);
    handle.setDraft("ab");
    handle.settleDraft("a");
    expect(state(mount(1)).draft).toBe("ab");
    handle.settleDraft("ab");
    expect(state(mount(1)).draft).toBeNull();
  });

  test("closing the sheet keeps the note and the view for the next open", () => {
    mount(1);
    handle.setNoteMd("hello");
    handle.openNotes("write");
    handle.closeNotes();
    expect(state(mount(1))).toMatchObject({
      open: false,
      view: "write",
      noteMd: "hello",
    });
  });

  test("another recording never sees it, and clearing forgets everything", () => {
    mount(1);
    handle.setNoteMd("hello");
    handle.openNotes("write");
    expect(state(mount(2))).toEqual({
      open: false,
      view: "preview",
      draft: null,
      noteMd: null,
    });
    clearNotesUi();
    expect(state(mount(1)).noteMd).toBeNull();
  });

  test("with no recording in progress there is nothing to write to", () => {
    mount(null);
    handle.openNotes("write");
    handle.setDraft("late");
    expect(state(mount(null)).open).toBe(false);
    expect(state(mount(1)).draft).toBeNull();
  });
});
