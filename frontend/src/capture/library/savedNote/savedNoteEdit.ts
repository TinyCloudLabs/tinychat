/** What the saved note's editor holds for one recording, apart from the note itself. */
export interface EditFields {
  /** The text being edited; null when the note is not in Edit. */
  draft: string | null;
  /** The confirmation that is open: Cancel with changes, or closing the sheet with changes. */
  confirming: "cancel" | "close" | null;
}

export const NOT_EDITING: EditFields = { draft: null, confirming: null };

export const isEditing = (fields: EditFields): boolean => fields.draft !== null;

/** The edit differs from the saved note. */
export const isDirty = (fields: EditFields, saved: string): boolean =>
  fields.draft !== null && fields.draft !== saved;

/** Edit: opens the editor on the note, or on the draft kept from an earlier visit. */
export function startEdit(fields: EditFields, saved: string): EditFields {
  return { draft: fields.draft ?? saved, confirming: null };
}

export function typeInto(fields: EditFields, text: string): EditFields {
  return fields.draft === null ? fields : { ...fields, draft: text };
}

/** Cancel: nothing to lose leaves Edit at once; changes ask first. */
export function requestCancel(fields: EditFields, saved: string): EditFields {
  if (fields.draft === null) return fields;
  return isDirty(fields, saved)
    ? { ...fields, confirming: "cancel" }
    : NOT_EDITING;
}

/** The phone sheet is closing: changes ask first. Returns whether it may close now. */
export function requestClose(
  fields: EditFields,
  saved: string,
): { fields: EditFields; close: boolean } {
  if (isDirty(fields, saved))
    return { fields: { ...fields, confirming: "close" }, close: false };
  return { fields: NOT_EDITING, close: true };
}

/** Keep editing. */
export function keepEditing(fields: EditFields): EditFields {
  return { ...fields, confirming: null };
}

/** Discard changes: the edit is gone and the note stays as it was. Says whether the sheet was closing. */
export function discardChanges(fields: EditFields): {
  fields: EditFields;
  close: boolean;
} {
  return { fields: NOT_EDITING, close: fields.confirming === "close" };
}

/** The note was saved: Edit is over. */
export const saved = (): EditFields => NOT_EDITING;
