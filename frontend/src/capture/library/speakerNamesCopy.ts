// Wording for renaming a note's speakers (TC-2189).
export const SPEAKER_NAMES_COPY = {
  rename: (name: string) => `Rename speaker ${name}`,
  fieldLabel: (name: string) => `Name for ${name}`,
  mePlaceholder: "Your name",
  othersPlaceholder: "Alice, Bob",
  otherPlaceholder: "Name",
  save: "Save",
  cancel: "Cancel",
  reset: (original: string) => `Go back to ${original}`,
  /** Names in the call: the group of names to pick from in the rename form (read by screen readers only). */
  choices: "Names in the call",
  /** The mark on a name the app suggested, until it is kept or changed. */
  suggested: "Suggested",
  renamed: (from: string, to: string) => `${from} is now ${to}.`,
  cleared: (original: string) => `Back to ${original}.`,
  undo: "Undo",
  undone: "Rename undone.",
  failed: "Couldn't save the speaker name. Try again.",
} as const;

/** Labels the recorders give the user's own side of a two-sided note. */
export const OWN_SIDE_LABELS: ReadonlySet<string> = new Set(["Me", "You"]);
/**
 * Who spoke when: the label of one person of the other side, in a Mac recording of a call where the call window
 * showed who was speaking ("Them 1", "Them 2", ...). The number is the person's place in the call's list of people.
 */
const CALL_PERSON_LABEL = /^Them [1-9][0-9]*$/;

/** Whether `label` names one person of the other side ("Them 1"), not the whole other side ("Them"). */
export function isCallPersonLabel(label: string): boolean {
  return CALL_PERSON_LABEL.test(label);
}

const OTHER_SIDE = new Set(["Them", "Others"]);

/** Labels they give the other side, which may be one person or several; "Them 1", "Them 2", ... are each one of them. */
export const OTHER_SIDE_LABELS: { has(label: string): boolean } = Object.freeze({
  has: (label: string) => OTHER_SIDE.has(label) || isCallPersonLabel(label),
});
