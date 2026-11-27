import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { GoogleCalendarEvent } from "@tinyboilerplate/core";

import { captureEvents, type LibraryChangedDetail } from "@/capture/captureEvents";
import { disconnectCalendarLink, readCalendarLinkStatus } from "@/lib/connectors/googleCalendarLink";
import { at, BACKEND, calendarLinkSpace, meet, timed, type CalendarLinkSpace } from "./calendarLinkSpace.fixture";
import { calendarLinkRunner, type CalendarLinkRunner } from "./linkRunner";

const VOICE = "exo-voice-note";
const MEET = "google-meet";
const HOUR = 60 * 60_000;
/** The same instant as a calendar in Europe/Zurich writes it in winter. */
const zurich = (iso: string) => new Date(Date.parse(iso) + HOUR).toISOString().replace(".000Z", "+01:00");
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

let space: CalendarLinkSpace;
let runner: CalendarLinkRunner;
let changed: (LibraryChangedDetail | undefined)[];
let stopListening: () => void;

const consider = async (...notes: { source: string; sourceId: string }[]) => {
  for (const note of notes) runner.consider(note.source, note.sourceId);
  await runner.idle();
};
const disconnect = (removeDetails = false) =>
  disconnectCalendarLink({ tcw: space.tcw, backendUrl: BACKEND, sessionStore: space.sessionStore, removeDetails, fetchImpl: space.fetchImpl });

beforeAll(() => { import.meta.env.VITE_CALENDAR_LINKING = "true"; });
afterAll(() => { delete import.meta.env.VITE_CALENDAR_LINKING; });
beforeEach(async () => {
  space = calendarLinkSpace();
  await space.connect();
  runner = calendarLinkRunner(space.deps)!;
  changed = [];
  stopListening = captureEvents.on("library-changed", (detail) => changed.push(detail));
});
afterEach(() => { stopListening(); runner.cancelAll(); });

describe("linking a note by time", () => {
  test("a note recorded inside one meeting is linked to it, with its invitees and nobody's address", async () => {
    space.google.events = [timed("standup", at(10), at(11), {
      organizer: { displayName: "Dana Organizer", email: "dana@example.com" },
      attendees: [
        { displayName: "Alice Chen", email: "alice@example.com", responseStatus: "accepted" },
        { self: true, displayName: "Robin Sample", email: "robin@example.com", responseStatus: "accepted" },
        { email: "nameless@example.com", responseStatus: "needsAction", optional: true },
      ],
    })];
    const note = await space.add(VOICE, "n1", at(10.1), 1500);

    await consider(note);

    expect(space.link(note.id)).toEqual({
      v: 1, provider: "google", calendar: "primary", event_id: "standup", title: "Event standup", start: at(10), end: at(11),
      invitees: [
        { name: "Dana Organizer", response: "accepted", organizer: true },
        { name: "Alice Chen", response: "accepted" },
        { name: "Robin Sample", response: "accepted", self: true },
        { name: "", response: "needsAction", optional: true },
      ],
      attendees_omitted: false,
      match: { method: "time_overlap", confidence: "medium", overlap: 1, linked_at: expect.any(String) },
      candidates: [],
    });
    expect(space.stored(note.id).metadata).not.toContain("@");
    // The note keeps its own title, and the open note is told to read its row again.
    expect(space.stored(note.id).title).toBe("Recording");
    expect(changed).toEqual([{ source: VOICE, sourceId: "n1" }]);
    // What went to Google asked for no address.
    expect(space.lists()).toHaveLength(1);
    expect(space.lists()[0]!.url).not.toContain("email");
  });

  test("a note that spans the boundary of two back-to-back meetings waits for the user's pick", async () => {
    space.google.events = [timed("first", at(10), at(10.5)), timed("second", at(10.5), at(11))];
    const note = await space.add(VOICE, "n1", at(10.25), 1800);

    await consider(note);

    const link = space.link(note.id)!;
    expect(link.event_id).toBeUndefined();
    expect(link.match).toBeUndefined();
    expect(link.candidates).toEqual([
      { event_id: "first", title: "Event first", start: at(10), end: at(10.5) },
      { event_id: "second", title: "Event second", start: at(10.5), end: at(11) },
    ]);
  });

  test("all-day, declined and cancelled events never link", async () => {
    space.google.events = [
      { id: "all-day", status: "confirmed", summary: "Offsite", start: { date: at(0).slice(0, 10) }, end: { date: at(24).slice(0, 10) } },
      timed("declined", at(10), at(11), { attendees: [{ self: true, responseStatus: "declined" }] }),
      timed("cancelled", at(10), at(11), { status: "cancelled" }),
    ];
    const note = await space.add(VOICE, "n1", at(10.1), 1500);

    await consider(note);

    expect(space.lists()).toHaveLength(1);
    expect(space.link(note.id)).toBeUndefined();
    expect(space.writes()).toEqual([]);
    expect(changed).toEqual([]);
  });

  test("an instance of a series links as that instance, wherever it was moved and whatever zone the calendar writes", async () => {
    space.google.events = [timed("weekly_moved", zurich(at(14)), zurich(at(15)), {
      recurringEventId: "weekly", iCalUID: "weekly@google.com",
      originalStartTime: { dateTime: zurich(at(9)), timeZone: "Europe/Zurich" },
    })];
    const note = await space.add(VOICE, "n1", at(14.05), 3000);

    await consider(note);

    expect(space.link(note.id)).toMatchObject({
      event_id: "weekly_moved", recurring_event_id: "weekly", original_start: at(9), ical_uid: "weekly@google.com",
      start: at(14), end: at(15), match: { method: "time_overlap", confidence: "medium" },
    });
  });

  test("a pasted transcript, a combined meeting and a note without an exact time are not looked up", async () => {
    space.google.events = [timed("standup", at(10), at(11))];
    const notes = [
      await space.add(VOICE, "pasted", at(10.1), 1500, { capture: "pasted" }),
      await space.add("exo-merged", "combined", at(10.1), 1500),
      await space.add(MEET, "gemini-notes", at(10.1), null, { datetime_exact: false }),
      await space.add("fireflies", "undated", null, 1500),
    ];

    await consider(...notes);

    expect(space.lists()).toEqual([]);
    for (const note of notes) expect(space.link(note.id)).toBeUndefined();
    expect(await runner.backfill()).toEqual({ considered: 0, linked: 0, ambiguous: 0, listCalls: 0 });
  });
});

