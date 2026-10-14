import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { CONNECTORS } from "@/lib/connectors/registry";
import type { CalendarAutojoinStatus } from "@/lib/connectors/calendarAutojoinApi";
import { CalendarAutojoinOffReason, createCalendarAutojoinActions } from "./CalendarAutojoinSection";
import { revokeGoogleUpstream } from "./ConnectorDialog";
import { autojoinDetail } from "@/capture/meetingSources/useCalendarAutojoin";
import { CalendarAutojoinRow } from "@/capture/meetingSources/MeetingSourcesView";
import { deleteConnectorKey } from "@/lib/connectors/connectorSecrets";
import { runDisconnect } from "@/lib/connectors/connectorLifecycle";

const session = { getToken: () => "tinychat-session", isExpired: () => false } as SessionStore;
const google = CONNECTORS.find((row) => row.id === "google-meet")!;
const on: CalendarAutojoinStatus = { state: "on", enabled: true, lastScanAt: 123, errorCode: null, outcomes: [] };
const off: CalendarAutojoinStatus = { ...on, state: "off", enabled: false };

describe("TC-1100 visible off reasons", () => {
  for (const [reason, copy] of [
    ["user_disabled", "You turned calendar autojoin off."],
    ["google_account_changed", "Google account changed. Turn on calendar autojoin for this account."],
    ["disconnected", "Google was disconnected. Reconnect to turn calendar autojoin on."],
    ["needs_reconnect", "Google access needs to be renewed. It may have been revoked from another TinyChat account or your Google settings. Reconnect to resume calendar autojoin."],
    ["invalid_grant", "Google access was revoked elsewhere, such as from another TinyChat account or your Google settings, or expired. Reconnect Google to resume calendar autojoin."],
    ["setup_expired", "Google setup expired. Turn on calendar autojoin to try again."],
    ["setup_pending", "Finish Google setup to turn calendar autojoin on."],
    ["never_enabled", "Calendar autojoin has not been turned on yet."],
    ["unknown", "The reason calendar autojoin was turned off is unavailable. Turn it on to resume."],
  ] as const) {
    test(`${reason} renders the same short copy in connector settings and Meeting sources`, () => {
      const status: CalendarAutojoinStatus = { ...off, offReason: reason };
      const section = renderToStaticMarkup(createElement(CalendarAutojoinOffReason, { status }));
      expect(section).toContain(copy);
      const detail = autojoinDetail(status, null);
      expect(detail.warning).toBeNull();
      const source = renderToStaticMarkup(createElement(CalendarAutojoinRow, {
        on: status.enabled, disabled: false, ...detail, onToggle() {},
      }));
      expect(source).toContain(copy);
      expect(source).toContain('aria-checked="false"');
    });
  }

  test("a read error does not hide an already-known off reason", () => {
    const detail = autojoinDetail({ ...off, offReason: "user_disabled" }, "Status unavailable");
    expect(detail.detail).toBe("You turned calendar autojoin off.");
    expect(detail.warning).toBe("Status unavailable");
  });

  test("enabled and loading states render no off explanation", () => {
    for (const status of [on, null]) {
      expect(renderToStaticMarkup(createElement(CalendarAutojoinOffReason, { status }))).toBe("");
      expect(autojoinDetail(status, null).detail).toBeNull();
    }
  });

  test("older backend bodies still get a visible explanation", () => {
    expect(renderToStaticMarkup(createElement(CalendarAutojoinOffReason, { status: off }))).toContain("reason calendar autojoin was turned off is unavailable");
    expect(autojoinDetail({ ...off, state: "needs_reconnect", errorCode: "invalid_grant" }, null).detail).toContain("revoked elsewhere");
  });
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function unlockedBrowser() {
  return { secrets: { isUnlocked: true, get: async () => ({ ok: true, data: "old-account-browser-token" }) } } as unknown as TinyCloudWeb;
}

describe("Google disconnect across interrupted account replacement", () => {
  test("shared-grant skips still finish both browser requests and delete the vault key", async () => {
    let stored: string | null = "synthetic-shared-refresh-token";
    const paths: string[] = [];
    const tcw = { secrets: { isUnlocked: true,
      get: async () => ({ ok: true, data: stored }),
      delete: async () => { stored = null; return { ok: true }; },
    } } as unknown as TinyCloudWeb;
    const revoke = await revokeGoogleUpstream({ tcw, descriptor: google,
      backendUrl: "https://backend.example", sessionStore: session,
      fetchImpl: (async url => { paths.push(new URL(String(url)).pathname);
        return Response.json({ status: "disconnected", upstreamRevoked: "not_applicable" }); }) as typeof fetch,
    });
    expect(revoke.status).toBe("revoked");
    expect(paths).toEqual(["/api/connectors/google/autojoin/disconnect", "/api/connectors/google/oauth/revoke"]);
    const result = await runDisconnect({ connectorId: google.id, source: google.source, mode: "keep-data",
      webhooks: { disable: async () => ({ status: "feature-dark" }), recordPurge: async () => ({ status: "feature-dark" }) },
      featureDark: true,
      secrets: { isUnlocked: () => true, unlock: async () => ({ ok: true }), deleteKey: () => deleteConnectorKey(tcw, google) },
      store: { listKnownSourceIds: async () => ({ ok: true, data: [] }), purgeConnector: async () => ({ ok: true, data: undefined }),
        clearFirefliesAttempt: async () => ({ ok: true, data: undefined }), getConnection: async () => ({ ok: true, data: null }),
        countMeetings: async () => ({ ok: true, data: 0 }), updateSyncState: async () => ({ ok: true, data: undefined }) },
    }, () => {});
    expect(result.done).toBe(true);
    expect(stored).toBeNull();
  });
  for (const browserStatus of [200, 400]) {
    test(`server-account revoke failure stays visible after browser-account ${browserStatus === 200 ? "revoke succeeds" : "invalid_grant"}`, async () => {
      const calls: { url: string; body: string }[] = [];
      const result = await revokeGoogleUpstream({ tcw: unlockedBrowser(), descriptor: google,
        backendUrl: "https://backend.example", sessionStore: session,
        fetchImpl: (async (url, init) => {
          calls.push({ url: String(url), body: String(init?.body) });
          if (String(url).endsWith("/autojoin/disconnect")) {
            return Response.json({ status: "disconnected", upstreamRevoked: "failed" }, { status: 502 });
          }
          return browserStatus === 200 ? Response.json({ status: "revoked" })
            : Response.json({ error: "invalid_grant" }, { status: 400 });
        }) as typeof fetch,
      });
      expect(result.status).toBe("failed");
      expect(result.message).toContain("server credentials were removed");
      expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
        "/api/connectors/google/autojoin/disconnect", "/api/connectors/google/oauth/revoke",
      ]);
      expect(calls[0]!.body).toBe("{}");
      expect(JSON.parse(calls[1]!.body)).toEqual({ token: "old-account-browser-token" });
    });
  }
  test("successful revocation of both credentials reports success", async () => {
    expect((await revokeGoogleUpstream({ tcw: unlockedBrowser(), descriptor: google,
      backendUrl: "https://backend.example", sessionStore: session,
      fetchImpl: (async () => Response.json({ status: "disconnected", upstreamRevoked: "ok" })) as typeof fetch,
    })).status).toBe("revoked");
  });
  test("unconfirmed server disable stops before reading browser credentials", async () => {
    let reads = 0;
    const tcw = { secrets: { isUnlocked: true, get: async () => { reads++; return { ok: true, data: "token" }; } } } as unknown as TinyCloudWeb;
    expect((await revokeGoogleUpstream({ tcw, descriptor: google, backendUrl: "https://backend.example", sessionStore: session,
      fetchImpl: (async () => { throw new Error("offline"); }) as typeof fetch,
    })).status).toBe("server-unavailable");
    expect(reads).toBe(0);
  });
});

