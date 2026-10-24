/** Lines longer than this are counted and dropped, never parsed. */
export const MAX_LINE_BYTES = 4096;
/** Per (component, event_code) cap per window; the overflow is reported as one `log_dropped` event per key and window. */
export const CAP_PER_WINDOW = 30;
export const CAP_WINDOW_SECONDS = 60;
/**
 * The volume limits, and the ONLY place their default numbers live. They are baked into the generated Vector config as
 * `local max_lines = N` / `local daily_budget = N`; the sidecar's entrypoint replaces them only when the env var
 * (BETTERSTACK_MAX_LINES_PER_MINUTE, BETTERSTACK_DAILY_BYTE_BUDGET) is a positive integer, else the default stays.
 *
 * Arithmetic. The log service's free tier is 3 GB RETAINED with 3-day retention (unconfirmed; the real plan and a
 * measured baseline per source come from the plan owner), shared by every source, so the whole tier's steady ingest is
 * about 1 GB/day. The backend may use about 20% of that, ~200 MB/day. The DEFAULT is deliberately lower:
 *   daily budget 20 MB/day = ~60 MB retained (3 days) = ~2% of the tier.
 * The counter lives in memory, so a sidecar restart may re-spend it: three restarts in a day still stay under
 * ~60 MB/day = ~180 MB retained (~6%). Raising the budget up to ~200 MB/day needs only the env var, no code change.
 * Lines per minute: 120 passed (the whole backend stream, applied before the sinks, so the local copy is capped too); the
 * dropped-count lines add at most 10 + 1 (+ 7 gate summaries), so a sink sees at most 138 lines per minute at the default.
 * At the daily budget the shipper drops logs until 00:00Z; it never exceeds the budget and nothing raises it.
 */
export const DEFAULT_DAILY_BYTE_BUDGET = 20_000_000;
export const DEFAULT_MAX_LINES_PER_MINUTE = 120;
/** Seconds in the budget "day": 86400 = one UTC day (epoch-aligned, so the reset is at 00:00Z). Only the budget check shortens it. */
export const DAY_SECONDS = 86_400;

/**
 * The daily budget's size estimate for one event (a flat object of strings, numbers and booleans). It mirrors `size` in the
 * budget Lua transform and never under-counts the JSON bytes the sink sends: a string field costs key + value + 8, any
 * other field key + text + 6, plus 3 for the braces and the newline.
 */
export function estimateBytes(log) {
  let bytes = 3;
  for (const [key, value] of Object.entries(log)) {
    bytes += Buffer.byteLength(key) + 6;
    bytes += typeof value === 'string' ? Buffer.byteLength(value) + 2 : String(value).length;
  }
  return bytes;
}

/**
 * Ceiling for the daily budget variable: above it the sidecar ignores the variable and keeps the default (a value is never
 * clamped to it). 200 MB/day is about 20% of the free tier (3 GB retained, 3-day window); lifting it is a code change only.
 */
export const MAX_DAILY_BYTE_BUDGET = 200_000_000;
/** At most this many per-key `log_dropped` lines are emitted per window; the rest are folded into the one `log_stream_dropped` count. */
export const MAX_DROPPED_LINES = 10;
/** Gate summaries: one `logship_gate_summary_total` line per gate reason per minute (7 reasons in fields.json). */
export const GATE_SUMMARY_LINES = 7;
/**
 * The exact ceiling on lines reaching a sink in one cap window: the whole-stream cap + the per-key dropped-count lines
 * + the one stream dropped-count line + the gate summaries. The dropped-count lines are NOT inside max_lines, so the ceiling
 * is max_lines + MAX_DROPPED_LINES + 1 + GATE_SUMMARY_LINES (138 at the default of 120).
 */
export const lineCeiling = maxLines => maxLines + MAX_DROPPED_LINES + 1 + GATE_SUMMARY_LINES;
