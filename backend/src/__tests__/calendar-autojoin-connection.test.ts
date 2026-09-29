import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import express from "express";
import type { AddressInfo } from "node:net";
import { CalendarAutojoinConnection, GOOGLE_AUTOJOIN_CREDENTIAL_SOURCE, browserTokenPayload } from "../services/calendar-autojoin-connection.js";
import { MemoryCalendarAutojoinStore, TenantCoordinator, type CalendarOccurrence } from "../services/calendar-autojoin-store.js";
import { CredentialStore, InMemoryCredentialRowStore } from "../services/credential-store.js";
import { GOOGLE_AUTOJOIN_SCOPES, GoogleOAuthError, type GoogleOAuthPort, type GoogleTokenPayload } from "../services/google-oauth.js";
import { createGoogleOAuthRouter } from "../routes/google-oauth.js";
import { createCalendarAutojoinRouter } from "../routes/calendar-autojoin.js";

const TENANT = "0x7d033300000000000000000000000000000073f2";
const OTHER = "0xb1b1b10000000000000000000000000000001111";
const VERIFIER = "a".repeat(43);
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");
const STATE = "state-0123456789abcdef";
const MASTER = "Zk9pQ2xUb0FzRHZFcldxTnBZeEhtQjNnU2o1dDBjMD0=";
const source = GOOGLE_AUTOJOIN_CREDENTIAL_SOURCE;

