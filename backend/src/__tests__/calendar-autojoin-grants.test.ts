import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash, createHmac, hkdfSync } from "node:crypto";
import type { AddressInfo } from "node:net";
import express from "express";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import { createCalendarAutojoinRouter } from "../routes/calendar-autojoin.js";
import { createGoogleOAuthRouter } from "../routes/google-oauth.js";
import { BackendStorageLane } from "../services/backend-storage-lane.js";
import { CalendarAutojoinConnection, GOOGLE_AUTOJOIN_CREDENTIAL_SOURCE, type CalendarAutojoinConnectionOptions } from "../services/calendar-autojoin-connection.js";
import { kvCalendarAutojoinStores, TenantCoordinator, type CalendarConnection, type CalendarOccurrence } from "../services/calendar-autojoin-store.js";
import { CalendarAutojoinWorker } from "../services/calendar-autojoin-worker.js";
import { CredentialStore, KvCredentialRowStore } from "../services/credential-store.js";
import { GOOGLE_AUTOJOIN_SCOPES, GoogleOAuthError, type GoogleOAuthPort } from "../services/google-oauth.js";
import type { GoogleCalendarPort } from "../services/google-calendar.js";
import { MemoryTranscriberIndexStore } from "../services/transcriber-index.js";
import type { TranscriptionApiClient } from "../services/transcription-api.js";

const A = `0x${"1".repeat(40)}`;
const B = `0x${"2".repeat(40)}`;
const C = `0x${"3".repeat(40)}`;
const SUBJECT = "synthetic-shared-google-identity";
const OTHER_SUBJECT = "synthetic-other-google-identity";
const SOURCE = GOOGLE_AUTOJOIN_CREDENTIAL_SOURCE;
const NOW = Date.parse("2026-10-14T12:00:00Z");
const MASTER = Buffer.alloc(32, 7).toString("base64");
const VERIFIER = "a".repeat(43);
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");
let lines: string[];
let log: ReturnType<typeof spyOn<typeof console, "log">>;
let warn: ReturnType<typeof spyOn<typeof console, "warn">>;
beforeEach(() => {
  lines = [];
  log = spyOn(console, "log").mockImplementation((...args) => { lines.push(args.join(" ")); });
  warn = spyOn(console, "warn").mockImplementation((...args) => { lines.push(args.join(" ")); });
});
afterEach(() => { log.mockRestore(); warn.mockRestore(); });

function fixture() {
  let now = NOW;
  let reads = 0;
  const values = new Map<string, unknown>();
  const subjects = new Map<string, string>();
  const revoked = new Set<string>();
  const calls: string[] = [];
  const node = { kv: {
    async get(key: string) {
      reads++;
      return values.has(key) ? { ok: true, data: { data: structuredClone(values.get(key)) } }
        : { ok: false, error: { code: "KV_NOT_FOUND", service: "kv", message: `Key not found: ${key}` } };
    },
    async put(key: string, value: unknown) { values.set(key, structuredClone(value)); return { ok: true, data: {} }; },
    async delete(key: string) { values.delete(key); return { ok: true, data: {} }; },
    async list({ prefix }: { prefix: string }) { reads++; return { ok: true, data: { keys: [...values.keys()].filter(key => key.startsWith(prefix)) } }; },
  } } as unknown as TinyCloudNode;
  const lane = new BackendStorageLane();
  const stores = kvCalendarAutojoinStores(node, lane);
  const coordinator = new TenantCoordinator();
  const credentialOptions = { master: () => MASTER, previousMaster: () => null, now: () => now };
  const credentials = new CredentialStore(new KvCredentialRowStore(node, lane), credentialOptions);
  const backfillCredentials = new CredentialStore(new KvCredentialRowStore(node, lane, { priority: "background" }), credentialOptions);
  let nextSubject = SUBJECT;
  let nextTenant = A;
  let serial = 0;
  const mint = (tenant: string, subject: string) => {
    const grant = ++serial;
    const accessToken = `synthetic-access-${tenant}-${grant}`;
    const refreshToken = `synthetic-refresh-${tenant}-${grant}`;
    subjects.set(accessToken, subject); subjects.set(refreshToken, subject);
    return { kind: "oauth" as const, accessToken, refreshToken, scope: GOOGLE_AUTOJOIN_SCOPES,
      expiresAt: new Date(now - 1).toISOString() };
  };
  const oauth: GoogleOAuthPort = {
    authorizeUrl() { return "https://accounts.google.com/o/oauth2/v2/auth"; },
    async exchangeCode() { const secret = mint(nextTenant, nextSubject); return { access_token: secret.accessToken,
      refresh_token: secret.refreshToken, scope: secret.scope, subject: nextSubject, expires_in: 3_600 }; },
    async refresh(token) {
      if (revoked.has(subjects.get(token)!)) throw new GoogleOAuthError({ status: 400, error: "invalid_grant", operation: "refresh" });
      const access = `${token}-refreshed`; subjects.set(access, subjects.get(token)!);
      return { access_token: access, expires_in: 3_600, scope: GOOGLE_AUTOJOIN_SCOPES };
    },
    async revoke(token) { calls.push(token); if (subjects.has(token)) revoked.add(subjects.get(token)!); },
  };
  const calendar: GoogleCalendarPort = { async listEvents() { return []; }, async getEvent() { return null; }, async probePrimary() {} };
  const options: CalendarAutojoinConnectionOptions = { store: stores.request, credentials, backfillCredentials,
    coordinator, oauth, calendar, now: () => now };
  const connection = new CalendarAutojoinConnection(options);
  const worker = new CalendarAutojoinWorker({ store: stores.worker, dispatchStore: stores.dispatch, coordinator, connection,
    calendar, api: {} as TranscriptionApiClient, index: new MemoryTranscriberIndexStore(), now: () => now, random: () => 0 });
  return { values, node, lane, stores, credentials, backfillCredentials, options, connection, worker, oauth,
    mint, calls, resetReads() { reads = 0; }, get reads() { return reads; }, advance(ms: number) { now += ms; },
    async seed(tenant = A, subject = SUBJECT, patch: Partial<CalendarConnection> = {}) {
      const secret = mint(tenant, subject);
      await stores.request.putConnection({ tenant, subject, state: "enabled", generation: 1, scopes: GOOGLE_AUTOJOIN_SCOPES.split(" "),
        credentialRef: SOURCE, nextScanAt: now, scanComplete: true, ...patch });
      await credentials.store({ source: SOURCE, address: tenant, secret });
      return secret;
    },
    async backfill() { await connection.backfillGrantReferences(await stores.worker.listConnections(), stores.worker); },
    async connect(tenant: string, subject: string) {
      nextTenant = tenant; nextSubject = subject;
      const state = `state-${tenant}-0123456789abcdef`;
      await connection.begin(tenant, { state, challenge: CHALLENGE, consent: true });
      const setup = await connection.exchange(tenant, { state, code: "synthetic-code", verifier: VERIFIER });
      await connection.enable(tenant, setup.setupId);
    },
    restart() {
      const restartedLane = new BackendStorageLane();
      const restartedStores = kvCalendarAutojoinStores(node, restartedLane);
      const restartedCredentials = new CredentialStore(new KvCredentialRowStore(node, restartedLane), credentialOptions);
      const restartedBackfill = new CredentialStore(new KvCredentialRowStore(node, restartedLane, { priority: "background" }), credentialOptions);
      const restartedCoordinator = new TenantCoordinator();
      const restartedConnection = new CalendarAutojoinConnection({ ...options, store: restartedStores.request,
        credentials: restartedCredentials, backfillCredentials: restartedBackfill, coordinator: restartedCoordinator });
      const restartedWorker = new CalendarAutojoinWorker({ store: restartedStores.worker, dispatchStore: restartedStores.dispatch,
        coordinator: restartedCoordinator, connection: restartedConnection, calendar, api: {} as TranscriptionApiClient,
        index: new MemoryTranscriberIndexStore(), now: () => now, random: () => 0 });
      return { lane: restartedLane, stores: restartedStores, credentials: restartedCredentials,
        connection: restartedConnection, worker: restartedWorker };
    },
  };
}

