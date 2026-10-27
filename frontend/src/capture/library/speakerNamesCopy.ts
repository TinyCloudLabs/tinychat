// Wording for renaming a note's speakers (TC-2189).
export const SPEAKER_NAMES_COPY = {
  rename: (name: string) => `Rename speaker ${name}`,
  fieldLabel: (name: string) => `Name for ${name}`,
  mePlaceholder: "Your name",
  othersPlaceholder: "Alice, Bob",
  otherPlaceholder: "Name",
  save: "Save",
  cancel: "Cancel",
  reset: (original: string) => `Use ${original}`,
  renamed: (from: string, to: string) => `${from} is now ${to}.`,
  cleared: (original: string) => `${original} is back to its original label.`,
  undo: "Undo",
  undone: "Rename undone.",
  failed: "Couldn't save the speaker name. Try again.",
} as const;

/** Labels the recorders give the user's own side of a two-sided note. */
export const OWN_SIDE_LABELS: ReadonlySet<string> = new Set(["Me", "You"]);
/** Labels they give the other side, which may be one person or several. */
export const OTHER_SIDE_LABELS: ReadonlySet<string> = new Set(["Them", "Others"]);