describe("linking a note by its meeting", () => {
  test("a Google Meet import links to the event held in its space, and keeps the code it resolved", async () => {
    await space.connectMeet();
    space.google.spaces.set("abc123", "abc-defg-hij");
    space.google.events = [timed("planning", at(10), at(11), meet("abc-defg-hij")), timed("other-call", at(9.5), at(11.5), meet("xyz-abcd-efg"))];
    const note = await space.add(MEET, "rec-1", at(10.05), 3000, { space: "spaces/abc123", conference_record: "conferenceRecords/rec-1" });

    await consider(note);

    expect(space.link(note.id)).toMatchObject({
      event_id: "planning", conference: { type: "hangoutsMeet", code: "abc-defg-hij" },
      match: { method: "meeting_code", confidence: "high", overlap: 1 },
    });
    expect(space.meta(note.id).meeting_code).toBe("abc-defg-hij");
    // The space was asked about with the Meet connector's token, not with calendar linking's.
    const asked = space.requests.find((request) => request.url.startsWith("https://meet.googleapis.com/v2/spaces/abc123"))!;
    expect(new URL(asked.url).searchParams.get("fields")).toBe("meetingCode");
    expect(space.requests.filter((request) => request.url.endsWith("/oauth/refresh")).map((request) => request.body))
      .toEqual([{ refreshToken: "refresh-link" }, { refreshToken: "refresh-meet" }]);
  });

  test("the same import is not linked by time to an event held in another space", async () => {
    await space.connectMeet();
    space.google.spaces.set("abc123", "abc-defg-hij");
    space.google.events = [timed("other-call", at(10), at(11), meet("xyz-abcd-efg"))];
    const note = await space.add(MEET, "rec-1", at(10.05), 3000, { space: "spaces/abc123" });

    await consider(note);

    expect(space.link(note.id)).toBeUndefined();
    expect(space.meta(note.id)).toEqual({ space: "spaces/abc123", meeting_code: "abc-defg-hij" });
    expect(changed).toEqual([]);
  });

  test("without the Google Meet connector the import's meeting is unknown, and time decides", async () => {
    space.google.events = [timed("other-call", at(10), at(11), meet("xyz-abcd-efg"))];
    const note = await space.add(MEET, "rec-1", at(10.05), 3000, { space: "spaces/abc123" });

    await consider(note);

    expect(space.link(note.id)).toMatchObject({ event_id: "other-call", match: { method: "time_overlap", confidence: "medium" } });
    expect(space.requests.filter((request) => request.url.includes("meet.googleapis.com"))).toEqual([]);
  });

  test("a voice note whose call window gave a meeting code links by it, for Google Meet and for Zoom", async () => {
    const people = { v: 1, source: "call_window", truncated: false, people: [{ id: "p1", name: "Alex Example" }] };
    space.google.events = [
      timed("meet-call", at(10.4), at(11), meet("abc-defg-hij")),
      timed("meet-other", at(10), at(11), meet("xyz-abcd-efg")),
      timed("zoom-call", at(14), at(15), { conferenceData: { entryPoints: [{ entryPointType: "video", uri: "https://zoom.us/j/1234567890" }] } }),
      timed("zoom-other", at(14), at(15), { conferenceData: { entryPoints: [{ entryPointType: "video", uri: "https://zoom.us/j/9876543210" }] } }),
    ];
    const onMeet = await space.add(VOICE, "meet", at(10.1), 3000, { call_participants: { ...people, app: "google-meet", meeting_code: "abc-defg-hij" } });
    const onZoom = await space.add(VOICE, "zoom", at(14.1), 3000, { call_participants: { ...people, app: "zoom", meeting_code: "123 456 7890" } });

    await consider(onMeet, onZoom);

    expect(space.link(onMeet.id)).toMatchObject({ event_id: "meet-call", match: { method: "meeting_code", confidence: "high" } });
    expect(space.link(onZoom.id)).toMatchObject({ event_id: "zoom-call", conference: { type: "zoom", code: "1234567890" }, match: { method: "meeting_code" } });
  });
});

