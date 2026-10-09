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
