// Extracted unchanged from shared/metrics.ts; provenance in origins.ts.
const MINUTE = 60_000;
const pad = (value: number) => String(value).padStart(2, "0");
/** "45m", "3h 20m", "2d 4h". */
export function formatDuration(ms: number): string {
  const minutes = Math.round(Math.max(0, ms) / MINUTE);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}h ${pad(minutes % 60)}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
}
