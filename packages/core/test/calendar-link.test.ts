import { describe, expect, test } from "bun:test";

import {
  ambiguousCalendarLink, calendarLinkInviteeNames, calendarLinkState, linkedCalendarLink, matchCalendarEvent,
  parseCalendarLink, refreshedCalendarLink, unlinkedCalendarLink, type CalendarNote, type GoogleCalendarEvent,
} from "../src/index.js";

const at = (time: string) => Date.parse(`2026-11-27T${time}:00Z`);
const note = (start: string, end: string, conference?: CalendarNote["conference"]): CalendarNote =>
  ({ start: at(start), end: at(end), ...(conference ? { conference } : {}) });
const event = (id: string, start: string, end: string, patch: Partial<GoogleCalendarEvent> = {}): GoogleCalendarEvent => ({
  id, status: "confirmed", summary: `Meeting ${id}`,
  start: { dateTime: `2026-11-27T${start}:00Z` }, end: { dateTime: `2026-11-27T${end}:00Z` }, ...patch,
});
const meet = (code: string): Partial<GoogleCalendarEvent> =>
  ({ conferenceData: { conferenceId: code, conferenceSolution: { key: { type: "hangoutsMeet" } } } });

describe("matchCalendarEvent", () => {
  test("a note inside the only meeting links on time", () => {
    const match = matchCalendarEvent(note("10:05", "10:25"), [event("a", "10:00", "10:30")]);
    expect(match).toMatchObject({ kind: "linked", method: "time_overlap", confidence: "medium", overlap: 1, event: { id: "a" } });
  });

  test("a note across two back-to-back meetings is the user's pick, with both offered", () => {
    const match = matchCalendarEvent(note("10:20", "10:40"), [event("a", "10:00", "10:30"), event("b", "10:30", "11:00")]);
    expect(match.kind).toBe("ambiguous");
    expect(match.kind === "ambiguous" && match.candidates.map(candidate => candidate.id)).toEqual(["a", "b"]);
  });

  test("the same meeting code links with high confidence, to the instance that overlaps", () => {
    const series = { ...meet("abc-defg-hij"), recurringEventId: "weekly" };
    const match = matchCalendarEvent(note("10:02", "10:28", { type: "hangoutsMeet", code: "abc-defg-hij" }), [
      event("weekly_1", "10:00", "10:30", series),
      // Another instance of the series, on the same code, later the same day: the code alone does not pick it.
      event("weekly_2", "15:00", "15:30", series),
      event("other", "10:00", "10:30"),
    ]);
    expect(match).toMatchObject({ kind: "linked", method: "meeting_code", confidence: "high", event: { id: "weekly_1" } });
  });

  test("an event with a different known code is never matched on time", () => {
    const known = { type: "hangoutsMeet", code: "abc-defg-hij" } as const;
    expect(matchCalendarEvent(note("10:00", "10:30", known), [event("a", "10:00", "10:30", meet("zzz-zzzz-zzz"))])).toEqual({ kind: "none" });
    // An event with no conference at all can still link by time.
    expect(matchCalendarEvent(note("10:00", "10:30", known), [event("a", "10:00", "10:30", meet("zzz-zzzz-zzz")), event("b", "10:00", "10:30")]))
      .toMatchObject({ kind: "ambiguous", candidates: [{ id: "b" }] });
    expect(matchCalendarEvent(note("10:00", "10:30", known), [event("b", "10:00", "10:30")]))
      .toMatchObject({ kind: "linked", method: "time_overlap", event: { id: "b" } });
  });

  test("all-day, declined, cancelled and non-default events never link", () => {
    const within = note("10:05", "10:25");
    for (const unlinkable of [
      { id: "day", status: "confirmed", start: { date: "2026-11-27" }, end: { date: "2026-11-28" } },
      event("declined", "10:00", "10:30", { attendees: [{ self: true, responseStatus: "declined" }] }),
      event("cancelled", "10:00", "10:30", { status: "cancelled" }),
      event("focus", "10:00", "10:30", { eventType: "focusTime" }),
      event("hold", "10:00", "10:30", { transparency: "transparent" }),
    ] satisfies GoogleCalendarEvent[]) expect(matchCalendarEvent(within, [unlinkable])).toEqual({ kind: "none" });
    // A "free" event that carries a conference is a meeting.
    expect(matchCalendarEvent(within, [event("free", "10:00", "10:30", { transparency: "transparent", ...meet("abc-defg-hij") })]).kind).toBe("linked");
  });

  test("times are compared as instants, whatever zone each side was written in", () => {
    const zurich = event("z", "10:00", "10:30", { start: { dateTime: "2026-11-27T11:00:00+01:00", timeZone: "Europe/Zurich" },
      end: { dateTime: "2026-11-27T11:30:00+01:00", timeZone: "Europe/Zurich" } });
    // The note was recorded on a Mac in New York: 05:02 to 05:28 local.
    const recorded = { start: Date.parse("2026-11-27T05:02:00-05:00"), end: Date.parse("2026-11-27T05:28:00-05:00") };
    expect(matchCalendarEvent(recorded, [zurich])).toMatchObject({ kind: "linked", event: { id: "z" } });
    // A time without an offset is not read in the host's zone.
    expect(matchCalendarEvent(recorded, [event("naive", "10:00", "10:30", { start: { dateTime: "2026-11-27T10:00:00" } })])).toEqual({ kind: "none" });
  });

  test("a note that starts just before the meeting and runs into it passes; one that only brushes it is offered or dropped", () => {
    // Starts 8 minutes early, 2 of its 10 minutes inside: the start window makes it a match.
    expect(matchCalendarEvent(note("09:52", "10:02"), [event("a", "10:00", "10:30")])).toMatchObject({ kind: "linked", event: { id: "a" } });
    // A two-hour recording that contains a whole 30-minute meeting but starts an hour before it: the user picks.
    expect(matchCalendarEvent(note("09:00", "11:00"), [event("a", "10:00", "10:30")])).toMatchObject({ kind: "ambiguous", candidates: [{ id: "a" }] });
    // Ten minutes of a two-hour recording inside a two-hour meeting: nothing to ask about.
    expect(matchCalendarEvent(note("08:10", "10:10"), [event("a", "10:00", "12:00")])).toEqual({ kind: "none" });
  });

  test("one event passing among several on the calendar links only when it has a conference", () => {
    const events = [event("a", "10:00", "10:30"), event("b", "10:30", "11:00")];
    expect(matchCalendarEvent(note("10:28", "11:00"), events)).toMatchObject({ kind: "ambiguous", candidates: [{ id: "b" }, { id: "a" }] });
    expect(matchCalendarEvent(note("10:28", "11:00"), [events[0]!, event("b", "10:30", "11:00", meet("abc-defg-hij"))]))
      .toMatchObject({ kind: "linked", method: "time_overlap", event: { id: "b" } });
  });

  test("at most three candidates are offered, the best first", () => {
    const match = matchCalendarEvent(note("10:00", "11:00"), ["a", "b", "c", "d"].map((id, index) => event(id, "10:00", `10:${50 - index * 5}`)));
    expect(match.kind === "ambiguous" && match.candidates.map(candidate => candidate.id)).toEqual(["a", "b", "c"]);
  });

  test("a note of unknown length links to the meeting going on when it started", () => {
    expect(matchCalendarEvent(note("10:10", "10:10"), [event("a", "10:00", "10:30")])).toMatchObject({ kind: "linked", event: { id: "a" } });
    expect(matchCalendarEvent(note("10:30", "10:30"), [event("a", "10:00", "10:30")])).toEqual({ kind: "none" });
  });
});

