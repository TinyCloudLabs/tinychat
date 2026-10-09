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

export interface NotesUi extends NotesUiFields {
  /** Opens the notes in `view`. The desktop note view always passes "write". */
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

/** Forgets everything: the recording ended (Done or discard), or a test starts clean. */
export function clearNotesUi(): void {
  if (stored === null) return;
  stored = null;
  emit();
}

/** Forgets the state of every recording but `key` (null: all of it). */
export function clearNotesUiExcept(key: string | null): void {
  if (stored !== null && stored.key !== key) clearNotesUi();
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
