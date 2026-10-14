export const FIREFLIES_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export function isFirefliesStale(
  lastSuccessAt: string | null,
  now = Date.now(),
): boolean {
  if (!lastSuccessAt) return true;
  const timestamp = Date.parse(lastSuccessAt);
  return !Number.isFinite(timestamp) || now - timestamp > FIREFLIES_STALE_AFTER_MS;
}
