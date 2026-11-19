/** Split an engine range only when it is too long for a seekable transcript row.
 * The interior boundaries are estimates, so callers must retain `coarse`.
 */
export function splitLongTimedSegment<T extends { start: number; end: number; text: string; timing?: "engine" | "coarse" | "unknown" }>(
  segment: T, maxDuration: number,
): T[] {
  if (segment.end - segment.start <= maxDuration) return [segment];
  const boundaries = [...segment.text.matchAll(/\s+/g)].map((match) => match.index + match[0].length);
  const count = Math.min(Math.ceil((segment.end - segment.start) / maxDuration), boundaries.length + 1);
  const pieces: T[] = [];
  for (let i = 0; i < count; i++) {
    const from = i === 0 ? 0 : boundaries[Math.floor(i * (boundaries.length + 1) / count) - 1]!;
    const to = i === count - 1 ? segment.text.length : boundaries[Math.floor((i + 1) * (boundaries.length + 1) / count) - 1]!;
    pieces.push({ ...segment,
      start: segment.start + (segment.end - segment.start) * i / count,
      end: segment.start + (segment.end - segment.start) * (i + 1) / count,
      text: segment.text.slice(from, to), timing: "coarse" });
  }
  return pieces;
}
