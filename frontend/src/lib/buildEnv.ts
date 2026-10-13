// Shared by vite.config.ts (the `__EXO_BUILD_INFO__` baseline, TC-840): the
// first of several environment variables to actually say something. `??`
// alone is not enough — an exported-but-empty variable ("", or whitespace a
// workflow step produced) would shadow a valid fallback.

/** The first non-empty trimmed value, trimmed; undefined when none say anything. */
export function firstNonEmpty(...values: (string | undefined)[]): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}
