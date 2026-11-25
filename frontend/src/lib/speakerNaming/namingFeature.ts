// Build-time opt-in for suggested speaker names. Off, nothing of the feature is reachable: no run, no menu action,
// no setting, and a suggestion already stored on a note is not shown.

/** Exact-match "true", the same contract the other VITE_* feature flags use. */
export function speakerNameSuggestionsEnabled(): boolean {
  try {
    // Read by its full name, so that a build which defines only this one variable (the screenshot harness) sets it.
    return import.meta.env.VITE_SPEAKER_NAME_SUGGESTIONS === "true";
  } catch {
    // No env injection in this runtime: the flag is off.
    return false;
  }
}
