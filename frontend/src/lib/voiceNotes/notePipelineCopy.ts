// Words for the note pipeline (notePipeline.ts). Short sentences, "·" between a state and its detail,
// no em dashes. Every blocker line says what is wrong and, where it is true, that the note is safe.
import type { PipelineActionKind, PipelineDevice, StepKey } from "./notePipeline";
import { deviceName as platformDeviceName } from "@/lib/platform";
import { PRIVATE_TOO_LARGE_NOTE, PRIVATE_TOO_LONG_NOTE } from "@/lib/privateCloud";
import { STORAGE_FULL_RECORDING_LINE, STORAGE_FULL_TRANSCRIPT_LINE } from "@/lib/storageStatus";

export const deviceName = (device: PipelineDevice): string => platformDeviceName(device === "mac" ? "tauri" : device === "iphone" ? "ios" : device === "android" ? "android" : device === "browser" ? "web" : undefined);

export const STEP_LABEL = {
  phone: (device: PipelineDevice) => `Audio on ${deviceName(device)}`,
  space: "Audio in your space",
  transcript: "Transcript",
  notes: "Notes",
} as const satisfies Record<StepKey, string | ((device: PipelineDevice) => string)>;

export const ACTION_LABEL: Record<PipelineActionKind, string> = {
  "sign-in": "Sign in",
  retry: "Try again",
  "get-model": "Get model",
  "manage-storage": "Manage storage",
  "check-again": "Check again",
  "review-consent": "Review consent",
  reread: "Try again",
};

export function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

/** "42%" from a 0..1 fraction, clamped. */
export const percentText = (fraction: number): string => `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`;

/** "next" for the first place, "2nd" after. */
const place = (position: number): string => (position <= 1 ? "next" : ordinal(position));

const withDetail = (lead: string, _detail: string | null | undefined): string => lead;

export const privatePartsDone = (completed: number | null, total: number | null): string | null =>
  completed === null || total === null || total <= 0 ? null : `${completed} of ${total} parts done`;

export const PHONE_COPY = {
  finishing: "Finishing the recording…",
  timedOut: "Exo will finish it next launch",
  recoveryFailed: "Couldn't recover · audio kept",
  writeFailed: (detail: string | null | undefined) => withDetail("Couldn't write the recording", detail),
  partialAudio: "Saved · part of this recording couldn't be written",
  quarantineReadFailed: (detail: string | null | undefined) => withDetail("Couldn't check for recordings that failed to save", detail),
};

export const SPACE_COPY = {
  afterRecording: "After recording",
  waiting: "Waiting to upload",
  uploading: (fraction: number | null) => (fraction === null ? "Uploading audio to your TinyCloud space…" : `Uploading audio to your TinyCloud space · ${percentText(fraction)}`),
  retrying: "Retrying…",
  retryIn: (ms: number) => `Your TinyCloud space is slow to answer · trying again in ${Math.max(1, Math.ceil(ms / 1_000))} s`,
  offline: "Waiting for a connection",
  offlineCaption: "Offline · Resumes automatically",
  signedOut: (device: PipelineDevice) => `You're signed out. This note is safe on ${deviceName(device)}.`,
  sessionExpired: (device: PipelineDevice) => `Your session ended. This note is safe on ${deviceName(device)}.`,
  otherAccount: "Recorded on another account",
  accountUnknown: (device: PipelineDevice) => `Exo can't tell which account this note belongs to. It stays on ${deviceName(device)}.`,
  quota: (device: PipelineDevice) => `Saved on ${deviceName(device)}. ${STORAGE_FULL_RECORDING_LINE}`,
  timeout: (device: PipelineDevice) => `Saving timed out. This note is safe on ${deviceName(device)}.`,
  server: (_detail: string | null | undefined, device: PipelineDevice) =>
    `Your space couldn't take this note. It is safe on ${deviceName(device)}. Try again.`,
  unreachable: (device: PipelineDevice) => `Couldn't reach your space. This note is safe on ${deviceName(device)}.`,
};

export const TRANSCRIPT_COPY = {
  savedInSpace: "Saved in your space",
  noSpeechInSpace: "No speech found",
};

