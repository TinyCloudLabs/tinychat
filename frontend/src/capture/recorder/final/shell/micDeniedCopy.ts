import { openSettingsUnavailable } from "@/lib/voiceNotes/captureEngine";
import { FINAL_COPY } from "../finalCopy";

export const BROWSER_DENIED_LINE = "Microphone access is off.";
export const BROWSER_REVOKED_LINE = "Microphone permission was revoked.";

/** The status line for a denied microphone; a browser has no Settings to open, so it is not told to. */
export const deniedLine = (): string => (openSettingsUnavailable() ? BROWSER_DENIED_LINE : FINAL_COPY.denied);
export const revokedLine = (): string => (openSettingsUnavailable() ? BROWSER_REVOKED_LINE : FINAL_COPY.permissionRevoked);

export const OPEN_SETTINGS_FAILED_LINE = "Couldn't open Settings. Open Settings › Exo › Microphone.";

/** What the person sees when opening Settings fails; the cause is only logged, never shown. */
export function openSettingsFailedLine(cause: unknown): string {
  console.error("[Recorder] Could not open Settings", cause);
  return OPEN_SETTINGS_FAILED_LINE;
}