describe("TC-1101 shared Google grant custody", () => {
  test("shared subject: all distinct tokens skip for A, B keeps working next tick, last B revokes both", async () => {
    const f = fixture(); const a = await f.seed(); const b = await f.seed(B); await f.backfill();
    expect(await f.connection.disconnect(A, a.accessToken)).toMatchObject({ upstreamRevoked: "not_applicable" });
    expect(f.calls).toHaveLength(0);
    expect(await f.credentials.status(SOURCE, A)).toBeNull();
    expect((await f.stores.request.getConnection(A))?.state).toBe("disabled");
    await f.worker.tick();
    expect((await f.stores.request.getConnection(B))?.state).toBe("enabled");
    expect((await f.connection.getStatus(B)).offReason).toBeNull();
    // A second browser-token call after server custody was deleted must also skip.
    await f.connection.disconnect(A, a.refreshToken);
    expect(f.calls).toHaveLength(0);
    await f.connection.disconnect(B, b.refreshToken);
    expect(f.calls).toHaveLength(1); // identical server/browser refresh token is deduplicated.
    await f.worker.stop();
  });

  test("the last holder retains one revoke per distinct token", async () => {
    const f = fixture(); const a = await f.seed(); await f.backfill();
    await f.connection.disconnect(A, a.accessToken);
    expect(f.calls).toHaveLength(2);
  });

  test("the SPA's separate disconnect and OAuth revoke requests both protect the shared grant", async () => {
    const f = fixture(); const a = await f.seed(); await f.seed(B); await f.backfill();
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.user = { address: A } as typeof req.user; next(); });
    app.use("/api/connectors/google/autojoin", createCalendarAutojoinRouter({ connection: f.connection, nativeReturn: false }));
    app.use("/api/connectors/google/oauth", createGoogleOAuthRouter({ oauth: f.oauth, autojoin: f.connection, appOrigin: "https://app.example.test", desktopClientId: "synthetic-desktop", nativeReturn: false,
      config: { enabled: true, clientId: "synthetic-client", clientSecret: "synthetic-secret", redirectUri: "https://example.test/callback",
        scope: GOOGLE_AUTOJOIN_SCOPES, authorizeEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenEndpoint: "https://oauth2.googleapis.com/token", revokeEndpoint: "https://oauth2.googleapis.com/revoke" } }));
    const server = app.listen(0); await new Promise<void>(done => server.once("listening", done));
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/connectors/google`;
      for (const [path, body] of [["autojoin/disconnect", {}], ["oauth/revoke", { token: a.refreshToken }]] as const) {
        const response = await fetch(`${base}/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ status: "disconnected", upstreamRevoked: "not_applicable" });
      }
      expect(f.calls).toHaveLength(0);
      expect(await f.credentials.status(SOURCE, A)).toBeNull();
      await f.worker.tick();
      expect((await f.stores.request.getConnection(B))?.state).toBe("enabled");
    } finally { await f.worker.stop(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
  });

  test("concurrent last-holder disconnects never both skip", async () => {
    const f = fixture(); const a = await f.seed(); const b = await f.seed(B); await f.backfill();
    await Promise.all([f.connection.disconnect(A, a.refreshToken), f.connection.disconnect(B, b.refreshToken)]);
    expect(f.calls.length).toBeGreaterThanOrEqual(1);
    expect(f.calls.length).toBeLessThanOrEqual(2);
  });

  test("reference-check failure revokes every distinct token with only fixed reason metadata", async () => {
    const f = fixture(); const a = await f.seed(); await f.seed(B); await f.backfill();
    const check = spyOn(f.connection.grantIndex, "release").mockImplementation(() => { throw new Error("Synthetic reference failure"); });
    try { await f.connection.disconnect(A, a.accessToken); } finally { check.mockRestore(); }
    expect(f.calls).toHaveLength(2);
    const events = lines.filter(line => line.includes("code=grant_revoke"));
    expect(events).toEqual(Array(2).fill("[calendar-autojoin] code=grant_revoke outcome=revoke reason=reference_check_failed"));
  });

  test("cold start or failed background read revokes securely until a successful full backfill", async () => {
    for (const failedRead of [false, true]) {
      const f = fixture(); const a = await f.seed(); await f.seed(B);
      if (failedRead) {
        const read = spyOn(f.backfillCredentials, "getCredential").mockRejectedValue(new Error("Synthetic unavailable read"));
        try { await f.backfill(); } finally { read.mockRestore(); }
      }
      await f.connection.disconnect(A, a.refreshToken);
      expect(f.calls).toHaveLength(1);
      expect(lines.some(line => line.includes("reason=index_unavailable"))).toBe(true);
    }
  });

  test("backfill uses background reads, retries failure, and adds no reads once trusted", async () => {
    const f = fixture(); await f.seed(); await f.seed(B);
    const read = spyOn(f.backfillCredentials, "getCredential").mockRejectedValueOnce(new Error("Synthetic unavailable read"));
    try { await f.backfill(); } finally { read.mockRestore(); }
    expect(f.connection.grantIndex.needsBackfill).toBe(true);
    const rows = await f.stores.worker.listConnections();
    const run = spyOn(f.lane, "run");
    try {
      await f.connection.backfillGrantReferences(rows, f.stores.worker);
      expect(f.connection.grantIndex.needsBackfill).toBe(false);
      // Reuse enumeration: one latest connection and one credential read per live tenant.
      expect(run.mock.calls).toHaveLength(4);
      expect(run.mock.calls.every(([, options]) => options?.priority === "background")).toBe(true);
      run.mockClear();
      await f.connection.backfillGrantReferences(rows, f.stores.worker);
      expect(run.mock.calls).toHaveLength(0);
    } finally { run.mockRestore(); }
  });

  test("the real worker backfills existing custody before its normal reconciliation", async () => {
    const f = fixture(); const a = await f.seed(); await f.seed(B);
    expect(f.connection.grantIndex.needsBackfill).toBe(true);
    try {
      await f.worker.tick();
      expect(f.connection.grantIndex.needsBackfill).toBe(false);
      await f.connection.disconnect(A, a.refreshToken);
      expect(f.calls).toHaveLength(0);
    } finally { await f.worker.stop(); }
  });

  test("shutdown stops backfill before starting another credential read", async () => {
    const f = fixture(); await f.seed(); await f.seed(B);
    const rows = await f.stores.worker.listConnections();
    let stopping = false;
    const original = f.backfillCredentials.getCredential.bind(f.backfillCredentials);
    const read = spyOn(f.backfillCredentials, "getCredential").mockImplementation(async (...args) => {
      stopping = true; return original(...args);
    });
    try {
      await f.connection.backfillGrantReferences(rows, f.stores.worker, () => stopping);
      expect(read.mock.calls).toHaveLength(1);
      expect(f.connection.grantIndex.needsBackfill).toBe(true);
    } finally { read.mockRestore(); }
  });

  test("same-account ordinary reconnect keeps its live reference while remembering the new browser grant", async () => {
    const f = fixture(); await f.seed(); const b = await f.seed(B); await f.backfill();
    const browser = f.mint(A, SUBJECT);
    await f.connection.browserReconnect(A, SUBJECT, [browser.accessToken, browser.refreshToken]);
    await f.connection.disconnect(B, b.refreshToken);
    expect(f.calls).toHaveLength(0);
    await f.connection.disconnect(A, browser.refreshToken);
    expect(f.calls).toHaveLength(2);
  });

  test("re-enabling autojoin keeps the Meet token's browser binding, so Meet disconnect still honors a shared holder", async () => {
    const f = fixture(); await f.connect(A, SUBJECT); await f.connect(B, SUBJECT); await f.backfill();
    // The Meet connector's token is a different grant from autojoin's server token.
    const meet = f.mint(A, SUBJECT);
    await f.connection.browserReconnect(A, SUBJECT, [meet.accessToken, meet.refreshToken]);
    const bound = (await f.stores.request.getConnection(A))!.googleBrowserBinding!;
    await f.connection.disable(A);
    await f.connect(A, SUBJECT); // Re-enable issues a new server token; the browser holds none of it.
    expect((await f.stores.request.getConnection(A))!.googleBrowserBinding).toEqual(bound);
    await f.connection.disconnect(A);
    await f.connection.disconnect(A, meet.refreshToken);
    expect(f.calls).toHaveLength(0); // B still holds this Google account.
    expect(lines.some(line => line.includes("reason=token_unindexed"))).toBe(false);
  });

  test("a deleted connection is removed by the background pass and never counts", async () => {
    const f = fixture(); const a = await f.seed(); await f.seed(B); await f.backfill();
    const bKey = [...f.values].find(([key, value]) => key.includes("connections/") && (value as CalendarConnection).tenant === B)?.[0];
    expect(bKey).toBeDefined(); f.values.delete(bKey!);
    f.connection.grantIndex.invalidate(); await f.backfill();
    await f.connection.disconnect(A, a.refreshToken);
    expect(f.calls).toHaveLength(1);
  });

  test("an uncertain credential installation forces backfill before any revoke can be skipped", async () => {
    const f = fixture(); const a = await f.seed(); await f.seed(B); await f.backfill();
    const rotate = spyOn(f.credentials, "rotate").mockRejectedValue(new Error("Synthetic write uncertainty"));
    try { await expect(f.connection.accessToken(B, true)).rejects.toThrow("Synthetic write uncertainty"); }
    finally { rotate.mockRestore(); }
    expect(f.connection.grantIndex.needsBackfill).toBe(true);
    await f.connection.disconnect(A, a.refreshToken);
    expect(f.calls).toHaveLength(1);
  });

  test("an enable that committed before reporting failure invalidates the reference projection", async () => {
    const f = fixture(); const a = await f.seed(); await f.seed(B); await f.backfill();
    const write = f.stores.request.putConnection.bind(f.stores.request);
    const put = spyOn(f.stores.request, "putConnection").mockImplementation(async row => {
      await write(row);
      if (row.state === "enabled") throw new Error("Synthetic committed enable uncertainty");
    });
    try { await expect(f.connect(C, SUBJECT)).rejects.toThrow("Synthetic committed enable uncertainty"); }
    finally { put.mockRestore(); }
    expect((await f.stores.request.getConnection(C))?.state).toBe("enabled");
    expect(f.connection.grantIndex.needsBackfill).toBe(true);
    await f.connection.disconnect(A, a.refreshToken);
    expect(f.calls).toHaveLength(1);
  });

  test("ordinary subject replacement moves bindings and stops old references, without any upstream revoke", async () => {
    const f = fixture(); await f.seed(); await f.seed(B); await f.backfill();
    const browser = f.mint(A, OTHER_SUBJECT);
    await f.connection.browserReconnect(A, OTHER_SUBJECT, [browser.accessToken, browser.refreshToken]);
    expect(f.calls).toHaveLength(0);
    expect((await f.connection.getStatus(A)).offReason).toBe("google_account_changed");
    expect(await f.credentials.status(SOURCE, A)).toBeNull();
    await f.connection.disconnect(B);
    expect(f.calls).toHaveLength(1); // A no longer counts for the old subject.
    await f.connect(C, OTHER_SUBJECT);
    await f.connection.disconnect(A, browser.refreshToken);
    expect(f.calls).toHaveLength(1); // newly bound browser grant is protected by C's SERVER custody.
  });

  test("explicit autojoin exchange adds new live custody and makes zero account-change revokes", async () => {
    const f = fixture(); await f.connect(A, SUBJECT); await f.connect(B, SUBJECT); await f.backfill();
    await f.connect(A, OTHER_SUBJECT);
    expect(f.calls).toHaveLength(0);
    await f.connect(C, OTHER_SUBJECT);
    await f.connection.disconnect(A);
    expect(f.calls).toHaveLength(0);
    await f.connection.disconnect(B);
    expect(f.calls).toHaveLength(1);
  });

  test("each known token is checked against its own grant, and an unknown token revokes securely", async () => {
    const f = fixture(); const a = await f.seed(); await f.seed(B); await f.backfill();
    const browser = f.mint(C, OTHER_SUBJECT);
    // Simulate an interrupted browser replacement: old server custody, different verified browser grant.
    f.connection.grantIndex.bindBrowser(A, OTHER_SUBJECT, [browser.refreshToken]);
    await f.connection.disconnect(A, browser.refreshToken);
    expect(f.calls).toHaveLength(1);
    expect(f.calls.includes(a.refreshToken)).toBe(false);
    expect(f.calls.includes(browser.refreshToken)).toBe(true);
    const g = fixture(); await g.seed(); await g.seed(B); await g.backfill();
    await g.connection.disconnect(A, "synthetic-unrecognized-token");
    expect(g.calls).toHaveLength(1);
    expect(lines.some(line => line.includes("reason=token_unindexed"))).toBe(true);
  });

  for (const state of ["disabled", "needs_reconnect", "expired_setup", "missing_credential", "api_key"] as const) {
    test(`a ${state} holder does not count`, async () => {
      const f = fixture(); const a = await f.seed();
      await f.seed(B, SUBJECT, state === "disabled" || state === "needs_reconnect" ? { state }
        : state === "expired_setup" ? { state: "enabling", setupExpiresAt: NOW } : {});
      if (state === "missing_credential") await f.credentials.delete(SOURCE, B);
      if (state === "api_key") await f.credentials.store({ source: SOURCE, address: B, secret: { kind: "api_key", apiKey: "synthetic-key" } });
      await f.backfill(); await f.connection.disconnect(A, a.refreshToken);
      expect(f.calls).toHaveLength(1);
    });
  }

  test("unexpired enabling counts until expiration, including before cleanup", async () => {
    const f = fixture(); const a = await f.seed();
    await f.seed(B, SUBJECT, { state: "enabling", setupExpiresAt: NOW + 60_000 }); await f.backfill();
    await f.connection.disconnect(A, a.refreshToken); expect(f.calls).toHaveLength(0);
    f.advance(60_001);
    await f.connection.disconnect(A, a.refreshToken); expect(f.calls).toHaveLength(1);
  });

  test("needs_reconnect and user Disable remove references immediately", async () => {
    for (const action of ["needs_reconnect", "disable"] as const) {
      const f = fixture(); const a = await f.seed(); await f.seed(B); await f.backfill();
      if (action === "disable") await f.connection.disable(B);
      else await f.connection.needsReconnect(B, 1, "invalid_grant");
      await f.connection.disconnect(A, a.refreshToken);
      expect(f.calls).toHaveLength(1);
    }
  });

  test("a connect after the worker's enumeration survives backfill completion", async () => {
    const f = fixture(); await f.seed();
    const start = f.connection.beginGrantBackfill();
    const listed = await f.stores.worker.listConnections();
    await f.connect(B, SUBJECT);
    await f.connection.backfillGrantReferences(listed, f.stores.worker, () => false, start);
    await f.connection.disconnect(A);
    expect(f.calls).toHaveLength(0);
  });

  test("credential installation and reference publication serialize against disconnect", async () => {
    const f = fixture(); await f.seed(); await f.backfill();
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const installed = new Promise<void>(resolve => { started = resolve; });
    let captured!: () => void;
    const teardownRead = new Promise<void>(resolve => { captured = resolve; });
    const get = f.credentials.getCredential.bind(f.credentials);
    const capture = spyOn(f.credentials, "getCredential").mockImplementation(async (...args) => {
      const secret = await get(...args);
      if (args[1] === A && args[2] === "teardown") captured();
      return secret;
    });
    const check = spyOn(f.connection.grantIndex, "release");
    const write = f.credentials.store.bind(f.credentials);
    const intercept = spyOn(f.credentials, "store").mockImplementation(async input => {
      const result = await write(input);
      if (input.address === B) { started(); await gate; }
      return result;
    });
    try {
      const connecting = f.connect(B, SUBJECT);
      await installed;
      const disconnecting = f.connection.disconnect(A);
      await teardownRead;
      // Drain continuations after capture: the grant check must still wait for B's publication.
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(check.mock.calls).toHaveLength(0);
      expect(f.calls).toHaveLength(0);
      release(); await Promise.all([connecting, disconnecting]);
      expect(f.calls).toHaveLength(0);
    } finally { release(); intercept.mockRestore(); capture.mockRestore(); check.mockRestore(); }
  });

  test("index and grant logs contain only HMAC digests and reason/count metadata", async () => {
    const f = fixture(); const a = await f.seed(); await f.seed(B); await f.backfill();
    const bytes = JSON.stringify(f.connection.grantIndex, (_key, value) => value instanceof Map ? [...value]
      : value instanceof Set ? [...value] : typeof value === "function" ? undefined : value);
    for (const raw of [SUBJECT, a.accessToken, a.refreshToken]) expect(bytes.includes(raw)).toBe(false);
    const digest = f.credentials.referenceHasher("calendar-autojoin-google-subject-v1")(SUBJECT);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(bytes.includes(digest)).toBe(true);
    expect(f.credentials.referenceHasher("different-reference-namespace")(SUBJECT) === digest).toBe(false);
    await f.connection.disconnect(A, a.accessToken);
    for (const raw of [SUBJECT, A, B, a.accessToken, a.refreshToken]) expect(lines.some(line => line.includes(raw))).toBe(false);
  });

  const counts: number[] = [];
  for (const tenants of [0, 30, 500]) {
    test(`disconnect reads stay bounded with ${tenants} other tenants`, async () => {
      const f = fixture(); await f.seed();
      for (let i = 0; i < tenants; i++) await f.seed(`0x${(i + 4).toString(16).padStart(40, "0")}`, OTHER_SUBJECT);
      await f.backfill(); f.resetReads();
      await f.connection.disconnect(A);
      counts.push(f.reads);
      expect(f.reads).toBe(4);
      expect(counts.every(value => value === counts[0])).toBe(true);
    });
  }

  for (const shared of [false, true]) {
    for (const point of ["summary", "listing", "outcome", "credential_delete", "callback", "precommit", "credential_read"] as const) {
      test(`#385 failure matrix ${point}: ${shared ? "shared holder skips every token" : "last holder preserves per-token revokes"}`, async () => {
        const f = fixture(); const a = await f.seed(); if (shared) await f.seed(B); await f.backfill();
        const row: CalendarOccurrence = { tenant: A, subject: SUBJECT, id: "synthetic-pending", eventId: "synthetic-event",
          start: NOW, end: NOW + 60_000, meetingUrl: "https://meet.google.com/abc-defg-hij", title: "Synthetic metadata",
          phase: "outcome_unknown", idempotencyKey: "synthetic-key", stopRequested: false, nextAttemptAt: NOW, attemptCount: 1, updatedAt: NOW };
        await f.stores.request.putOccurrence(row);
        const boom = () => { throw new Error("Synthetic matrix failure"); };
        const restores: (() => void)[] = [];
        if (point === "callback") f.options.onDisabled = boom;
        else if (point === "credential_delete" || point === "credential_read") {
          const spy = point === "credential_delete" ? spyOn(f.credentials, "delete").mockImplementation(async () => boom())
            : spyOn(f.credentials, "getCredential").mockImplementation(async () => boom());
          restores.push(() => spy.mockRestore());
        } else {
          const spy = point === "summary" ? spyOn(f.stores.request, "putStatusSummary").mockImplementation(async () => boom())
            : point === "listing" ? spyOn(f.stores.request, "listOccurrences").mockImplementation(async () => boom())
              : point === "outcome" ? spyOn(f.stores.request, "updateOccurrence").mockImplementation(async () => boom())
                : spyOn(f.stores.request, "putConnection").mockImplementation(async () => boom());
          restores.push(() => spy.mockRestore());
        }
        try {
          const work = f.connection.disconnect(A, a.accessToken);
          if (point === "summary" || point === "credential_read") await work;
          else await expect(work).rejects.toThrow("Synthetic matrix failure");
          expect(f.calls).toHaveLength(shared ? 0 : point === "credential_read" ? 1 : 2);
        } finally { for (const restore of restores) restore(); }
        expect((await f.stores.request.getConnection(A))?.state).toBe(point === "precommit" ? "enabled" : "disabled");
        expect(!!await f.credentials.status(SOURCE, A)).toBe(point === "precommit" || point === "credential_delete");
      });
    }
  }
});

