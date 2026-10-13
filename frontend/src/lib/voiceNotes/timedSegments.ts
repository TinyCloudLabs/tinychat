/** Split an engine range only when it is too long for a seekable transcript row.
 * The interior boundaries are estimates, so callers must retain `coarse`.
 */
export function splitLongTimedSegment<T extends { start: number; end: number; text: string; timing?: "engine" | "coarse" | "unknown" }>(
  segment: T, maxDuration: number,
): T[] {
  if (segment.end - segment.start <= maxDuration) return [segment];
  const words = segment.text.trim().split(/\s+/);
  const count = Math.ceil((segment.end - segment.start) / maxDuration);
  const byCharacter = words.length < count;
  const tokens = byCharacter ? Array.from(segment.text) : words;
  const pieces: T[] = [];
  for (let i = 0; i < count; i++) {
    const from = Math.floor(i * tokens.length / count);
    const to = Math.floor((i + 1) * tokens.length / count);
    if (from === to) continue;
    pieces.push({ ...segment,
      start: segment.start + (segment.end - segment.start) * i / count,
      end: segment.start + (segment.end - segment.start) * (i + 1) / count,
      text: tokens.slice(from, to).join(byCharacter ? "" : " "), timing: "coarse" });
  }
  return pieces;
}
