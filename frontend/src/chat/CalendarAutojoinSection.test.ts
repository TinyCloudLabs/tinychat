import { describe, expect, test } from "bun:test";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { CONNECTORS } from "@/lib/connectors/registry";
import type { CalendarAutojoinStatus } from "@/lib/connectors/calendarAutojoinApi";
import { createCalendarAutojoinActions } from "./CalendarAutojoinSection";
import { revokeGoogleUpstream } from "./ConnectorDialog";

const session = { getToken: () => "tinychat-session", isExpired: () => false } as SessionStore;
const google = CONNECTORS.find((row) => row.id === "google-meet")!;
const on: CalendarAutojoinStatus = { state: "on", enabled: true, lastScanAt: 123, errorCode: null, outcomes: [] };
const off: CalendarAutojoinStatus = { ...on, state: "off", enabled: false };
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
  test("only the latest refresh may publish its result", async () => {
    const old = deferred<CalendarAutojoinStatus>();
    let reads = 0;
    let shown = on;
    const actions = createCalendarAutojoinActions({ status: () => ++reads === 1 ? old.promise : Promise.resolve(off), disable: async () => off },
      (update) => { if (update.status) shown = update.status; });
    const first = actions.refresh();
    await actions.refresh();
    old.resolve(on); await first;
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
