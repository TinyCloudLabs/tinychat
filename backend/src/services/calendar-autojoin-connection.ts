import { createHash, randomBytes } from "node:crypto";
import type { CredentialStore, OAuthCredentialSecret } from "./credential-store.js";
import type { CalendarAutojoinStore, CalendarConnection, TenantCoordinator } from "./calendar-autojoin-store.js";
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
}

/** One-account custody lifecycle. Tenant policy coordination is separate from the global KV lane. */
export class CalendarAutojoinConnection {
  private readonly transactions = new Map<string, Transaction>();
  private readonly refreshing = new Map<string, Promise<string>>();
  private readonly now: () => number;

  constructor(private readonly options: CalendarAutojoinConnectionOptions) {
    this.now = options.now ?? Date.now;
  }

  async getStatus(tenant: string) {
    const connection = await this.options.store.getConnection(tenant);
    const outcomes = (await this.options.store.listOccurrences(tenant))
      .filter(row => !!row.errorCode || ["missed", "missed_window", "failed", "event_ineligible", "event_changed"].includes(row.disposition ?? ""))
      .sort((a, b) => b.start - a.start).slice(0, 30)
      .map(row => ({ id: row.id, title: row.title, start: row.start,
        reason: row.errorCode ?? row.disposition ?? "failed", ...(row.meetingId ? { meetingId: row.meetingId } : {}) }));
    return {
      state: connection?.state === "needs_reconnect" ? "needs_reconnect" as const
        : connection?.errorCode ? "error" as const
        : connection?.state === "enabled" ? "on" as const : "off" as const,
      enabled: connection?.state === "enabled",
      lastScanAt: connection?.lastScanAt ?? null,
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
    const connection = await this.options.store.getConnection(tenant);
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
    await this.options.coordinator.run(tenant, async () => {
      const current = await this.options.store.getConnection(tenant);
      if (transaction.expiresAt <= this.now()) throw new CalendarAutojoinError("invalid_oauth_transaction", 400);
      if ((current?.generation ?? 0) !== transaction.generation) throw new CalendarAutojoinError("connection_changed");
      // Persist disabled scheduling and stop intent in the old subject namespace first.
      const disabled = await this.disableLocked(tenant);
      const enabling: CalendarConnection = {
        ...disabled, subject: tokens.subject!, state: "enabling", consentAt: transaction.consentAt,
        scopes, credentialRef: GOOGLE_AUTOJOIN_CREDENTIAL_SOURCE, setupId,
        setupExpiresAt: this.now() + SETUP_TTL_MS, errorCode: undefined,
      };
      // A crash after this write but before custody remains disabled and is cleaned on expiry.
      await this.options.store.putConnection(enabling);
      await this.options.credentials.store({ source: GOOGLE_AUTOJOIN_CREDENTIAL_SOURCE, address: tenant,
        secret: this.secret(tokens) });
    });
    return { ...browserTokenPayload(tokens), setupId };
  }

  /** Called only after the browser confirms it persisted the matching importer secret. */
  async enable(tenant: string, setupId: string) {
    const connection = await this.options.store.getConnection(tenant);
    this.assertSetup(connection, setupId);
    const secret = await this.options.credentials.getCredential(GOOGLE_AUTOJOIN_CREDENTIAL_SOURCE, tenant, "fetch-worker");
    if (secret?.kind !== "oauth" || !secret.refreshToken) throw new CalendarAutojoinError("refresh_token_required", 400);
    try {
      await this.options.calendar.probePrimary(secret.accessToken);
    } catch (error) {
      if (isPermanentAuthorizationFailure(error)) await this.needsReconnect(tenant, connection!.generation);
      throw error;
    }
    await this.options.coordinator.run(tenant, async () => {
      const latest = await this.options.store.getConnection(tenant);
      this.assertSetup(latest, setupId);
      if (latest!.generation !== connection!.generation) throw new CalendarAutojoinError("connection_changed");
      await this.options.store.putConnection({ ...latest!, state: "enabled", setupId: undefined,
        setupExpiresAt: undefined, nextScanAt: this.now(), errorCode: undefined, scanComplete: false });
    });
    return this.getStatus(tenant);
  }

  async disable(tenant: string) {
    await this.options.coordinator.run(tenant, () => this.disableLocked(tenant));
    return this.getStatus(tenant);
  }

  /** Browser-only reconnect must never silently leave unattended access following another account. */
  async browserReconnect(tenant: string): Promise<void> {
    await this.options.coordinator.run(tenant, () => this.disableLocked(tenant));
  }

  async disconnect(tenant: string, browserToken?: string) {
    let serverToken: string | undefined;
    let unreadable = false;
    await this.options.coordinator.run(tenant, async () => {
      // Read for revocation before ending custody, but never let a decrypt failure prevent deletion.
      try {
        const secret = await this.options.credentials.getCredential(GOOGLE_AUTOJOIN_CREDENTIAL_SOURCE, tenant, "teardown");
        if (secret?.kind === "oauth") serverToken = secret.refreshToken ?? secret.accessToken;
      } catch { unreadable = true; }
      await this.disableLocked(tenant);
    });
    let failed = unreadable;
    const tokens = [...new Set([serverToken, browserToken].filter((token): token is string => !!token))];
    for (const token of tokens) {
      try { await this.options.oauth.revoke(token); } catch (error) {
        // Revoking a refresh token also revokes its sibling access tokens in the same grant.
        if (!(error instanceof GoogleOAuthError && error.error === "invalid_token")) failed = true;
      }
    }
    return { status: "disconnected" as const,
      upstreamRevoked: failed ? "failed" as const : tokens.length ? "ok" as const : "not_applicable" as const };
  }

  async cleanupEnabling(tenant: string): Promise<void> {
    await this.options.coordinator.run(tenant, async () => {
      const row = await this.options.store.getConnection(tenant);
      if (row?.state === "enabling" && (row.setupExpiresAt ?? 0) <= this.now()) {
        await this.disableLocked(tenant);
      } else if (row && (row.state === "disabled" || row.state === "needs_reconnect")) {
        // Recover a crash after persisted disable but before local credential deletion.
        if (await this.options.credentials.status(GOOGLE_AUTOJOIN_CREDENTIAL_SOURCE, tenant)) {
          await this.options.credentials.delete(GOOGLE_AUTOJOIN_CREDENTIAL_SOURCE, tenant);
        }
      }
    });
  }

  async accessToken(tenant: string, forceRefresh = false): Promise<string> {
    const connection = await this.options.store.getConnection(tenant);
    if (connection?.state !== "enabled") throw new CalendarAutojoinError("autojoin_disabled");
    const key = `${tenant}:${connection.generation}`;
    const existing = this.refreshing.get(key);
    if (existing) return existing;
    const work = this.readOrRefresh(tenant, connection.generation, forceRefresh);
    this.refreshing.set(key, work);
    try { return await work; } finally { if (this.refreshing.get(key) === work) this.refreshing.delete(key); }
  }

  private async readOrRefresh(tenant: string, generation: number, forceRefresh: boolean): Promise<string> {
    const old = await this.options.credentials.getCredential(GOOGLE_AUTOJOIN_CREDENTIAL_SOURCE, tenant, "token-refresh");
    if (old?.kind !== "oauth" || !old.refreshToken) {
      await this.needsReconnect(tenant, generation);
      throw new CalendarAutojoinError("needs_reconnect", 401);
    }
    if (!forceRefresh && old.expiresAt && Date.parse(old.expiresAt) > this.now() + 60_000) return old.accessToken;
    let tokens: GoogleTokenPayload;
    try { tokens = await this.options.oauth.refresh(old.refreshToken); }
    catch (error) {
      if (isPermanentAuthorizationFailure(error)) await this.needsReconnect(tenant, generation);
      throw error;
    }
    if (tokens.scope !== undefined && !tokens.scope.split(/\s+/).includes(GOOGLE_CALENDAR_SCOPE)) {
      await this.needsReconnect(tenant, generation);
      throw new CalendarAutojoinError("insufficient_scope", 403);
    }
    return this.options.coordinator.run(tenant, async () => {
      const latest = await this.options.store.getConnection(tenant);
      if (latest?.state !== "enabled" || latest.generation !== generation) throw new CalendarAutojoinError("connection_changed");
      await this.options.credentials.rotate({ source: GOOGLE_AUTOJOIN_CREDENTIAL_SOURCE, address: tenant,
        secret: this.secret(tokens, old) });
      return tokens.access_token;
    });
  }

  async needsReconnect(tenant: string, generation: number): Promise<void> {
    await this.options.coordinator.run(tenant, async () => {
      const row = await this.options.store.getConnection(tenant);
      if (row?.generation !== generation) return;
      const disabled = await this.disableLocked(tenant);
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
  private async disableLocked(tenant: string): Promise<CalendarConnection> {
    const current = await this.options.store.getConnection(tenant);
    const disabled: CalendarConnection = { ...(current ?? { tenant, subject: null, scopes: [] }),
      state: "disabled", generation: (current?.generation ?? 0) + 1, nextScanAt: 0,
      credentialRef: undefined, setupId: undefined, setupExpiresAt: undefined, errorCode: undefined, scanComplete: false };
    await this.options.store.putConnection(disabled);
    for (const [key, value] of this.transactions) if (value.tenant === tenant) this.transactions.delete(key);
    try {
      for (const row of await this.options.store.listOccurrences(tenant)) {
        if (row.phase === "terminal" || (!row.createBody && !row.meetingId && !row.idempotencyKey)) continue;
        await this.options.store.updateOccurrence(tenant, row.id, latest => latest && latest.phase !== "terminal"
          ? { ...latest, stopRequested: true, nextAttemptAt: this.now(), updatedAt: this.now() } : latest);
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
