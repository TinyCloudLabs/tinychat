import { createHash, randomBytes } from "node:crypto";
import type { CredentialStore, CredentialAccessPurpose, CredentialSecret, OAuthCredentialSecret } from "./credential-store.js";
import { TenantCoordinator, type CalendarAutojoinStore, type CalendarAutojoinReadMetrics, type CalendarConnection } from "./calendar-autojoin-store.js";
import { CalendarAutojoinGrantIndex, liveGoogleConnection, type GoogleGrantRevokeDecision, type GrantBackfillSnapshot } from "./calendar-autojoin-grants.js";
import type { CalendarAutojoinStatus, CalendarAutojoinOffReason } from "./calendar-autojoin-status-cache.js";
import { calendarAutojoinOutcomes } from "./calendar-autojoin-status-summary.js";
import { REQUEST_LANE_WAIT_MS } from "./backend-storage-lane.js";
import { GOOGLE_CALENDAR_SCOPE, GoogleOAuthError, type GoogleOAuthPort, type GoogleTokenPayload } from "./google-oauth.js";

export const GOOGLE_AUTOJOIN_CREDENTIAL_SOURCE = "google-calendar";
const SETUP_TTL_MS = 10 * 60_000;

export class CalendarAutojoinError extends Error {
  constructor(readonly code: string, readonly status = 409) { super(code); }
}

interface Transaction {
  tenant: string;
  purpose: "autojoin";
  challenge: string;
  nonce: string;
  consentAt: number;
  generation: number;
  expiresAt: number;
}

export interface CalendarAutojoinConnectionOptions {
  store: CalendarAutojoinStore;
  credentials: CredentialStore;
  oauth: GoogleOAuthPort;
  coordinator: TenantCoordinator;
  calendar: { probePrimary(accessToken: string): Promise<void> };
  now?: () => number;
  /** Lane budget for one whole status read (connection row plus occurrence listing). */
  statusBudgetMs?: number;
  /** TC-1047: called once a tenant's disabled row is persisted (disable, disconnect, needs_reconnect, re-setup). */
  onDisabled?: (tenant: string) => void;
  grantIndex?: CalendarAutojoinGrantIndex;
  /** Background-priority credential reader for restart backfill; never enumerates credential rows. */
  backfillCredentials?: CredentialStore;
  /** TC-1013 S4b: removes the tenant's Exo state. Runs after custody, enablement and revocation; a failure is logged and does not block disconnect. */
  teardownExoOwner?: (owner: string) => Promise<unknown>;
}

/** One-account custody lifecycle. Tenant policy coordination is separate from the global KV lane. */
export class CalendarAutojoinConnection {
  private readonly transactions = new Map<string, Transaction>();
  private readonly refreshing = new Map<string, Promise<string>>();
  private readonly now: () => number;
  readonly grantIndex: CalendarAutojoinGrantIndex;
  /** Serialize credential installation plus index publication against decrement-and-check. */
  private readonly grantWriter = new TenantCoordinator();

  constructor(private readonly options: CalendarAutojoinConnectionOptions) {
    this.now = options.now ?? Date.now;
    let hasher: ((subject: string) => string) | undefined;
    let tokenHasher: ((token: string) => string) | undefined;
    this.grantIndex = options.grantIndex ?? new CalendarAutojoinGrantIndex(subject => {
      hasher ??= options.credentials.referenceHasher("calendar-autojoin-google-subject-v1");
      return hasher(subject);
    }, token => {
      tokenHasher ??= options.credentials.referenceHasher("calendar-autojoin-google-token-v1");
      return tokenHasher(token);
    }, this.now);
  }

  /** User settings writes invalidate even when the persisted policy fields happen to match. */
  private writeSettings<T>(tenant: string, write: () => Promise<T>): Promise<T> {
    return this.options.store.statusCache.mutate(tenant, () => this.options.coordinator.run(tenant, write));
  }

