const RECOVERY_FAILED = "Couldn't recover this recording";
const WRITE_FAILED = "Couldn't save all of this recording";

/** Every line of text on the Soft Capture home that the library's own rows do not already say (TC-871). */
export const HOME_COPY = {
  heading: "Capture",
  library: "Library",
  inProgress: "In progress",
  recent: "Recent",
  seeAll: "See all",
  recentEmpty: "Your recordings appear here",
  loadingRecent: "Loading your recent captures…",
  recentFailed: "Couldn’t load your recent captures.",
  retryRecent: "Try again",
  voiceNoteTitle: "Voice note",
  onPhoneOne: "1 voice note on this phone",
  onPhoneMany: (count: number) => `${count} voice notes on this phone`,
  notInSpace: "Not in your space yet",
  saveNow: "Save now",
  willFinish: "Kept on this phone. Exo will finish it automatically.",
  willRetry: "Exo will retry when it next opens",
  timedOutMeta: "Saving… · kept on this phone",
  recoveryFailedMeta: RECOVERY_FAILED,
  quarantinedMeta: `${RECOVERY_FAILED} · audio kept`,
  /** What the recorder's own error line says once native has reported the failure; replaces "Exo will finish it automatically". */
  recoveryFailedError: `${RECOVERY_FAILED}. Exo will try again when it next opens.`,
  writeFailedError: `${WRITE_FAILED}.`,
  timedOutSheet: {
    title: "Saving this recording",
    body: "Kept on this phone. Exo will finish it automatically.",
  },
  writeFailedMeta: WRITE_FAILED,
  needsAttention: "Needs attention",
  opensDetails: "Opens details",
  scanFailure:
    "Exo couldn't check for unfinished recordings. It will try again when it next opens.",
  upload: "Upload",
  recorder: "Recorder",
  meeting: "Meeting",
  recordLabel: "Recorder, record a voice note",
  openRecorderLabel: "Open recorder",
  uploadLabel: "Upload audio",
  meetingLabel: "Send a notetaker to a meeting",
  close: "Close",
  tryAgain: "Try again",
  tryingAgain: "Trying again…",
  delete: "Delete",
  deleting: "Deleting…",
  keep: "Keep",
  tryAgainFailed: "Couldn't try again. The recording is still on this phone.",
  deleteFailed: "Couldn't delete this recording. It is still on this phone.",
  deleteConfirm: {
    title: "Delete this recording?",
    body: "The audio will be deleted from this phone. This can't be undone.",
  },
  quarantineFailure:
    "Exo couldn't check for recordings it kept. It will try again when it next opens.",
  recoveryFailedSheet: {
    title: RECOVERY_FAILED,
    body: "Exo couldn't finish saving this recording. It will try again when it next opens.",
  },
  quarantinedSheet: {
    title: RECOVERY_FAILED,
    body: "Exo tried several times and couldn't finish saving this recording. The audio is kept on this phone.",
  },
  writeFailedSheet: {
    title: WRITE_FAILED,
    body: "This phone stopped saving the recording partway through. What was recorded up to that point is kept; the rest was not recorded.",
  },
} as const;
