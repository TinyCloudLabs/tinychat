import type { DesktopCaptureExtras } from "@/lib/voiceNotes/desktopCaptureExtras";

export const SYSTEM_AUDIO_TITLE = "Also record this Mac's audio?";
export const SYSTEM_AUDIO_BODY = "Exo can record everything this Mac plays, such as the other side of calls, videos and notifications, as Them alongside your mic as Me. A note's channel layout is set when it starts; changes during a note apply to its next recording segment.";
export const SYSTEM_AUDIO_RECORD = "Record this Mac's audio";
export const SYSTEM_AUDIO_MIC_ONLY = "Mic only";

export async function needsSystemAudioDisclosure(extras: DesktopCaptureExtras): Promise<boolean> {
  const [enabled, consented] = await Promise.all([extras.systemAudio.get(), extras.systemAudioConsent.get()]);
  return enabled && !consented;
}

export async function chooseSystemAudio(extras: DesktopCaptureExtras, choice: "record" | "mic-only"): Promise<void> {
  if (choice === "mic-only") await extras.systemAudio.set(false);
  await extras.systemAudioConsent.set(true);
}
