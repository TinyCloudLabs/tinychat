import type { CalendarOccurrence } from "./calendar-autojoin-store.js";
import type { CalendarAutojoinStatus } from "./calendar-autojoin-status-cache.js";

/** Only outcomes are materialized: current connection policy/timestamps remain authoritative. */
export interface CalendarAutojoinStatusSummary {
  version: 1;
  outcomes: CalendarAutojoinStatus["outcomes"];
}

/** The existing status filter, priority, ordering and 30-outcome limit, shared by every publisher. */
export function calendarAutojoinOutcomes(rows: readonly CalendarOccurrence[]): CalendarAutojoinStatus["outcomes"] {
  return rows
    .filter(row => !!row.errorCode || ["missed", "missed_window", "not_accepted", "failed", "event_ineligible", "event_changed", "already_recorded", "unverified_capture", "capacity_exhausted"].includes(row.disposition ?? ""))
    // RSVP hints fill only spare slots; future unanswered invites must not hide real failures.
    .sort((a, b) => Number((a.errorCode ?? a.disposition) === "not_accepted")
      - Number((b.errorCode ?? b.disposition) === "not_accepted") || b.start - a.start).slice(0, 30)
    .map(row => ({ id: row.id, title: row.title, start: row.start,
      reason: row.errorCode ?? row.disposition ?? "failed", ...(row.meetingId ? { meetingId: row.meetingId } : {}) }));
}
