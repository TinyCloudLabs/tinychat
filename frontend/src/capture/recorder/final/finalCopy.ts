export const FINAL_COPY = {
  listening: "Listening",
  resting: "Resting · tap to continue",
  interrupted: "Interrupted",
  tapToResume: "Tap to resume",
  microphoneOff: "Microphone off",
  idle: "Ready",
  starting: "Starting…",
  saving: "Saving…",
  stopping: "Saving…",
  discarding: "Discarding…",
  noSoundFrom: (input: string) => `No sound from ${input}`,
  resumesWhenCallEnds: "Resumes when the call ends",
  resumeBlocked: "Microphone unavailable. Check your audio input.",
  resumeBlockedReason:
    "The microphone could not resume because the audio session is blocked.",
  micUnavailable:
    "The microphone is unavailable. Choose another input or reconnect it.",
  interruptedUnknown: "Recording was interrupted. Check the microphone status.",
  noSignal: "No sound is reaching the microphone.",
  inputMuted: "The microphone input is muted.",
  interruptionInProgress: "Waiting for the system interruption to end.",
  inputChanged: "The microphone input changed. Waiting for capture to recover.",
  audioServicesReset:
    "Audio services restarted. Waiting for capture to recover.",
  microphoneReadFailed:
    "The microphone could not be read. Waiting for capture to recover.",
  appSuspended: "Recording was interrupted while the app was inactive.",
  audioWriterStalled:
    "Audio is no longer being written. Stop and save this recording.",
  pauseTimedOut:
    "The microphone did not confirm the pause. Check its state before continuing.",
  durationLimitReached: "The recording reached its time limit.",
  diskFull: "There is not enough storage to continue recording.",
  audioWriteFailed:
    "The recording could not be written. Stop and save what was captured.",
  permissionRevoked:
    "Microphone permission was revoked. Open Settings to allow access.",
  denied: "Microphone access is off. Open Settings to allow access.",
  openSettings: "Open Settings",
  stopAt: (text: string) => `Stops at ${text}`,
  stoppedAtThreeHours: "Stopped at 3 hours",
  comingNextUpdate: "Coming with the next update",
  needsApp: "needs the app",
  onThisPhone: "on this phone",
  onThisMac: "on this Mac",
  sealedEnclave: "sealed enclave",
  assemblyAi: "AssemblyAI",
  identifySpeakers: "Identify speakers",
  powerfulOnly: "Powerful only",
  whisperUnavailable: "Get Whisper for this Mac",
  modelUnavailable: "Get the on-device model",
  modes: {
    skipName: "Skip",
    localName: "Local",
    privateName: "Private",
    powerfulName: "Powerful",
    speakersName: "AssemblyAI · speakers",
    audioOnly: "audio only",
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
      "An on-device model transcribes it. Nothing leaves your phone; slower and less accurate.",
    localDesktopExplanation:
      "Whisper transcribes on this Mac after you stop, and nothing leaves the machine. Names the selected model and points to Settings.",
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
