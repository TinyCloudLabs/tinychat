import { afterEach, describe, expect, test } from "bun:test";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { CALENDAR_AUTOJOIN_COUNTS_ROUTE_PATH, createCalendarAutojoinCountsRouter } from "../routes/calendar-autojoin-counts.js";
import { CREDENTIAL_COUNT_PATHS, bucketFor } from "../rate-limits.js";
import type { CalendarConnection } from "../services/calendar-autojoin-store.js";

const ADMIN_KEY = "a".repeat(40);
const EMAIL_SCOPE = "https://www.googleapis.com/auth/userinfo.email";
const closers: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(closers.splice(0).map(close => close())); });

function row(tenant: string, patch: Partial<CalendarConnection>): CalendarConnection {
  return { tenant, subject: `sub-${tenant}`, state: "enabled", generation: 1, scopes: ["openid"], nextScanAt: 0, scanComplete: true, ...patch };
}

async function countsApp(env: Record<string, string | undefined>, list: () => Promise<CalendarConnection[]>) {
  const app = express();
  app.use(createCalendarAutojoinCountsRouter(env, { listConnections: list }));
  const listening = Promise.withResolvers<Server>();
  const server = app.listen(0, "127.0.0.1", () => listening.resolve(server));
  await listening.promise;
  closers.push(() => {
    const closed = Promise.withResolvers<void>();
    server.closeAllConnections();
    server.close(() => closed.resolve());
    return closed.promise;
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return (key?: string) => fetch(`${base}${CALENDAR_AUTOJOIN_COUNTS_ROUTE_PATH}`, { headers: key === undefined ? {} : { "x-admin-key": key } });
}

describe("GET /api/internal/calendar-autojoin-counts (TC-916)", () => {
  test("it is not registered unless the credential count's admin key is set and long enough", async () => {
    for (const env of [{}, { CREDENTIAL_COUNT_ADMIN_KEY: "too-short" }]) {
      const get = await countsApp(env, async () => []);
      expect((await get(ADMIN_KEY)).status).toBe(404);
    }
  });

  test("a wrong or missing key is a bare 401 and never lists", async () => {
    let listed = 0;
    const get = await countsApp({ CREDENTIAL_COUNT_ADMIN_KEY: ADMIN_KEY }, async () => { listed++; return []; });
    for (const key of ["wrong-key-wrong-key-wrong-key-0000", undefined]) {
      const response = await get(key);
      expect([response.status, await response.text(), response.headers.get("cache-control")]).toEqual([401, "", "no-store"]);
    }
    expect(listed).toBe(0);
  });

  test("the correct key gets exactly the five counts and no tenant, email or subject", async () => {
    const rows = [
      row("0xa1", { scopes: ["openid", EMAIL_SCOPE], verifiedEmail: "a1@example.com" }),
      row("0xa2", { scopes: ["openid", "email"], verifiedEmail: "a2@example.com" }),
      row("0xa3", { scopes: ["openid", EMAIL_SCOPE] }), // granted, but the ID token did not verify the email
      row("0xa4", {}), // connected before the email scope was requested
      row("0xa5", { state: "needs_reconnect", scopes: ["openid", EMAIL_SCOPE], verifiedEmail: "a5@example.com" }),
      row("0xa6", { state: "disabled" }),
    ];
    const get = await countsApp({ CREDENTIAL_COUNT_ADMIN_KEY: ADMIN_KEY }, async () => rows);
    const response = await get(ADMIN_KEY);
    const text = await response.text();
    expect([response.status, response.headers.get("cache-control")]).toEqual([200, "no-store"]);
    expect(JSON.parse(text)).toEqual({
      connections: 6, enabled: 4, enabled_with_email_scope_granted: 3, enabled_with_verified_email: 2, enabled_needing_reconnect: 2,
    });
    expect(text).not.toMatch(/0xa|example\.com|sub-/);
  });

  test("a listing failure is a bare 503", async () => {
    const get = await countsApp({ CREDENTIAL_COUNT_ADMIN_KEY: ADMIN_KEY }, async () => { throw new Error("kv down 0xa1"); });
    const response = await get(ADMIN_KEY);
    expect([response.status, await response.text()]).toEqual([503, ""]);
  });

  test("the path is outside the global bucket exactly like the credential count's", () => {
    expect(bucketFor("GET", CALENDAR_AUTOJOIN_COUNTS_ROUTE_PATH)).toBe(bucketFor("GET", CREDENTIAL_COUNT_PATHS[0]));
    expect(bucketFor("GET", CALENDAR_AUTOJOIN_COUNTS_ROUTE_PATH)).not.toBe("global");
  });
});
