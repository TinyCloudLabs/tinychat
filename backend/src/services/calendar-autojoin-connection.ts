import { createHash, randomBytes } from "node:crypto";
import { CredentialCustodyChanged, credentialCustodyVersion, CUSTODY_STEPS_PER_CHANGE, type CredentialStore, type CredentialAccessPurpose, type CredentialSecret, type OAuthCredentialSecret } from "./credential-store.js";
import { CalendarRowChanged, TenantCoordinator, type CalendarAutojoinStore, type CalendarAutojoinReadMetrics, type CalendarConnection } from "./calendar-autojoin-store.js";
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
  /** Test seam: the bound of the cached access-token map (default ACCESS_TOKEN_CACHE_MAX). */
  accessTokenCacheMax?: number;
  /** The worker's store, for the reads of the calls the worker makes every tick (cleanupEnabling,
   *  accessToken). Default `store`. Writes and every other read use `store`. */
  workerStore?: CalendarAutojoinStore;
  /** TC-1013 S4b: removes the tenant's Exo state. Runs after custody, enablement and revocation; a failure is logged and does not block disconnect. */
  teardownExoOwner?: (owner: string) => Promise<unknown>;
}

/** The same stored row for a compare-and-set: both absent, or the same state and generation. */
function sameConnectionVersion(stored: CalendarConnection | null, read: CalendarConnection | null): boolean {
  return stored === null ? read === null : read !== null && stored.state === read.state && stored.generation === read.generation;
}

interface AccessTokenEntry { generation: number; custody: number; token: string; expiresAt: number }
/** Cached access tokens at most: one per connected account, so far above any expected population. */
const ACCESS_TOKEN_CACHE_MAX = 5_000;
/** A token this close to expiry is refreshed, never served, so it is dropped. */
const ACCESS_TOKEN_MARGIN_MS = 60_000;