describe("TC-1101 failed custody and lifecycle reads", () => {
  test("a throwing refresh credential read preserves the error and forces the next disconnect to revoke", async () => {
    const f = fixture(); const a = await f.seed(); await f.seed(B); await f.backfill();
    const get = f.credentials.getCredential.bind(f.credentials);
    const error = new Error("Synthetic unreadable custody");
    const read = spyOn(f.credentials, "getCredential").mockImplementation(async (...args) => {
      if (args[1] === B) throw error;
      return get(...args);
    });
    try {
      await expect(f.connection.accessToken(B, true)).rejects.toBe(error);
      expect(f.connection.grantIndex.needsBackfill).toBe(true);
      await f.connection.disconnect(A, a.refreshToken);
      expect(f.calls).toHaveLength(1);
    } finally { read.mockRestore(); }
  });

  for (const failure of ["corrupt_ciphertext", "throwing_read", "deleted", "wrong_key", "revoked", "non_oauth"] as const) {
    test(`real worker removes trust in formerly usable ${failure} custody before disconnect`, async () => {
      const f = fixture(); const a = await f.seed(); const b = await f.seed(B); await f.backfill();
      const key = `credentials/${SOURCE}/${B}`;
      const restores: (() => void)[] = [];
      if (failure === "corrupt_ciphertext") {
        const row = f.values.get(key) as { ciphertext: string };
        const bytes = Buffer.from(row.ciphertext, "base64"); bytes[bytes.length - 1]! ^= 1;
        f.values.set(key, { ...row, ciphertext: bytes.toString("base64") });
      } else if (failure === "throwing_read") {
        const get = f.credentials.getCredential.bind(f.credentials);
        const read = spyOn(f.credentials, "getCredential").mockImplementation(async (...args) => {
          if (args[1] === B) throw new Error("Synthetic failed custody read");
          return get(...args);
        });
        restores.push(() => read.mockRestore());
      } else if (failure === "deleted") await f.credentials.delete(SOURCE, B);
      else if (failure === "wrong_key") {
        const wrong = new CredentialStore(new KvCredentialRowStore(f.node, f.lane), {
          master: () => Buffer.alloc(32, 9).toString("base64"), previousMaster: () => null,
        });
        await wrong.store({ source: SOURCE, address: B, secret: b });
      } else if (failure === "revoked") {
        f.values.set(key, { ...f.values.get(key)!, revokedAt: new Date(NOW).toISOString() });
      } else await f.credentials.store({ source: SOURCE, address: B, secret: { kind: "api_key", apiKey: "synthetic-key" } });
      try {
        await f.worker.tick();
        if (failure === "corrupt_ciphertext" || failure === "wrong_key") {
          expect(lines.some(line => line.includes("result=unreadable"))).toBe(true);
          expect(f.connection.grantIndex.needsBackfill).toBe(true);
          // Preserve scan-error behavior; decryption failure is not a fabricated OAuth rejection.
          expect((await f.stores.request.getConnection(B))?.errorCode).toBe("calendar_scan_failed");
        }
        if (failure === "throwing_read") expect(f.connection.grantIndex.needsBackfill).toBe(true);
        await f.connection.disconnect(A, a.refreshToken);
        expect(f.calls).toHaveLength(1);
      } finally { for (const restore of restores) restore(); await f.worker.stop(); }
    });
  }

  test("a failed enable credential read invalidates an indexed pending holder without changing the error", async () => {
    const f = fixture(); const a = await f.seed(); await f.seed(B, SUBJECT, {
      state: "enabling", setupId: "synthetic-setup", setupExpiresAt: NOW + 60_000,
    }); await f.backfill();
    const get = f.credentials.getCredential.bind(f.credentials);
    const error = new Error("Synthetic failed enable custody read");
    const read = spyOn(f.credentials, "getCredential").mockImplementation(async (...args) => {
      if (args[1] === B) throw error;
      return get(...args);
    });
    try {
      await expect(f.connection.enable(B, "synthetic-setup")).rejects.toBe(error);
      expect(f.connection.grantIndex.needsBackfill).toBe(true);
      await f.connection.disconnect(A, a.refreshToken);
      expect(f.calls).toHaveLength(1);
    } finally { read.mockRestore(); }
  });

  for (const unusable of ["deleted", "non_oauth", "missing_refresh"] as const) {
    test(`enable observes ${unusable} custody and immediately stops counting the pending holder`, async () => {
      const f = fixture(); const a = await f.seed(); const b = await f.seed(B, SUBJECT, {
        state: "enabling", setupId: "synthetic-setup", setupExpiresAt: NOW + 60_000,
      }); await f.backfill();
      if (unusable === "deleted") await f.credentials.delete(SOURCE, B);
      else await f.credentials.store({ source: SOURCE, address: B, secret: unusable === "non_oauth"
        ? { kind: "api_key", apiKey: "synthetic-key" } : { ...b, refreshToken: undefined } });
      await expect(f.connection.enable(B, "synthetic-setup")).rejects.toMatchObject({ code: "refresh_token_required" });
      await f.connection.disconnect(A, a.refreshToken);
      expect(f.calls).toHaveLength(1);
    });
  }

  test("invalid_grant followed by a failed latest-row read cannot preserve trusted live custody", async () => {
    const f = fixture(); const a = await f.seed(); await f.seed(B); await f.backfill();
    const refresh = spyOn(f.oauth, "refresh").mockRejectedValue(new GoogleOAuthError({ status: 400, error: "invalid_grant", operation: "refresh" }));
    const get = f.stores.request.getConnection.bind(f.stores.request);
    const error = new Error("Synthetic unavailable latest row");
    let reads = 0;
    const read = spyOn(f.stores.request, "getConnection").mockImplementation(async (...args) => {
      if (args[0] === B && ++reads === 2) throw error;
      return get(...args);
    });
    try {
      await expect(f.connection.accessToken(B, true)).rejects.toBe(error);
      expect(f.connection.grantIndex.needsBackfill).toBe(true);
      await f.connection.disconnect(A, a.refreshToken);
      expect(f.calls).toHaveLength(1);
    } finally { read.mockRestore(); refresh.mockRestore(); }
  });

  test("a later successful custody read cannot restore trust without complete backfill", async () => {
    const f = fixture(); const a = await f.seed(); await f.seed(B); await f.backfill();
    const read = spyOn(f.credentials, "getCredential").mockRejectedValueOnce(new Error("Synthetic temporary read failure"));
    try { await expect(f.connection.accessToken(B, true)).rejects.toThrow("Synthetic temporary read failure"); }
    finally { read.mockRestore(); }
    await f.connection.accessToken(B, true);
    expect(f.connection.grantIndex.needsBackfill).toBe(true);
    await f.backfill();
    expect(f.connection.grantIndex.needsBackfill).toBe(false);
    await f.connection.disconnect(A, a.refreshToken);
    expect(f.calls).toHaveLength(0);
  });
});