  /** A failed lifecycle read cannot confirm the holder's current policy/generation. */
  private async readConnection(tenant: string, store = this.options.store): Promise<CalendarConnection | null> {
    try {
      const row = await store.getConnection(tenant);
      if (!row) this.grantIndex.forget(tenant);
      else if (!liveGoogleConnection(row, this.now())) this.grantIndex.detach(tenant);
      return row;
    }
    catch (error) { this.grantIndex.invalidate(); throw error; }
  }

  /** Failed reads make the projection uncertain; only a complete backfill can restore trust. */
  private async readCustody(tenant: string, purpose: CredentialAccessPurpose,
    reader = this.options.credentials): Promise<CredentialSecret | null> {
    try {
      const secret = await reader.getCredential(GOOGLE_AUTOJOIN_CREDENTIAL_SOURCE, tenant, purpose);
      // A known absence/unusable credential cannot count. Retain hashed browser bindings for
      // the SPA's second revoke call after the first call has already deleted server custody.
      if (secret?.kind !== "oauth" || !secret.refreshToken) this.grantIndex.detach(tenant);
      return secret;
    } catch (error) {
      // A teardown cannot read A's token, but that does not make other holders uncertain.
      if (purpose === "teardown") this.grantIndex.detach(tenant);
      else this.grantIndex.invalidate();
      throw error;
    }
  }

  getLastGoodStatus(tenant: string) { return this.options.store.statusCache.get(tenant); }

  getStatus(tenant: string, metrics?: CalendarAutojoinReadMetrics): Promise<CalendarAutojoinStatus> {
    return this.options.store.statusCache.refresh(tenant, () => this.readStatus(tenant, metrics));
  }

  private async readStatus(tenant: string, metrics?: CalendarAutojoinReadMetrics): Promise<CalendarAutojoinStatus> {
    // One wall-clock deadline for both the two-job summary and legacy N+2-job listing paths.
    const deadline = Date.now() + (this.options.statusBudgetMs ?? REQUEST_LANE_WAIT_MS);
    const connection = await this.options.store.getConnection(tenant, deadline, metrics);
    // Occurrences are only scheduled for a tenant with a connection row, and connection rows are
    // never deleted (disable/disconnect rewrite them as "disabled"). A never-connected tenant has
    // no outcomes, so skip the prefix listing: on the shared serialized storage lane it pushed this
    // read past the client's 20s abort, showing a never-connected account an error.
    if (!connection) return { state: "off" as const, enabled: false, offReason: "never_enabled", lastScanAt: null, lastDispatchLag: null, errorCode: null, outcomes: [] };
    // Until the first summary publication, preserve the existing history and timeout fallback.
    const summary = await this.options.store.getStatusSummaryOrLegacy(tenant, deadline, metrics);
    const outcomes = summary.outcomes;
    const offReason = connection.state === "enabled" ? null
      : connection.state === "enabling" && (connection.setupExpiresAt ?? 0) <= this.now() ? "setup_expired"
        : connection.offReason ?? (connection.state === "needs_reconnect" ? "needs_reconnect"
          : connection.state === "enabling" ? "setup_pending" : "unknown");
    return {
      state: connection?.state === "needs_reconnect" ? "needs_reconnect" as const
        : connection?.errorCode ? "error" as const
        : connection?.state === "enabled" ? "on" as const : "off" as const,
      enabled: connection?.state === "enabled",
      offReason,
      lastScanAt: connection?.lastScanAt ?? null,
      lastDispatchLag: connection.lastDispatchLag ?? null,
      errorCode: connection?.errorCode ?? null,
      outcomes,
    };
  }

