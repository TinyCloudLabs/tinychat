import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SavedNotePage } from "./SavedNoteView";
import { editedLabel } from "./savedNoteMeta";
import type { SavedNoteViewProps } from "./SavedNoteView";
import type { SavedNoteScreen } from "./useSavedNoteScreen";

const noop = () => {};

function screenOf(over: {
  md?: string;
  load?: SavedNoteScreen["note"]["load"];
  editing?: boolean;
  draft?: string | null;
  confirming?: "cancel" | "close" | null;
  saveError?: string | null;
  saving?: boolean;
  sync?: SavedNoteScreen["note"]["sync"];
  copyState?: SavedNoteScreen["copyState"];
}): SavedNoteScreen {
  const md = over.md ?? "";
  return {
    note: {
      load: over.load ?? { status: "ready", record: { md, savedEditAt: "2026-10-09T10:00:00Z" } },
      retryLoad: noop,
      saving: over.saving ?? false,
      saveError: over.saveError ?? null,
      sync: over.sync ?? "idle",
      save: async () => true,
    },
    draft: {
      draft: over.draft ?? (over.editing ? md : null),
      confirming: over.confirming ?? null,
      edit: noop,
      type: noop,
      cancel: noop,
      close: () => true,
      keep: noop,
      discard: () => false,
      finish: noop,
    },
    savedMd: md,
    editing: over.editing ?? false,
    dirty: false,
    seek: null,
    playFrom: noop,
    copyState: over.copyState ?? "idle",
    copy: async () => {},
    save: async () => {},
    startEdit: noop,
    cancel: noop,
    requestClose: () => true,
  };
}

const props = (screen: SavedNoteScreen, over: Partial<SavedNoteViewProps> = {}): SavedNoteViewProps => ({
  screen,
  layout: "page",
  theme: "night",
  id: "rec-1",
  title: "Standup",
  meta: "1 min · saved to your space",
  loadAudio: null,
  transcript: <p>the transcript</p>,
  partialAudio: false,
  onBack: noop,
  ...over,
});

const html = (screen: SavedNoteScreen, over?: Partial<SavedNoteViewProps>) =>
  renderToStaticMarkup(<SavedNotePage {...props(screen, over)} />);

describe("SavedNotePage", () => {
  test("reading: title, meta, ← Capture, Copy and Edit, the transcript", () => {
    const out = html(screenOf({ md: "- **0:08** TTL" }));
    expect(out).toContain("Standup");
    expect(out).toContain("1 min · saved to your space");
    expect(out).toContain("Back to Capture");
    expect(out).toContain(">Copy<");
    expect(out).toContain(">Edit<");
    expect(out).toContain("the transcript");
    expect(out).not.toContain(">Save<");
  });

  test("an empty note offers Add a note, not Edit, Copy or the Edited line", () => {
    for (const layout of ["page", "sheet"] as const) {
      const out = html(screenOf({ md: "" }), { layout });
      expect(out).toContain(">Add a note<");
      expect(out).not.toContain(">Edit<");
      expect(out).not.toContain(">Copy<");
      expect(out).not.toContain("Edited");
    }
  });

  test("a note never edited after saving shows no Edited line, on the page or the sheet", () => {
    for (const layout of ["page", "sheet"] as const) {
      const out = html(
        screenOf({ md: "typed while recording", load: { status: "ready", record: { md: "typed while recording", savedEditAt: null } } }),
        { layout },
      );
      expect(out).toContain(">Edit<");
      expect(out).not.toContain("Edited");
      expect(out).not.toContain('data-testid="saved-note-edited"');
    }
  });

  test("a note edited after saving shows when, from the record, on the page and the sheet", () => {
    for (const layout of ["page", "sheet"] as const) {
      expect(html(screenOf({ md: "hi" }), { layout })).toContain(`Edited ${editedLabel("2026-10-09T10:00:00Z")}`);
    }
  });

  test("a note with text shows when it was last edited, from the record", () => {
    const out = html(screenOf({ md: "hi" }));
    expect(out).toContain('data-testid="saved-note-edited"');
    expect(out).toContain(`Edited ${editedLabel("2026-10-09T10:00:00Z")}`);
    expect(html(screenOf({ md: "hi", editing: true }))).not.toContain("Edited");
  });

  test("editing: Cancel and Save replace Copy and Edit, and the shortcuts are listed", () => {
    const out = html(screenOf({ md: "hi", editing: true }));
    expect(out).toContain(">Cancel<");
    expect(out).toContain(">Save<");
    expect(out).not.toContain(">Edit<");
    expect(out).not.toContain(">Copy<");
    expect(out).toContain("⌘S saves · esc cancels");
    expect(out).toContain('data-editing="true"');
  });

  test("saving disables Save and says so", () => {
    const out = html(screenOf({ md: "hi", editing: true, saving: true }));
    expect(out).toContain("Saving…");
    expect(out).toContain('aria-disabled="true"');
  });

  test("a failed save is an alert that says the text is kept", () => {
    const out = html(screenOf({ md: "hi", editing: true, draft: "typed", saveError: "disk full" }));
    expect(out).toContain('role="alert"');
    expect(out).toContain("What you typed is kept. disk full");
  });

  test("a note saved here but not in the space yet says so", () => {
    expect(html(screenOf({ md: "hi", sync: "failed" }))).toContain("Note not synced yet");
  });

  test("loading and a failed read keep the rest of the page", () => {
    expect(html(screenOf({ load: { status: "loading" } }))).toContain("Loading note…");
    const failed = html(screenOf({ load: { status: "failed", message: "gone" } }));
    expect(failed).toContain("The note could not be loaded.");
    expect(failed).toContain("Try again");
    expect(failed).toContain("the transcript");
  });

  test("a recording that only partly saved says so", () => {
    expect(html(screenOf({ md: "hi" }), { partialAudio: true })).toContain('data-testid="saved-note-partial"');
  });

  test("the player is there only when the recording has audio", () => {
    expect(html(screenOf({ md: "hi" }))).not.toContain("Play");
    expect(html(screenOf({ md: "hi" }), { loadAudio: async () => ({ blob: new Blob() }) as never })).toContain('class="sn-player"');
  });

  test("a discard confirmation makes the page behind it inert", () => {
    const out = html(screenOf({ md: "hi", editing: true, draft: "x", confirming: "cancel" }));
    expect(out).toContain("Discard your changes?");
    expect(out).toContain("Keep editing");
    expect(out).toContain("Discard changes");
  });
});
