/**
 * The length a player shows: the media's own once it reports a real one, else the length the
 * recording was saved with. A streamed or header-less file reports Infinity or NaN (and some
 * WebViews 0) until it is fully read; the saved length is known before anything loads.
 */
export function playbackDuration(knownSecs: number | null | undefined, mediaSecs: number): number | null {
  if (Number.isFinite(mediaSecs) && mediaSecs > 0) return mediaSecs;
  if (typeof knownSecs === "number" && Number.isFinite(knownSecs) && knownSecs > 0) return knownSecs;
  return null;
}

/** Where a scrubber value lands: inside the clip, whatever the slider reports. */
export function scrubTarget(value: number, durationSecs: number | null): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return durationSecs === null ? value : Math.min(value, durationSecs);
}