  async begin(tenant: string, input: { state: string; challenge: string; consent: boolean }) {
    if (input.consent !== true || !/^[A-Za-z0-9._~-]{16,512}$/.test(input.state)
      || !/^[A-Za-z0-9._~-]{43,128}$/.test(input.challenge)) {
      throw new CalendarAutojoinError("invalid_request", 400);
    }
    for (const [key, value] of this.transactions) {
      if (value.expiresAt <= this.now() || value.tenant === tenant) this.transactions.delete(key);
    }
    if (this.transactions.has(input.state) || this.transactions.size >= 5_000) {
      throw new CalendarAutojoinError("oauth_transaction_unavailable", 429);
    }
    const connection = await this.readConnection(tenant);
    const transaction: Transaction = {
      tenant, purpose: "autojoin", challenge: input.challenge,
      nonce: randomBytes(32).toString("base64url"), consentAt: this.now(),
      generation: connection?.generation ?? 0, expiresAt: this.now() + SETUP_TTL_MS,
    };
    this.transactions.set(input.state, transaction);
    return { authorizationUrl: this.options.oauth.authorizeUrl({ state: input.state,
      challenge: input.challenge, purpose: "autojoin", nonce: transaction.nonce }) };
  }

  async exchange(tenant: string, input: { state: string; code: string; verifier: string }) {
    const transaction = this.transactions.get(input.state);
    if (!transaction || transaction.tenant !== tenant || transaction.purpose !== "autojoin"
      || transaction.expiresAt <= this.now()
      || createHash("sha256").update(input.verifier).digest("base64url") !== transaction.challenge) {
      throw new CalendarAutojoinError("invalid_oauth_transaction", 400);
    }
    this.transactions.delete(input.state); // A code/consent transaction is never replayable.
    const tokens = await this.options.oauth.exchangeCode({ code: input.code, verifier: input.verifier, nonce: transaction.nonce });
    const scopes = [...new Set((tokens.scope ?? "").split(/\s+/).filter(Boolean))];
    if (!tokens.subject) throw new CalendarAutojoinError("invalid_identity", 400);
    if (!scopes.includes(GOOGLE_CALENDAR_SCOPE) || !scopes.includes("openid")) {
      throw new CalendarAutojoinError("insufficient_scope", 403);
    }
    if (!tokens.refresh_token) throw new CalendarAutojoinError("refresh_token_required", 400);
    const setupId = randomBytes(32).toString("base64url");
    await this.writeSettings(tenant, async () => {
      const current = await this.readConnection(tenant);
      if (transaction.expiresAt <= this.now()) throw new CalendarAutojoinError("invalid_oauth_transaction", 400);
      if ((current?.generation ?? 0) !== transaction.generation) throw new CalendarAutojoinError("connection_changed");
      // Persist disabled scheduling and stop intent in the old subject namespace first.
      const disabled = await this.disableLocked(tenant, "setup_pending");
      const enabling: CalendarConnection = {
        ...disabled, subject: tokens.subject!, state: "enabling", consentAt: transaction.consentAt,
        scopes, credentialRef: GOOGLE_AUTOJOIN_CREDENTIAL_SOURCE, setupId,
        setupExpiresAt: this.now() + SETUP_TTL_MS, errorCode: undefined,
        // Always overwrite: a reconnect to another Google account must not keep a stale email.
        verifiedEmail: tokens.email?.toLowerCase(),
      };
      // A crash after this write but before custody remains disabled and is cleaned on expiry.
      await this.options.store.putConnection(enabling);
      await this.grantWriter.run("grants", async () => {
        const secret = this.secret(tokens);
        try { await this.options.credentials.store({ source: GOOGLE_AUTOJOIN_CREDENTIAL_SOURCE, address: tenant, secret }); }
        catch (error) { this.grantIndex.invalidate(); throw error; }
        this.holdGrant(enabling, secret);
      });
    });
    // The browser holds no autojoin token, so none is returned.
    return { setupId };
  }

