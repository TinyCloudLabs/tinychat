import type { DesktopCaptureExtras } from "@/lib/voiceNotes/desktopCaptureExtras";

export const SYSTEM_AUDIO_TITLE = "Also record this Mac's audio?";
export const SYSTEM_AUDIO_BODY = "TinyCloud One can record everything this Mac plays, such as the other side of calls, videos and notifications, as Them alongside your mic as Me. Turning it off applies when you resume. Turning it on applies to your next recording.";
export const SYSTEM_AUDIO_RECORD = "Record this Mac's audio";
export const SYSTEM_AUDIO_MIC_ONLY = "Mic only";

export async function needsSystemAudioDisclosure(extras: DesktopCaptureExtras): Promise<boolean> {
  const [enabled, consented] = await Promise.all([extras.systemAudio.get(), extras.systemAudioConsent.get()]);
  return enabled && !consented;
}

export async function chooseSystemAudio(extras: DesktopCaptureExtras, choice: "record" | "mic-only"): Promise<void> {
  if (choice === "mic-only") {
    await extras.systemAudio.set(false);
    turnCallNamesOff(extras);
  }
  await extras.systemAudioConsent.set(true);
}

/**
 * Names in the call are read only while this Mac's audio is recorded too, so that setting goes off with it. Not
 * waited for: a build without the setting, or a failure, changes nothing about the choice.
 */
function turnCallNamesOff(extras: DesktopCaptureExtras): void {
  try {
    extras.callNames?.set(false).catch(() => {});
  } catch {
    // The choice stands.
  }
}
