// TC-1152 S2c-1: what the Combine flow needs to know about a member's stored transcript body
// before it hands the pair to the stitcher: how many segments it holds (the size guard) and how
// long its recorded span is (the overlap figure on the confirm sheet). The stitcher does its own
// strict parsing; this only reads the three shapes a stored body has (an array, `{sentences}`,
// `{segments}`) and answers null for anything else.

/**
 * Most segments one capture may hold for the Combine flow. Opus's #454 delta review measured the
 * stitcher's quadratic steps at about 0.26 s at 3k segments, 1.8 s at 12k and 6.6 s at 24k per member
 * (a 3-hour meeting is ~700). The flow also runs it in a Worker, so a long check never freezes the
 * screen; this limit keeps a run to a few seconds.
 */
export const COMBINE_MAX_SEGMENTS_PER_MEMBER = 10_000;

/** The fields of a segment this module reads; the stitcher validates the rest. */
export interface BodySegment {
  start_time?: unknown;
  end_time?: unknown;
  start?: unknown;
  end?: unknown;
}

/** The segments of a stored body (a JSON string or already parsed), or null when it is none of the known shapes. */
export function bodySegments(body: unknown): BodySegment[] | null {
  let value: unknown = body;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return null; }
  }
  const holder = value as { sentences?: unknown; segments?: unknown } | null;
  const list = Array.isArray(value) ? value : Array.isArray(holder?.sentences) ? holder.sentences : holder?.segments;
  return Array.isArray(list) ? (list as (BodySegment | null)[]).filter((s): s is BodySegment => typeof s === "object" && s !== null) : null;
}

/** First start and last end, in seconds from the capture's own start; null when no segment has times. */
export function bodySpan(segments: readonly BodySegment[]): { first: number; last: number } | null {
  let first = Infinity;
  let last = -Infinity;
  for (const s of segments) {
    const start = Number(s.start_time ?? s.start);
    const end = Number(s.end_time ?? s.end ?? s.start_time ?? s.start);
    if (Number.isFinite(start) && start < first) first = start;
    if (Number.isFinite(end) && end > last) last = end;
  }
  return first <= last ? { first, last } : null;
}
