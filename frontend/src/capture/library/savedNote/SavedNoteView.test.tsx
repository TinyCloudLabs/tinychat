import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement, ReactNode } from "react";
import { Children, isValidElement } from "react";
import { MeetingAudioPlayer } from "@/chat/MeetingAudioPlayer";
import { SavedNoteBody, SavedNotePage } from "./SavedNoteView";
import { editedLabel } from "./savedNoteMeta";
import { PipelineStepper } from "@/capture/pipeline/PipelineStepper";
import { allDone, signedOut, uploading, waitingForModel } from "@/capture/pipeline/pipelineFixtures";
import type { NotePipeline } from "@/lib/voiceNotes/notePipeline";
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
  recordingId: "rec-1",
  title: "Standup",
  meta: "1 min · saved to your space",
  stepper: null,
  audio: null,
  durationSecs: 42,
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
    expect(html(screenOf({ md: "hi" }), { audio: { load: async () => ({ blob: new Blob() }) as never } })).toContain('class="sn-player"');
  });

  test("a discard confirmation makes the page behind it inert", () => {
    const out = html(screenOf({ md: "hi", editing: true, draft: "x", confirming: "cancel" }));
    expect(out).toContain("Discard your changes?");
    expect(out).toContain("Keep editing");
    expect(out).toContain("Discard changes");
  });
});

describe("SavedNoteBody's player", () => {
  const playerIn = (node: ReactNode): ReactElement | null => {
    if (!isValidElement(node)) return null;
    if (node.type === MeetingAudioPlayer) return node;
    for (const child of Children.toArray((node.props as { children?: ReactNode }).children)) {
      const found = playerIn(child);
      if (found) return found;
    }
    return null;
  };
  const load = async () => new Blob();
  const player = (over: Partial<SavedNoteViewProps>) => {
    const view = props(screenOf({ md: "hi" }), { audio: { load }, ...over });
    const refs = { editButton: { current: null }, cancelButton: { current: null } };
    return playerIn(SavedNoteBody({ ...view, ...refs, toolbarHost: undefined }));
  };

  test("is the same player when a note that was only on the phone becomes the space's row, so a load or playback in flight carries on", () => {
    const standIn = player({ id: "on-phone:rec-9", recordingId: "rec-9" });
    const row = player({ id: "9", recordingId: "rec-9" });
    expect(standIn?.key).not.toBeNull();
    expect(row?.key).toBe(standIn?.key ?? "");
  });

  test("a note still on the phone gives the player its load, flagged as on the phone, and its moments seek", () => {
    const load = async () => "capacitor://localhost/_capacitor_file_/rec-1.m4a";
    const seek = { seconds: 12, nonce: 1 };
    const view = props({ ...screenOf({ md: "hi" }), seek }, { audio: { load, onPhone: true } });
    const refs = { editButton: { current: null }, cancelButton: { current: null } };
    const found = playerIn(SavedNoteBody({ ...view, ...refs, toolbarHost: undefined }));
    expect(found?.props).toMatchObject({ load, seek });
    expect((found?.props as { resolveUrl?: unknown }).resolveUrl).toBeUndefined();
  });

  test("is a new player for another recording", () => {
    expect(player({ id: "1", recordingId: "rec-1" })?.key).not.toBe(player({ id: "2", recordingId: "rec-2" })?.key);
  });
});

describe("the pipeline under the meta line", () => {
  const stepper = (pipeline: NotePipeline) => (pipeline.done ? null : <PipelineStepper pipeline={pipeline} onAction={noop} />);
  const cases: [string, NotePipeline, string][] = [
    ["uploading", uploading(40), "Uploading"],
    ["signed out", signedOut(), "Sign in"],
    ["waiting for the model", waitingForModel(), "Get model"],
  ];

  for (const [name, pipeline, text] of cases) {
    test(`${name}: the stepper shows on the page and the sheet, after the meta`, () => {
      for (const layout of ["page", "sheet"] as const) {
        const out = html(screenOf({ md: "hi" }), { layout, meta: "1 min", stepper: stepper(pipeline) });
        expect(out).toContain('aria-label="Where this note is"');
        expect(out).toContain(text);
        expect(out.indexOf("1 min")).toBeLessThan(out.indexOf('aria-label="Where this note is"'));
      }
    });
  }

  test("done: no stepper, and the meta says it is saved", () => {
    for (const layout of ["page", "sheet"] as const) {
      const out = html(screenOf({ md: "hi" }), { layout, stepper: stepper(allDone()) });
      expect(out).not.toContain("Where this note is");
      expect(out).toContain("1 min · saved to your space");
    }
  });
});
