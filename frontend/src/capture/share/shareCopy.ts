// TC-3195: the lines the share screens build from a share's display (approved mock copy).
import { shortAddress, sourceLabel, type RecordingShareDisplay } from "@/lib/nativeShares/display";
import { receivedShareEnded, type ReceivedRecordingShare } from "@/lib/nativeShares/receivedShares";
import { formatSpokenDuration, shortDate, timeOfDay } from "../library/formatters";

const ENDS_SOON_MS = 7 * 86_400_000;

/** "Meeting · Nov 16 · 32 min". */
export function shareItemLine(display: RecordingShareDisplay, now: Date): string {
  const parts = [sourceLabel(display.source), shortDate(new Date(display.recordedAt), now)];
  if (display.durationSeconds !== null) parts.push(formatSpokenDuration(display.durationSeconds));
  return parts.join(" · ");
}

/**
 * A Shared with me row's meta: "From 0xd559…f412", with "Ends Nov 20" near the end, "Ended Nov 20" after it, or
 * "No longer shared" once revoked. All come from the account's own record, never the link; its day header dates it.
 * The state's spaces don't break, so a narrow row moves it to its own line whole.
 */
export function sharedRowMeta(record: ReceivedRecordingShare, now: Date): string {
  const from = `From ${shortAddress(record.owner.address)}`;
  const ends = Date.parse(record.accessExpiresAt);
  const state = record.revokedAt ? "No longer shared"
    : receivedShareEnded(record, now) ? `Ended ${shortDate(new Date(ends), now)}`
    : ends - now.getTime() < ENDS_SOON_MS ? `Ends ${shortDate(new Date(ends), now)}`
    : null;
  return state ? `${from} · ${state.replaceAll(" ", "\u00a0")}` : from;
}

/** A shared row's second line: the title and the length are the row's fields that came with the link. */
export const SHARED_ROW_CUE = "Title and length from the link";

/** "Shared by 0xd559…f412 · Nov 16, 2:00 PM · 32 min"; once revoked or ended, "Shared by 0xd559…f412 · Oct 28". */
export function sharedDetailMeta(record: ReceivedRecordingShare, now: Date): string {
  const recorded = new Date(record.display.recordedAt);
  const by = `Shared by ${shortAddress(record.owner.address)}`;
  if (record.revokedAt || receivedShareEnded(record, now)) return `${by} · ${shortDate(recorded, now)}`;
  const parts = [by, `${shortDate(recorded, now)}, ${timeOfDay(recorded)}`];
  if (record.display.durationSeconds !== null) parts.push(formatSpokenDuration(record.display.durationSeconds));
  return parts.join(" · ");
}

/** "Opened by 1 person", "Opened by 3 people". */
export function openedByText(count: number): string {
  return `Opened by ${count} ${count === 1 ? "person" : "people"}`;
}