  /**
   * Finishes setup from the server-held credential alone; it needs no browser-side secret. The
   * browser holds no autojoin token, so this must not record a browser binding: the row's
   * `googleBrowserBinding` written by the Meet exchange describes the Meet connector's token. (Backfill
   * may still register an unbound enabled row's server digests as browser digests; that is harmless,
   * since the Meet token's digest differs and is then treated as unindexed.)
   */
  async enable(tenant: string, setupId: string) {
    const connection = await this.readConnection(tenant);
    this.assertSetup(connection, setupId);
    const secret = await this.readCustody(tenant, "fetch-worker");
    if (secret?.kind !== "oauth" || !secret.refreshToken) throw new CalendarAutojoinError("refresh_token_required", 400);
    try {
      await this.options.calendar.probePrimary(secret.accessToken);
    } catch (error) {
      if (isPermanentAuthorizationFailure(error)) await this.needsReconnect(tenant, connection!.generation, authorizationOffReason(error));
      throw error;
    }
    await this.writeSettings(tenant, async () => {
      const latest = await this.readConnection(tenant);
      this.assertSetup(latest, setupId);
      if (latest!.generation !== connection!.generation) throw new CalendarAutojoinError("connection_changed");
      const enabled: CalendarConnection = { ...latest!, state: "enabled", setupId: undefined,
        setupExpiresAt: undefined, nextScanAt: this.now(), errorCode: undefined, offReason: undefined, scanComplete: false };
      await this.grantWriter.run("grants", async () => {
        try { await this.options.store.putConnection(enabled); }
        catch (error) { this.grantIndex.invalidate(); throw error; }
        this.holdGrant(enabled, secret);
      });
    });
    // A setup persisted by the previous backend can survive an upgrade without a summary.
    // Backfill on this user action, outside tenant coordination, so subsequent reads are bounded.
    if (!await this.options.store.getStatusSummary(tenant)) {
      const occurrences = await this.options.store.listOccurrences(tenant);
      await this.options.store.putStatusSummary(tenant, { version: 1, outcomes: calendarAutojoinOutcomes(occurrences) });
    }
    return this.getStatus(tenant);
  }

  async disable(tenant: string) {
    await this.writeSettings(tenant, () => this.disableLocked(tenant, "user_disabled"));
    return this.getStatus(tenant);
  }

  /** Compare the verified exchanged account with the latest binding under tenant coordination. */
  async browserReconnect(tenant: string, subject?: string, tokens: string[] = []): Promise<void> {
    // Older in-flight connector grants may lack OIDC identity; they cannot prove an account change.
    if (!subject) return;
    await this.options.coordinator.run(tenant, async () => {
      const current = await this.readConnection(tenant);
      if (!current?.subject) return; // Connector-only accounts remain outside the reference count.
      if (current.subject !== subject) {
        await this.options.store.statusCache.mutate(tenant, () => this.disableLocked(tenant, "google_account_changed"));
      }
      // The ordinary exchange installs only browser custody. Remember its verified binding for
      // a later browser-token Disconnect, without adding a live server-credential reference.
      if (!tokens.length) return;
      try {
        const googleBrowserBinding = this.grantIndex.bindBrowser(tenant, subject, tokens);
        const written = await this.options.store.updateConnection(tenant, latest => latest && { ...latest, googleBrowserBinding });
        if (!written) throw new Error("google_browser_binding_unavailable");
      } catch {
        this.grantIndex.forget(tenant); this.grantIndex.invalidate();
        // Optional identity bookkeeping cannot fail an already-successful ordinary exchange.
        console.warn("[calendar-autojoin] code=grant_index_update reason=browser_binding_unavailable");
      }
    });
  }

