// A recording's title is `connector_meeting.title`. A title the user typed is marked in the row's
// metadata so no auto-titling, re-transcribe or re-sync replaces it:
//
//   title:    "Q4 planning call"
//   metadata: { "title_user": true, "title_auto_value": "Oct 9 · AssemblyAI Universal-2 · Ana", ... }
//
// `title_auto_value` is the automatic title the row had, so clearing the name returns to it.
export const TITLE_USER_KEY = "title_user";
export const TITLE_AUTO_VALUE_KEY = "title_auto_value";
export const MAX_RECORDING_TITLE_LENGTH = 120;

/** Control characters and runs of whitespace become one space; the ends are trimmed; the length is capped. Empty = no name. */
export function normalizeRecordingTitle(raw: string): string {
  const printable = [...raw].map((ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f) ? " " : ch;
  }).join("");
  return [...printable.replace(/\s+/g, " ").trim()].slice(0, MAX_RECORDING_TITLE_LENGTH).join("").trim();
}

/** True when the recording's title was typed by the user (a list read returns the marker as 1). */
export function hasUserTitle(metadata: unknown): boolean {
  return !!metadata && typeof metadata === "object" && [true, 1].includes((metadata as Record<string, unknown>)[TITLE_USER_KEY] as never);
}

/**
 * What a sync or re-combine writes for a row that already exists: a user's title is kept and the
 * incoming one becomes the automatic title to return to; otherwise the incoming title applies.
 */
export function keepUserTitle(
  existing: { title: string | null; metadata: Record<string, unknown> },
  incoming: { title: string | null; metadata: Record<string, unknown> },
): { title: string | null; metadata: Record<string, unknown> } {
  if (!hasUserTitle(existing.metadata)) return incoming;
  return {
    title: existing.title,
    metadata: { ...incoming.metadata, [TITLE_USER_KEY]: true,
      [TITLE_AUTO_VALUE_KEY]: incoming.title ?? existing.metadata[TITLE_AUTO_VALUE_KEY] ?? null },
  };
}