describe("the stored link", () => {
  const invited: GoogleCalendarEvent = event("weekly_20261127T100000Z", "10:00", "10:30", {
    summary: "Weekly sync", recurringEventId: "weekly", originalStartTime: { dateTime: "2026-11-27T09:00:00Z" }, iCalUID: "uid@google.com",
    organizer: { displayName: "Olga Organizer", email: "olga@example.com" },
    attendees: [
      { self: true, displayName: "Sam Self", email: "sam@example.com", responseStatus: "accepted" },
      { displayName: "Alice Chen", email: "alice@example.com", responseStatus: "accepted", optional: true },
      { displayName: "bob@example.com", email: "bob@example.com", responseStatus: "tentative" },
      { email: "nameless@example.com", responseStatus: "bogus" },
      { displayName: "Room 4", resource: true, responseStatus: "accepted" },
    ],
    ...meet("ABC-DEFG-HIJ"),
  });

  test("keeps the instance's identity and the invitees, and no address", () => {
    const link = linkedCalendarLink(invited, { method: "time_overlap", confidence: "medium", overlap: 0.9234 }, "2026-11-27T12:00:00.000Z");
    expect(link).toEqual({
      v: 1, provider: "google", calendar: "primary",
      event_id: "weekly_20261127T100000Z", recurring_event_id: "weekly", original_start: "2026-11-27T09:00:00.000Z", ical_uid: "uid@google.com",
      title: "Weekly sync", start: "2026-11-27T10:00:00.000Z", end: "2026-11-27T10:30:00.000Z",
      conference: { type: "hangoutsMeet", code: "abc-defg-hij" },
      invitees: [
        { name: "Olga Organizer", response: "accepted", organizer: true },
        { name: "Sam Self", response: "accepted", self: true },
        { name: "Alice Chen", response: "accepted", optional: true },
        { name: "", response: "tentative" },
        { name: "", response: "needsAction" },
      ],
      attendees_omitted: false,
      match: { method: "time_overlap", confidence: "medium", overlap: 0.92, linked_at: "2026-11-27T12:00:00.000Z" },
      candidates: [],
    });
    expect(JSON.stringify(link)).not.toContain("example.com");
    expect(calendarLinkState(link)).toBe("linked");
    expect(parseCalendarLink(JSON.parse(JSON.stringify(link)))).toEqual(link);
    expect(calendarLinkInviteeNames(link)).toEqual(["Olga Organizer", "Alice Chen"]);
  });

  test("a moved instance keeps its identity; a deleted one keeps its snapshot", () => {
    const link = linkedCalendarLink(invited, "user", "2026-11-27T12:00:00.000Z");
    const moved = refreshedCalendarLink(link, { ...invited, summary: "Weekly sync (moved)", start: { dateTime: "2026-11-27T14:00:00Z" }, end: { dateTime: "2026-11-27T14:30:00Z" } });
    expect(moved).toMatchObject({ event_id: link.event_id, recurring_event_id: "weekly", original_start: "2026-11-27T09:00:00.000Z",
      title: "Weekly sync (moved)", start: "2026-11-27T14:00:00.000Z", match: { method: "user", confidence: "user" } });
    const gone = refreshedCalendarLink(moved, null);
    expect(gone).toEqual({ ...moved, event_missing: true });
    // The event is back (an undo in Calendar): the mark goes.
    expect(refreshedCalendarLink(gone, invited).event_missing).toBeUndefined();
    expect(refreshedCalendarLink(link, { ...invited, id: "another" })).toBe(link);
  });

  test("waiting for a pick and the user's \"none\" are states of their own, with no invitees to offer", () => {
    const waiting = ambiguousCalendarLink([event("a", "10:00", "10:30"), event("b", "10:30", "11:00")]);
    expect(calendarLinkState(waiting)).toBe("ambiguous");
    expect(waiting.candidates).toEqual([
      { event_id: "a", title: "Meeting a", start: "2026-11-27T10:00:00.000Z", end: "2026-11-27T10:30:00.000Z" },
      { event_id: "b", title: "Meeting b", start: "2026-11-27T10:30:00.000Z", end: "2026-11-27T11:00:00.000Z" },
    ]);
    expect(parseCalendarLink(JSON.parse(JSON.stringify(waiting)))).toEqual(waiting);
    const none = unlinkedCalendarLink("2026-11-27T12:00:00.000Z");
    expect(calendarLinkState(none)).toBe("none");
    expect(parseCalendarLink(JSON.parse(JSON.stringify(none)))).toEqual(none);
    expect(calendarLinkInviteeNames(waiting)).toEqual([]);
    expect(calendarLinkInviteeNames(none)).toEqual([]);
  });

  test("what is not a link reads as none", () => {
    for (const value of [null, "link", [], { v: 2 }, { v: 1, provider: "google", calendar: "primary" },
      { v: 1, provider: "google", calendar: "primary", event_id: "a" }]) expect(parseCalendarLink(value)).toBeNull();
  });
});