  async disconnect(tenant: string, browserToken?: string) {
    let serverToken: string | undefined;
    let failed = false;
    let invoked = false;
    let decisions: GoogleGrantRevokeDecision[] | undefined;
    try {
      await this.writeSettings(tenant, async () => {
        // Capture before deleting custody; retain it through every post-commit failure.
        try {
          const secret = await this.readCustody(tenant, "teardown");
          if (secret?.kind === "oauth") serverToken = secret.refreshToken ?? secret.accessToken;
        } catch { failed = true; }
        const tokens = distinctTokens(serverToken, browserToken);
        decisions = await this.grantWriter.run("grants", async () => {
          try { return this.grantIndex.release(tenant, tokens); }
          catch {
            this.grantIndex.invalidate();
            return tokens.map(() => ({ revoke: true, reason: "reference_check_failed" } as const));
          }
        });
        await this.disableLocked(tenant, "disconnected");
      });
    } finally {
      // Revoke outside tenant coordination, including when local teardown fails after commit.
      const tokens = distinctTokens(serverToken, browserToken);
      for (const [i, token] of tokens.entries()) {
        const decision = decisions?.[i] ?? { revoke: true, reason: "reference_check_failed" };
        console.log(`[calendar-autojoin] code=grant_revoke outcome=${decision.revoke ? "revoke" : "skip"} reason=${decision.reason}`);
        if (!decision.revoke) continue;
        invoked = true;
        try { await this.options.oauth.revoke(token); } catch (error) {
          // Revoking a refresh token also revokes its sibling access tokens in the same grant.
          if (!(error instanceof GoogleOAuthError && error.error === "invalid_token")) failed = true;
        }
      }
      // Exo owner cleanup after revocation, outside tenant coordination. Best-effort: a failure is logged
      // and the exo grant stays for the owner's DELETE retry.
      if (this.options.teardownExoOwner) {
        try { await this.options.teardownExoOwner(tenant); } catch {
          console.log("[calendar-autojoin] code=exo_teardown outcome=failed");
        }
      }
    }
    return { status: "disconnected" as const,
      upstreamRevoked: failed ? "failed" as const : invoked ? "ok" as const : "not_applicable" as const };
  }

  /** Uses the worker's existing connection enumeration, after dispatch. Request paths never backfill. */
  beginGrantBackfill(): GrantBackfillSnapshot { return this.grantIndex.beginBackfill(); }
  invalidateGrantReferences(): void { this.grantIndex.invalidate(); }

  async backfillGrantReferences(rows: CalendarConnection[], store = this.options.store, stopping = () => false,
    start = this.grantIndex.beginBackfill()): Promise<void> {
    if (!this.grantIndex.needsBackfill || stopping()) return;
    const seen = new Set(rows.map(row => row.tenant.toLowerCase()));
    let failed = false;
    for (const listed of rows) {
      if (stopping()) return;
      try {
        await this.options.coordinator.run(listed.tenant, async () => {
          const row = await this.readConnection(listed.tenant, store);
          if (!row) { this.grantIndex.forget(listed.tenant); return; }
          if (row.googleBrowserBinding) this.grantIndex.restoreBrowser(listed.tenant, row.googleBrowserBinding);
          if (!liveGoogleConnection(row, this.now())) { this.grantIndex.detach(listed.tenant); return; }
          const secret = await this.readCustody(listed.tenant, "fetch-worker", this.options.backfillCredentials);
          if (secret?.kind !== "oauth" || !secret.refreshToken) { this.grantIndex.forget(listed.tenant); return; }
          this.holdGrant(row, secret, row.state === "enabled" && !row.googleBrowserBinding);
        });
      } catch { failed = true; this.grantIndex.invalidate(); }
    }
    if (!failed && !stopping()) this.grantIndex.completeBackfill(start, seen);
    console.log(`[calendar-autojoin] code=grant_index_backfill outcome=${failed || this.grantIndex.needsBackfill ? "failed" : "ok"} tenants=${seen.size}`);
  }

  private holdGrant(row: CalendarConnection, secret: OAuthCredentialSecret, browserConfirmed = false): void {
    try { this.grantIndex.hold(row, distinctTokens(secret.accessToken, secret.refreshToken), browserConfirmed); }
    catch {
      this.grantIndex.forget(row.tenant); this.grantIndex.invalidate();
      console.warn("[calendar-autojoin] code=grant_index_update reason=hash_failed");
    }
  }

