import type { AppPlatform } from "@/lib/platform";
import type { TranscriptionAvailability } from "@/lib/voiceNotes/voiceNoteTranscription";

const MODE_NAMES = {
  skip: "Audio only",
  local: "Local",
  private: "Private",
  powerful: "Powerful",
} as const;

/** One name per transcription mode, keyed by the provider's transcriber id; every surface that names a mode reads this. */
export const TRANSCRIBER_NAME = {
  off: MODE_NAMES.skip,
  "on-device": MODE_NAMES.local,
  "private-cloud": MODE_NAMES.private,
  assemblyai: MODE_NAMES.powerful,
} as const;

/** The first stop of a route diagram: the device the audio starts on. */
export function routeSourceName(platform: AppPlatform): string {
  if (platform === "ios" || platform === "android") return "This phone";
  return platform === "tauri" ? "This Mac" : "This browser";
}

/** Why Private cannot be chosen right now, and whether checking again can change it. */
export function privateNotOffered(availability: TranscriptionAvailability | undefined, errorCode?: string): { reason: string; canRecheck: boolean } {
  if (availability === "checking") return { reason: "Checking…", canRecheck: false };
  if (availability === "failed" && errorCode === "native_status_failed")
    return { reason: "Couldn't check this phone's file upload", canRecheck: true };
  if (availability === "failed") return { reason: "Couldn't check right now", canRecheck: true };
  return { reason: "Not available right now", canRecheck: false };
}

export const CHECK_AGAIN = "Check again";

export const FINAL_COPY = {
  listening: "Listening",
  resting: "Resting · tap to continue",
  interrupted: "Interrupted",
  tapToResume: "Tap to resume",
  tapToTryAgain: "Tap to try again",
  microphoneOff: "Microphone off",
  idle: "Ready",
  starting: "Starting…",
  saving: "Saving…",
  discarding: "Discarding…",
  noSoundFrom: (input: string) => `No sound from ${input}`,
  noSoundFromMicrophone: "No sound from the microphone",
  resumesWhenCallEnds: "Resumes when the call ends",
  stalledReconnecting: "The microphone stopped sending sound. Reconnecting…",
  callOrSiriPause: "Paused by a call or Siri. Resumes when it ends.",
  resumeBlockedReason:
    "The microphone could not resume because the audio session is blocked.",
  micUnavailable:
    "The microphone is unavailable. Choose another input or reconnect it.",
  stalledNeedsUser: "The microphone stopped sending sound.",
  inputChanged: "The microphone input changed. Waiting for capture to recover.",
  audioServicesReset:
    "Audio services restarted. Waiting for capture to recover.",
  microphoneReadFailed:
    "The microphone could not be read. Waiting for capture to recover.",
  appSuspended: "Recording was interrupted while the app was inactive.",
  permissionRevoked:
    "Microphone permission was revoked. Open Settings to allow access.",
  denied: "Microphone access is off. Open Settings to allow access.",
  unexpectedMicState:
    "The microphone state is unexpected. Check the recording.",
  savingAtLimit: "Saving at the limit…",
  savingAfterDiskFull: "Saving the audio captured before storage ran out…",
  writeFailed: "The recording could not be saved.",
  unsafeSessionsFolder:
    "Recording is blocked by an unsafe entry in the vault sessions folder. Remove unexpected links or files there, then try again.",
  sessionExists:
    "This recording session already exists. Discard this attempt and start a new recording.",
  stopAndSaveRecorded: "Stop and save what's recorded.",
  stopAt: (text: string) => `Stops at ${text}`,
  comingNextUpdate: "Coming with the next update",
  disabled: "Disabled",
  needsApp: "needs the app",
  onThisPhone: "on this phone",
  onThisMac: "on this Mac",
  sealedEnclave: "sealed enclave",
  assemblyAi: "AssemblyAI",
  identifySpeakers: "Identify speakers",
  powerfulOnly: "Powerful only",
  whisperUnavailable: "Get Whisper for this Mac",
  modelUnavailable: "Get the on-device model",
  modelTryAgain: "Try again",
  speechGet: "Get speech from iOS",
  speechGetting: "Getting speech from iOS…",
  speechFailed: "Couldn't get speech from iOS",
  speechNotInstalled: "Speech from iOS isn't on this phone yet",
  speechUnsupported: "On-device transcription isn't available on this iPhone",
  speechLocaleUnsupported: "On-device transcription doesn't support this language yet",
  modes: {
    skipName: MODE_NAMES.skip,
    localName: MODE_NAMES.local,
    privateName: MODE_NAMES.private,
    powerfulName: MODE_NAMES.powerful,
    speakersName: "AssemblyAI · speakers",
    noTranscript: "no transcript",
    skipCaption: {
      phone: "Just the recording, kept on this phone.",
      desktop: "Just the recording, saved to your space.",
      web: "Just the recording, saved to your space.",
    },
    skipExplanation:
      "Only the audio is saved. Transcribe it later if you like.",
    localPhoneCaption: "Nothing leaves it; a little slower.",
    localDesktopCaption: "Whisper on this Mac, after you stop.",
    localPhoneExplanation:
      "Your phone transcribes it after you stop. Nothing leaves your phone.",
    localDesktopExplanation: (model: string) =>
      `Whisper ${model} transcribes on this Mac after you stop, and nothing leaves the machine. Change the model in ⚙︎ Settings.`,
    localWebExplanation:
      "Runs on your phone or Mac in the Exo app. Not available in the browser.",
    privateCaption: "Fast, accurate, and sealed from Exo.",
    privateExplanation:
      "Transcribed in a sealed hardware enclave. Not even Exo can read it. Fast and accurate.",
    powerfulCaption: "Most accurate. Audio deleted after processing.",
    powerfulExplanation:
      "Uploaded to AssemblyAI, a third-party service: the most accurate, with speaker labels. Audio is deleted after processing.",
  },
} as const;
