/** The device shell renders its own recorder; every other signed-out surface needs the standalone one. */
export function shouldMountRecordingOverlay(options: {
  voiceNotesInApp: boolean;
  isReady: boolean;
  deviceCapture: boolean;
  nativeSignInScreenShown: boolean;
  shareTokenPresent: boolean;
}): boolean {
  return options.voiceNotesInApp && !options.isReady &&
    !(options.deviceCapture && !options.nativeSignInScreenShown && !options.shareTokenPresent);
}
