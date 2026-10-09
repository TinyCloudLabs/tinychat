const WRITE_FAILED = "Couldn't save all of this recording";

/** Every line of text on the desktop Capture home that the library's own rows and the phone home do not already say. */
export const DESKTOP_HOME_COPY = {
  heading: "Capture",
  library: "Library",
  start: "Start recording",
  startLabel: "Start recording a voice note",
  back: "Back to recording",
  upload: "Upload",
  meeting: "Meeting",
  uploadLabel: "Upload audio",
  meetingLabel: "Send a notetaker to a meeting",
  connect: "Connect existing meetings",
  connected: (count: number) => `${count} connected`,
  connectUnavailable: "Connection status unavailable",
  inProgress: "In progress",
  recent: "Recent",
  filters: "Filter recent captures",
  recentEmpty: "Your recordings appear here",
  filterEmpty: { note: "No voice notes yet", meeting: "No meetings yet" },
  loadingRecent: "Loading your recent captures…",
  recentFailed: "Couldn’t load your recent captures.",
  retryRecent: "Try again",
  voiceNoteTitle: "Voice note",
  onMacOne: "1 voice note on this Mac",
  onMacMany: (count: number) => `${count} voice notes on this Mac`,
  notInSpace: "Not in your space yet",
  saveNow: "Save now",
  willFinish: "Kept on this Mac. Exo will finish it automatically.",
  willRetry: "Exo will retry when it next opens",
  timedOut: "Saving… · kept on this Mac",
  recoveryFailed: "Couldn't recover this recording",
  writeFailed: WRITE_FAILED,
  partialAudio: "Saved — part of this recording couldn't be written",
  dismiss: "Dismiss",
  dismissLabel: (title: string) => `Dismiss the notice for ${title}`,
  scanFailure:
    "Exo couldn't check for unfinished recordings. It will try again when it next opens.",
} as const;

/** The failed-recording sheet's shared copy, which says "this phone", for the desktop home. */
export const onThisMac = (text: string): string =>
  text.replaceAll("this phone", "this Mac").replaceAll("This phone", "This Mac");
