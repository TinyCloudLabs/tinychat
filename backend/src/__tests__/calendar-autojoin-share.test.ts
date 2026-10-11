// TC-581: share-if-on-invite. The bot owner's (A's) own calendar event is the trust anchor; the
// recipient (B) gets the transcript only as an accepted attendee on it, by verified email.
import { describe, expect, test } from "bun:test";
import { shareDecision, windowsOverlap } from "../services/calendar-autojoin-share.js";
import type { CalendarOccurrence } from "../services/calendar-autojoin-store.js";
import { calendarOccurrenceIdentity, eligibleCalendarEvent, type GoogleCalendarEvent } from "../services/google-calendar.js";

const OWNER = "0xaaaa";
const SUBJECT = "owner-subject";
const START = Date.parse("2026-09-25T12:00:00Z");
const RECIPIENT = "bee@example.test";

const ownerEvent = (patch: Partial<GoogleCalendarEvent> = {}): GoogleCalendarEvent => ({
  id: "owner-event", status: "confirmed", summary: "Team sync", organizer: { self: true, email: "owner@example.test" },
  start: { dateTime: new Date(START).toISOString() }, end: { dateTime: new Date(START + 1_800_000).toISOString() },
  hangoutLink: "https://meet.google.com/abc-defg-hij",
  attendees: [
    { email: "owner@example.test", self: true, responseStatus: "accepted" },
    { email: RECIPIENT, responseStatus: "accepted" },
  ],
  ...patch,
});

function ownerRow(event = ownerEvent()): CalendarOccurrence {
  const eligible = eligibleCalendarEvent(event)!;
  return { id: calendarOccurrenceIdentity(OWNER, SUBJECT, event)!, tenant: OWNER, subject: SUBJECT, ...eligible,
    phase: "sent", nextAttemptAt: 0, attemptCount: 0, stopRequested: false, meetingId: "mtg_owner", updatedAt: 0 };
}

const withRecipient = (responseStatus: string, email = RECIPIENT) => ownerEvent({ attendees: [
  { email: "owner@example.test", self: true, responseStatus: "accepted" }, { email, responseStatus },
] });

describe("shareDecision", () => {
  test("an accepted attendee is allowed", () => {
    expect(shareDecision(ownerEvent(), ownerRow(), RECIPIENT)).toEqual({ ok: true });
  });

  test.each(["tentative", "declined", "needsAction"])("a %s attendee is denied", (status) => {
    expect(shareDecision(withRecipient(status), ownerRow(), RECIPIENT)).toEqual({ ok: false, reason: "not_accepted_attendee" });
  });

  test("an account not on the guest list is denied", () => {
    const event = ownerEvent({ attendees: [{ email: "owner@example.test", self: true, responseStatus: "accepted" }] });
    expect(shareDecision(event, ownerRow(event), RECIPIENT)).toEqual({ ok: false, reason: "not_accepted_attendee" });
    const noList = ownerEvent({ attendees: undefined });
    expect(shareDecision(noList, ownerRow(noList), RECIPIENT)).toEqual({ ok: false, reason: "not_accepted_attendee" });
  });

  test("the email match is case-insensitive", () => {
    expect(shareDecision(withRecipient("accepted", "Bee@Example.TEST"), ownerRow(), RECIPIENT)).toEqual({ ok: true });
  });

  test.each(["bee+tag@example.test", "b.ee@example.test", "bee@example.test.evil", "bee@mail.example.test"])(
    "an alias or variant (%s) is denied", (email) => {
      expect(shareDecision(withRecipient("accepted", email), ownerRow(), RECIPIENT)).toEqual({ ok: false, reason: "not_accepted_attendee" });
    });

  test("a truncated attendee list is denied", () => {
    const event = ownerEvent({ attendeesOmitted: true });
    expect(shareDecision(event, ownerRow(), RECIPIENT)).toEqual({ ok: false, reason: "attendees_omitted" });
  });

  test("a missing recipient email is denied", () => {
    expect(shareDecision(ownerEvent(), ownerRow(), undefined)).toEqual({ ok: false, reason: "no_verified_email" });
    expect(shareDecision(ownerEvent(), ownerRow(), "")).toEqual({ ok: false, reason: "no_verified_email" });
  });

  test("the owner's event gone (404/null) is denied", () => {
    expect(shareDecision(null, ownerRow(), RECIPIENT)).toEqual({ ok: false, reason: "event_missing" });
  });

  test("the owner's event cancelled is denied", () => {
    expect(shareDecision(ownerEvent({ status: "cancelled" }), ownerRow(), RECIPIENT)).toEqual({ ok: false, reason: "event_ineligible" });
  });

  test("the owner's event moved is denied", () => {
    const moved = ownerEvent({ start: { dateTime: new Date(START + 3_600_000).toISOString() }, end: { dateTime: new Date(START + 5_400_000).toISOString() } });
    expect(shareDecision(moved, ownerRow(), RECIPIENT)).toEqual({ ok: false, reason: "event_changed" });
  });

  test("the owner's event with a new Meet link is denied", () => {
    expect(shareDecision(ownerEvent({ hangoutLink: "https://meet.google.com/xyz-abcd-efg" }), ownerRow(), RECIPIENT))
      .toEqual({ ok: false, reason: "event_changed" });
  });

  test("a different event identity is denied", () => {
    expect(shareDecision(ownerEvent({ id: "another-event" }), ownerRow(), RECIPIENT)).toEqual({ ok: false, reason: "event_changed" });
  });
});

describe("windowsOverlap", () => {
  const at = (h: number, m: number) => Date.parse(`2026-09-25T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`);
  test("back-to-back windows do not overlap", () => {
    expect(windowsOverlap({ start: at(10, 0), end: at(10, 30) }, { start: at(10, 30), end: at(11, 0) })).toBe(false);
    expect(windowsOverlap({ start: at(10, 30), end: at(11, 0) }, { start: at(10, 0), end: at(10, 30) })).toBe(false);
  });
  test("overlapping and contained windows overlap", () => {
    expect(windowsOverlap({ start: at(10, 0), end: at(10, 31) }, { start: at(10, 30), end: at(11, 0) })).toBe(true);
    expect(windowsOverlap({ start: at(10, 0), end: at(11, 0) }, { start: at(10, 15), end: at(10, 45) })).toBe(true);
  });
});