export const LOCAL_COPY = {
  readyOnDevice: (device: PipelineDevice) => `Ready on ${deviceName(device)}`,
  waitingForModel: (fraction: number | null) =>
    fraction === null ? "Waiting for the on-device model" : `Waiting for the on-device model · ${percentText(fraction)}`,
  verifyingModel: "Checking the on-device model…",
  waitingForWifi: "Waiting for Wi-Fi",
  lowDataMode: "Waiting for Wi-Fi · Low Data Mode is on",
  needsModel: (device: PipelineDevice) => `Transcripts on ${deviceName(device)} need the on-device model.`,
  gettingSpeech: "Getting speech from iOS…",
  speechFailed: "Couldn't get speech from iOS",
  speechUnsupported: (device: PipelineDevice) => `On-device transcription isn't available on ${deviceName(device)}`,
  speechLocaleUnsupported: "On-device transcription doesn't support this language yet",
  modelFailed: (detail: string | null | undefined) => withDetail("The on-device model couldn't download", detail),
  queued: (position: number | null) => (position === null ? "Queued" : `Queued · ${place(position)}`),
  transcribing: (fraction: number | null) => (fraction === null ? "Transcribing…" : `Transcribing · ${percentText(fraction)}`),
  transcribingOnMac: (fraction: number | null) => (fraction === null ? "Transcribing on this Mac…" : `Transcribing on this Mac · ${percentText(fraction)}`),
  adding: "Adding to this note…",
  failed: (detail: string | null | undefined, device: PipelineDevice) => withDetail(`Couldn't transcribe on ${deviceName(device)}`, detail),
  cancelled: (device: PipelineDevice) => `Transcribing on ${deviceName(device)} was cancelled`,
  syncFailed: () => "Couldn't add the transcript to this note",
  notAdded: (device: PipelineDevice) => `The transcript is ready on ${deviceName(device)} but hasn't been added to this note`,
  missingTranscript: `${deviceName("phone")} says it finished transcribing but has no transcript for the note`,
  transcriptReadFailed: `Couldn't read the transcript on ${deviceName("phone")}.`,
  transcriptCheckFailed: `Couldn't check this note on ${deviceName("phone")}.`,
  transcriptSyncFailed: "Couldn't add the transcript to this note.",
  transcriptStorageFull: (device: PipelineDevice) => `Saved on ${deviceName(device)}. ${STORAGE_FULL_TRANSCRIPT_LINE}`,
  unrecorded: (device: PipelineDevice) => `The transcript is in your space, but ${deviceName(device)} couldn't record it.`,
  checkingSpace: "Checking your space…",
  checkingSpaceAfterUploads: "Checking your space · after uploads",
  notStarted: "Waiting to transcribe",
  noSpeech: "No speech found",
  readFailed: (detail: string | null | undefined) => withDetail("Couldn't check this note's transcript", detail),
  otherReadFailed: (detail: string | null | undefined) => withDetail("Some details about this note couldn't be read", detail),
};

export const PRIVATE_COPY = {
  waiting: (position: number) => `Waiting · ${place(position)}`,
  preparing: "Preparing…",
  sending: "Sending audio to Private transcription",
  inQueue: (position: number | null) => (position === null ? "In the queue" : `In the queue · #${position}`),
  transcribing: (completed: number | null, total: number | null) => {
    const partsDone = privatePartsDone(completed, total);
    return partsDone === null ? "Transcribing…" : `Transcribing · ${partsDone}`;
  },
  saving: "Saving transcript",
  notStarted: "Waiting for private transcription",
  afterUpload: "After audio uploads",
  noSpeech: "No speech found",
  unavailable: "Private transcription isn't available right now",
  limitsUnknown: "Private's limits aren't available right now. Try again later.",
  checkFailed: "Couldn't check whether private transcription is available",
  checking: "Checking private transcription…",
  noConsent: "Waiting for your OK to use Private",
  failed: (code: string, provider: "private" | "powerful" | "unknown" = "private") => code === "recording_too_long" ? PRIVATE_TOO_LONG_NOTE : code === "recording_too_large" ? PRIVATE_TOO_LARGE_NOTE : provider === "powerful" ? "Powerful transcription didn't finish." : provider === "unknown" ? "Transcription didn't finish." : "Private transcription didn't finish.",
};

export const NOTES_COPY = {
  syncing: "Syncing notes…",
  failed: "Couldn't sync your notes",
  waitingForRow: "Waiting for the note to reach your space",
  notSynced: "Your notes haven't reached your space yet",
  unreadable: (detail: string | null | undefined, device: PipelineDevice) => withDetail(`Couldn't read this note's text on ${deviceName(device)}`, detail),
};
