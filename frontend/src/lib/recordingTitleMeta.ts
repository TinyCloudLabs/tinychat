import { autoMeetingTitle } from "./meetingTitle";

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

function parseObject(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string") return {};
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch { return {}; }
}

/** The automatic title a row returns to when its name is cleared; null when none is known. */
const VOICE_NOTE = "exo-voice-note";
function autoTitleOf(row: { source: string; startedAt: unknown; participants: unknown; metadata: Record<string, unknown> }): string | null {
  const m = row.metadata;
  if (row.source === VOICE_NOTE && m.transcription_outcome === "transcribed") {
    let names: unknown = [];
    try { names = JSON.parse(typeof row.participants === "string" ? row.participants : "[]"); } catch { /* no names */ }
    const recomputed = autoMeetingTitle({ startedAt: row.startedAt,
      participantNames: Array.isArray(names) ? names.map((p) => (p as { name?: unknown } | null)?.name) : [] });
    if (recomputed) return recomputed;
  }
  for (const value of [m.title_auto, m[TITLE_AUTO_VALUE_KEY]]) if (typeof value === "string" && value) return value;
  return null;
}

export interface TitleRow { title: string | null; metadata: string | null; source: string; startedAt: unknown; participants: unknown }

/**
 * The title and metadata a rename writes: `name` (already normalized) is the user's title; an empty `name`
 * returns the row to its automatic title. Null when the row already is what was asked for.
 */
export function planRename(name: string, row: TitleRow): { title: string | null; metadata: Record<string, unknown> } | null {
  const metadata = parseObject(row.metadata);
  const { [TITLE_USER_KEY]: _user, [TITLE_AUTO_VALUE_KEY]: _auto, ...rest } = metadata;
  if (name) {
    const auto = hasUserTitle(metadata) ? metadata[TITLE_AUTO_VALUE_KEY] ?? null : row.title;
    return { title: name, metadata: { ...rest, [TITLE_USER_KEY]: true, [TITLE_AUTO_VALUE_KEY]: auto } };
  }
  if (!hasUserTitle(metadata)) return null;
  // A recorded `title_auto_value` is the captured answer, even when it is null: an originally-untitled row's
  // rename stored null there, so clearing returns the row to null rather than keeping the user's title.
  if (TITLE_AUTO_VALUE_KEY in metadata) return { title: (metadata[TITLE_AUTO_VALUE_KEY] as string | null) ?? null, metadata: rest };
  const auto = autoTitleOf({ source: row.source, startedAt: row.startedAt, participants: row.participants, metadata });
  // `title_auto` stays: an untranscribed note returns to that title, so its commit still names it.
  return { title: auto ?? row.title, metadata: rest };
}