describe("Calendar control request ordering", () => {
  test("a delayed On refresh cannot overwrite acknowledged Off; polling waits for a mutation", async () => {
    const stale = deferred<CalendarAutojoinStatus>();
    const disabling = deferred<CalendarAutojoinStatus>();
    let shown = on;
    let busy = false;
    let reads = 0;
    const actions = createCalendarAutojoinActions({
      status: () => { reads++; return stale.promise; }, disable: () => disabling.promise,
    }, (update) => { if (update.status) shown = update.status; if (update.busy !== undefined) busy = update.busy; });
    const refresh = actions.refresh();
    const disable = actions.disable();
    await actions.refresh();
    expect(reads).toBe(1);
    expect(busy).toBe(true);
    disabling.resolve(off); await disable;
    expect(shown).toEqual(off);
    expect(busy).toBe(false);
    stale.resolve(on); await refresh;
    expect(shown).toEqual(off);
  });
  test("an older failed refresh cannot overwrite a successful disable with an error", async () => {
    const stale = deferred<CalendarAutojoinStatus>();
    let error: string | null = null;
    const actions = createCalendarAutojoinActions({ status: () => stale.promise, disable: async () => off },
      (update) => { if (update.error !== undefined) error = update.error; });
    const refresh = actions.refresh();
    await actions.disable();
    stale.reject(new Error("old request failed")); await refresh;
    expect(error).toBeNull();
  });
  test("polls coalesce while a delayed status read is pending, then refresh again after success", async () => {
    const pending = deferred<CalendarAutojoinStatus>();
    let reads = 0;
    let shown: CalendarAutojoinStatus | null = null;
    const actions = createCalendarAutojoinActions({ status: () => ++reads === 1 ? pending.promise : Promise.resolve(off), disable: async () => off },
      (update) => { if (update.status) shown = update.status; });
    const first = actions.refresh();
    const poll = actions.refresh();
    pending.resolve(on);
    await Promise.all([first, poll]);
    expect(reads).toBe(1);
    expect(shown).toEqual(on);
    await actions.refresh();
    expect(reads).toBe(2);
    expect(shown).toEqual(off);
  });
  test("a delayed failure remains visible despite another poll, and the next read can recover", async () => {
    const pending = deferred<CalendarAutojoinStatus>();
    let reads = 0;
    let error: string | null = null;
    let shown: CalendarAutojoinStatus | null = null;
    const actions = createCalendarAutojoinActions({ status: () => ++reads === 1 ? pending.promise : Promise.resolve(off), disable: async () => off },
      (update) => { if (update.error !== undefined) error = update.error; if (update.status) shown = update.status; });
    const first = actions.refresh();
    const poll = actions.refresh();
    pending.reject(new Error("upstream unavailable"));
    await Promise.all([first, poll]);
    expect(reads).toBe(1);
    expect(error).toBe("Calendar autojoin status is unavailable. Try again shortly.");
    expect(shown).toBeNull();
    await actions.refresh();
    expect(reads).toBe(2);
    expect(error).toBeNull();
    expect(shown).toEqual(off);
  });
  test("unmount discards late refreshes and mutations", async () => {
    for (const action of ["refresh", "disable"] as const) {
      const pending = deferred<CalendarAutojoinStatus>();
      const updates: unknown[] = [];
      const actions = createCalendarAutojoinActions({ status: () => pending.promise, disable: () => pending.promise },
        (update) => updates.push(update));
      const running = actions[action]();
      actions.dispose();
      const count = updates.length;
      pending.resolve(off); await running;
      expect(updates).toHaveLength(count);
      await actions.refresh();
      await actions.disable();
      expect(updates).toHaveLength(count);
    }
  });
});