describe("how often the calendar is read", () => {
  test("notes that change together share one listing; notes days apart are listed for one by one", async () => {
    space.google.events = [timed("morning", at(10), at(11)), timed("afternoon", at(15), at(16)), timed("last-week", at(10, -7), at(11, -7))];
    const morning = await space.add(VOICE, "morning", at(10.1), 1500);
    const afternoon = await space.add(VOICE, "afternoon", at(15.1), 1500);

    await consider(morning, afternoon, morning);

    expect(space.lists()).toHaveLength(1);
    const window = new URL(space.lists()[0]!.url).searchParams;
    expect([window.get("timeMin"), window.get("timeMax")]).toEqual([at(9.1), new Date(Date.parse(at(15.1)) + 1500_000 + HOUR).toISOString()]);
    expect(space.link(morning.id)?.event_id).toBe("morning");
    expect(space.link(afternoon.id)?.event_id).toBe("afternoon");

    const lastWeek = await space.add(VOICE, "last-week", at(10.1, -7), 1500);
    const evening = await space.add(VOICE, "evening", at(20), 1500);
    await consider(lastWeek, evening);
    expect(space.lists()).toHaveLength(3);
    expect(space.link(lastWeek.id)?.event_id).toBe("last-week");
  });

  test("a note with a link, or one that matched nothing, is not looked up again", async () => {
    space.google.events = [timed("standup", at(10), at(11))];
    const linked = await space.add(VOICE, "linked", at(10.1), 1500);
    const alone = await space.add(VOICE, "alone", at(20), 1500);
    await consider(linked, alone);
    expect(space.lists()).toHaveLength(1);
    expect(space.link(alone.id)).toBeUndefined();

    await consider(linked, alone);
    await consider(linked, alone);

    expect(space.lists()).toHaveLength(1);
    expect(space.writes()).toHaveLength(1);
  });

  test("a calendar that cannot be read writes nothing, and a note is tried twice in a session", async () => {
    space.google.events = [timed("standup", at(10), at(11))];
    const note = await space.add(VOICE, "n1", at(10.1), 1500);
    const working = space.google.refresh;
    space.google.refresh = () => json({ error: "temporarily_unavailable" }, 503);

    await consider(note);
    await consider(note);
    await consider(note);

    expect(space.requests.filter((request) => request.url.endsWith("/oauth/refresh"))).toHaveLength(2);
    expect(space.lists()).toEqual([]);
    expect(space.link(note.id)).toBeUndefined();
    expect(await readCalendarLinkStatus(space.tcw)).toMatchObject({ state: "connected" });

    // Connecting again starts the count afresh.
    space.google.refresh = working;
    await space.connect();
    await consider(note);
    expect(space.link(note.id)?.event_id).toBe("standup");
  });
});

