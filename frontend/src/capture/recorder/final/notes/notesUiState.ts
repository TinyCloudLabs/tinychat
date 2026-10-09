import { useMemo, useRef, useSyncExternalStore } from "react";
import type { NotesView } from "../notesViewPreference";

/** What the notes UI holds for the recording in progress, above whichever layout is mounted. */
export interface NotesUiFields {
  /** The notes sheet (phone) or note view (desktop) is open. */
  open: boolean;
  view: NotesView;
  /** Typed text that has not been committed through `setNoteText` yet; null when nothing is waiting. */
  draft: string | null;
  /** The last write of the note failed; what was typed is kept in `draft`. Cleared by the next write that works. */
  saveFailed: boolean;
}

/**
 * The notes UI, for whichever layout is mounted. This is the one API the phone sheet and the desktop note view
 * share; both read the same state, so a layout switch loses nothing.
 */
export interface NotesUi extends NotesUiFields {
  /**
   * Opens the notes in `view` ("write" or "preview"). The desktop note view's "Write notes" passes `"write"`; the
   * phone's "View notes" passes the view the user last used. Does nothing when no recording is in progress.
   */
  openNotes(view: NotesView): void;
  closeNotes(): void;
  setView(view: NotesView): void;
  setDraft(md: string): void;
}

const INITIAL: NotesUiFields = {
  open: false,
  view: "preview",
  draft: null,
  saveFailed: false,
};

// One recording is in progress at a time; state for any other key is not used.
let stored: { key: string; fields: NotesUiFields } | null = null;
const listeners = new Set<() => void>();

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
const snapshot = () => stored;
const emit = () => {
  for (const listener of [...listeners]) listener();
};

/** Changes the state of recording `key` (starting it from `seed` if it has none yet). Usable outside React. */
export function updateNotesUi(
  key: string,
  patch: (fields: NotesUiFields) => Partial<NotesUiFields>,
  seed?: Partial<NotesUiFields>,
): void {
  const base = stored?.key === key ? stored.fields : { ...INITIAL, ...seed };
  const changes = patch(base);
  if (stored?.key === key && Object.entries(changes).every(([name, value]) => base[name as keyof NotesUiFields] === value)) return;
  stored = { key, fields: { ...base, ...changes } };
  emit();
}

/** Like `updateNotesUi`, but only while recording `key` still has state: a late save result after the recording ended must not bring it back. */
export function patchNotesUi(
  key: string,
  patch: (fields: NotesUiFields) => Partial<NotesUiFields>,
): void {
  if (stored?.key === key) updateNotesUi(key, patch);
}

export function readNotesUi(key: string): NotesUiFields | null {
  return stored?.key === key ? stored.fields : null;
}

/** Forgets everything of the recording in progress: it ended (Done or discard), or a test starts clean. Leaves `unsavedNote`. */
export function clearNotesUi(): void {
  if (stored === null) return;
  stored = null;
  emit();
}

/** Forgets the state of every recording but `key` (null: all of it), and the unsaved note of any other recording than `key`. */
export function clearNotesUiExcept(key: string | null): void {
  if (stored !== null && stored.key !== key) clearNotesUi();
  if (key !== null && unsaved !== null && unsaved.key !== key) dismissUnsavedNote();
}

/** A note whose last text could not be saved when its recording ended with Done anyway. */
export interface UnsavedNote {
  /** The recording it belongs to (`recordingKey`). */
  key: string;
  md: string;
}

// Kept after the recording's own state is cleared, so the saved receipt can still tell the user and offer the text.
let unsaved: UnsavedNote | null = null;
const unsavedSnapshot = () => unsaved;

/** The recording `key` ended with `md` unsaved. Held until the user dismisses it or another recording starts. */
export function retainUnsavedNote(key: string, md: string): void {
  unsaved = { key, md };
  emit();
}

export function dismissUnsavedNote(): void {
  if (unsaved === null) return;
  unsaved = null;
  emit();
}

export function readUnsavedNote(): UnsavedNote | null {
  return unsaved;
}

/** The note the last recording ended without saving; null when there is none. */
export function useUnsavedNote(): UnsavedNote | null {
  return useSyncExternalStore(subscribe, unsavedSnapshot, unsavedSnapshot);
}

/**
 * The notes UI state of recording `key`, shared by every layout, so a phone ⇄ desktop switch (unmount, remount)
 * loses nothing. `seed` is the state before anything has been changed (the harness).
 */
export function useNotesUi(
  key: string | null,
  seed?: Partial<NotesUiFields>,
): NotesUi {
  const current = useSyncExternalStore(subscribe, snapshot, snapshot);
  const seedRef = useRef(seed);
  seedRef.current = seed;

  const fields = current !== null && current.key === key ? current.fields : undefined;
  return useMemo(() => {
    const now = fields ?? { ...INITIAL, ...seedRef.current };
    const set = (patch: (f: NotesUiFields) => Partial<NotesUiFields>) => {
      // No recording in progress (it just ended): there is nothing for this state to belong to.
      if (key === null) return;
      updateNotesUi(key, patch, seedRef.current);
    };
    return {
      ...now,
      openNotes: (view) => set(() => ({ open: true, view })),
      closeNotes: () => set(() => ({ open: false })),
      setView: (view) => set(() => ({ view })),
      setDraft: (md) => set(() => ({ draft: md })),
    };
  }, [fields, key]);
}
