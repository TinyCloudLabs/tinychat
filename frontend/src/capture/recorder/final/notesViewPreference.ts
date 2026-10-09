export type NotesView = "write" | "preview";

export const NOTES_VIEW_KEY = "exo.notesView";

/** Preview the first time, then whichever view was used last. */
export function readNotesView(
  storage: Pick<Storage, "getItem"> = localStorage,
): NotesView {
  return storage.getItem(NOTES_VIEW_KEY) === "write" ? "write" : "preview";
}

export function rememberNotesView(
  view: NotesView,
  storage: Pick<Storage, "setItem"> = localStorage,
): void {
  storage.setItem(NOTES_VIEW_KEY, view);
}
