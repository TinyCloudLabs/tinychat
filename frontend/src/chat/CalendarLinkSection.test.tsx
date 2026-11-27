import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { CalendarLinkRow } from "@/capture/meetingSources/MeetingSourcesView";
import {
  CALENDAR_LINK_UNAVAILABLE_COPY,
  GOOGLE_CALENDAR_LINK_CONSENT_COPY,
  transcriptAwareConsentCopy,
} from "@/lib/connectors/consentCopy";
import type { CalendarLinkStatus } from "@/lib/connectors/googleCalendarLink";
import { CONNECTORS } from "@/lib/connectors/registry";
import {
  CalendarLinkControls,
  calendarLinkDisplay,
  calendarUnlinkMessage,
  createCalendarLinkActions,
  probeGoogleOAuthRoutes,
  type CalendarLinkDeps,
  type CalendarLinkDisplay,
  type CalendarLinkView,
  type CalendarUnlinkUpstream,
  type GoogleOAuthRoutes,
} from "./CalendarLinkSection";
import { revokeGoogleUpstream, upstreamRevokeMessage } from "./ConnectorDialog";

const session = { getToken: () => "tinychat-session", isExpired: () => false } as SessionStore;
const google = CONNECTORS.find((row) => row.id === "google-meet")!;
const OFF: CalendarLinkStatus = { state: "off" };
const CONNECTED: CalendarLinkStatus = { state: "connected", connectedAt: "2026-11-27T10:00:00.000Z" };
const NEEDS_RECONNECT: CalendarLinkStatus = { state: "needs-reconnect" };
const UPSTREAMS: readonly CalendarUnlinkUpstream[] = ["revoked", "kept", "failed", "no-token"];

/** A row driven by fake reads, with the view the two surfaces would be handed. */
function row(input: { status: CalendarLinkStatus; routes?: GoogleOAuthRoutes } & Partial<CalendarLinkDeps>) {
  let status = input.status;
  let view: CalendarLinkView = { status: null, routes: null, busy: null, notice: null, error: null };
  let opened = 0;
  const actions = createCalendarLinkActions({
    readStatus: async () => status,
    routes: async () => input.routes ?? "available",
    disconnect: input.disconnect ?? (async () => { status = OFF; return { upstream: "revoked" }; }),
    backfill: input.backfill ?? (async () => null),
  }, (update) => { view = { ...view, ...update }; }, () => { opened++; });
  return { actions, display: () => calendarLinkDisplay(view), opened: () => opened };
}

/** Both surfaces' markup for a view: the settings card first, Meeting sources second. */
function markup(display: CalendarLinkDisplay): string[] {
  const handlers = { display, onLink() {}, onUnlink() {}, onLinkExisting() {} };
  return [createElement(CalendarLinkControls, handlers), createElement(CalendarLinkRow, handlers)]
    .map((surface) => renderToStaticMarkup(createElement(MemoryRouter, null, surface)));
}