function fixture() {
  let now = 1_800_000_000_000;
  const store = new MemoryCalendarAutojoinStore();
  const rows = new InMemoryCredentialRowStore();
  const credentials = new CredentialStore(rows, { master: () => MASTER, previousMaster: () => null, now: () => now });
  let tokenResponse: GoogleTokenPayload = { access_token: "access-token", refresh_token: "refresh-token", expires_in: 3600,
    scope: GOOGLE_AUTOJOIN_SCOPES, subject: "google-subject" };
  let exchangeCount = 0;
  const revokes: string[] = [];
  const oauth: GoogleOAuthPort = {
    authorizeUrl(input) { return `https://accounts.google.com/oauth?state=${input.state}&nonce=${input.nonce}`; },
    async exchangeCode() { exchangeCount++; return { ...tokenResponse }; },
    async refresh() { return { access_token: "rotated-access", expires_in: 3600 }; },
    async revoke(token) { revokes.push(token); },
  };
  const probes: string[] = [];
  const calendar = { async probePrimary(token: string) { probes.push(token); } };
  const connection = new CalendarAutojoinConnection({ store, credentials, oauth, coordinator: new TenantCoordinator(), calendar, now: () => now });
  return { store, rows, credentials, oauth, probes, revokes, connection, calendar,
    setTokens(tokens: Partial<GoogleTokenPayload>) { tokenResponse = { ...tokenResponse, ...tokens }; },
    get exchangeCount() { return exchangeCount; },
    advance(ms: number) { now += ms; },
    async exchange(tenant = TENANT) {
      await connection.begin(tenant, { state: STATE, challenge: CHALLENGE, consent: true });
      return connection.exchange(tenant, { state: STATE, code: "authorization-code", verifier: VERIFIER });
    },
    async enable(tenant = TENANT) { const tokens = await this.exchange(tenant); return connection.enable(tenant, tokens.setupId); },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function attempt(): CalendarOccurrence {
  return { tenant: TENANT, subject: "google-subject", id: "old-attempt", eventId: "google-event", start: 1_800_000_000_000,
    end: 1_800_000_060_000, meetingUrl: "https://meet.google.com/aaa-bbbb-ccc", title: "Calendar meeting",
    phase: "outcome_unknown", idempotencyKey: "frozen-key", stopRequested: false, nextAttemptAt: 0, attemptCount: 1,
    generation: 1, updatedAt: 0 };
}

describe("Calendar OAuth custody lifecycle", () => {
  test("browser responses whitelist token fields and never return identity claims", () => {
    const internal = { access_token: "access", refresh_token: "refresh", subject: "google-subject", id_token: "signed-identity", email: "private@example.test" };
    expect(browserTokenPayload(internal)).toEqual({ access_token: "access", refresh_token: "refresh" });
  });

  test("requires explicit consent and binds the one-use transaction to tenant and PKCE", async () => {
    const f = fixture();
    await expect(f.connection.begin(TENANT, { state: STATE, challenge: CHALLENGE, consent: false })).rejects.toMatchObject({ code: "invalid_request" });
    await f.connection.begin(TENANT, { state: STATE, challenge: CHALLENGE, consent: true });
    await expect(f.connection.exchange(OTHER, { state: STATE, code: "code", verifier: VERIFIER })).rejects.toMatchObject({ code: "invalid_oauth_transaction" });
    await expect(f.connection.exchange(TENANT, { state: STATE, code: "code", verifier: "b".repeat(43) })).rejects.toMatchObject({ code: "invalid_oauth_transaction" });
    expect(f.exchangeCount).toBe(0);
    const result = await f.connection.exchange(TENANT, { state: STATE, code: "code", verifier: VERIFIER });
    expect(result).not.toHaveProperty("subject");
    expect(await f.credentials.getCredential(source, OTHER, "fetch-worker")).toBeNull();
    await expect(f.connection.exchange(TENANT, { state: STATE, code: "code", verifier: VERIFIER })).rejects.toMatchObject({ code: "invalid_oauth_transaction" });
  });

  test("requires actual granted Calendar/openid scopes and a usable refresh token", async () => {
    for (const tokens of [{ scope: "openid" }, { scope: undefined }, { refresh_token: undefined }, { subject: undefined }]) {
      const f = fixture(); f.setTokens(tokens);
      await expect(f.exchange()).rejects.toBeInstanceOf(Error);
      expect(await f.credentials.status(source, TENANT)).toBeNull();
      expect((await f.connection.getStatus(TENANT)).enabled).toBe(false);
    }
  });

  test("persists enabling before custody, waits for browser completion and verifies primary Calendar", async () => {
    const f = fixture();
    const storeCredential = f.credentials.store.bind(f.credentials);
    f.credentials.store = async (input) => {
      expect((await f.store.getConnection(TENANT))?.state).toBe("enabling");
      return storeCredential(input);
    };
    const result = await f.exchange();
    expect((await f.store.getConnection(TENANT))?.state).toBe("enabling");
    await expect(f.connection.accessToken(TENANT)).rejects.toMatchObject({ code: "autojoin_disabled" });
    expect(f.probes).toEqual([]);
    const status = await f.connection.enable(TENANT, result.setupId);
    expect(status.state).toBe("on");
    expect(f.probes).toEqual(["access-token"]);
    expect(f.rows.dump()).not.toContain("refresh-token");
    expect(f.rows.dump()).not.toContain("access-token");
  });

  test("failed custody and abandoned enabling cannot schedule and are cleaned after expiry", async () => {
    const f = fixture();
    const result = await f.exchange();
    f.advance(10 * 60_000 + 1);
    await f.connection.cleanupEnabling(TENANT);
    expect(await f.credentials.status(source, TENANT)).toBeNull();
    await expect(f.connection.enable(TENANT, result.setupId)).rejects.toMatchObject({ code: "setup_expired" });
    const broken = fixture(); broken.credentials.store = async () => { throw new Error("storage unavailable"); };
    await expect(broken.exchange()).rejects.toThrow("storage unavailable");
    expect((await broken.store.getConnection(TENANT))?.state).toBe("enabling");
    expect((await broken.connection.getStatus(TENANT)).enabled).toBe(false);
  });

  test("probe failure never enables and a probe finishing after disable cannot re-enable", async () => {
    const f = fixture();
    const setup = await f.exchange();
    f.calendar.probePrimary = async () => { throw new Error("network failure"); };
    await expect(f.connection.enable(TENANT, setup.setupId)).rejects.toThrow();
    expect((await f.store.getConnection(TENANT))?.state).toBe("enabling");
    const gate = deferred<void>(); const started = deferred<void>();
    f.calendar.probePrimary = async () => { started.resolve(); await gate.promise; };
    const enabling = f.connection.enable(TENANT, setup.setupId);
    await started.promise;
    await f.connection.disable(TENANT);
    gate.resolve();
    await expect(enabling).rejects.toMatchObject({ code: "setup_expired" });
    expect((await f.connection.getStatus(TENANT)).enabled).toBe(false);
  });

  test("disable removes server custody without revocation, preserves old attempts and increments generation", async () => {
    const f = fixture(); await f.enable();
    await f.store.putOccurrence(attempt());
    const before = (await f.store.getConnection(TENANT))!.generation;
    await f.connection.disable(TENANT);
    expect((await f.store.getConnection(TENANT))!.generation).toBe(before + 1);
    expect((await f.store.getOccurrence(TENANT, "old-attempt"))?.stopRequested).toBe(true);
    expect(await f.credentials.status(source, TENANT)).toBeNull();
    expect(f.revokes).toEqual([]);
  });

  test("same-subject reconnect preserves identity, replacement doesn't wait for unknown old attempts", async () => {
    const f = fixture(); await f.enable(); await f.store.putOccurrence(attempt());
    await f.enable();
    expect((await f.store.getConnection(TENANT))?.subject).toBe("google-subject");
    f.setTokens({ subject: "different-google-subject" }); await f.enable();
    expect((await f.store.getConnection(TENANT))?.subject).toBe("different-google-subject");
    expect(await f.store.getOccurrence(TENANT, "old-attempt")).toMatchObject({ subject: "google-subject", stopRequested: true, idempotencyKey: "frozen-key" });
  });

  test("browser-only reconnect ends custody and invalidates an in-flight enabling exchange", async () => {
    const f = fixture(); await f.enable();
    await f.connection.begin(TENANT, { state: STATE, challenge: CHALLENGE, consent: true });
    await f.connection.browserReconnect(TENANT);
    expect(await f.credentials.status(source, TENANT)).toBeNull();
    expect((await f.connection.getStatus(TENANT)).enabled).toBe(false);
    await expect(f.connection.exchange(TENANT, { state: STATE, code: "code", verifier: VERIFIER })).rejects.toThrow();
  });

  test("late refresh after disable and re-enable cannot resurrect or overwrite credentials", async () => {
    const f = fixture(); await f.enable();
    const gate = deferred<GoogleTokenPayload>(); const started = deferred<void>();
    f.oauth.refresh = async () => { started.resolve(); return gate.promise; };
    const refreshing = f.connection.accessToken(TENANT, true);
    await started.promise;
    await f.connection.disable(TENANT);
    f.setTokens({ refresh_token: "new-account-refresh", access_token: "new-account-access", subject: "new-subject" });
    await f.enable();
    gate.resolve({ access_token: "stale-access", refresh_token: "stale-refresh" });
    await expect(refreshing).rejects.toMatchObject({ code: "connection_changed" });
    expect(await f.credentials.getCredential(source, TENANT, "fetch-worker")).toMatchObject({ accessToken: "new-account-access", refreshToken: "new-account-refresh" });
  });

  test("refresh preserves omitted refresh tokens and saves rotations", async () => {
    const f = fixture(); await f.enable();
    expect(await f.connection.accessToken(TENANT, true)).toBe("rotated-access");
    expect(await f.credentials.getCredential(source, TENANT, "fetch-worker")).toMatchObject({ refreshToken: "refresh-token" });
    f.oauth.refresh = async () => ({ access_token: "second-access", refresh_token: "second-refresh", expires_in: 3600 });
    await f.connection.accessToken(TENANT, true);
    expect(await f.credentials.getCredential(source, TENANT, "fetch-worker")).toMatchObject({ refreshToken: "second-refresh" });
  });

  test("invalid grant requires reconnect and permanent lookup work survives", async () => {
    const f = fixture(); await f.enable(); await f.store.putOccurrence(attempt());
    f.oauth.refresh = async () => { throw new GoogleOAuthError({ status: 400, error: "invalid_grant", operation: "refresh" }); };
    await expect(f.connection.accessToken(TENANT, true)).rejects.toMatchObject({ error: "invalid_grant" });
    expect((await f.connection.getStatus(TENANT)).state).toBe("needs_reconnect");
    expect(await f.store.getOccurrence(TENANT, "old-attempt")).toMatchObject({ stopRequested: true, phase: "outcome_unknown" });
    expect(await f.credentials.status(source, TENANT)).toBeNull();
  });

  test("refresh scope loss stops scheduling without trusting previously granted scopes", async () => {
    const f = fixture(); await f.enable();
    f.oauth.refresh = async () => ({ access_token: "access", scope: "openid", expires_in: 3600 });
    await expect(f.connection.accessToken(TENANT, true)).rejects.toMatchObject({ code: "insufficient_scope" });
    expect((await f.connection.getStatus(TENANT)).state).toBe("needs_reconnect");
    expect(await f.credentials.status(source, TENANT)).toBeNull();
  });

  test("recovers credential deletion after disable persisted and local delete failed", async () => {
    const f = fixture(); await f.enable();
    const remove = f.credentials.delete.bind(f.credentials);
    f.credentials.delete = async () => { throw new Error("write failed"); };
    await expect(f.connection.disable(TENANT)).rejects.toThrow("write failed");
    expect((await f.store.getConnection(TENANT))?.state).toBe("disabled");
    expect(await f.credentials.status(source, TENANT)).not.toBeNull();
    f.credentials.delete = remove;
    await f.connection.cleanupEnabling(TENANT);
    expect(await f.credentials.status(source, TENANT)).toBeNull();
  });

  test("status exposes missed windows and unresolved failed dispatch without losing recording metadata", async () => {
    const f = fixture();
    await f.store.putOccurrence({ ...attempt(), phase: "terminal", disposition: "missed_window" });
    await f.store.putOccurrence({ ...attempt(), id: "uncertain", errorCode: "lookup_identity_mismatch" });
    const status = await f.connection.getStatus(TENANT);
    expect(status.outcomes.map(outcome => outcome.reason).sort()).toEqual(["lookup_identity_mismatch", "missed_window"]);
  });

  test("disconnect deletes custody and reports failed revocation even without browser token", async () => {
    const f = fixture(); await f.enable();
    f.oauth.revoke = async () => { throw new Error("upstream failure containing secret"); };
    expect(await f.connection.disconnect(TENANT)).toEqual({ status: "disconnected", upstreamRevoked: "failed" });
    expect(await f.credentials.status(source, TENANT)).toBeNull();
    expect((await f.connection.getStatus(TENANT)).enabled).toBe(false);
  });
});

describe("authenticated autojoin routes", () => {
  test("ordinary OAuth reconnect disables a rebind completed while its exchange was in flight", async () => {
    const f = fixture(); await f.enable();
    const original = f.oauth.exchangeCode;
    const response = deferred<GoogleTokenPayload>(); const started = deferred<void>();
    f.oauth.exchangeCode = async (input) => {
      if (input.code === "slow-browser-code") { started.resolve(); return response.promise; }
      return original(input);
    };
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.user = { address: TENANT } as typeof req.user; next(); });
    app.use("/oauth", createGoogleOAuthRouter({ oauth: f.oauth, autojoin: f.connection, appOrigin: "https://app.example.test" }));
    const server = app.listen(0); await new Promise<void>(done => server.once("listening", done));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/oauth`;
    try {
      const pending = fetch(`${base}/exchange`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: "slow-browser-code", verifier: VERIFIER }) });
      await started.promise;
      await f.enable();
      expect((await f.connection.getStatus(TENANT)).enabled).toBe(true);
      response.resolve({ access_token: "ordinary-browser-token" });
      expect((await pending).status).toBe(200);
      expect((await f.connection.getStatus(TENANT)).enabled).toBe(false);
      expect(await f.credentials.status(source, TENANT)).toBeNull();
    } finally { await new Promise<void>(done => server.close(() => done())); }
  });

  test("derives tenant from session, rejects unauthenticated access, never accepts posted tenant", async () => {
    const f = fixture();
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { if (req.headers.authorization) req.user = { address: TENANT } as typeof req.user; next(); });
    app.use("/autojoin", createCalendarAutojoinRouter({ connection: f.connection }));
    const server = app.listen(0); await new Promise<void>(done => server.once("listening", done));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/autojoin`;
    try {
      expect((await fetch(`${base}/status`)).status).toBe(401);
      const begin = await fetch(`${base}/begin`, { method: "POST", headers: { authorization: "session", "content-type": "application/json" },
        body: JSON.stringify({ tenant: OTHER, state: STATE, challenge: CHALLENGE, consent: true, scopes: GOOGLE_AUTOJOIN_SCOPES }) });
      expect(begin.status).toBe(200);
      await expect(f.connection.exchange(OTHER, { state: STATE, code: "code", verifier: VERIFIER })).rejects.toThrow();
      await f.connection.exchange(TENANT, { state: STATE, code: "code", verifier: VERIFIER });
      expect((await f.store.getConnection(TENANT))?.state).toBe("enabling");
      expect(await f.store.getConnection(OTHER)).toBeNull();
    } finally { await new Promise<void>(done => server.close(() => done())); }
  });
});
