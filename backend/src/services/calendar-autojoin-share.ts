/**
 * TC-581 share-if-on-invite: the pure policy. When B's calendar auto-join collides with a capture
 * A's auto-join already started, B gets that transcript only if B's verified Google email is an
 * ACCEPTED attendee on A's own calendar event. A's calendar is the trust anchor, so copying a Meet
 * link into your own calendar gets you nothing. Every uncertain case denies.
 */
import type { CalendarOccurrence } from "./calendar-autojoin-store.js";
import { calendarOccurrenceIdentity, eligibleCalendarEvent, type GoogleCalendarEvent } from "./google-calendar.js";

export type ShareDecision = { ok: true } | { ok: false; reason: string };

/** Half-open windows: 10:00–10:30 and 10:30–11:00 do not overlap. */
export function windowsOverlap(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start < b.end && b.start < a.end;
}

export function shareDecision(
  ownerEvent: GoogleCalendarEvent | null,
  ownerRow: CalendarOccurrence,
  recipientEmail: string | undefined,
): ShareDecision {
  if (!ownerEvent) return { ok: false, reason: "event_missing" };
  const eligible = eligibleCalendarEvent(ownerEvent);
  if (!eligible) return { ok: false, reason: "event_ineligible" };
  if (eligible.meetingUrl !== ownerRow.meetingUrl || eligible.start !== ownerRow.start || eligible.end !== ownerRow.end
    || calendarOccurrenceIdentity(ownerRow.tenant, ownerRow.subject, ownerEvent) !== ownerRow.id) {
    return { ok: false, reason: "event_changed" };
  }
  if (ownerEvent.attendeesOmitted) return { ok: false, reason: "attendees_omitted" };
  if (!recipientEmail) return { ok: false, reason: "no_verified_email" };
  const email = recipientEmail.toLowerCase();
  const accepted = ownerEvent.attendees?.some(attendee =>
    typeof attendee.email === "string" && attendee.email.toLowerCase() === email && attendee.responseStatus === "accepted");
  return accepted ? { ok: true } : { ok: false, reason: "not_accepted_attendee" };
}
