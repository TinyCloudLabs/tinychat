// TC-3195: the lines the share screens build from a share's display (approved mock copy).
import { senderLabel, sourceLabel, type RecordingShareDisplay } from "@/lib/nativeShares/display";
import type { ReceivedRecordingShare } from "@/lib/nativeShares/receivedShares";
import { formatSpokenDuration, shortDate, timeOfDay } from "../library/formatters";

const ENDS_SOON_MS = 7 * 86_400_000;

/** "Meeting · Nov 16 · 32 min". */
export function shareItemLine(display: RecordingShareDisplay, now: Date): string {
  const parts = [sourceLabel(display.source), shortDate(new Date(display.recordedAt), now)];
  if (display.durationSeconds !== null) parts.push(formatSpokenDuration(display.durationSeconds));
  return parts.join(" · ");
}

/** A Shared with me row: "From Alex Chen · Nov 16", "… · Ends Nov 20" near the end, "… · No longer shared". */
export function sharedRowMeta(record: ReceivedRecordingShare, now: Date): string {
  const from = `From ${senderLabel(record.display, record.owner.address)}`;
  if (record.revokedAt) return `${from} · No longer shared`;
  const ends = Date.parse(record.accessExpiresAt);
  if (ends - now.getTime() < ENDS_SOON_MS) return `${from} · Ends ${shortDate(new Date(ends), now)}`;
  return `${from} · ${shortDate(new Date(record.display.recordedAt), now)}`;
}

/** "Shared by Alex Chen · Nov 16, 2:00 PM · 32 min"; once revoked, "Shared by Alex Chen · Oct 28". */
export function sharedDetailMeta(record: ReceivedRecordingShare, now: Date): string {
  const recorded = new Date(record.display.recordedAt);
  const by = `Shared by ${senderLabel(record.display, record.owner.address)}`;
  if (record.revokedAt) return `${by} · ${shortDate(recorded, now)}`;
  const parts = [by, `${shortDate(recorded, now)}, ${timeOfDay(recorded)}`];
  if (record.display.durationSeconds !== null) parts.push(formatSpokenDuration(record.display.durationSeconds));
  return parts.join(" · ");
}

/** "Opened by 1 person", "Opened by 3 people". */
export function openedByText(count: number): string {
  return `Opened by ${count} ${count === 1 ? "person" : "people"}`;
}
