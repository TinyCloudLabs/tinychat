// Notetaker duration and stop-time rules (TC-2243, PTX #137). The server owns the clock: it caps a
// meeting at four hours from creation and reports `scheduled_stop_at`; this file only decides what
// the UI offers and how the stop time reads.
import type { TranscriberMeeting } from "./transcriberApi";

const HOUR = 3600;
export const MAX_NOTETAKER_DURATION_SECONDS = 4 * HOUR;
export const DEFAULT_NOTETAKER_DURATION_SECONDS = HOUR;

export const NOTETAKER_DURATION_OPTIONS: ReadonlyArray<{ seconds: number; label: string }> = [
  { seconds: 1800, label: "30 minutes" },
  { seconds: HOUR, label: "1 hour" },
  { seconds: 2 * HOUR, label: "2 hours" },
  { seconds: 3 * HOUR, label: "3 hours" },
  { seconds: MAX_NOTETAKER_DURATION_SECONDS, label: "4 hours (maximum)" },
];

export type NotetakerExtensionId = "plus15" | "plus30" | "no-limit";
export type NotetakerExtensionUpdate = { extend_by_seconds: 900 | 1800 } | { max_duration_seconds: null };

export interface NotetakerExtension {
  id: NotetakerExtensionId;
  label: string;
  update: NotetakerExtensionUpdate;
}

export const NOTETAKER_EXTENSIONS: readonly NotetakerExtension[] = [
  { id: "plus15", label: "+15 min", update: { extend_by_seconds: 900 } },
  { id: "plus30", label: "+30 min", update: { extend_by_seconds: 1800 } },
  // "No limit" is still capped at four hours from creation by the server.
  { id: "no-limit", label: "No limit", update: { max_duration_seconds: null } },
];

const NOT_LIVE: Record<string, true | undefined> = { processing: true, completed: true, failed: true, cancelled: true };

/**
 * The extensions to offer on a meeting row: only for a live bot of this account's own, and only
 * while there is room below the four-hour cap. A server that reports no duration predates PTX #137,
 * so nothing is offered there.
 */
export function extensionsFor(meeting: TranscriberMeeting): readonly NotetakerExtension[] {
  if (NOT_LIVE[meeting.status] || meeting.metadata?.shared === true) return [];
  if (typeof meeting.max_duration_seconds !== "number") return [];
  return meeting.max_duration_seconds >= MAX_NOTETAKER_DURATION_SECONDS ? [] : NOTETAKER_EXTENSIONS;
}

/** "Stops at 10:30 AM", with the day when it is not today. Null when the server gave no usable time. */
export function formatStopsAt(iso: string | null | undefined, now: Date = new Date()): string | null {
  if (!iso) return null;
  const stop = new Date(iso);
  if (Number.isNaN(stop.getTime())) return null;
  const clock = stop.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const sameDay = stop.toDateString() === now.toDateString();
  if (sameDay) return `Stops at ${clock}`;
  const day = stop.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `Stops at ${day}, ${clock}`;
}
