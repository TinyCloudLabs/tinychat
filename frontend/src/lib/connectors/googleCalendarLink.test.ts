import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CALENDAR_LINK_EVENT_FIELDS, linkedCalendarLink, unlinkedCalendarLink } from "@tinyboilerplate/core";

import { writeRowCalendarLink } from "@/lib/calendarLink/calendarLinkRows";
import { at, BACKEND, CALENDAR_EVENTS, calendarLinkSpace, timed, type CalendarLinkSpace } from "@/lib/calendarLink/calendarLinkSpace.fixture";
import { resetVaultSecretCacheForTests } from "./connectorSecrets";
import {
  CALENDAR_LINK_SECRET, disconnectCalendarLink, GOOGLE_CALENDAR_LINK_SCOPE, listCalendarLinkEvents, onCalendarLinkStatus,
  readCalendarLinkEvent, readCalendarLinkStatus, saveCalendarLinkConnection,
} from "./googleCalendarLink";

const SECRET_SLOT = `${CALENDAR_LINK_SECRET.secretScope}/${CALENDAR_LINK_SECRET.secretName}`;
const GRANT = { version: 1, subjectHash: "subject", tokenHashes: ["hash"] };
const WINDOW = { timeMin: Date.parse(at(0)), timeMax: Date.parse(at(24)) };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const refreshes = (space: CalendarLinkSpace) => space.requests.filter((request) => request.url.endsWith("/oauth/refresh"));
const revokes = (space: CalendarLinkSpace) => space.requests.filter((request) => request.url.endsWith("/oauth/revoke"));
const disconnect = (space: CalendarLinkSpace, removeDetails = false) =>
  disconnectCalendarLink({ tcw: space.tcw, backendUrl: BACKEND, sessionStore: space.sessionStore, removeDetails, fetchImpl: space.fetchImpl });

let space: CalendarLinkSpace;
beforeEach(() => { space = calendarLinkSpace(); });
// Linking never talks to Calendar autojoin, whatever it does.
afterEach(() => { expect(space.requests.filter((request) => request.url.includes("autojoin"))).toEqual([]); });

describe("connecting", () => {
  test("keeps the token in a secret of its own, and a status that reads while the vault is locked", async () => {
    const heard: unknown[] = [];
    const stop = onCalendarLinkStatus((tcw) => heard.push(tcw));
    expect(await readCalendarLinkStatus(space.tcw)).toEqual({ state: "off" });

    expect(await space.connect({ grant: GRANT })).toEqual({ ok: true });
    stop();

    expect([...space.vault.keys()]).toEqual([SECRET_SLOT]);
    expect(JSON.parse(space.vault.get(SECRET_SLOT)!)).toEqual({ v: 1, token: "refresh-link", grant: GRANT });
    expect(heard).toEqual([space.tcw]);
    space.secrets.isUnlocked = false;
    expect(await readCalendarLinkStatus(space.tcw)).toEqual({ state: "connected", connectedAt: expect.any(String) });
  });

  test("a grant without the calendar scope is refused and nothing is stored", async () => {
    for (const scope of [undefined, "openid", "https://www.googleapis.com/auth/calendar.events.readonly"]) {
      expect(await saveCalendarLinkConnection(space.tcw, { refreshToken: "refresh-link", desktop: false, scope })).toEqual({ ok: false, reason: "scope" });
    }
    expect(space.vault.size).toBe(0);
    expect(await readCalendarLinkStatus(space.tcw)).toEqual({ state: "off" });
  });

  test("a vault that stays locked stores nothing", async () => {
    space.secrets.isUnlocked = false;
    space.secrets.unlockable = false;
    expect(await saveCalendarLinkConnection(space.tcw, { refreshToken: "refresh-link", desktop: false, scope: GOOGLE_CALENDAR_LINK_SCOPE }))
      .toEqual({ ok: false, reason: "locked", message: "The vault is locked" });
    expect(space.vault.size).toBe(0);
    expect(await readCalendarLinkStatus(space.tcw)).toEqual({ state: "off" });
  });

  test("a token the desktop client obtained is refreshed as a desktop token", async () => {
    await space.connect({ desktop: true });
    await listCalendarLinkEvents(space.deps, WINDOW);
    expect(refreshes(space).map((request) => request.body)).toEqual([{ refreshToken: "refresh-link", client: "desktop" }]);
  });
});

