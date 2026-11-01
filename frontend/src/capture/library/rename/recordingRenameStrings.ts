/** User-facing copy for renaming a recording. Kept in one place. */
export const RECORDING_RENAME_ACTION = "Rename recording";
export const RECORDING_RENAME_FIELD_LABEL = "Recording title";
export const RECORDING_RENAME_PLACEHOLDER = "Name this recording";
export const RECORDING_RENAME_HINT = "Leave empty to use the automatic title.";
export const RECORDING_RENAME_SAVE = "Save";
export const RECORDING_RENAME_CANCEL = "Cancel";
export const RECORDING_RENAME_FAILED = "Couldn’t rename this recording. Try again.";
/** The pencil's name for one recording, so a list of them reads apart. */
export const recordingRenameLabel = (title: string): string => `${RECORDING_RENAME_ACTION}: ${title}`;
