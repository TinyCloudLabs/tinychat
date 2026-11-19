import {
  MEETING_DB_DETAILS,
  MEETING_DB_SUMMARIES,
  MEETING_DB_TRANSCRIPTS,
  type MeetingDbPath,
} from "./schema.js";

/** Every meeting database path, exactly as it must appear in a grant. */
export const MEETING_DB_PATHS: readonly MeetingDbPath[] = Object.freeze([
  MEETING_DB_DETAILS,
  MEETING_DB_SUMMARIES,
  MEETING_DB_TRANSCRIPTS,
]);

/** 1: details only. 2: details and summaries. 3: all three databases. */
export type PrivacyLevel = 1 | 2 | 3;

export const DEFAULT_PRIVACY_LEVEL = 2 satisfies PrivacyLevel;

const DATABASES_BY_LEVEL: Readonly<Record<PrivacyLevel, readonly MeetingDbPath[]>> = Object.freeze({
  1: Object.freeze([MEETING_DB_DETAILS]),
  2: Object.freeze([MEETING_DB_DETAILS, MEETING_DB_SUMMARIES]),
  3: Object.freeze([MEETING_DB_DETAILS, MEETING_DB_SUMMARIES, MEETING_DB_TRANSCRIPTS]),
});

/** Database paths a privacy level grants. Throws RangeError for any value other than 1, 2 or 3. */
export function databasesForLevel(level: PrivacyLevel): readonly MeetingDbPath[] {
  if (level !== 1 && level !== 2 && level !== 3) {
    throw new RangeError(`unknown privacy level: ${String(level)}`);
  }
  return DATABASES_BY_LEVEL[level];
}

/**
 * Throws unless `path` is exactly one of the meeting database paths. Trailing
 * slashes, the bare app prefix and any other path are rejected.
 */
export function assertExactMeetingDbPath(path: string): asserts path is MeetingDbPath {
  if (!MEETING_DB_PATHS.includes(path as MeetingDbPath)) {
    throw new Error(
      `not an exact meeting database path: ${JSON.stringify(path)}; expected one of ${MEETING_DB_PATHS.join(", ")}`,
    );
  }
}