describe("TC-1101 identity and reference hashing boundaries", () => {
  test("HKDF/HMAC pins server-master dependence and separation from token and encryption keys", () => {
    const f = fixture();
    const hash = f.credentials.referenceHasher("calendar-autojoin-google-subject-v1");
    expect(hash(SUBJECT)).toBe("1076a66859ce0fd7a0a692e1204a2847e9828bc00833d7df28930f59ea4f7647");
    expect(hash(SUBJECT) === hash(SUBJECT.toUpperCase())).toBe(false);
    expect(hash(SUBJECT) === f.credentials.referenceHasher("calendar-autojoin-google-token-v1")(SUBJECT)).toBe(false);
    const alternate = new CredentialStore(new KvCredentialRowStore(f.node, f.lane), {
      master: () => Buffer.alloc(32, 9).toString("base64"), previousMaster: () => null,
    });
    expect(hash(SUBJECT) === alternate.referenceHasher("calendar-autojoin-google-subject-v1")(SUBJECT)).toBe(false);
    const encryptionKey = hkdfSync("sha256", MASTER, "tinychat-credential-v1", "calendar-autojoin-google-subject-v1", 32);
    expect(hash(SUBJECT) === createHmac("sha256", Buffer.from(encryptionKey)).update(SUBJECT).digest("hex")).toBe(false);
  });

  test("the production index uses distinct token and subject HMAC namespaces", async () => {
    const f = fixture(); const a = await f.seed(); await f.backfill();
    const index = f.connection.grantIndex as unknown as {
      tenants: Map<string, { subjectHash: string }>;
      serverTokens: Map<string, { subjectHash: string; tokenHashes: Set<string> }>;
    };
    const tokenHash = f.credentials.referenceHasher("calendar-autojoin-google-token-v1");
    const subjectHash = f.credentials.referenceHasher("calendar-autojoin-google-subject-v1");
    expect(index.tenants.get(A)?.subjectHash).toBe(subjectHash(SUBJECT));
    expect([...index.serverTokens.get(A)!.tokenHashes]).toEqual([tokenHash(a.accessToken), tokenHash(a.refreshToken)]);
    expect(index.serverTokens.get(A)!.tokenHashes.has(subjectHash(a.refreshToken))).toBe(false);
  });

  test("a token bound to another tenant cannot borrow that tenant's skip decision", async () => {
    const f = fixture(); const a = await f.seed(); await f.seed(B); await f.backfill();
    await f.connection.disconnect(C, a.refreshToken);
    expect(f.calls).toHaveLength(1);
  });

  test("an arbitrary browser token cannot borrow its tenant's known server subject", async () => {
    const f = fixture(); const a = await f.seed(); await f.seed(B); await f.backfill();
    await f.connection.disconnect(A, "synthetic-unbound-browser-token");
    expect(f.calls).toHaveLength(1);
    expect(f.calls.includes(a.refreshToken)).toBe(false);
  });

  test("detached binding replay skips only while another live holder remains", async () => {
    const f = fixture(); const a = await f.seed(); await f.seed(B); await f.backfill();
    await f.connection.disconnect(A, a.refreshToken);
    await f.connection.disconnect(A, a.accessToken);
    expect(f.calls).toHaveLength(0);
    await f.connection.disable(B);
    await f.connection.disconnect(A, a.refreshToken);
    expect(f.calls).toHaveLength(1);
  });

  test("case-distinct Google subjects never protect each other's grant", async () => {
    const f = fixture(); const a = await f.seed(); await f.seed(B, SUBJECT.toUpperCase()); await f.backfill();
    await f.connection.disconnect(A, a.refreshToken);
    expect(f.calls).toHaveLength(1);
  });

  test("a mid-check hashing failure discards an earlier skip and revokes both tokens without logging identity", async () => {
    const f = fixture(); const a = await f.seed(); await f.seed(B); await f.backfill();
    const index = f.connection.grantIndex as unknown as { hashToken: (token: string) => string };
    const original = index.hashToken;
    index.hashToken = token => { if (token === a.accessToken) throw new Error("Synthetic partial hash failure"); return original(token); };
    try { await f.connection.disconnect(A, a.accessToken); }
    finally { index.hashToken = original; }
    expect(f.calls).toHaveLength(2);
    expect(f.connection.grantIndex.needsBackfill).toBe(true);
    expect(lines.some(line => line.includes(SUBJECT) || line.includes(a.accessToken))).toBe(false);
  });

  test("an invalid-grant refresh detaches the holder before a later disconnect", async () => {
    const f = fixture(); const a = await f.seed(); await f.seed(B); await f.backfill();
    const refresh = spyOn(f.oauth, "refresh").mockRejectedValue(new GoogleOAuthError({ status: 400, error: "invalid_grant", operation: "refresh" }));
    try { await expect(f.connection.accessToken(B, true)).rejects.toMatchObject({ error: "invalid_grant" }); }
    finally { refresh.mockRestore(); }
    await f.connection.disconnect(A, a.refreshToken);
    expect(f.calls).toHaveLength(1);
  });

  test("an enabling holder expires at the exact boundary", async () => {
    const f = fixture(); const a = await f.seed(); await f.seed(B, SUBJECT, { state: "enabling", setupExpiresAt: NOW + 1 }); await f.backfill();
    f.advance(1);
    await f.connection.disconnect(A, a.refreshToken);
    expect(f.calls).toHaveLength(1);
  });

  test("a subject without a matching Google credential reference cannot count", async () => {
    const f = fixture(); const a = await f.seed(); await f.seed(B, SUBJECT, { credentialRef: undefined }); await f.backfill();
    await f.connection.disconnect(A, a.refreshToken);
    expect(f.calls).toHaveLength(1);
  });
});

