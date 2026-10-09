import "../../recorder/final/soft.css";
import "../../recorder/final/phone.css";
import "../../recorder/final/desktop/desktop.css";
import "./savedNote.css";
import * as Dialog from "@radix-ui/react-dialog";
import {
  useEffect,
  useId,
  useRef,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { MeetingAudioPlayer } from "@/chat/MeetingAudioPlayer";
import { DESKTOP_HOME_COPY } from "../../home/desktop/desktopCopy";
import { ConfirmDialog } from "../../recorder/final/desktop/ConfirmDialog";
import { NoteRenderer, NoteWriter } from "../../recorder/final/notes";
import { SheetDialog } from "../../recorder/final/SheetDialog";
import type { AudioLoad } from "../NoteDetailView";
import { SAVED_NOTE_COPY as COPY } from "./savedNoteCopy";
import { editedLabel } from "./savedNoteMeta";
import type { SavedNoteScreen } from "./useSavedNoteScreen";

export type SavedNoteLayout = "page" | "sheet";

export interface SavedNoteViewProps {
  screen: SavedNoteScreen;
  layout: SavedNoteLayout;
  theme: "night" | "day";
  id: string;
  title: string;
  meta: string;
  /** Reads the recording's audio; null when it has none stored. */
  loadAudio: AudioLoad | null;
  /** The transcript section (the Library's own). */
  transcript: ReactNode;
  /** Below the transcript. */
  footer?: ReactNode;
  /** Part of the recording could not be written. */
  partialAudio: boolean;
  /** The page's ← Capture, and what the sheet does once it may close. */
  onBack: () => void;
}

function Notes({
  screen,
  layout,
  loadAudio,
  editButton,
  cancelButton,
}: Pick<SavedNoteViewProps, "screen" | "layout" | "loadAudio"> & {
  editButton: React.RefObject<HTMLButtonElement | null>;
  cancelButton: React.RefObject<HTMLButtonElement | null>;
}) {
  const { note, draft, savedMd, editing, copyState } = screen;
  const ids = useId();
  const wasEditing = useRef(false);
  // Leaving Edit (Save, Cancel, Discard) unmounts the button that had focus.
  useEffect(() => {
    if (wasEditing.current && !editing) editButton.current?.focus();
    wasEditing.current = editing;
  }, [editing, editButton]);

  const ready = note.load.status === "ready";
  const editedWhen =
    note.load.status === "ready" && note.load.record?.savedEditAt && savedMd.trim() !== ""
      ? editedLabel(note.load.record.savedEditAt)
      : null;
  const onKeys = (event: KeyboardEvent) => {
    const save =
      ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") ||
      (event.ctrlKey && event.key === "Enter");
    if (save) {
      event.preventDefault();
      event.stopPropagation();
      void screen.save();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      screen.cancel();
    }
  };

  return (
    <section
      className="sn-sec"
      aria-labelledby={`${ids}-notes`}
      data-testid="saved-note-notes"
      data-editing={editing}
    >
      <div className="sn-sechead">
        <h2 id={`${ids}-notes`} className="sn-label">
          {COPY.notes}
          {editing && <span className="sn-editing"> {COPY.editing}</span>}
        </h2>
        {ready && editing && (
          <>
            <button
              ref={cancelButton}
              type="button"
              className="sn-pill"
              onClick={screen.cancel}
            >
              {COPY.cancel}
            </button>
            <button
              type="button"
              className="sn-pill sn-primary"
              aria-disabled={note.saving || undefined}
              onClick={() => !note.saving && void screen.save()}
            >
              {note.saving ? COPY.saving : COPY.save}
            </button>
          </>
        )}
        {ready && !editing && (
          <>
            {savedMd.trim() !== "" && (
              <button
                type="button"
                className="sn-pill"
                onClick={() => void screen.copy()}
              >
                {copyState === "copied" ? COPY.copied : COPY.copy}
              </button>
            )}
            {savedMd.trim() !== "" && (
              <button
                ref={editButton}
                type="button"
                className="sn-pill"
                onClick={screen.startEdit}
              >
                {COPY.edit}
              </button>
            )}
          </>
        )}
      </div>
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {copyState === "copied" ? "Note copied" : ""}
      </span>
      {copyState === "failed" && (
        <p className="sn-alert" role="alert">
          {COPY.copyFailed}
        </p>
      )}
      {note.saveError !== null && (
        <p className="sn-alert" role="alert" data-testid="saved-note-save-error">
          {COPY.saveFailed(note.saveError)}
        </p>
      )}
      {note.sync === "failed" && (
        <p className="sn-hint" role="status" data-testid="saved-note-not-synced">
          {COPY.notSynced}
        </p>
      )}
      {note.load.status === "loading" && (
        <p className="sn-hint" role="status">
          {COPY.loading}
        </p>
      )}
      {note.load.status === "failed" && (
        <p className="sn-alert" role="alert">
          {COPY.loadFailed} {note.load.message}
          <button type="button" className="nt-retry" onClick={note.retryLoad}>
            Try again
          </button>
        </p>
      )}
      {ready &&
        (editing ? (
          <div className="sn-edit" onKeyDownCapture={onKeys}>
            <NoteWriter
              initialValue={draft.draft ?? ""}
              onChange={draft.type}
              autoFocus
              disabled={note.saving}
              label={COPY.noteField}
            />
            {layout === "page" && <p className="sn-hint">{COPY.shortcuts}</p>}
          </div>
        ) : savedMd.trim() === "" ? (
          <button
            ref={editButton}
            type="button"
            className="sn-pill sn-add"
            data-testid="saved-note-add"
            onClick={screen.startEdit}
          >
            {COPY.addNote}
          </button>
        ) : (
          <div className="sn-read" data-testid="saved-note-rendered">
            <NoteRenderer
              md={savedMd}
              label={COPY.notes}
              onMoment={loadAudio ? screen.playFrom : undefined}
            />
          </div>
        ))}
      {ready && !editing && editedWhen !== null && (
        <p className="sn-foot" data-testid="saved-note-edited">
          {COPY.edited(editedWhen)}
        </p>
      )}
    </section>
  );
}

interface Refs {
  editButton: React.RefObject<HTMLButtonElement | null>;
  cancelButton: React.RefObject<HTMLButtonElement | null>;
}

const useRefs = (): Refs => ({
  editButton: useRef<HTMLButtonElement>(null),
  cancelButton: useRef<HTMLButtonElement>(null),
});

function Body(props: SavedNoteViewProps & Refs) {
  const { editButton, cancelButton } = props;
  const { screen, layout, loadAudio, id } = props;
  const notes = (
    <Notes
      screen={screen}
      layout={layout}
      loadAudio={loadAudio}
      editButton={editButton}
      cancelButton={cancelButton}
    />
  );
  const transcript = (
    <div className="sn-transcript" data-testid="saved-note-transcript">
      {props.transcript}
    </div>
  );
  return (
    <>
      {props.partialAudio && (
        <p className="sn-hint" role="status" data-testid="saved-note-partial">
          {DESKTOP_HOME_COPY.partialAudio}
        </p>
      )}
      {loadAudio && (
        <div className="sn-player">
          <MeetingAudioPlayer key={id} load={loadAudio} seek={screen.seek} />
        </div>
      )}
      {layout === "page" ? (
        <>
          {notes}
          {transcript}
        </>
      ) : (
        <>
          {transcript}
          {notes}
        </>
      )}
      {props.footer}
    </>
  );
}

function Confirm({
  screen,
  layout,
  onBack,
  cancelButton,
  editButton,
}: SavedNoteViewProps & {
  cancelButton: React.RefObject<HTMLElement | null>;
  editButton: React.RefObject<HTMLElement | null>;
}) {
  const ids = useId();
  if (screen.draft.confirming === null) return null;
  const keep = screen.draft.keep;
  const discard = () => {
    if (screen.draft.discard()) onBack();
  };
  if (layout === "page")
    return (
      <ConfirmDialog
        titleId={`${ids}-t`}
        descriptionId={`${ids}-d`}
        title={COPY.discardTitle}
        description={COPY.discardBody}
        keep={{ label: COPY.keepEditing, onPress: keep }}
        other={{ label: COPY.discardChanges, tone: "danger", onPress: discard }}
        returnFocus={cancelButton}
        fallbackFocus={editButton}
      />
    );
  return (
    <SheetDialog
      role="alertdialog"
      titleId={`${ids}-t`}
      descriptionId={`${ids}-d`}
      title={COPY.discardTitle}
      description={COPY.discardBody}
      onCancel={keep}
      returnFocus={cancelButton}
      fallbackFocus={editButton}
    >
      <button type="button" className="pr-keep" data-initial="" onClick={keep}>
        {COPY.keepEditing}
      </button>
      <button type="button" className="pr-discard" onClick={discard}>
        {COPY.discardChanges}
      </button>
    </SheetDialog>
  );
}

/** The saved note on a wide screen: its own page, with ← Capture. */
export function SavedNotePage(props: SavedNoteViewProps) {
  const refs = useRefs();
  return (
    <div
      className={`soft-skin soft-${props.theme} sn-page`}
      data-layout="desktop"
      data-testid="saved-note-page"
      data-note-id={props.id}
    >
      <div className="sn-col" inert={props.screen.draft.confirming !== null}>
        <button
          type="button"
          className="sn-back"
          aria-label={COPY.backLabel}
          onClick={props.onBack}
        >
          <span aria-hidden="true">←</span> {COPY.back}
        </button>
        <h1 className="soft-title sn-title">{props.title}</h1>
        <p className="sn-meta">{props.meta}</p>
        <Body {...props} {...refs} />
      </div>
      <Confirm {...props} {...refs} />
    </div>
  );
}

/** The saved note on a phone: a sheet over the Library; ✕, Escape and the veil close it, asking first if there are changes. */
export function SavedNoteSheet(props: SavedNoteViewProps) {
  const refs = useRefs();
  const { screen, onBack } = props;
  const close = () => {
    if (screen.requestClose()) onBack();
  };
  const confirming = screen.draft.confirming !== null;
  return (
    <Dialog.Root open onOpenChange={(open) => !open && close()}>
      <Dialog.Portal>
        <Dialog.Overlay className="sn-overlay" />
        <Dialog.Content
          className={`soft-skin soft-${props.theme} sn-sheet`}
          data-layout="phone"
          data-testid="saved-note-sheet"
          data-note-id={props.id}
          onEscapeKeyDown={(event) => {
            if (confirming) {
              event.preventDefault();
              screen.draft.keep();
            } else if (screen.editing) {
              event.preventDefault();
              screen.cancel();
            }
          }}
          onOpenAutoFocus={(event) => {
            // Editing again after a width change: the writer takes focus itself.
            if (screen.editing) event.preventDefault();
          }}
        >
          <div className="sn-sheet-body" inert={confirming}>
            <div className="sn-sheet-head">
              <Dialog.Title className="soft-title sn-title">
                {props.title}
              </Dialog.Title>
              <Dialog.Close className="sn-x" aria-label={COPY.close}>
                <span aria-hidden="true">✕</span>
              </Dialog.Close>
            </div>
            <Dialog.Description className="sn-meta">
              {props.meta}
            </Dialog.Description>
            <Body {...props} {...refs} />
          </div>
          <Confirm {...props} {...refs} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