describe("reading the calendar", () => {
  test("lists the primary calendar through the fields mask, follows every page and counts the calls", async () => {
    await space.connect();
    space.google.events = Array.from({ length: 600 }, (_, index) => timed(`e${index}`, at(index / 100), at(index / 100 + 0.5)));

    const listed = await listCalendarLinkEvents(space.deps, WINDOW);

    expect(listed).toMatchObject({ ok: true, data: { calls: 3, complete: true } });
    expect(listed.ok && listed.data.events.map((event) => event.id)).toEqual(space.google.events.map((event) => event.id));
    expect(space.lists()).toHaveLength(3);
    for (const request of space.lists()) {
      const url = new URL(request.url);
      expect(`${url.origin}${url.pathname}`).toBe(CALENDAR_EVENTS);
      expect(Object.fromEntries([...url.searchParams].filter(([name]) => name !== "pageToken"))).toEqual({
        singleEvents: "true", showDeleted: "false", orderBy: "startTime", maxResults: "250",
        timeMin: at(0), timeMax: at(24), fields: CALENDAR_LINK_EVENT_FIELDS,
      });
      expect(request.url).not.toContain("email");
      expect(request.authorization).toBe("Bearer access-1");
    }
    // The access token stays in memory: a second listing asks for no new one.
    await listCalendarLinkEvents(space.deps, WINDOW);
    expect(refreshes(space)).toHaveLength(1);
    expect(refreshes(space)[0]!.body).toEqual({ refreshToken: "refresh-link" });
  });

  test("a page limit stops the listing with what was read", async () => {
    await space.connect();
    space.google.events = Array.from({ length: 600 }, (_, index) => timed(`e${index}`, at(index / 100), at(index / 100 + 0.5)));
    const listed = await listCalendarLinkEvents(space.deps, WINDOW, { maxPages: 2 });
    expect(listed).toMatchObject({ ok: true, data: { calls: 2, complete: false } });
    expect(listed.ok && listed.data.events).toHaveLength(500);
  });

  test("one event is read by its id with the same fields, and a deleted one reads as gone", async () => {
    await space.connect();
    space.google.events = [timed("standup", at(10), at(11))];

    expect(await readCalendarLinkEvent(space.deps, "standup")).toEqual({ ok: true, data: space.google.events[0]! });
    expect(await readCalendarLinkEvent(space.deps, "deleted")).toEqual({ ok: true, data: null });

    const url = new URL(space.requests.find((request) => request.url.startsWith(`${CALENDAR_EVENTS}/standup`))!.url);
    expect(CALENDAR_LINK_EVENT_FIELDS).toContain(`items(${url.searchParams.get("fields")})`);
    expect(url.href).not.toContain("email");
  });

  test("a 401 from Google gets one fresh access token and one retry", async () => {
    await space.connect();
    space.google.events = [timed("standup", at(10), at(11))];
    space.google.list = (authorization) => (authorization === "Bearer access-1" ? json({ error: { code: 401 } }, 401) : null);

    const listed = await listCalendarLinkEvents(space.deps, WINDOW);
    expect(listed.ok && listed.data.events).toHaveLength(1);
    expect(refreshes(space)).toHaveLength(2);
    expect(space.lists().map((request) => request.authorization)).toEqual(["Bearer access-1", "Bearer access-2"]);

    space.google.list = () => json({ error: { code: 401 } }, 401);
    expect(await listCalendarLinkEvents(space.deps, WINDOW)).toEqual({ ok: false, reason: "unavailable" });
    expect(space.lists()).toHaveLength(4);
    expect(await readCalendarLinkStatus(space.tcw)).toMatchObject({ state: "connected" });
  });

  test("Google's invalid_grant, and nothing else, asks for a reconnect", async () => {
    await space.connect();
    const heard: unknown[] = [];
    const stop = onCalendarLinkStatus((tcw) => heard.push(tcw));

    // The proxy's own failures, the network and an expired session leave the status alone.
    for (const failure of [
      () => json({ error: "internal_error" }, 500),
      () => json({ error: "temporarily_unavailable", upstream_status: 503 }, 502),
      () => json({ error: "unauthorized" }, 401),
      () => json({ error: "invalid_request" }, 400),
      () => { throw new TypeError("Failed to fetch"); },
    ]) {
      space.google.refresh = failure;
      expect(await listCalendarLinkEvents(space.deps, WINDOW)).toEqual({ ok: false, reason: "unavailable" });
      expect(await readCalendarLinkStatus(space.tcw)).toMatchObject({ state: "connected" });
    }
    space.secrets.isUnlocked = false;
    expect(await listCalendarLinkEvents(space.deps, WINDOW)).toEqual({ ok: false, reason: "locked" });
    expect(await readCalendarLinkStatus(space.tcw)).toMatchObject({ state: "connected" });
    expect(heard).toEqual([]);

    space.secrets.isUnlocked = true;
    space.google.refresh = () => json({ error: "invalid_grant", error_description: "Token has been expired or revoked.", upstream_status: 400 }, 400);
    expect(await listCalendarLinkEvents(space.deps, WINDOW)).toEqual({ ok: false, reason: "needs-reconnect" });
    expect(await readCalendarLinkStatus(space.tcw)).toEqual({ state: "needs-reconnect" });
    expect(heard).toEqual([space.tcw]);
    stop();

    // Nothing is asked again until the user reconnects.
    const sent = space.requests.length;
    expect(await readCalendarLinkEvent(space.deps, "standup")).toEqual({ ok: false, reason: "needs-reconnect" });
    expect(space.requests).toHaveLength(sent);
    expect(space.lists()).toHaveLength(0);
  });

  test("nothing is asked for while linking is not connected", async () => {
    expect(await listCalendarLinkEvents(space.deps, WINDOW)).toEqual({ ok: false, reason: "off" });
    expect(space.requests).toEqual([]);
  });
});

