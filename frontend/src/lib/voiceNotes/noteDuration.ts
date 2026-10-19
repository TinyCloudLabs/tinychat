/**
 * The one duration a voice note is judged by, in seconds.
 *
 * Precedence: the capture's exact `duration_ms` (written by every save since the
 * fractional-duration change) wins. Otherwise a stored fractional `duration_secs`
 * is exact. A stored integer with no capture is a legacy row that was rounded to
 * the nearest second, so the real duration is at most half a second above it:
 * `stored + 0.5` is the conservative upper bound used for admission. `null` when
 * neither source says.
 */
export function preciseDurationSeconds(storedSecs: number | null, captureDurationMs: unknown): number | null {
  if (typeof captureDurationMs === "number" && Number.isFinite(captureDurationMs) && captureDurationMs >= 0) {
    return captureDurationMs / 1000;
  }
  if (typeof storedSecs !== "number" || !Number.isFinite(storedSecs) || storedSecs < 0) return null;
  return Number.isInteger(storedSecs) ? storedSecs + 0.5 : storedSecs;
}

/** `capture.duration_ms` from a row's metadata (JSON text or parsed object); `undefined` when absent or malformed. */
export function captureDurationMs(metadata: unknown): unknown {
  let parsed: unknown = metadata;
  if (typeof metadata === "string") {
    try {
      parsed = JSON.parse(metadata);
    } catch {
      return undefined;
    }
  }
  if (!parsed || typeof parsed !== "object" || !("capture" in parsed)) return undefined;
  const capture = parsed.capture;
  if (!capture || typeof capture !== "object" || !("duration_ms" in capture)) return undefined;
  return capture.duration_ms;
}
