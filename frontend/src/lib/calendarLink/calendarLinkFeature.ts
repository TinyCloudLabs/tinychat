// Build-time opt-in for calendar linking. Off, nothing of the feature is reachable: no runner, no settings row, no
// chip (a link already stored on a note is not shown), and no invitee among the naming candidates or suggestions.

/** Exact-match "true", the same contract the other VITE_* feature flags use. */
export function calendarLinkingEnabled(): boolean {
  try {
    // Read by its full name, so that a build which defines only this one variable (the screenshot harness) sets it.
    return import.meta.env.VITE_CALENDAR_LINKING === "true";
  } catch {
    // No env injection in this runtime: the flag is off.
    return false;
  }
}