describe("the user's pick", () => {
  test("choices are the linkable events around the note, those it overlaps first, then the nearest", async () => {
    space.google.events = [
      timed("before", at(5), at(6)),
      timed("after", at(11), at(12)),
      timed("tail", at(10.4), at(11)),
      timed("during", at(9.75), at(10.75)),
      timed("too-late", at(17), at(18)),
      timed("cancelled", at(10), at(11), { status: "cancelled" }),
      { id: "all-day", status: "confirmed", start: { date: at(0).slice(0, 10) }, end: { date: at(24).slice(0, 10) } },
    ];
    const note = await space.add(VOICE, "n1", at(10), 1800);

    expect(await runner.choices(note)).toEqual([
      { event_id: "during", title: "Event during", start: at(9.75), end: at(10.75) },
      { event_id: "tail", title: "Event tail", start: at(10.4), end: at(11) },
      { event_id: "after", title: "Event after", start: at(11), end: at(12) },
      { event_id: "before", title: "Event before", start: at(5), end: at(6) },
    ]);
    const window = new URL(space.lists()[0]!.url).searchParams;
    expect([window.get("timeMin"), window.get("timeMax")]).toEqual([at(4), at(16.5)]);

    space.google.events = Array.from({ length: 14 }, (_, index) => timed(`e${index}`, at(8 + index / 4), at(8.25 + index / 4)));
    expect(await runner.choices(note)).toHaveLength(10);
  });

  test("a picked event is read again from Google and stored as the user's", async () => {
    space.google.events = [timed("first", at(10), at(10.5)), timed("second", at(10.5), at(11))];
    const note = await space.add(VOICE, "n1", at(10.25), 1800);
    await consider(note);
    space.google.events[1] = timed("second", at(10.5), at(11.5), { summary: "Second, renamed" });

    expect(await runner.pick(note, "second")).toBe(true);

    expect(space.link(note.id)).toMatchObject({
      event_id: "second", title: "Second, renamed", end: at(11.5), candidates: [],
      match: { method: "user", confidence: "user", linked_at: expect.any(String) },
    });
    expect(changed).toEqual([{ source: VOICE, sourceId: "n1" }, { source: VOICE, sourceId: "n1" }]);

    // An event that is gone by now cannot be picked.
    expect(await runner.pick(note, "deleted")).toBe(false);
    expect(space.link(note.id)?.event_id).toBe("second");
  });

  test("after None of these, neither a change of the note nor a backfill links it again", async () => {
    space.google.events = [timed("standup", at(10), at(11))];
    const note = await space.add(VOICE, "n1", at(10.1), 1500);
    await consider(note);
    expect(space.link(note.id)?.event_id).toBe("standup");

    expect(await runner.pick(note, null)).toBe(true);
    const none = space.link(note.id)!;
    expect(none).toMatchObject({ invitees: [], candidates: [], match: { method: "user", confidence: "user" } });
    expect(none.event_id).toBeUndefined();

    await consider(note);
    expect(await runner.backfill()).toEqual({ considered: 0, linked: 0, ambiguous: 0, listCalls: 0 });
    expect(space.link(note.id)).toEqual(none);
  });

  test("the calendar's choices and picks need the calendar; unlinking does not", async () => {
    space.google.events = [timed("standup", at(10), at(11))];
    const note = await space.add(VOICE, "n1", at(10.1), 1500);
    await consider(note);
    await disconnect();

    expect(await runner.choices(note)).toBeNull();
    expect(await runner.pick(note, "standup")).toBe(false);
    expect(space.link(note.id)?.event_id).toBe("standup");
    expect(await runner.pick(note, null)).toBe(true);
    expect(space.link(note.id)?.event_id).toBeUndefined();
  });
});

