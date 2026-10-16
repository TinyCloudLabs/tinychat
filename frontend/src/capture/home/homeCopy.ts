// Local recording copy follows the active capture engine when read, after the
// native, desktop or browser recorder has been installed.
import { captureDeviceName } from "@/lib/voiceNotes/captureEngine";

const RECOVERY_FAILED = "Couldn't recover this recording";
const WRITE_FAILED = "Couldn't save all of this recording";
const PARTIAL_AUDIO = "Part of this recording couldn't be written";

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
  /** A note kept on this device with no row in the space yet; read as "On this phone" in a badge. */
  get onThisPhone() { return `on ${captureDeviceName()}`; },
  savingBadge: "Saving…",
  inProgressCount: (count: number) => `${count} in progress`,
  onPhoneCount: (count: number) => `${count} on ${captureDeviceName()}`,
  get onPhoneOne() { return `1 voice note on ${captureDeviceName()}`; },
  onPhoneMany: (count: number) => `${count} voice notes on ${captureDeviceName()}`,
  notInSpace: "Not in your space yet",
  savingToSpace: "Saving to your TinyCloud space…",
  saveNow: "Save now",
  manageStorage: "Manage storage",
  get willFinish() { return `Kept on ${captureDeviceName()}. Exo will finish it automatically.`; },
  willRetry: "Exo will retry when it next opens",
  /** Native has used up its automatic retries on a quarantined recording: no promise to try again. */
  quarantinedCard: "Couldn't recover · audio kept",
  get timedOutMeta() { return `Saving… · kept on ${captureDeviceName()}`; },
  recoveryFailedMeta: RECOVERY_FAILED,
  quarantinedMeta: `${RECOVERY_FAILED} · audio kept`,
  /** What the recorder's own error line says once native has reported the failure; replaces "Exo will finish it automatically". */
  recoveryFailedError: `${RECOVERY_FAILED}. Exo will try again when it next opens.`,
  writeFailedError: `${WRITE_FAILED}.`,
  timedOutSheet: {
    title: "Saving this recording",
    get body() { return `Kept on ${captureDeviceName()}. Exo will finish it automatically.`; },
  },
  writeFailedMeta: WRITE_FAILED,
  /** Shared with the desktop follow-ups: the informational line under a saved recording that is missing some audio. */
  partialAudioMeta: "Saved — part of this recording couldn't be written",
  partialAudioSheet: {
    title: PARTIAL_AUDIO,
    get body() { return `The recording was saved, but ${captureDeviceName()} couldn't write all of the audio. The part that couldn't be written is missing.`; },
  },
  partialAudioMissing: (formatted: string) => `About ${formatted} is missing`,
  partialAudioMissingBrief: "Less than a second is missing",
  dismiss: "Dismiss",
  dismissFailed: "Couldn't dismiss this notice. It is still shown.",
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
  get tryAgainFailed() { return `Couldn't try again. The recording is still on ${captureDeviceName()}.`; },
  get deleteFailed() { return `Couldn't delete this recording. It is still on ${captureDeviceName()}.`; },
  deleteConfirm: {
    title: "Delete this recording?",
    get body() { return `The audio will be deleted from ${captureDeviceName()}. This can't be undone.`; },
  },
  quarantineFailure:
    "Exo couldn't check for recordings it kept. It will try again when it next opens.",
  recoveryFailedSheet: {
    title: RECOVERY_FAILED,
    body: "Exo couldn't finish saving this recording. It will try again when it next opens.",
  },
  quarantinedSheet: {
    title: RECOVERY_FAILED,
    get body() { return `Exo tried several times and couldn't finish saving this recording. The audio is kept on ${captureDeviceName()}.`; },
  },
  unplayableSheet: {
    title: RECOVERY_FAILED,
    body: "This recording can't be recovered. You can delete it.",
  },
  writeFailedSheet: {
    title: WRITE_FAILED,
    get body() { return `Saving stopped on ${captureDeviceName()} partway through. What was recorded up to that point is kept; the rest was not recorded.`; },
  },
} as const;