  async cleanupEnabling(tenant: string): Promise<void> {
    await this.options.coordinator.run(tenant, async () => {
      const row = await this.readConnection(tenant);
      if (!row) this.grantIndex.forget(tenant);
      else if (!liveGoogleConnection(row, this.now())) this.grantIndex.detach(tenant);
      if (row?.state === "enabling" && (row.setupExpiresAt ?? 0) <= this.now()) {
        await this.disableLocked(tenant, "setup_expired");
      } else if (row && (row.state === "disabled" || row.state === "needs_reconnect")) {
        // Recover a crash after persisted disable but before local credential deletion.
        let credentialPresent: boolean;
        try { credentialPresent = !!await this.options.credentials.status(GOOGLE_AUTOJOIN_CREDENTIAL_SOURCE, tenant); }
        catch (error) { this.grantIndex.invalidate(); throw error; }
        if (credentialPresent) {
          await this.options.credentials.delete(GOOGLE_AUTOJOIN_CREDENTIAL_SOURCE, tenant);
        }
      }
    });
  }

  async accessToken(tenant: string, forceRefresh = false): Promise<string> {
    const connection = await this.readConnection(tenant);
    if (connection?.state !== "enabled") throw new CalendarAutojoinError("autojoin_disabled");
    const key = `${tenant}:${connection.generation}`;
    const existing = this.refreshing.get(key);
    if (existing) return existing;
    const work = this.readOrRefresh(tenant, connection.generation, forceRefresh);
    this.refreshing.set(key, work);
    try { return await work; } finally { if (this.refreshing.get(key) === work) this.refreshing.delete(key); }
  }

  private async readOrRefresh(tenant: string, generation: number, forceRefresh: boolean): Promise<string> {
    const old = await this.readCustody(tenant, "token-refresh");
    if (old?.kind !== "oauth" || !old.refreshToken) {
      await this.needsReconnect(tenant, generation);
      throw new CalendarAutojoinError("needs_reconnect", 401);
    }
    if (!forceRefresh && old.expiresAt && Date.parse(old.expiresAt) > this.now() + 60_000) return old.accessToken;
    let tokens: GoogleTokenPayload;
    try { tokens = await this.options.oauth.refresh(old.refreshToken); }
    catch (error) {
      if (isPermanentAuthorizationFailure(error)) await this.needsReconnect(tenant, generation, authorizationOffReason(error));
      throw error;
    }
    if (tokens.scope !== undefined && !tokens.scope.split(/\s+/).includes(GOOGLE_CALENDAR_SCOPE)) {
      await this.needsReconnect(tenant, generation);
      throw new CalendarAutojoinError("insufficient_scope", 403);
    }
    return this.options.coordinator.run(tenant, async () => {
      const latest = await this.readConnection(tenant);
      if (latest?.state !== "enabled" || latest.generation !== generation) throw new CalendarAutojoinError("connection_changed");
      await this.grantWriter.run("grants", async () => {
        const secret = this.secret(tokens, old);
        try { await this.options.credentials.rotate({ source: GOOGLE_AUTOJOIN_CREDENTIAL_SOURCE, address: tenant, secret }); }
        catch (error) { this.grantIndex.invalidate(); throw error; }
        this.holdGrant(latest, secret);
      });
      return tokens.access_token;
    });
  }

  async needsReconnect(tenant: string, generation: number, reason: "needs_reconnect" | "invalid_grant" = "needs_reconnect"): Promise<void> {
    await this.options.coordinator.run(tenant, async () => {
      const row = await this.readConnection(tenant);
      if (row?.generation !== generation) return;
      this.grantIndex.detach(tenant);
      const disabled = await this.disableLocked(tenant, reason);
      await this.options.store.putConnection({ ...disabled, state: "needs_reconnect", errorCode: "needs_reconnect" });
    });
  }