describe("opening a linked note", () => {
  test("stores what changed of its event, once per session, and nothing when nothing changed", async () => {
    space.google.events = [timed("moved", at(10), at(11)), timed("same", at(13), at(14))];
    const moved = await space.add(VOICE, "moved", at(10.1), 1500);
    const same = await space.add(VOICE, "same", at(13.1), 1500);
    await consider(moved, same);
    const [linked, writes] = [space.link(moved.id)!, space.writes().length];
    space.google.events[0] = timed("moved", at(11), at(12), { summary: "Moved and renamed", attendees: [{ displayName: "Alice Chen", responseStatus: "tentative" }] });

    runner.refresh(moved);
    runner.refresh(same);
    await runner.idle();

    expect(space.link(moved.id)).toEqual({ ...linked, title: "Moved and renamed", start: at(11), end: at(12), invitees: [{ name: "Alice Chen", response: "tentative" }] });
    expect(space.writes()).toHaveLength(writes + 1);
    expect(changed.at(-1)).toEqual({ source: VOICE, sourceId: "moved" });

    const sent = space.requests.length;
    runner.refresh(moved);
    runner.refresh(same);
    await runner.idle();
    expect(space.requests).toHaveLength(sent);
  });

  test("an event that was deleted leaves the stored snapshot, marked as missing", async () => {
    space.google.events = [timed("standup", at(10), at(11))];
    const note = await space.add(VOICE, "n1", at(10.1), 1500);
    await consider(note);
    const linked = space.link(note.id)!;
    space.google.events = [];

    runner.refresh(note);
    await runner.idle();

    expect(space.link(note.id)).toEqual({ ...linked, event_missing: true });
  });
});

describe("the backfill", () => {
  /** Six months of a calendar with three meetings a day, and notes recorded in some of them. */
  async function sixMonths() {
    const events: GoogleCalendarEvent[] = [];
    for (let day = 0; day <= 170; day++) {
      events.push(timed(`morning-${day}`, at(9, -day), at(9.5, -day)), timed(`lunch-${day}`, at(13, -day), at(14, -day)), timed(`late-${day}`, at(16, -day), at(16.5, -day)));
    }
    events.push(timed("late-extra", at(16.5, -10), at(17, -10)));
    space.google.events = events;
    const inMeetings = [];
    for (let day = 0; day <= 170; day += 17) inMeetings.push(await space.add(day % 2 ? "fireflies" : VOICE, `lunch-${day}`, at(13.1, -day), 2400));
    const between = await space.add(VOICE, "between", at(16.25, -10), 1800);
    const alone = await space.add(VOICE, "alone", at(3, -50), 600);
    return { inMeetings, between, alone };
  }

  test("links months of notes with one paged listing, and a second run writes nothing", async () => {
    const { inMeetings, between, alone } = await sixMonths();

    const first = await runner.backfill();

    expect(first).toEqual({ considered: 13, linked: 11, ambiguous: 1, listCalls: 3 });
    expect(space.lists()).toHaveLength(3);
    expect(first!.listCalls).toBeLessThanOrEqual(Math.ceil(space.google.events.length / 250));
    for (const [index, note] of inMeetings.entries()) {
      expect(space.link(note.id)).toMatchObject({ event_id: `lunch-${index * 17}`, match: { method: "time_overlap", confidence: "medium" } });
    }
    expect(space.link(between.id)?.candidates.map((candidate) => candidate.event_id)).toEqual(["late-10", "late-extra"]);
    expect(space.link(alone.id)).toBeUndefined();
    // Many rows at once: the Library is told to list again, once.
    expect(changed).toEqual([undefined]);

    const writes = space.writes().length;
    expect(writes).toBe(12);
    expect(await runner.backfill()).toEqual({ considered: 1, linked: 0, ambiguous: 0, listCalls: 1 });
    expect(space.writes()).toHaveLength(writes);
    expect(changed).toEqual([undefined]);
  });

  test("two callers at once share one run", async () => {
    await sixMonths();
    const [one, other] = await Promise.all([runner.backfill(), runner.backfill()]);
    expect(one).toEqual(other);
    expect(space.lists()).toHaveLength(3);
  });

  test("stops listing after 40 pages and links only the notes the listing reached", async () => {
    // An event every ten minutes for ten weeks: more than 40 pages hold.
    const slot = (index: number) => at(index / 6, -80);
    space.google.events = Array.from({ length: 10_300 }, (_, index) => timed(`e${index}`, slot(index), slot(index + 0.5)));
    const reached = await space.add(VOICE, "reached", slot(6.1), 120);
    const beyond = await space.add(VOICE, "beyond", slot(10_200.1), 120);

    expect(await runner.backfill()).toEqual({ considered: 2, linked: 1, ambiguous: 0, listCalls: 40 });

    expect(space.lists()).toHaveLength(40);
    expect(space.link(reached.id)?.event_id).toBe("e6");
    expect(space.link(beyond.id)).toBeUndefined();
  });

  /** A Google Meet import of six weeks ago and one of two days ago, each recorded in a meeting of its own. */
  async function oldAndRecent() {
    space.google.events = [timed("old", at(10, -40), at(11, -40)), timed("recent", at(10, -2), at(11, -2))];
    return {
      old: await space.add(MEET, "old", at(10.1, -40), 1500),
      recent: await space.add(MEET, "recent", at(10.1, -2), 1500),
      since: Date.parse(at(0, -5)),
    };
  }

  test("with since, only the notes from then on are read, and the calendar is listed for them alone", async () => {
    const { old, recent, since } = await oldAndRecent();

    expect(await runner.backfill({ since })).toEqual({ considered: 1, linked: 1, ambiguous: 0, listCalls: 1 });

    expect(space.link(recent.id)?.event_id).toBe("recent");
    expect(space.link(old.id)).toBeUndefined();
    expect(space.lists()).toHaveLength(1);
    const window = new URL(space.lists()[0]!.url).searchParams;
    expect([window.get("timeMin"), window.get("timeMax")]).toEqual([at(10.1, -3), new Date(Date.parse(at(10.1, -1)) + 1500_000).toISOString()]);
  });

  test("a run of every note under way answers a request for the recent ones, with one listing", async () => {
    const { old, recent, since } = await oldAndRecent();

    const [all, recentOnly] = await Promise.all([runner.backfill(), runner.backfill({ since })]);

    expect(all).toEqual({ considered: 2, linked: 2, ambiguous: 0, listCalls: 1 });
    expect(recentOnly).toEqual(all);
    expect(space.lists()).toHaveLength(1);
    expect([space.link(old.id)?.event_id, space.link(recent.id)?.event_id]).toEqual(["old", "recent"]);
  });

  test("a run of the recent notes under way answers a later since, and does not swallow a request for every note", async () => {
    const { old, since } = await oldAndRecent();

    const [recentOnly, later, all] = await Promise.all([runner.backfill({ since }), runner.backfill({ since: since + HOUR }), runner.backfill()]);

    expect(recentOnly).toEqual({ considered: 1, linked: 1, ambiguous: 0, listCalls: 1 });
    expect(later).toEqual(recentOnly);
    // The full request took its turn afterwards and linked what the first run had left.
    expect(all).toEqual({ considered: 1, linked: 1, ambiguous: 0, listCalls: 1 });
    expect(space.lists()).toHaveLength(2);
    expect(space.link(old.id)?.event_id).toBe("old");
  });

  test("answers null when linking is not connected", async () => {
    await sixMonths();
    await disconnect();
    expect(await runner.backfill()).toBeNull();
    expect(space.lists()).toEqual([]);
    expect(space.writes()).toEqual([]);
  });
});

