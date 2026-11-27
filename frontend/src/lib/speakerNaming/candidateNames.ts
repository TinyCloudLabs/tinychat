// The people who may be speaking in a voice note, as far as the user's own space knows them. The list goes to the
// naming model, which uses it only for spelling ("Varella" in the transcript is Varela on the list); with an empty
// list naming still runs and gives the names as the recording says them.
//
// Five sources, in this order:
//   1. the people the desktop app read from the meeting window while this note was recorded
//      (`metadata.call_participants`): they were in this call. All of them, the user's own entry included;
//   2. the people invited to the calendar event the note is linked to (`metadata.calendar_link.invitees`), by
//      display name only and without the user's own entry: they were invited, which is not the same as being there.
//      Nothing else of the event goes to the model: no address, title, time or response;
//   3. names a new transcript took off this note's numbered speakers (`metadata.earlier_speaker_names`);
//   4. names the user typed for speakers of any note (`metadata.speaker_names`), newest note first;
//   5. participants of the meetings the connectors brought in during the 180 days before the note: first those of
//      a meeting that ran while the note was recorded, then by how many meetings a name is in.
// Generic labels, email addresses and phone numbers are not names. Compared without case; the first 60 are kept.
import { CONNECTORS_SQL_DB_NAME, FIREFLIES_MEETING_SOURCE } from "@tinyboilerplate/core";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { cleanSpeakerName, SPEAKER_NAMES_KEY } from "@/capture/library/speakerNames";
import { GMEET_MEETING_SOURCE } from "@/lib/connectors/gmeetNormalize";
import { GRANOLA_CSV_SOURCE } from "@/lib/connectors/granolaCsv";
import { isPersonName } from "@/lib/meetingTitle";

export const MAX_CANDIDATE_NAMES = 60;
export const CANDIDATE_WINDOW_DAYS = 180;

const DAY_MS = 24 * 60 * 60 * 1000;
const MEETING_SOURCES = [FIREFLIES_MEETING_SOURCE, GMEET_MEETING_SOURCE, GRANOLA_CSV_SOURCE] as const;

export interface CandidateSources {
  /** The names in this note's `call_participants`, in stored order. */
  call: readonly string[];
  /** The display names of the people invited to the note's linked calendar event (`calendarLinkInviteeNames`); none when absent. */
  invited?: readonly string[];
  /** This note's `earlier_speaker_names`, oldest first. */
  earlier: readonly string[];
  /** Every value of `speaker_names` across the user's rows, newest row first. A value can hold several names ("Alice, Bob"). */
  named: readonly string[];
  /** The meetings in the window, newest first: who took part, and whether it ran while the note was recorded. */
  meetings: readonly { participants: readonly string[]; overlaps: boolean }[];
}

/** The candidate list from what the space holds: cleaned, without duplicates, at most MAX_CANDIDATE_NAMES. */
export function candidateNames(sources: CandidateSources): string[] {
  const held = new Map<string, number>();
  for (const meeting of sources.meetings) {
    for (const key of new Set(meeting.participants.map((name) => cleanSpeakerName(name).toLowerCase()))) held.set(key, (held.get(key) ?? 0) + 1);
  }
  const fromMeetings = (overlapping: boolean) => sources.meetings.filter((meeting) => meeting.overlaps === overlapping)
    .flatMap((meeting) => meeting.participants);
  // A stable sort: names in equally many meetings stay in the order of the meetings, newest first.
  const byFrequency = fromMeetings(false).map((name) => ({ name, count: held.get(cleanSpeakerName(name).toLowerCase()) ?? 0 }))
    .sort((a, b) => b.count - a.count).map(({ name }) => name);
  const seen = new Set<string>();
  const names: string[] = [];
  for (const raw of [...sources.call, ...sources.invited ?? [], ...sources.earlier, ...sources.named.flatMap((value) => value.split(",")), ...fromMeetings(true), ...byFrequency]) {
    const name = cleanSpeakerName(raw);
    const key = name.toLowerCase();
    if (seen.has(key) || !isPersonName(name)) continue;
    seen.add(key);
    names.push(name);
    if (names.length === MAX_CANDIDATE_NAMES) break;
  }
  return names;
}

function parsed(cell: unknown): unknown {
  if (typeof cell !== "string") return cell;
  try { return JSON.parse(cell) as unknown; } catch { return null; }
}

/** The names in a row's `participants` column: a JSON list of `{ name, email }`. */
function participantNames(cell: unknown): string[] {
  const list = parsed(cell);
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry: { name?: unknown } | string | null) => {
    const name = typeof entry === "string" ? entry : entry?.name;
    return typeof name === "string" ? [name] : [];
  });
}

/**
 * Reads the candidates for one note from the space; `note` is what its own row holds. The two queries return
 * `participants` and the `speaker_names` value only, never a row's whole `metadata`: that can hold 50 KB of
 * transcript per row. Throws when the space cannot be read.
 */
export async function readCandidateNames(space: Pick<TinyCloudWeb, "sql">,
  note: { call: readonly string[]; invited?: readonly string[]; earlier: readonly string[]; startedAt: string | null; durationSecs: number | null }): Promise<string[]> {
  const db = space.sql.db(CONNECTORS_SQL_DB_NAME);
  const named = await db.query(
    `SELECT json_extract(metadata, '$.${SPEAKER_NAMES_KEY}') FROM connector_meeting
      WHERE json_valid(metadata) AND json_extract(metadata, '$.${SPEAKER_NAMES_KEY}') IS NOT NULL ORDER BY started_at DESC`, []);
  if (!named.ok) throw new Error(`Read speaker names: ${named.error.message}`);
  const typed = (named.data.rows as unknown[][]).flatMap((row) => {
    const names = parsed(row[0]);
    return names !== null && typeof names === "object" ? Object.values(names).filter((name): name is string => typeof name === "string") : [];
  });

  const start = Date.parse(note.startedAt ?? "");
  let meetings: CandidateSources["meetings"] = [];
  if (Number.isFinite(start)) {
    const end = start + Math.max(0, note.durationSecs ?? 0) * 1000;
    // Stored times are ISO strings and compare as text; a day of slack, and the exact test below, cover any that
    // are written with another offset.
    const rows = await db.query(
      `SELECT participants, started_at, duration_secs FROM connector_meeting
        WHERE source IN (${MEETING_SOURCES.map(() => "?").join(", ")}) AND started_at >= ? AND started_at <= ? ORDER BY started_at DESC`,
      [...MEETING_SOURCES, new Date(start - (CANDIDATE_WINDOW_DAYS + 1) * DAY_MS).toISOString(), new Date(end + DAY_MS).toISOString()]);
    if (!rows.ok) throw new Error(`Read meeting participants: ${rows.error.message}`);
    meetings = (rows.data.rows as unknown[][]).flatMap((row) => {
      const began = Date.parse(typeof row[1] === "string" ? row[1] : "");
      if (!Number.isFinite(began) || began < start - CANDIDATE_WINDOW_DAYS * DAY_MS || began > end) return [];
      const ended = began + Math.max(0, Number(row[2]) || 0) * 1000;
      return [{ participants: participantNames(row[0]), overlaps: ended >= start }];
    });
  }
  return candidateNames({ call: note.call, invited: note.invited, earlier: note.earlier, named: typed, meetings });
}