describe("TC-1101 restart persistence and reconciliation", () => {
  test("ordinary reconnect survives restart and both SPA disconnect calls preserve the shared grant", async () => {
    const f = fixture(); await f.connect(A, SUBJECT); await f.connect(B, SUBJECT); await f.backfill();
    const cached = await f.connection.getStatus(A);
    const lastGood = f.connection.getLastGoodStatus(A);
    const browser = f.mint(A, SUBJECT);
    await f.connection.browserReconnect(A, SUBJECT, [browser.accessToken, browser.refreshToken]);
    expect(f.connection.getLastGoodStatus(A)).toEqual(lastGood); // Bookkeeping must not invalidate fix 1.
    expect(cached).not.toHaveProperty("googleBrowserBinding");
    const binding = (await f.stores.request.getConnection(A))!.googleBrowserBinding!;
    const serialized = JSON.stringify(binding);
    for (const raw of [SUBJECT, browser.accessToken, browser.refreshToken]) expect(serialized.includes(raw)).toBe(false);
    expect(binding.tokenHashes).toHaveLength(2);
    await f.worker.stop();
    const restarted = f.restart();
    try {
      await restarted.worker.tick();
      expect(restarted.connection.grantIndex.needsBackfill).toBe(false);
      f.resetReads(); await restarted.connection.disconnect(A);
      expect(f.reads).toBe(4);
      f.resetReads(); await restarted.connection.disconnect(A, browser.refreshToken);
      expect(f.reads).toBe(4);
      expect(f.calls).toHaveLength(0);
      expect(await restarted.credentials.status(SOURCE, A)).toBeNull();
      // Force B's real refresh path after the two-call disconnect.
      f.advance(3_600_001); await restarted.worker.tick();
      expect((await restarted.stores.request.getConnection(B))?.state).toBe("enabled");
      expect(f.calls).toHaveLength(0);
    } finally { await restarted.worker.stop(); }
  });

  test("a different-account browser binding survives disabled custody and backend restart", async () => {
    const f = fixture(); await f.connect(A, SUBJECT); await f.connect(B, OTHER_SUBJECT); await f.backfill();
    const browser = f.mint(A, OTHER_SUBJECT);
    await f.connection.browserReconnect(A, OTHER_SUBJECT, [browser.accessToken, browser.refreshToken]);
    expect(f.calls).toHaveLength(0);
    expect((await f.stores.request.getConnection(A))?.offReason).toBe("google_account_changed");
    await f.worker.stop();
    const restarted = f.restart();
    try {
      await restarted.worker.tick();
      f.resetReads(); await restarted.connection.disconnect(A);
      expect(f.reads).toBe(4);
      f.resetReads(); await restarted.connection.disconnect(A, browser.refreshToken);
      expect(f.reads).toBe(4);
      expect(f.calls).toHaveLength(0);
      expect((await restarted.stores.request.getConnection(B))?.state).toBe("enabled");
    } finally { await restarted.worker.stop(); }
  });

  test("optional browser binding publication failure preserves the exchange while invalidating index trust", async () => {
    const f = fixture(); await f.connect(A, SUBJECT); await f.backfill();
    const browser = f.mint(A, SUBJECT);
    const put = spyOn(f.stores.request, "updateConnection").mockRejectedValue(new Error("Synthetic binding publication failure"));
    try { await f.connection.browserReconnect(A, SUBJECT, [browser.accessToken, browser.refreshToken]); }
    finally { put.mockRestore(); }
    expect(f.connection.grantIndex.needsBackfill).toBe(true);
    expect((await f.stores.request.getConnection(A))?.state).toBe("enabled");
    expect(lines.some(line => line === "[calendar-autojoin] code=grant_index_update reason=browser_binding_unavailable")).toBe(true);
  });

  test("browser binding publication preserves worker bookkeeping updated after the initial read", async () => {
    const f = fixture(); await f.connect(A, SUBJECT); await f.backfill();
    const browser = f.mint(A, SUBJECT);
    const original = f.connection.grantIndex.bindBrowser.bind(f.connection.grantIndex);
    let bookkeeping: Promise<CalendarConnection | null> | undefined;
    const bind = spyOn(f.connection.grantIndex, "bindBrowser").mockImplementation((...args) => {
      bookkeeping = f.stores.worker.updateConnection(A, row => row && { ...row, lastScanAt: NOW + 1, nextScanAt: NOW + 60_000 });
      return original(...args);
    });
    try { await f.connection.browserReconnect(A, SUBJECT, [browser.accessToken, browser.refreshToken]); await bookkeeping; }
    finally { bind.mockRestore(); }
    const row = await f.stores.request.getConnection(A);
    expect(row?.lastScanAt).toBe(NOW + 1);
    expect(row?.nextScanAt).toBe(NOW + 60_000);
    expect(row?.googleBrowserBinding?.tokenHashes).toHaveLength(2);
  });

  test("an invalidation during backfill prevents trust until another complete successful pass", async () => {
    const f = fixture(); await f.seed(); await f.seed(B);
    const original = f.backfillCredentials.getCredential.bind(f.backfillCredentials);
    let invalidated = false;
    const read = spyOn(f.backfillCredentials, "getCredential").mockImplementation(async (...args) => {
      const secret = await original(...args);
      if (!invalidated) { invalidated = true; f.connection.grantIndex.invalidate(); }
      return secret;
    });
    try { await f.backfill(); } finally { read.mockRestore(); }
    expect(f.connection.grantIndex.needsBackfill).toBe(true);
    await f.backfill();
    expect(f.connection.grantIndex.needsBackfill).toBe(false);
  });

  test("an ambiguous exchange credential write invalidates the projection", async () => {
    const f = fixture(); const a = await f.seed(); await f.seed(B); await f.backfill();
    const original = f.credentials.store.bind(f.credentials);
    const error = new Error("Synthetic committed credential uncertainty");
    const store = spyOn(f.credentials, "store").mockImplementation(async input => {
      await original(input);
      if (input.address === C) throw error;
    });
    try { await expect(f.connect(C, SUBJECT)).rejects.toBe(error); }
    finally { store.mockRestore(); }
    expect(f.connection.grantIndex.needsBackfill).toBe(true);
    expect(await f.credentials.status(SOURCE, C)).not.toBeNull();
    await f.connection.disconnect(A, a.refreshToken);
    expect(f.calls).toHaveLength(1);
  });

  test("rotation re-holds the newly rotated token so a shared-holder disconnect still skips", async () => {
    const f = fixture(); await f.connect(A, SUBJECT); await f.connect(B, SUBJECT); await f.backfill();
    const rotated = f.mint(B, SUBJECT);
    const refresh = spyOn(f.oauth, "refresh").mockResolvedValue({ access_token: rotated.accessToken,
      refresh_token: rotated.refreshToken, scope: GOOGLE_AUTOJOIN_SCOPES, expires_in: 3_600 });
    try { await f.connection.accessToken(B, true); } finally { refresh.mockRestore(); }
    const held = await f.credentials.getCredential(SOURCE, B, "fetch-worker");
    expect(held?.kind === "oauth" && held.refreshToken === rotated.refreshToken).toBe(true);
    await f.connection.disconnect(B);
    expect(f.calls).toHaveLength(0);
    f.advance(3_600_001);
    try {
      await f.worker.tick();
      expect((await f.stores.request.getConnection(A))?.state).toBe("enabled");
    } finally { await f.worker.stop(); }
  });

  test("a missing revoke decision defaults to revoking every distinct token", async () => {
    const f = fixture(); const a = await f.seed(); await f.seed(B); await f.backfill();
    const check = spyOn(f.connection.grantIndex, "release").mockReturnValue([]);
    try { await f.connection.disconnect(A, a.accessToken); } finally { check.mockRestore(); }
    expect(f.calls).toHaveLength(2);
    expect(lines.filter(line => line.includes("code=grant_revoke"))).toEqual(Array(2).fill(
      "[calendar-autojoin] code=grant_revoke outcome=revoke reason=reference_check_failed"));
  });

  for (const readFailure of ["enumeration", "worker_policy"] as const) {
    test(`a failed ${readFailure} read invalidates other-holder trust`, async () => {
      const f = fixture(); const a = await f.seed(); await f.seed(B); await f.backfill();
      const original = f.stores.worker.getConnection.bind(f.stores.worker);
      const read = readFailure === "enumeration"
        ? spyOn(f.stores.worker, "listConnections").mockRejectedValue(new Error("Synthetic enumeration failure"))
        : spyOn(f.stores.worker, "getConnection").mockImplementation(async tenant => {
          if (tenant === B) throw new Error("Synthetic worker policy failure");
          return original(tenant);
        });
      try {
        await f.worker.tick();
        expect(f.connection.grantIndex.needsBackfill).toBe(true);
        await f.connection.disconnect(A, a.refreshToken);
        expect(f.calls).toHaveLength(1);
      } finally { read.mockRestore(); await f.worker.stop(); }
    });
  }

  for (const [tenants, rows, before, after] of [[10, 0, 131, 31], [10, 30, 731, 31], [50, 10, 1651, 151]] as const) {
    test(`cold-window lane jobs T=${tenants} N=${rows}: ${before} before, ${after} after`, async () => {
      for (const placement of ["before", "after"] as const) {
        const f = fixture();
        for (let i = 0; i < tenants; i++) {
          const tenant = `0x${(i + 4).toString(16).padStart(40, "0")}`;
          await f.connect(tenant, SUBJECT);
          for (let j = 0; j < rows; j++) await f.stores.worker.putOccurrence({ tenant, subject: SUBJECT,
            id: `synthetic-row-${j}`, eventId: `synthetic-event-${j}`, start: NOW - 86_400_000, end: NOW - 86_000_000,
            meetingUrl: "https://meet.google.com/abc-defg-hij", title: "Synthetic metadata", phase: "terminal",
            disposition: "missed_window", nextAttemptAt: 0, attemptCount: 0, stopRequested: false, updatedAt: NOW });
        }
        await f.worker.stop();
        const restarted = f.restart();
        const run = spyOn(restarted.lane, "run");
        let trustedAt = -1;
        const complete = restarted.connection.grantIndex.completeBackfill.bind(restarted.connection.grantIndex);
        const trust = spyOn(restarted.connection.grantIndex, "completeBackfill").mockImplementation((...args) => {
          complete(...args);
          if (!restarted.connection.grantIndex.needsBackfill && trustedAt < 0) trustedAt = run.mock.calls.length;
        });
        const backfill = restarted.connection.backfillGrantReferences.bind(restarted.connection);
        let deferred: Parameters<typeof backfill> | undefined;
        // Reproduce the previous after-reconciliation placement with the same real components.
        const late = placement === "before" ? spyOn(restarted.connection, "backfillGrantReferences").mockImplementation(async (...args) => { deferred = args; }) : undefined;
        try {
          await restarted.worker.tick();
          if (deferred) await backfill(...deferred);
          expect(trustedAt).toBe(placement === "before" ? before : after);
        } finally { late?.mockRestore(); trust.mockRestore(); run.mockRestore(); await restarted.worker.stop(); }
      }
    });
  }
});