describe("disconnecting", () => {
  test("stops the work under way and every later lookup, and keeps the links unless asked to remove them", async () => {
    space.google.events = [timed("standup", at(10), at(11)), timed("review", at(15), at(16))];
    const linked = await space.add(VOICE, "linked", at(10.1), 1500);
    const late = await space.add(VOICE, "late", at(15.1), 1500);
    await consider(linked);
    const asked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<null>();
    space.google.list = () => { asked.resolve(); return release.promise; };

    runner.consider(late.source, late.sourceId);
    await asked.promise;
    const done = disconnect();
    release.resolve(null);
    expect(await done).toEqual({ upstream: "revoked", removedDetails: null });
    await runner.idle();
    await consider(late);

    expect(space.lists()).toHaveLength(2);
    expect(space.link(late.id)).toBeUndefined();
    expect(space.link(linked.id)?.event_id).toBe("standup");

    await space.connect();
    expect(await disconnect(true)).toEqual({ upstream: "revoked", removedDetails: 1 });
    expect(space.link(linked.id)).toBeUndefined();
    expect(space.requests.filter((request) => request.url.includes("autojoin"))).toEqual([]);
  });
});

describe("one runner per space", () => {
  test("the capture surface and Settings get the same runner; another account gets its own; none when the feature is off", () => {
    expect(calendarLinkRunner({ tcw: space.tcw, backendUrl: BACKEND, sessionStore: space.sessionStore })).toBe(runner);
    const other = calendarLinkSpace();
    expect(calendarLinkRunner(other.deps)).not.toBe(runner);

    delete import.meta.env.VITE_CALENDAR_LINKING;
    try {
      expect(calendarLinkRunner(space.deps)).toBeUndefined();
    } finally {
      import.meta.env.VITE_CALENDAR_LINKING = "true";
    }
  });
});
