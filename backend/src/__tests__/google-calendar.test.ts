import { describe, expect, test } from "bun:test";
import {
  calendarOccurrenceIdentity, dispatchCutoff, eligibleCalendarEvent, ExternalOperationLimiter,
  GoogleCalendarClient, inDispatchWindow, normalizeGoogleMeetUrl, type GoogleCalendarEvent,
} from "../services/google-calendar.js";

const event = (patch: Partial<GoogleCalendarEvent> = {}): GoogleCalendarEvent => ({
  id: "instance", status: "confirmed", organizer: { self: true }, summary: "Private event",
  start: { dateTime: "2026-11-01T01:30:00-07:00" }, end: { dateTime: "2026-11-01T01:30:00-08:00" },
  hangoutLink: "https://meet.google.com/abc-defg-hij", ...patch,
});

describe("Google Calendar attendance and occurrence policy", () => {
  test("recurring moves and equivalent UTC original times preserve identity across DST", () => {
    const original = event({ recurringEventId: "series", originalStartTime: { dateTime: "2026-11-01T01:30:00-07:00" } });
    const moved = { ...original, id: "moved-instance", originalStartTime: { dateTime: "2026-11-01T08:30:00Z" },
      start: { dateTime: "2026-11-03T13:00:00-08:00" }, hangoutLink: "https://meet.google.com/xyz-abcd-efg" };
    const identity = calendarOccurrenceIdentity("0xAa", "subject", original);
    expect(identity).toBe(calendarOccurrenceIdentity("0xaa", "subject", moved));
    expect(identity).not.toBe(calendarOccurrenceIdentity("0xaa", "subject", { ...original,
      originalStartTime: { dateTime: "2026-11-01T01:30:00-08:00" } }));
    expect(identity).not.toBe(calendarOccurrenceIdentity("0xbb", "subject", original));
    expect(identity).not.toBe(calendarOccurrenceIdentity("0xaa", "another-subject", original));
    expect(calendarOccurrenceIdentity("tenant", "subject", event({ recurringEventId: "series" }))).toBeNull();
  });

  test("single events keep identity across far-future moves, but account changes separate it", () => {
    const current = event();
    const moved = event({ start: { dateTime: "2030-01-01T10:00:00Z" } });
    expect(calendarOccurrenceIdentity("a", "subject", current)).toBe(calendarOccurrenceIdentity("a", "subject", moved));
    expect(calendarOccurrenceIdentity("a", "subject", current)).not.toBe(calendarOccurrenceIdentity("a", "new", moved));
  });

  test("organizer or accepted self is required; explicit non-accepted self excludes even organizer", () => {
    expect(eligibleCalendarEvent(event())).not.toBeNull();
    expect(eligibleCalendarEvent(event({ organizer: { self: false }, attendees: [{ self: true, responseStatus: "accepted" }] }))).not.toBeNull();
    for (const responseStatus of ["declined", "tentative", "needsAction", undefined]) {
      expect(eligibleCalendarEvent(event({ attendees: [{ self: true, responseStatus }] }))).toBeNull();
    }
    expect(eligibleCalendarEvent(event({ organizer: { self: false }, attendees: [{ self: false, responseStatus: "accepted" }] }))).toBeNull();
    for (const status of ["tentative", "cancelled", undefined]) expect(eligibleCalendarEvent(event({ status }))).toBeNull();
    expect(eligibleCalendarEvent({ id: "instance", status: "cancelled" })).toBeNull();
    expect(eligibleCalendarEvent(event({ start: { date: "2026-11-01" }, end: { date: "2026-11-02" } }))).toBeNull();
  });

  test("only exact HTTPS Meet video links qualify, with valid hangout fallback", () => {
    expect(normalizeGoogleMeetUrl("https://meet.google.com/ABC-DEFG-HIJ/?authuser=1#extra"))
      .toBe("https://meet.google.com/abc-defg-hij");
    for (const value of ["http://meet.google.com/abc-defg-hij", "https://meet.google.com.evil/abc-defg-hij",
      "https://evil@meet.google.com/abc-defg-hij", "https://meet.google.com:444/abc-defg-hij",
      "https://meet.google.com/lookup/abc", "https://meet.google.com/abc-defg-hij/extra", "javascript:alert(1)"]) {
      expect(normalizeGoogleMeetUrl(value)).toBeNull();
    }
    expect(eligibleCalendarEvent(event({ conferenceData: { entryPoints: [
      { entryPointType: "phone", uri: "https://meet.google.com/xyz-abcd-efg" },
      { entryPointType: "video", uri: "https://zoom.us/j/123" },
    ] } }))?.meetingUrl).toBe("https://meet.google.com/abc-defg-hij");
    expect(eligibleCalendarEvent(event({ conferenceData: { entryPoints: [
      { entryPointType: "video", uri: "https://meet.google.com/xyz-abcd-efg" },
    ] } }))?.meetingUrl).toBe("https://meet.google.com/xyz-abcd-efg");
  });

  test("the send window excludes ended short events and the five-minute boundary", () => {
    const start = Date.parse("2026-09-25T12:00:00Z");
    const short = { start, end: start + 30_000 };
    expect(dispatchCutoff(short)).toBe(short.end);
    expect(inDispatchWindow(short, start - 60_001)).toBe(false);
    expect(inDispatchWindow(short, start - 60_000)).toBe(true);
    expect(inDispatchWindow(short, short.end - 1)).toBe(true);
    expect(inDispatchWindow(short, short.end)).toBe(false);
    expect(inDispatchWindow({ start, end: start + 900_000 }, start + 300_000)).toBe(false);
    expect(eligibleCalendarEvent(event({ start: { dateTime: "2026-09-25T12:00:00" } }))).toBeNull();
  });
});

