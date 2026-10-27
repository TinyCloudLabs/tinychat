// Wording for the word fixes list in Settings (TC-2199).
export const WORD_FIXES_COPY = {
  title: "Word fixes",
  hint: "Replaces words in every transcript you read, copy or export. Saved transcripts stay as they are.",
  empty: "No word fixes yet. Add one to correct a name or term the transcript gets wrong.",
  add: "Add a word fix",
  findLabel: "Replace this",
  findPlaceholder: "tiny cloud",
  replaceLabel: "With this",
  replacePlaceholder: "TinyCloud",
  save: "Save",
  cancel: "Cancel",
  edit: (find: string) => `Edit word fix for ${find}`,
  remove: (find: string) => `Delete word fix for ${find}`,
  failed: "Couldn't save your word fixes. Try again.",
  replacesWith: "becomes",
  nothing: "(nothing)",
} as const;