  private secret(tokens: GoogleTokenPayload, previous?: OAuthCredentialSecret): OAuthCredentialSecret {
    return { kind: "oauth", accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? previous?.refreshToken,
      expiresAt: new Date(this.now() + Math.max(0, tokens.expires_in ?? 0) * 1_000).toISOString(),
      scope: tokens.scope ?? previous?.scope };
  }

  private assertSetup(connection: CalendarConnection | null, setupId: string): void {
    if (!connection || connection.state !== "enabling" || connection.setupId !== setupId
      || (connection.setupExpiresAt ?? 0) <= this.now()) throw new CalendarAutojoinError("setup_expired");
  }

  /** Caller holds tenant coordination. Generation persists before credential/occurrence mutation. */
  private async disableLocked(tenant: string, offReason: CalendarAutojoinOffReason): Promise<CalendarConnection> {
    const current = await this.readConnection(tenant);
    const disabled: CalendarConnection = { ...(current ?? { tenant, subject: null, scopes: [] }),
      state: "disabled", generation: (current?.generation ?? 0) + 1, nextScanAt: 0,
      credentialRef: undefined, setupId: undefined, setupExpiresAt: undefined, errorCode: undefined, offReason, scanComplete: false };
    try { await this.options.store.putConnection(disabled); }
    catch (error) { this.grantIndex.invalidate(); throw error; }
    try {
      this.grantIndex.detach(tenant);
      this.options.onDisabled?.(tenant);
      for (const [key, value] of this.transactions) if (value.tenant === tenant) this.transactions.delete(key);
      const occurrences = await this.options.store.listOccurrences(tenant);
      for (const row of occurrences) {
        if (row.phase === "terminal" || (!row.createBody && !row.meetingId && !row.idempotencyKey)) continue;
        await this.options.store.updateOccurrence(tenant, row.id, latest => latest && latest.phase !== "terminal"
          ? { ...latest, stopRequested: true, nextAttemptAt: this.now(), updatedAt: this.now() } : latest);
      }
      // User writes must be immediately visible, including legacy tenants awaiting their first tick.
      // Teardown already lists these rows; stopRequested does not change the outcome projection.
      try {
        await this.options.store.putStatusSummary(tenant, { version: 1, outcomes: calendarAutojoinOutcomes(occurrences) });
      } catch {
        // Projection availability cannot abort teardown or lose the captured revocation token.
        this.options.store.forgetStatusSummaryDigest(tenant);
      }
    } finally {
      await this.options.credentials.delete(GOOGLE_AUTOJOIN_CREDENTIAL_SOURCE, tenant);
    }
    return disabled;
  }
}

export function browserTokenPayload(tokens: GoogleTokenPayload): GoogleTokenPayload {
  return {
    access_token: tokens.access_token,
    ...(tokens.token_type === undefined ? {} : { token_type: tokens.token_type }),
    ...(tokens.expires_in === undefined ? {} : { expires_in: tokens.expires_in }),
    ...(tokens.refresh_token === undefined ? {} : { refresh_token: tokens.refresh_token }),
    ...(tokens.scope === undefined ? {} : { scope: tokens.scope }),
  };
}

function isPermanentAuthorizationFailure(error: unknown): boolean {
  if (error instanceof GoogleOAuthError) return ["invalid_grant", "invalid_scope", "access_denied"].includes(error.error);
  return typeof error === "object" && error !== null && "requiresReconnect" in error && error.requiresReconnect === true;
}

function authorizationOffReason(error: unknown): "needs_reconnect" | "invalid_grant" {
  return error instanceof GoogleOAuthError && error.error === "invalid_grant" ? "invalid_grant" : "needs_reconnect";
}

function distinctTokens(...tokens: (string | undefined)[]): string[] {
  return [...new Set(tokens.filter((token): token is string => !!token))];
}