describe("Google primary-calendar API bounds", () => {
  test("requests primary expanded occurrences and assembles complete pagination", async () => {
    const seen: URL[] = [];
    const headers: Headers[] = [];
    const api = new GoogleCalendarClient({ fetchImpl: (async (url, init) => {
      seen.push(new URL(String(url))); headers.push(new Headers(init?.headers));
      return Response.json(seen.length === 1 ? { items: [event()], nextPageToken: "page 2" } : { items: [{ id: "deleted", status: "cancelled" }] });
    }) as typeof fetch });
    const now = Date.parse("2026-09-25T12:00:00Z");
    expect(await api.listEvents("access", now)).toHaveLength(2);
    expect(seen[0]!.pathname).toBe("/calendar/v3/calendars/primary/events");
    expect(Object.fromEntries(seen[0]!.searchParams)).toEqual({ singleEvents: "true", showDeleted: "true",
      timeMin: "2026-09-25T11:55:00.000Z", timeMax: "2026-09-26T12:00:00.000Z", maxResults: "500" });
    expect(seen[1]!.searchParams.get("pageToken")).toBe("page 2");
    expect(headers.every(h => h.get("Authorization") === "Bearer access")).toBe(true);
  });

  test("overflow, repeated page tokens, and a failed later page never return a partial scan", async () => {
    for (const response of [
      { items: Array.from({ length: 501 }, () => event()) },
      { items: Array.from({ length: 500 }, () => event()), nextPageToken: "more" },
      { items: [event()], nextPageToken: "repeated" },
    ]) {
      let calls = 0;
      const api = new GoogleCalendarClient({ fetchImpl: (async () => { calls++; return Response.json(response); }) as typeof fetch });
      await expect(api.listEvents("access")).rejects.toMatchObject({ code: "scan_incomplete" });
      expect(calls).toBeLessThanOrEqual(2);
    }
    let calls = 0;
    const api = new GoogleCalendarClient({ fetchImpl: (async () => ++calls === 1
      ? Response.json({ items: [event()], nextPageToken: "more" })
      : Response.json({ error: {} }, { status: 503 })) as typeof fetch });
    await expect(api.listEvents("access")).rejects.toMatchObject({ status: 503, retryable: true });
  });

  test("403 quota errors retry with the complete Retry-After; genuine denial needs reconnect", async () => {
    for (const reason of ["rateLimitExceeded", "userRateLimitExceeded", "quotaExceeded"]) {
      const api = new GoogleCalendarClient({ fetchImpl: (async () => Response.json({ error: { errors: [{ reason }] } },
        { status: 403, headers: { "Retry-After": "7200" } })) as typeof fetch });
      await expect(api.listEvents("access")).rejects.toMatchObject({ status: 403, code: "calendar_rate_limited",
        retryAfterMs: 7_200_000, requiresReconnect: false, retryable: true });
    }
    for (const status of [401, 403]) {
      const api = new GoogleCalendarClient({ fetchImpl: (async () => Response.json({ error: { errors: [{ reason: "forbidden" }] } }, { status })) as typeof fetch });
      await expect(api.getEvent("access", "id")).rejects.toMatchObject({ status, requiresReconnect: true, retryable: false });
    }
  });

  test("404/410 get means unavailable occurrence; other failures are never absence", async () => {
    for (const status of [404, 410]) {
      const api = new GoogleCalendarClient({ fetchImpl: (async () => new Response(null, { status })) as typeof fetch });
      expect(await api.getEvent("access", "cancelled/id")).toBeNull();
    }
    const api = new GoogleCalendarClient({ fetchImpl: (async () => new Response(null, { status: 500 })) as typeof fetch });
    await expect(api.getEvent("access", "id")).rejects.toMatchObject({ status: 500 });
  });

  test("shared limiter permits at most four external operations", async () => {
    const limiter = new ExternalOperationLimiter();
    let active = 0;
    let maximum = 0;
    await Promise.all(Array.from({ length: 20 }, () => limiter.run(async () => {
      active++; maximum = Math.max(maximum, active);
      await new Promise(resolve => setTimeout(resolve, 1));
      active--;
    })));
    expect(maximum).toBe(4);
    expect(active).toBe(0);
  });
});