/** The button labels each surface draws for a view. */
function buttons(display: CalendarLinkDisplay): string[][] {
  return markup(display).map((html) => [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((match) => match[1]!));
}

describe("Link Google Calendar row", () => {
  test("off offers Link, and pressing it opens the consent dialog", async () => {
    const off = row({ status: OFF });
    await off.actions.refresh();
    expect(off.display().label).toBe("Off");
    for (const labels of buttons(off.display())) expect(labels).toEqual(["Link"]);
    await off.actions.link();
    expect(off.opened()).toBe(1);
  });

  test("linked offers Unlink and Link existing notes, and no Link", async () => {
    const linked = row({ status: CONNECTED, routes: "unavailable" });
    await linked.actions.refresh();
    expect(linked.display().label).toBe("Linked");
    for (const labels of buttons(linked.display())) expect(labels).toEqual(["Link existing notes", "Unlink"]);
    for (const html of markup(linked.display())) expect(html).not.toContain(CALENDAR_LINK_UNAVAILABLE_COPY);
  });

  test("a link that needs reconnecting offers Reconnect, and can still be unlinked", async () => {
    const stale = row({ status: NEEDS_RECONNECT });
    await stale.actions.refresh();
    expect(stale.display().label).toBe("Needs reconnect");
    for (const labels of buttons(stale.display())) expect(labels).toEqual(["Reconnect", "Unlink"]);
    await stale.actions.link();
    expect(stale.opened()).toBe(1);
  });

  test("a server without the Google OAuth routes shows the sentence, no Link button, and never opens the dialog", async () => {
    for (const status of [OFF, NEEDS_RECONNECT]) {
      const dark = row({ status, routes: "unavailable" });
      await dark.actions.refresh();
      for (const labels of buttons(dark.display())) expect(labels).not.toContain("Link");
      for (const labels of buttons(dark.display())) expect(labels).not.toContain("Reconnect");
      for (const html of markup(dark.display())) expect(html).toContain("Calendar linking isn&#x27;t available on this server.");
      await dark.actions.link();
      expect(dark.opened()).toBe(0);
    }
  });

  test("a server that cannot be asked is said so on Link: no dialog, never a silent press", async () => {
    const offline = row({ status: OFF, routes: "unknown" });
    await offline.actions.refresh();
    for (const labels of buttons(offline.display())) expect(labels).toEqual(["Link"]);
    await offline.actions.link();
    expect(offline.opened()).toBe(0);
    expect(offline.display().error).toContain("Try again");
    for (const html of markup(offline.display())) expect(html).toContain('role="alert"');
  });

  test("Link existing notes reports what was linked and what needs a pick", async () => {
    const linked = row({ status: CONNECTED, backfill: async () => ({ considered: 9, linked: 3, ambiguous: 2, listCalls: 1 }) });
    await linked.actions.refresh();
    await linked.actions.linkExisting();
    expect(linked.display().notice).toBe("Linked 3. 2 need your pick.");
    expect(linked.display().busy).toBeNull();
  });

  test("Link existing notes says so when the calendar cannot be read", async () => {
    for (const backfill of [async () => null, async () => { throw new Error("offline"); }]) {
      const linked = row({ status: CONNECTED, backfill });
      await linked.actions.refresh();
      await linked.actions.linkExisting();
      const { notice, error } = linked.display();
      expect(notice ?? error).toBe("Your calendar can't be read right now. Try again shortly.");
    }
  });
});

describe("Unlink", () => {
  test("passes the remove-details choice on, shows the outcome and goes back to Off", async () => {
    for (const removeDetails of [false, true]) {
      const asked: boolean[] = [];
      let status = CONNECTED;
      let view: CalendarLinkView = { status: null, routes: null, busy: null, notice: null, error: null };
      const actions = createCalendarLinkActions({
        readStatus: async () => status,
        routes: async () => "available",
        disconnect: async (choice) => { asked.push(choice); status = OFF; return { upstream: "kept" }; },
        backfill: async () => null,
      }, (update) => { view = { ...view, ...update }; }, () => {});
      await actions.refresh();
      await actions.unlink(removeDetails);
      expect(asked).toEqual([removeDetails]);
      const display = calendarLinkDisplay(view);
      expect(display.label).toBe("Off");
      expect(display.notice).toBe(calendarUnlinkMessage("kept"));
      for (const html of markup(display)) expect(html).toContain("Google access stays in place");
    }
  });

  test("each outcome has its own line", () => {
    expect(calendarUnlinkMessage("revoked")).toBe(
      "TinyCloud One stopped reading your calendar and deleted its access token. Google access was removed.");
    expect(calendarUnlinkMessage("kept")).toBe(
      "TinyCloud One stopped reading your calendar and deleted its access token. Google access stays in place because another TinyCloud One Google feature may use it. Remove it any time in your Google Account under Third-party connections.");
    expect(calendarUnlinkMessage("failed")).toBe(
      "TinyCloud One stopped reading your calendar and deleted its access token. Google could not be asked to remove access. Remove it in your Google Account under Third-party connections.");
    expect(calendarUnlinkMessage("no-token")).toBe(
      "TinyCloud One stopped reading your calendar and has no access token left.");
  });

  test("no line, and no consent text, promises an immediate revoke for this feature only", () => {
    const texts = [...UPSTREAMS.map(calendarUnlinkMessage), GOOGLE_CALENDAR_LINK_CONSENT_COPY.disconnectNote ?? "",
      GOOGLE_CALENDAR_LINK_CONSENT_COPY.intro];
    for (const text of texts) expect(text).not.toMatch(/immediate|at once|right away|revoke/i);
    // Only the outcome where the server did remove the grant says that Google access is gone.
    for (const upstream of UPSTREAMS) {
      expect(calendarUnlinkMessage(upstream).includes("Google access was removed")).toBe(upstream === "revoked");
    }
    expect(GOOGLE_CALENDAR_LINK_CONSENT_COPY.disconnectNote).toContain("Google access itself may stay in place");
    expect(GOOGLE_CALENDAR_LINK_CONSENT_COPY.disconnectNote).toContain("Third-party connections");
  });

  test("a failed unlink is reported and the row reads its status again", async () => {
    const failing = row({ status: CONNECTED, disconnect: async () => { throw new Error("offline"); } });
    await failing.actions.refresh();
    await failing.actions.unlink(false);
    expect(failing.display().error).toBe("Could not unlink Google Calendar. Try again.");
    expect(failing.display().label).toBe("Linked");
  });
});

describe("Calendar linking consent", () => {
  test("says what is read and what never happens, and is not rewritten for the transcript writer", () => {
    expect(GOOGLE_CALENDAR_LINK_CONSENT_COPY.heading).toBe("Link Google Calendar");
    expect(GOOGLE_CALENDAR_LINK_CONSENT_COPY.intro).toBe(
      "Link your Google Calendar to your recordings. TinyCloud One reads your events (titles, times, guests, meeting links) to show which meeting a recording belongs to. It never joins meetings, sends a notetaker or changes your calendar. You can unlink at any time.");
    expect(transcriptAwareConsentCopy(GOOGLE_CALENDAR_LINK_CONSENT_COPY, "active")).toBe(GOOGLE_CALENDAR_LINK_CONSENT_COPY);
  });
});

describe("Google OAuth route probe", () => {
  const probe = (backendUrl: string, respond: () => Response | Promise<Response>) => {
    const requests: { url: string; method?: string; body?: string; auth: string | null }[] = [];
    const fetchImpl = (async (url, init) => {
      requests.push({ url: String(url), method: init?.method, body: String(init?.body),
        auth: new Headers(init?.headers).get("Authorization") });
      return respond();
    }) as typeof fetch;
    return { requests, ask: () => probeGoogleOAuthRoutes({ backendUrl, sessionStore: session, fetchImpl }) };
  };

  test("an unmounted route is unavailable, asked once per session", async () => {
    const dark = probe("https://dark.example", () => Response.json({ error: "not_found" }, { status: 404 }));
    expect(await dark.ask()).toBe("unavailable");
    expect(await dark.ask()).toBe("unavailable");
    expect(dark.requests).toEqual([{ url: "https://dark.example/api/connectors/google/oauth/refresh", method: "POST",
      body: "{}", auth: "Bearer tinychat-session" }]);
  });

  test("a mounted route refuses the empty body, which is the available answer", async () => {
    const mounted = probe("https://mounted.example", () => Response.json({ error: "invalid_request" }, { status: 400 }));
    expect(await mounted.ask()).toBe("available");
    expect(await mounted.ask()).toBe("available");
    expect(mounted.requests).toHaveLength(1);
  });

  test("a server that cannot be reached is unknown and is asked again", async () => {
    let online = false;
    const flaky = probe("https://flaky.example", () => {
      if (!online) throw new Error("offline");
      return Response.json({ error: "invalid_request" }, { status: 400 });
    });
    expect(await flaky.ask()).toBe("unknown");
    online = true;
    await Promise.resolve();
    expect(await flaky.ask()).toBe("available");
    expect(flaky.requests).toHaveLength(2);
  });

  test("an expired session asks nothing", async () => {
    let asked = 0;
    const answer = await probeGoogleOAuthRoutes({ backendUrl: "https://signed-out.example",
      sessionStore: { getToken: () => null, isExpired: () => true } as unknown as SessionStore,
      fetchImpl: (async () => { asked++; return new Response(null, { status: 404 }); }) as typeof fetch });
    expect(answer).toBe("unknown");
    expect(asked).toBe(0);
  });
});

describe("Google Meet disconnect while Calendar linking is connected", () => {
  const tcw = { secrets: { isUnlocked: true, get: async () => ({ ok: true, data: "meet-browser-token" }) } } as unknown as TinyCloudWeb;
  const disconnect = async (calendarLinkConnected: boolean) => {
    const bodies: Record<string, unknown> = {};
    const state = await revokeGoogleUpstream({ tcw, descriptor: google, backendUrl: "https://backend.example",
      sessionStore: session, calendarLinkConnected: async () => calendarLinkConnected,
      fetchImpl: (async (url, init) => {
        bodies[new URL(String(url)).pathname] = JSON.parse(String(init?.body));
        return Response.json({ status: "disconnected", upstreamRevoked: calendarLinkConnected ? "not_applicable" : "ok" });
      }) as typeof fetch });
    return { state, bodies };
  };

  test("both requests say linking holds the grant, and the outcome says Google access was kept", async () => {
    const { state, bodies } = await disconnect(true);
    expect(bodies).toEqual({
      "/api/connectors/google/autojoin/disconnect": { calendarLinkConnected: true },
      "/api/connectors/google/oauth/revoke": { token: "meet-browser-token", calendarLinkConnected: true },
    });
    expect(state.status).toBe("kept-for-calendar");
    const message = upstreamRevokeMessage(state);
    expect(message).toContain("Google access was kept because Calendar linking still uses it");
    expect(message).toContain("Unlink Google Calendar too");
  });

  test("a kept grant is reported even when no Meet token is left to send", async () => {
    const empty = { secrets: { isUnlocked: true, get: async () => ({ ok: true, data: "" }) } } as unknown as TinyCloudWeb;
    const state = await revokeGoogleUpstream({ tcw: empty, descriptor: google, backendUrl: "https://backend.example",
      sessionStore: session, calendarLinkConnected: async () => true,
      fetchImpl: (async () => Response.json({ status: "disconnected", upstreamRevoked: "not_applicable" })) as typeof fetch });
    expect(state.status).toBe("kept-for-calendar");
  });

  test("without linking connected nothing is added and the revoke is reported as before", async () => {
    const { state, bodies } = await disconnect(false);
    expect(bodies).toEqual({
      "/api/connectors/google/autojoin/disconnect": {},
      "/api/connectors/google/oauth/revoke": { token: "meet-browser-token" },
    });
    expect(state.status).toBe("revoked");
    expect(upstreamRevokeMessage(state)).toBeNull();
  });

  test("a build without Calendar linking never claims the grant", async () => {
    const bodies: unknown[] = [];
    const state = await revokeGoogleUpstream({ tcw, descriptor: google, backendUrl: "https://backend.example", sessionStore: session,
      fetchImpl: (async (_url, init) => { bodies.push(JSON.parse(String(init?.body)));
        return Response.json({ status: "disconnected", upstreamRevoked: "ok" }); }) as typeof fetch });
    expect(bodies).toEqual([{}, { token: "meet-browser-token" }]);
    expect(state.status).toBe("revoked");
  });
});
