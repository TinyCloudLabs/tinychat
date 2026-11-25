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
  // A name a model suggested, beside the label it is for, until the user takes or dismisses it. (`suggested` above
  // is the mark on a name already applied from the call window.)
  suggestedName: "Suggested name:",
  suggestion: (name: string) => `${name}?`,
  use: "Use",
  useFor: (name: string, original: string) => `Use ${name} for ${original}`,
  dismiss: "Dismiss",
  dismissFor: (name: string, original: string) => `Dismiss ${name} for ${original}`,
  /** How the transcript supports the name; the quoted words follow. */
  basis: {
    "self-introduction": "They say their own name:",
    introduced: "Someone introduces them or speaks to them by name:",
    thanked: "Someone thanks them by name:",
    inferred: "Worked out from what is said:",
  },
  quote: (words: string) => `“${words}”`,
  suggestionsFound: (count: number) => `Names suggested for ${count} speakers.`,
  useAll: "Use all",
  suggestNames: "Suggest names",
  // Settings → Voice notes.
  setting: "Suggest speaker names",
  settingHelp: "A name is suggested from the note's transcript and the names in your meetings, and nothing is renamed until you choose Use. A suggestion uses credits like a chat message. Off: names are suggested only when you choose Suggest names in a note's transcript menu.",
  settingUnread: "Could not read this setting.",
  settingUnsaved: "Could not save this setting. Try again.",
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
