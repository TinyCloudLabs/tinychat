import { openSettingsUnavailable } from "@/lib/voiceNotes/captureEngine";
import { FINAL_COPY } from "../finalCopy";

export const BROWSER_DENIED_LINE = "Microphone access is off.";
export const BROWSER_REVOKED_LINE = "Microphone permission was revoked.";

/** The status line for a denied microphone; a browser has no Settings to open, so it is not told to. */
export const deniedLine = (): string => (openSettingsUnavailable() ? BROWSER_DENIED_LINE : FINAL_COPY.denied);
export const revokedLine = (): string => (openSettingsUnavailable() ? BROWSER_REVOKED_LINE : FINAL_COPY.permissionRevoked);
