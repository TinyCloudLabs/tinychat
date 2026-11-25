import type { EligibleCalendarEvent, GoogleCalendarEvent } from "./google-calendar.js";

export type CalendarScanClass = "eligible" | "skipped_not_confirmed" | "skipped_not_timed"
  | "skipped_no_meet_link" | "skipped_not_accepted" | "skipped_other";
// Match calendarMeetEvent's offset requirement for non-eligible events only.
function timed(value: string): number {
  return /T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value) ? Date.parse(value) : NaN;
}

/** Classify the already evaluated eligibility and Meet candidate without repeating successful parsing. */
export function classifyCalendarScanEvent(event: GoogleCalendarEvent, eligible: EligibleCalendarEvent | null,
  meet: EligibleCalendarEvent | null): CalendarScanClass {
  if (!event || typeof event.id !== "string" || !event.id || typeof event.status !== "string"
    || (event.attendees !== undefined && !Array.isArray(event.attendees))) return "skipped_other";
  if (eligible) return "eligible";
  const self = event.attendees?.find(attendee => attendee.self);
  if ((self && self.responseStatus !== "accepted") || (!event.organizer?.self && self?.responseStatus !== "accepted")) return "skipped_not_accepted";
  if (event.status !== "confirmed") return "skipped_not_confirmed";
  const startValue = event.start?.dateTime;
  const endValue = event.end?.dateTime;
  if (!startValue || !endValue) return "skipped_not_timed";
  const start = timed(startValue);
  const end = timed(endValue);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return "skipped_not_timed";
  if (!meet) return "skipped_no_meet_link";
  return "skipped_other";
}
