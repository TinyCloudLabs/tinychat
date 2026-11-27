// A note's calendar link on its row (`metadata.calendar_link`), and the meeting code of a Google Meet import
// (`metadata.meeting_code`): the writes the link runner, the user's pick and a disconnect make. Any
// `connector_meeting` row can carry a link (a voice note, an upload, an imported meeting). Each statement changes
// one metadata key in the database, on the metadata as it is when the write runs, and runs on the space lane
// through voiceNoteRows.ts. The row's whole `metadata` is never read back: it can hold a transcript.
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { CALENDAR_LINK_KEY, type CalendarLink } from "@tinyboilerplate/core";

import { execute } from "@/lib/voiceNotes/voiceNoteRows";

/** The row's metadata as JSON functions may read it: a row whose metadata is absent or unreadable counts as empty. */
export const ROW_METADATA = "CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END";

const LINK_PATH = `$.${CALENDAR_LINK_KEY}`;

/**
 * Who writes a link:
 *   automatic  the runner's match: applies only where the row has no `calendar_link` at all, so a link, a pending
 *              pick and the user's "none" (`match.method: "user"` without an event) are never written over;
 *   user       the user's pick or unlink: replaces whatever is stored;
 *   refreshOf  the linked event read again: applies only where the stored `event_id` is still that event.
 */
export type CalendarLinkWrite = "automatic" | "user" | { refreshOf: string };

/**
 * `metadata.calendar_link`, written whole. `updated_at` moves, as for a rename: `writeRecordingTitle` writes the
 * whole metadata back only where it has not moved, and would otherwise erase a link saved between its read and its
 * write. Nothing else of the row changes: not its title, its transcript or its speaker names. False when nothing
 * was written.
 */
export async function writeRowCalendarLink(tcw: TinyCloudWeb, rowId: string, link: CalendarLink, write: CalendarLinkWrite,
  checkpoint: () => void = () => undefined): Promise<boolean> {
  const only = write === "user" ? "" : write === "automatic"
    ? ` AND json_type(${ROW_METADATA}, '${LINK_PATH}') IS NULL`
    : ` AND json_extract(${ROW_METADATA}, '${LINK_PATH}.event_id') = ?`;
  const changes = await execute(tcw,
    `UPDATE connector_meeting SET metadata = json_set(${ROW_METADATA}, '${LINK_PATH}', json(?)), updated_at = ? WHERE id = ?${only}`,
    [JSON.stringify(link), new Date().toISOString(), rowId, ...(typeof write === "object" ? [write.refreshOf] : [])], checkpoint);
  return changes > 0;
}

/**
 * "Remove calendar details from notes": `calendar_link` leaves every row that has one, whatever its state, the
 * user's picks and "none" included. The number of rows changed.
 */
export function clearAllCalendarLinks(tcw: TinyCloudWeb, checkpoint: () => void = () => undefined): Promise<number> {
  return execute(tcw,
    `UPDATE connector_meeting SET metadata = json_remove(metadata, '${LINK_PATH}'), updated_at = ?
      WHERE json_valid(metadata) AND json_type(metadata, '${LINK_PATH}') IS NOT NULL`,
    [new Date().toISOString()], checkpoint);
}

/**
 * The meeting code a Google Meet import's space resolved to (`metadata.meeting_code`), kept so the note still
 * knows its meeting after Google has deleted the conference record. False when the row is not a Google Meet
 * import or already holds this code.
 */
export async function writeRowMeetingCode(tcw: TinyCloudWeb, rowId: string, code: string,
  checkpoint: () => void = () => undefined): Promise<boolean> {
  const changes = await execute(tcw,
    `UPDATE connector_meeting SET metadata = json_set(${ROW_METADATA}, '$.meeting_code', ?), updated_at = ?
      WHERE id = ? AND source = 'google-meet' AND COALESCE(json_extract(${ROW_METADATA}, '$.meeting_code'), '') != ?`,
    [code, new Date().toISOString(), rowId, code], checkpoint);
  return changes > 0;
}