/** One-account custody lifecycle. Tenant policy coordination is separate from the global KV lane. */
export class CalendarAutojoinConnection {
  private readonly transactions = new Map<string, Transaction>();
  private readonly refreshing = new Map<string, Promise<string>>();
  /** Access tokens this process read or refreshed, by tenant, so a scan reads no custody while one is
   *  valid. An entry serves only its connection generation and only while no CredentialStore in this
   *  process has changed the credential since it was read (credentialCustodyVersion). Bounded
   *  (least recently used out), and dropped as soon as it cannot serve: on expiry (swept at least
   *  once a minute), and on any read of the connection that shows a disable, a deletion or another
   *  generation. */
  private readonly accessTokens = new Map<string, AccessTokenEntry>();
  private tokensSweptAt = 0;
  /** Disabled/reconnect tenants whose leftover custody this process already removed, at that generation. */
  private readonly custodyCleared = new Map<string, number>();
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
      this.observeConnection(tenant, row);
      return row;
    }
    catch (error) { this.grantIndex.invalidate(); throw error; }
  }

  /** Every read of a connection, here or by the worker: drop the tenant's cached access token unless
   *  the row is the enabled generation it was cached for, and sweep expired tokens. */
  observeConnection(tenant: string, row: CalendarConnection | null): void {
    const key = tenant.toLowerCase();
    const cached = this.accessTokens.get(key);
    if (cached && (row?.state !== "enabled" || row.generation !== cached.generation)) this.accessTokens.delete(key);
    if (this.now() - this.tokensSweptAt < ACCESS_TOKEN_MARGIN_MS) return;
    this.tokensSweptAt = this.now();
    for (const [other, entry] of this.accessTokens) if (entry.expiresAt <= this.now() + ACCESS_TOKEN_MARGIN_MS) this.accessTokens.delete(other);
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
      // The default `when` always disables, so a row is written.
      const disabled = (await this.disableLocked(tenant, "setup_pending"))!;
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
        try { await this.options.teardownExoOwner(tenant); } catch (error) {
          console.log(`[calendar-autojoin] code=exo_teardown outcome=failed error=${error instanceof Error ? error.message : "unknown"}`);
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
    // Never trust the index from memory: every row the pass reads comes from the node. A row
    // missing from the cached listing could only make a later disconnect revoke, never skip.
    store.rereadConnections();
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
      const row = await this.readConnection(tenant, this.options.workerStore);
      if (!row) this.grantIndex.forget(tenant);
      else if (!liveGoogleConnection(row, this.now())) this.grantIndex.detach(tenant);
      if (row?.state === "enabling" && (row.setupExpiresAt ?? 0) <= this.now()) {
        // Memory chose this; the stored row decides, inside the disable's own compare-and-set. A row
        // deleted or changed elsewhere is left as stored, and nothing is created.
        await this.disableLocked(tenant, "setup_expired", latest => latest?.state === "enabling"
          && latest.generation === row.generation && (latest.setupExpiresAt ?? 0) <= this.now());
      } else if (row && (row.state === "disabled" || row.state === "needs_reconnect")
        && this.custodyCleared.get(tenant.toLowerCase()) !== row.generation) {
        // Recover a crash after persisted disable but before local credential deletion. Every
        // credential write first moves the row out of this state at a new generation, so one check
        // per generation per process suffices.
        let credentialPresent: boolean;
        try { credentialPresent = !!await this.options.credentials.status(GOOGLE_AUTOJOIN_CREDENTIAL_SOURCE, tenant); }
        catch (error) { this.grantIndex.invalidate(); throw error; }
        if (credentialPresent) {
          await this.options.credentials.delete(GOOGLE_AUTOJOIN_CREDENTIAL_SOURCE, tenant);
        }
        this.custodyCleared.set(tenant.toLowerCase(), row.generation);
      }
    });
  }

  async accessToken(tenant: string, forceRefresh = false): Promise<string> {
    const connection = await this.readConnection(tenant, this.options.workerStore);
    if (connection?.state !== "enabled") throw new CalendarAutojoinError("autojoin_disabled");
    const cached = this.accessTokens.get(tenant.toLowerCase());
    if (cached) {
      const serves = cached.generation === connection.generation && cached.expiresAt > this.now() + ACCESS_TOKEN_MARGIN_MS
        && cached.custody === credentialCustodyVersion(GOOGLE_AUTOJOIN_CREDENTIAL_SOURCE, tenant);
      this.accessTokens.delete(tenant.toLowerCase());
      if (serves && !forceRefresh) { this.accessTokens.set(tenant.toLowerCase(), cached); return cached.token; }
    }
    const key = `${tenant}:${connection.generation}`;
    const existing = this.refreshing.get(key);
    if (existing) return existing;
    const work = this.readOrRefresh(tenant, connection.generation, forceRefresh);
    this.refreshing.set(key, work);
    try { return await work; } finally { if (this.refreshing.get(key) === work) this.refreshing.delete(key); }
  }

  private async readOrRefresh(tenant: string, generation: number, forceRefresh: boolean): Promise<string> {
    // Before the read: a custody change that lands after it makes the entry below unusable.
    const custody = credentialCustodyVersion(GOOGLE_AUTOJOIN_CREDENTIAL_SOURCE, tenant);
    const old = await this.readCustody(tenant, "token-refresh");
    if (old?.kind !== "oauth" || !old.refreshToken) {
      await this.needsReconnect(tenant, generation);
      throw new CalendarAutojoinError("needs_reconnect", 401);
    }
    if (!forceRefresh && old.expiresAt && Date.parse(old.expiresAt) > this.now() + ACCESS_TOKEN_MARGIN_MS) {
      // Custody changed while it was read: the secret may be one that no longer exists.
      if (credentialCustodyVersion(GOOGLE_AUTOJOIN_CREDENTIAL_SOURCE, tenant) !== custody) throw new CalendarAutojoinError("connection_changed");
      this.cacheToken(tenant, { generation, custody, token: old.accessToken, expiresAt: Date.parse(old.expiresAt) });
      return old.accessToken;
    }
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
        // A compare-and-write on custody: refused when any CredentialStore in this process changed
        // the credential since it was read (a delete, revoke or rotate), or the node holds another
        // version. The refreshed grant is then neither written back nor returned.
        try {
          await this.options.credentials.rotate({ source: GOOGLE_AUTOJOIN_CREDENTIAL_SOURCE, address: tenant, secret },
            { unlessCustodyChangedSince: custody });
        } catch (error) {
          if (error instanceof CredentialCustodyChanged) throw new CalendarAutojoinError("connection_changed");
          this.grantIndex.invalidate(); throw error;
        }
        this.holdGrant(latest, secret);
        // Valid while nothing changes custody after this rotation.
        this.cacheToken(tenant, { generation, custody: custody + CUSTODY_STEPS_PER_CHANGE, token: secret.accessToken, expiresAt: Date.parse(secret.expiresAt!) });
      });
      return tokens.access_token;
    });
  }

  /** Replaces the tenant's entry (most recently used), drops every expired one, and evicts the least
   *  recently used past the bound. */
  private cacheToken(tenant: string, entry: AccessTokenEntry): void {
    for (const [key, value] of this.accessTokens) if (value.expiresAt <= this.now() + ACCESS_TOKEN_MARGIN_MS) this.accessTokens.delete(key);
    this.accessTokens.delete(tenant.toLowerCase());
    this.accessTokens.set(tenant.toLowerCase(), entry);
    while (this.accessTokens.size > (this.options.accessTokenCacheMax ?? ACCESS_TOKEN_CACHE_MAX)) this.accessTokens.delete(this.accessTokens.keys().next().value!);
  }

  async needsReconnect(tenant: string, generation: number, reason: "needs_reconnect" | "invalid_grant" = "needs_reconnect"): Promise<void> {
    await this.options.coordinator.run(tenant, async () => {
      const row = await this.readConnection(tenant);
      if (row?.generation !== generation) return;
      this.grantIndex.detach(tenant);
      const disabled = await this.disableLocked(tenant, reason, latest => latest?.generation === generation);
      if (!disabled) return;
      try {
        await this.options.store.putConnection({ ...disabled, state: "needs_reconnect", errorCode: "needs_reconnect" },
          stored => sameConnectionVersion(stored, disabled) ? { ...stored!, state: "needs_reconnect", errorCode: "needs_reconnect" } : null);
      } catch (error) { if (!(error instanceof CalendarRowChanged)) throw error; } // changed since: it stands
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

  /**
   * Caller holds tenant coordination. Generation persists before credential/occurrence mutation.
   * The disable is a compare-and-set: `when` decides on the stored row, the disabled row is built
   * from that same row, and it is written with If-Match on that row's ETag; a row that changed is read,
   * decided and built again. The default `when` (a user's own disable) also records a row for a tenant
   * with none. Null, with nothing written or torn down, when `when` refuses.
   */
  private async disableLocked(tenant: string, offReason: CalendarAutojoinOffReason,
    when: (current: CalendarConnection | null) => boolean = () => true): Promise<CalendarConnection | null> {
    const disabledFrom = (row: CalendarConnection | null): CalendarConnection => ({ ...(row ?? { tenant, subject: null, scopes: [] }),
      state: "disabled", generation: (row?.generation ?? 0) + 1, nextScanAt: 0,
      credentialRef: undefined, setupId: undefined, setupExpiresAt: undefined, errorCode: undefined, offReason, scanComplete: false });
    // The lifecycle read keeps the grant index current; the write decides and builds on its own read.
    const current = await this.readConnection(tenant);
    if (!when(current)) return null;
    let disabled = disabledFrom(current);
    let refused = false;
    try {
      await this.options.store.putConnection(disabled, stored => {
        refused = !when(stored);
        return refused ? null : (disabled = disabledFrom(stored));
      });
    } catch (error) {
      if (refused && error instanceof CalendarRowChanged) return null;
      this.grantIndex.invalidate(); throw error;
    }
    try {
      this.grantIndex.detach(tenant);
      this.accessTokens.delete(tenant.toLowerCase());
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
