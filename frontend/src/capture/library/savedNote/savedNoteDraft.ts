import { useMemo, useSyncExternalStore } from "react";
import {
  discardChanges,
  keepEditing,
  NOT_EDITING,
  requestCancel,
  requestClose,
  saved,
  startEdit,
  typeInto,
  type EditFields,
} from "./savedNoteEdit";

// Held above the page and the sheet, keyed by recording, so leaving a note mid-edit (desktop) or a width change
// between the page and the sheet keeps what was typed until the user saves or discards it.
const edits = new Map<string, EditFields>();
const listeners = new Set<() => void>();

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

function set(id: string, next: EditFields): void {
  const current = edits.get(id) ?? NOT_EDITING;
  if (current.draft === next.draft && current.confirming === next.confirming)
    return;
  if (next.draft === null && next.confirming === null) edits.delete(id);
  else edits.set(id, next);
  for (const listener of [...listeners]) listener();
}

/** Sets recording `id`'s edit directly: the screenshot harness opens the editor and its confirmation this way. Never called by the app. */
export const setSavedNoteDraft = set;

export const readSavedNoteDraft = (id: string): EditFields =>
  edits.get(id) ?? NOT_EDITING;

/** Forgets every recording's edit (a test starts clean). */
export function clearSavedNoteDrafts(): void {
  if (edits.size === 0) return;
  edits.clear();
  for (const listener of [...listeners]) listener();
}

export interface SavedNoteDraft extends EditFields {
  edit(savedMd: string): void;
  type(text: string): void;
  cancel(savedMd: string): void;
  /** Whether the sheet may close now; otherwise a confirmation is open. */
  close(savedMd: string): boolean;
  keep(): void;
  /** Whether the sheet was closing when the changes were discarded. */
  discard(): boolean;
  /** The note was saved. */
  finish(): void;
}

export function useSavedNoteDraft(id: string): SavedNoteDraft {
  const fields = useSyncExternalStore(
    subscribe,
    () => edits.get(id) ?? NOT_EDITING,
    () => NOT_EDITING,
  );
  return useMemo(
    () => ({
      ...fields,
      edit: (savedMd) => set(id, startEdit(readSavedNoteDraft(id), savedMd)),
      type: (text) => set(id, typeInto(readSavedNoteDraft(id), text)),
      cancel: (savedMd) =>
        set(id, requestCancel(readSavedNoteDraft(id), savedMd)),
      close: (savedMd) => {
        const result = requestClose(readSavedNoteDraft(id), savedMd);
        set(id, result.fields);
        return result.close;
      },
      keep: () => set(id, keepEditing(readSavedNoteDraft(id))),
      discard: () => {
        const result = discardChanges(readSavedNoteDraft(id));
        set(id, result.fields);
        return result.close;
      },
      finish: () => set(id, saved()),
    }),
    [id, fields],
  );
}