describe("disconnecting", () => {
  test("is off at once, before the backend has answered, then deletes the secret and keeps the links", async () => {
    await space.connect({ grant: GRANT });
    const note = await space.add("exo-voice-note", "n1", at(10), 1800);
    await writeRowCalendarLink(space.tcw, note.id, linkedCalendarLink(timed("standup", at(10), at(11)), "user", at(12)), "user");
    const asked = Promise.withResolvers<void>();
    const answer = Promise.withResolvers<Response>();
    space.google.revoke = () => { asked.resolve(); return answer.promise; };

    const done = disconnect(space);
    expect(await readCalendarLinkStatus(space.tcw)).toEqual({ state: "off" });
    await asked.promise;
    expect(await readCalendarLinkStatus(space.tcw)).toEqual({ state: "off" });
    expect(await listCalendarLinkEvents(space.deps, WINDOW)).toEqual({ ok: false, reason: "off" });
    expect(space.lists()).toHaveLength(0);

    answer.resolve(json({ status: "disconnected", upstreamRevoked: "ok", reason: "last_holder" }));
    expect(await done).toEqual({ upstream: "revoked", removedDetails: null });

    expect(revokes(space).map((request) => request.body)).toEqual([{ token: "refresh-link", purpose: "calendar-link", grant: GRANT, connectorConnected: false }]);
    expect(space.vault.has(SECRET_SLOT)).toBe(false);
    expect(space.link(note.id)?.event_id).toBe("standup");
    expect(await readCalendarLinkStatus(space.tcw)).toEqual({ state: "off" });
  });

  test("deletes the secret whatever the backend's guard answered", async () => {
    const answers: [() => Response, string][] = [
      [() => json({ status: "disconnected", upstreamRevoked: "ok", reason: "last_holder" }), "revoked"],
      [() => json({ status: "disconnected", upstreamRevoked: "kept", reason: "shared_holder" }), "kept"],
      [() => json({ status: "disconnected", upstreamRevoked: "failed", reason: "last_holder" }, 502), "failed"],
      [() => { throw new TypeError("Failed to fetch"); }, "failed"],
    ];
    for (const [answer, upstream] of answers) {
      space = calendarLinkSpace();
      await space.connect();
      space.google.revoke = answer;
      expect(await disconnect(space)).toEqual({ upstream, removedDetails: null });
      expect(space.vault.has(SECRET_SLOT)).toBe(false);
      expect(await readCalendarLinkStatus(space.tcw)).toEqual({ state: "off" });
      expect(revokes(space)).toHaveLength(1);
    }
  });

  test("tells the guard that the Google Meet connector still holds the grant, and sends the token Google issued", async () => {
    await space.connect({ desktop: true });
    await space.connectMeet();

    await disconnect(space);

    expect(revokes(space).map((request) => request.body)).toEqual([{ token: "refresh-link", purpose: "calendar-link", connectorConnected: true }]);
    // The Meet connector's own secret is not linking's to delete.
    expect([...space.vault.keys()]).toEqual(["google-meet/REFRESH_TOKEN"]);
  });

  test("removes the calendar details from every note only when asked to", async () => {
    await space.connect();
    const linked = await space.add("exo-voice-note", "n1", at(10), 1800);
    const none = await space.add("fireflies", "f1", at(10), 1800);
    await space.add("fireflies", "f2", at(10), 1800);
    await writeRowCalendarLink(space.tcw, linked.id, linkedCalendarLink(timed("standup", at(10), at(11)), "user", at(12)), "user");
    await writeRowCalendarLink(space.tcw, none.id, unlinkedCalendarLink(at(12)), "user");

    expect(await disconnect(space, true)).toEqual({ upstream: "revoked", removedDetails: 2 });
    expect(space.link(linked.id)).toBeUndefined();
    expect(space.link(none.id)).toBeUndefined();
  });

  test("with no token to be found there is nothing to revoke, and linking is off all the same", async () => {
    await space.connect();
    // The secret is gone from the vault (another device unlinked), and this session has not read it yet.
    space.vault.clear();
    resetVaultSecretCacheForTests();
    space.secrets.isUnlocked = false;

    expect(await disconnect(space)).toEqual({ upstream: "no-token", removedDetails: null });
    expect(revokes(space)).toEqual([]);
    expect(await readCalendarLinkStatus(space.tcw)).toEqual({ state: "off" });
  });
});
