import { clearSessionAfterHandoff } from "../sessionSignedOut";
import type { SessionStore } from "@tinyboilerplate/client";

/**
 * The typed companion client for the connector-webhook routes
 * (`backend/src/routes/connector-webhooks.ts` + `backend/openapi.yaml`).
 *
 * Every type below MIRRORS the backend contract; nothing here is invented. The
 * card and the ingest path talk to the backend only through this module, so the
 * four states the surface has to tell apart live in ONE place:
 *
 *   `feature-dark`     the router is not mounted (`CONNECTOR_WEBHOOKS_ENABLED`
 *                      off) — a DEFINED product state, not an error. The whole
 *                      setup control is hidden; nothing is retried.
 *   `unauthenticated`  no session, an expired one, or a 401 — the session is
 *                      cleared, exactly as `createApiClient` does.
 *   `retryable`        503 / 429 / any 5xx. The backend asks for the SAME
 *                      idempotent call again; the card says "temporarily
 *                      unavailable", never "nothing pending".
 *   `rejected`         a 4xx that a retry cannot fix (`invalid_meeting_id`,
 *                      `unknown_source`, …).
 *
 * plus the fifth, which is a 200 body and not a status: `surfaceBlocked`. The
 * backend's surfacing gate FAILS CLOSED (a standing disabled marker, an
 * unreadable purge ledger, an aborted drain) and hands back an empty queue with
 * a reason. Reading that as "nothing pending" is the silence §4.4 forbids, so
 * `readSurfaceBlocked` is the only sanctioned way to ask.
 *
 * ── Why not `createApiClient(...).get/post/del` as the transport ──
 *
 * The bearer + CSRF construction is `createApiClient`'s, byte for byte, and
 * `webhooksApi.test.ts` PINS that by capturing what `createApiClient` puts on
 * the wire and comparing headers. What is not reused is its response handling,
 * for two contract-level reasons:
 *
 *  1. it collapses every non-2xx into a thrown `Error`, so the four states above
 *     are indistinguishable from the message alone — the route-disabled 404 that
 *     must hide the surface would look exactly like the 503 that must be
 *     retried;
 *  2. its `del()` sends no body, and `DELETE /purged` REQUIRES `{source}` (the
 *     route answers `400 unknown_source` without one).
 *
 * `chatApi.ts` sets the precedent for mirroring those headers when the shared
 * client's response handling does not fit the route (there, SSE).
 *
 * ── The one-time delivery secret ──
 *
 * `POST /config` on a mint/rotate is the ONLY response that carries `secret`,
 * and this module is a pass-through for it: it is returned to the caller and
 * held NOWHERE — no module state, no client field, no storage, no log. The
 * component that asked for the mint owns the value for as long as it renders the
 * reveal, and that is the whole lifetime. `GET /config` is defensively
 * normalized to `secret: null` so a value that has no business riding a poll
 * cannot reach a caller that would render or keep it. Nothing in this file
 * writes to `localStorage`, and no identifier — URL, token or secret — is ever
 * passed to `console`.
 */

// ── Wire types (exact mirrors of the backend contract) ───────────────

/** §4.5: `meeting.summarized` queues as a DISTINCT identity from its transcript. */
export type ConnectorPendingKind = "transcript" | "summary";

/** `GET /config`, and the config half of a `POST /config` response. */
export interface ConnectorWebhookConfig {
  /** False whenever a durable disabled marker stands, even over a surviving config. */
  enabled: boolean;
  disabledAt: string | null;
  source: string | null;
  /** The delivery URL the user pastes into their provider dashboard. */
  url: string | null;
  /**
   * The derived per-user signing secret. Non-null ONLY on a mint/rotate
   * `POST /config` response — null on `GET /config` and on a no-op POST.
   */
  secret: string | null;
  /** Whether a secret exists, so the card renders without ever re-reading it. */
  hasSecret: boolean;
  createdAt: string | null;
}

/** A `GET /config` poll. The secret never rides it. */
export interface ConnectorWebhookConfigPoll extends ConnectorWebhookConfig {
  secret: null;
}

/** `POST /config` — `rotated` is true when a new token invalidated the old URL. */
export interface ConnectorWebhookEnabled extends ConnectorWebhookConfig {
  status: "enabled";
  rotated: boolean;
}

/** `DELETE /config` — the single idempotent teardown. */
export interface ConnectorWebhookDisabled {
  status: "disabled";
  /** Exact, not a lower bound: the count comes from the clear itself. */
  queueDropped: number;
}

/**
 * `DELETE /api/connectors/credentials/:source` — the whole server-side teardown
 * (purge tombstone, stored sign-in, upstream revoke, held content, queue). Both
 * `ok` shapes mean the sign-in is gone from our server; `upstreamRevoked: false`
 * on a 502 means the provider did not confirm the revoke.
 */
export interface ConnectorCredentialTeardown {
  deleted: boolean;
  upstreamRevoked: boolean;
}

/**
 * Shown when the server removed the stored sign-in but the provider did not
 * confirm the revoke, so the owner can revoke it themselves.
 */
export const CREDENTIAL_REVOKE_UNCONFIRMED_MESSAGE =
  "Your Fireflies sign-in was removed from our server, but Fireflies didn't confirm it was revoked. Revoke it yourself in your Fireflies account.";

export interface ConnectorPendingItem {
  meetingId: string;
  kind: ConnectorPendingKind;
  receivedAt: string;
  attempts: number;
  nextAttemptAt: string;
  /** Short code only — never a payload fragment. */
  lastError?: string;
}

export interface ConnectorDeadItem extends ConnectorPendingItem {
  deadAt: string;
}

/** The reasons the backend's surfacing gate refuses to hand back ids. */
export type ConnectorSurfaceBlockedReason =
  | "revoked"
  | "ledger_unavailable"
  | "delegation_unusable"
  | "drain_aborted"
  | "drain_unreported";

export const CONNECTOR_SURFACE_BLOCKED_REASONS: readonly ConnectorSurfaceBlockedReason[] =
  [
    "revoked",
    "ledger_unavailable",
    "delegation_unusable",
    "drain_aborted",
    "drain_unreported",
  ];

/** `GET /pending` and `POST /drain`. */
export interface ConnectorWebhookPending {
  enabled: boolean;
  disabledAt: string | null;
  source: string | null;
  /** True while the caller's per-token delivery bucket is tripped — a card state. */
  deliveriesRateLimited: boolean;
  count: number;
  pending: ConnectorPendingItem[];
  deadCount: number;
  dead: ConnectorDeadItem[];
  /**
   * Present ONLY when the gate refused, in which case `count` is 0 and both
   * lists are empty. Typed loosely on the wire (a future backend reason must not
   * be read as "not blocked") — go through {@link readSurfaceBlocked}.
   */
  surfaceBlocked?: ConnectorSurfaceBlockedReason | (string & {});
}

/** One identity the browser has already written to the user's own space. */
export interface ConnectorAckItem {
  meetingId: string;
  kind: ConnectorPendingKind;
  /** Optional, and only `done` is accepted: successes only, in this version. */
  status?: "done";
}

export interface ConnectorAckRequest {
  /** Optional, and may only CONFIRM the caller's configured source. */
  source?: string;
  items: ConnectorAckItem[];
}

/** `POST /ack` — the caller's own queue snapshot plus the settlement counts. */
export interface ConnectorAckResult extends ConnectorWebhookPending {
  status: "acknowledged";
  /** Identities removed from the pending queue by this call. */
  acknowledged: number;
  /** Already gone — the lost-response retry, which is a success. */
  alreadySettled: number;
  /** Covered by the purge ledger: NOT settled and NOT counted as ingested. */
  tombstoned: number;
}

export interface ConnectorPurgeRequest {
  source: string;
  ids: string[];
  /** Watermark to advance to; defaults to now, never moves backwards. */
  purgedThrough?: string;
}

/**
 * `POST /purged` 200 — more than 200 ids, so only the newest are kept in
 * `recentIds`. The watermark still covers every id. The ordinary case is a 204,
 * which this client reports as an `ok` result carrying `null`.
 */
export interface ConnectorPurgeOverflow {
  status: "accepted";
  stored: number;
  dropped: number;
}

// ── Result envelope ──────────────────────────────────────────────────

/**
 * Every call resolves; nothing throws. A resolved non-`ok` result is a FAILURE
 * the caller must handle — the repo's fail-closed convention, and the reason
 * there is no fallback here that could hide one.
 */
export type ConnectorWebhooksResult<T> =
  | { status: "ok"; value: T }
  /** 404: the companion router is not mounted. The feature is dark — hide the surface. */
  | { status: "feature-dark" }
  /** 401, no token, or an expired session. The session has been cleared. */
  | { status: "unauthenticated" }
  /** 429 / 5xx. Retry the SAME idempotent call. */
  | { status: "retryable"; httpStatus: number; code: string | null }
  /** A 4xx a retry cannot fix, or an unreadable 2xx body. */
  | { status: "rejected"; httpStatus: number; code: string | null }
  /** The request never got an answer (network / abort). */
  | { status: "offline" };

/** The connector grant the backend holds for the owner: `DELETE` removes it. */
export const BACKEND_DELEGATION_BASE_PATH = "/api/delegations";

/** The exo sync grant: `DELETE` removes it. */
export const EXO_GRANT_BASE_PATH = "/api/exo/v1/grant";

/** Calendar autojoin: `POST /disconnect`. */
const CALENDAR_AUTOJOIN_BASE_PATH = "/api/connectors/google/autojoin";

/** `upstreamRevoked`: `ok` Google confirmed, `failed` Google did not, `not_applicable` nothing was stored. */
export interface CalendarAutojoinDisconnect {
  upstreamRevoked: "ok" | "failed" | "not_applicable";
}

/** The server-side Fireflies import grant: `DELETE` removes it. */
export const FIREFLIES_IMPORT_GRANT_BASE_PATH = "/api/connectors/fireflies/delegation";

/** The base path of the credential teardown. One segment deep: `/:source`. */
export const CONNECTOR_CREDENTIALS_BASE_PATH = "/api/connectors/credentials";

/**
 * The backend's own "this route is not available here" marker on a 404 (not mounted, or the owner
 * is not enrolled). A 404 without it came from somewhere else and is a failure, not a skip.
 */
export const ROUTE_UNAVAILABLE_HEADER = "X-Route-Unavailable";
export const CREDENTIALS_ROUTE_UNAVAILABLE = "connector-credentials";

/** The base path of the authenticated companions. Every route is ONE segment deep. */
export const CONNECTOR_WEBHOOKS_BASE_PATH = "/api/connectors/webhooks";

// `createApiClient`'s CSRF header, spelled here for the same reason chatApi.ts
// spells it: the constants are not exported from `@tinyboilerplate/client`.
// Header parity with `createApiClient` is pinned by test, not by comment.
const REQUEST_HEADER_NAME = "X-Requested-With";
const REQUEST_HEADER_VALUE = "XMLHttpRequest";

export interface ConnectorWebhooksClientConfig {
  sessionStore: SessionStore;
  /** Injectable for tests, as `FirefliesClient` does. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

/** `source` names a ledger-only source such as Granola; absent means Fireflies. */
export type FirefliesPurgeCheck = (meetingId: string, sourceTimestamp: string | null, source?: string, signal?: AbortSignal) => Promise<boolean>;

export interface ConnectorWebhooksClient {
  checkPurge?: FirefliesPurgeCheck;
  /** Poll. Never carries the delivery secret — read `hasSecret`. */
  getConfig(): Promise<ConnectorWebhooksResult<ConnectorWebhookConfigPoll>>;
  /**
   * Enable background sync, and mint/rotate the routing token. A mint or an
   * explicit `rotate` is the ONE response that carries the delivery secret; the
   * caller must hold it in component state only and must never persist it.
   */
  enable(options?: {
    source?: string;
    rotate?: boolean;
  }): Promise<ConnectorWebhooksResult<ConnectorWebhookEnabled>>;
  /** The single idempotent teardown. Retry the same call on `retryable`. */
  disable(): Promise<ConnectorWebhooksResult<ConnectorWebhookDisabled>>;
  /**
   * Delete the sign-in our server holds for `source` and ask the provider to
   * revoke it. A bare `DELETE` carrying only the session auth: no provider
   * token is ever read, held or sent from here. `feature-dark` (a 404 carrying the backend's
   * not-available marker) means the route is not mounted or the owner is not
   * enrolled — nothing to do; an unmarked 404 is a retryable failure. A read-only
   * `GET` comes first; any failed read is a failure, never a skip. The full `DELETE`
   * follows whether or not a sign-in is still stored, so a retry finishes a
   * teardown that stopped part-way. With no sign-in stored, a completed `DELETE`
   * resolves `ok` with `null`.
   * A failed provider revoke is still an
   * `ok` (`upstreamRevoked: false`): the local delete happened. Optional so a
   * lane that has no server-side sign-in (and test doubles) simply omits it.
   */
  teardownCredential?(
    source: string,
  ): Promise<ConnectorWebhooksResult<ConnectorCredentialTeardown | null>>;
  /**
   * Remove the import grant our server holds for the owner's Fireflies account, so it can no longer
   * import into the owner's space. `feature-dark` (a 404) means the server import is not mounted.
   * Optional so test doubles omit it.
   */
  removeFirefliesImportGrant?(): Promise<ConnectorWebhooksResult<{ state: string }>>;
  /**
   * Remove the connector grant our server holds for the owner (`DELETE /api/delegations`), which also clears
   * the owner's exo state. `feature-dark` (a 404) means nothing is mounted. Optional so test doubles omit it.
   */
  removeBackendDelegation?(): Promise<ConnectorWebhooksResult<{ status: string }>>;
  /** Remove the exo sync grant (`DELETE /api/exo/v1/grant`); a 404 (not mounted) is `feature-dark`. Optional like the above. */
  removeExoGrant?(): Promise<ConnectorWebhooksResult<{ status: string }>>;
  /**
   * Stop Calendar autojoin and delete the Google sign-in our server holds (`POST /disconnect` with `{}`).
   * `ok` with `upstreamRevoked: "failed"` (a 502) means the local delete happened and Google did not confirm
   * the revoke. A 404 is `feature-dark` (not mounted). Optional like the above.
   */
  disconnectCalendarAutojoin?(): Promise<ConnectorWebhooksResult<CalendarAutojoinDisconnect>>;
  getPending(): Promise<ConnectorWebhooksResult<ConnectorWebhookPending>>;
  /** The user-visit drain trigger. The response is the drain's OWN surfaced list. */
  drain(): Promise<ConnectorWebhooksResult<ConnectorWebhookPending>>;
  /** Settle identities the browser has already written. Idempotent by design. */
  acknowledge(
    request: ConnectorAckRequest,
  ): Promise<ConnectorWebhooksResult<ConnectorAckResult>>;
  /** Record a purge. `null` is the ordinary 204; a body reports the recentIds overflow. */
  recordPurge(
    request: ConnectorPurgeRequest,
  ): Promise<ConnectorWebhooksResult<ConnectorPurgeOverflow | null>>;
  /** The explicit user-initiated re-sync. Never fired automatically. */
  clearPurgeLedger(source: string): Promise<ConnectorWebhooksResult<null>>;
}

/**
 * Read the fail-closed surfacing gate. An unrecognized reason still reads as
 * BLOCKED: a backend that grows a new refusal must not be interpreted as "the
 * queue is empty" by an older bundle.
 */
export function readSurfaceBlocked(
  snapshot: Pick<ConnectorWebhookPending, "surfaceBlocked">,
):
  | { blocked: false }
  | { blocked: true; reason: ConnectorSurfaceBlockedReason | "unknown" } {
  const raw = snapshot.surfaceBlocked;
  if (typeof raw !== "string" || raw.length === 0) return { blocked: false };
  const known = CONNECTOR_SURFACE_BLOCKED_REASONS.find((r) => r === raw);
  return { blocked: true, reason: known ?? "unknown" };
}

export function createConnectorWebhooksClient(
  backendUrl: string,
  config: ConnectorWebhooksClientConfig,
): ConnectorWebhooksClient & { checkPurge: FirefliesPurgeCheck } {
  const { sessionStore } = config;
  // Bound, so calling it as a property does not rebind `this` (firefliesClient.ts).
  const fetchImpl = config.fetchImpl ?? fetch.bind(globalThis);

  async function request<T>(
    path: string,
    init: {
      method: "GET" | "POST" | "DELETE";
      body?: unknown;
      basePath?: string;
      signal?: AbortSignal;
      /** When set, a 404 is `feature-dark` only if it carries this marker header value; otherwise it is retryable. */
      darkMarker?: string;
      /** Reads a non-2xx answer the caller treats as a value; `null` falls through to the default failures. */
      onFailure?: (response: Response) => Promise<ConnectorWebhooksResult<T> | null>;
    },
  ): Promise<ConnectorWebhooksResult<T>> {
    // `createApiClient`'s two pre-flight checks. It throws on both; a defined
    // signed-out state is not an exception here, so they resolve instead.
    const token = sessionStore.getToken();
    if (!token) return { status: "unauthenticated" };
    if (sessionStore.isExpired()) {
      await clearSessionAfterHandoff(sessionStore);
      return { status: "unauthenticated" };
    }

    const hasBody = init.body !== undefined;
    let response: Response;
    try {
      response = await fetchImpl(
        `${backendUrl}${init.basePath ?? CONNECTOR_WEBHOOKS_BASE_PATH}${path}`,
        {
          method: init.method,
          headers: {
            ...(hasBody ? { "Content-Type": "application/json" } : {}),
            Authorization: `Bearer ${token}`,
            [REQUEST_HEADER_NAME]: REQUEST_HEADER_VALUE,
          },
          ...(hasBody ? { body: JSON.stringify(init.body) } : {}),
          signal: init.signal,
        },
      );
    } catch {
      // The error is not narrated: it can carry the delivery URL, and no
      // connector identifier reaches a log from this module (§6.3's browser half).
      return { status: "offline" };
    }

    // 401 clears the session, exactly as `createApiClient` does — SIWE has no
    // silent refresh, so the caller has to sign in again.
    if (response.status === 401) {
      await clearSessionAfterHandoff(sessionStore);
      return { status: "unauthenticated" };
    }
    // The router is mounted only when the feature flag is on, and every path
    // inside it exists. A 404 therefore means DARK, which is a product state:
    // do not show a setup control merely because the bundle contains one.
    if (response.status === 404) {
      if (
        init.darkMarker === undefined ||
        response.headers.get(ROUTE_UNAVAILABLE_HEADER) === init.darkMarker
      ) {
        return { status: "feature-dark" };
      }
      return { status: "retryable", httpStatus: 404, code: await readErrorCode(response) };
    }

    if (!response.ok) {
      const handled = init.onFailure ? await init.onFailure(response.clone()) : null;
      if (handled !== null) return handled;
      const code = await readErrorCode(response);
      if (response.status === 429 || response.status >= 500) {
        return { status: "retryable", httpStatus: response.status, code };
      }
      return { status: "rejected", httpStatus: response.status, code };
    }

    if (response.status === 204) return { status: "ok", value: null as T };
    try {
      return { status: "ok", value: (await response.json()) as T };
    } catch {
      // A 2xx we cannot read is a failure, never an empty snapshot.
      return { status: "rejected", httpStatus: response.status, code: null };
    }
  }

  /** `ConnectorError.error` — a short code, or null when the body is not one. */
  async function readErrorCode(response: Response): Promise<string | null> {
    try {
      const body = (await response.json()) as { error?: unknown };
      return typeof body?.error === "string" ? body.error : null;
    } catch {
      return null;
    }
  }

  return {
    async checkPurge(meetingId, sourceTimestamp, source, signal) {
      const result = await request<{ blocked: boolean }>("/purge-check", {
        method: "POST",
        body: source === undefined ? { meetingId, sourceTimestamp } : { meetingId, sourceTimestamp, source },
        signal,
      });
      if (result.status !== "ok" || typeof result.value?.blocked !== "boolean") {
        throw new Error("Fireflies sync failed");
      }
      return result.value.blocked;
    },
    async getConfig() {
      const result = await request<ConnectorWebhookConfig>("/config", {
        method: "GET",
      });
      if (result.status !== "ok") return result;
      // Defence in depth: the route returns `secret: null` on a poll, and a
      // value that reached here anyway is dropped rather than handed to a
      // caller that might render or keep it.
      return { status: "ok", value: { ...result.value, secret: null } };
    },
    enable(options = {}) {
      const body: { source?: string; rotate?: boolean } = {};
      if (options.source !== undefined) body.source = options.source;
      if (options.rotate !== undefined) body.rotate = options.rotate;
      return request<ConnectorWebhookEnabled>("/config", {
        method: "POST",
        body,
      });
    },
    disable() {
      return request<ConnectorWebhookDisabled>("/config", { method: "DELETE" });
    },
    async teardownCredential(source) {
      const path = `/${encodeURIComponent(source)}`;
      const stored = await request<{ connected?: unknown }>(path, {
        method: "GET",
        basePath: CONNECTOR_CREDENTIALS_BASE_PATH,
        darkMarker: CREDENTIALS_ROUTE_UNAVAILABLE,
      });
      if (stored.status !== "ok") return stored;
      if (typeof stored.value?.connected !== "boolean") {
        return { status: "rejected", httpStatus: 200, code: null };
      }
      const connected = stored.value.connected;
      let revokeUnconfirmed = false;
      const torn = await request<ConnectorCredentialTeardown | null>(path, {
        method: "DELETE",
        basePath: CONNECTOR_CREDENTIALS_BASE_PATH,
        // 502 `upstream_revoke_failed` + `deleted: true`: the local delete
        // happened and only the provider's confirmation is missing.
        async onFailure(response) {
          if (response.status !== 502) return null;
          try {
            const body = (await response.json()) as { error?: unknown; deleted?: unknown };
            if (body?.error === "upstream_revoke_failed" && body.deleted === true) {
              revokeUnconfirmed = true;
              return { status: "ok", value: { deleted: true, upstreamRevoked: false } };
            }
          } catch {
            // An unreadable 502 is a plain retryable failure.
          }
          return null;
        },
      });
      if (!connected && torn.status === "ok" && !revokeUnconfirmed) {
        return { status: "ok", value: null };
      }
      return torn;
    },
    removeFirefliesImportGrant() {
      return request<{ state: string }>("", { method: "DELETE", basePath: FIREFLIES_IMPORT_GRANT_BASE_PATH });
    },
    removeBackendDelegation() {
      return request<{ status: string }>("", { method: "DELETE", basePath: BACKEND_DELEGATION_BASE_PATH });
    },
    removeExoGrant() {
      return request<{ status: string }>("", { method: "DELETE", basePath: EXO_GRANT_BASE_PATH });
    },
    disconnectCalendarAutojoin() {
      return request<CalendarAutojoinDisconnect>("/disconnect", {
        method: "POST",
        body: {},
        basePath: CALENDAR_AUTOJOIN_BASE_PATH,
        // 502 `upstreamRevoked: "failed"`: the stored sign-in was deleted here and only Google's confirmation is missing.
        async onFailure(response) {
          if (response.status !== 502) return null;
          try {
            const body = (await response.json()) as { upstreamRevoked?: unknown };
            if (body?.upstreamRevoked === "failed") return { status: "ok", value: { upstreamRevoked: "failed" } };
          } catch {
            // An unreadable 502 is a plain retryable failure.
          }
          return null;
        },
      });
    },
    getPending() {
      return request<ConnectorWebhookPending>("/pending", { method: "GET" });
    },
    drain() {
      // No body: `POST /drain` reads none, and the source comes from the config.
      return request<ConnectorWebhookPending>("/drain", { method: "POST", body: {} });
    },
    acknowledge(ackRequest) {
      const body: ConnectorAckRequest = { items: ackRequest.items };
      if (ackRequest.source !== undefined) body.source = ackRequest.source;
      // Sent verbatim: the backend validates every id and kind, rejects the
      // whole batch on one bad element, and caps the batch at 200. A second,
      // client-side copy of those rules is a second thing to forget to update.
      return request<ConnectorAckResult>("/ack", { method: "POST", body });
    },
    recordPurge(purgeRequest) {
      const body: ConnectorPurgeRequest = {
        source: purgeRequest.source,
        ids: purgeRequest.ids,
      };
      if (purgeRequest.purgedThrough !== undefined) {
        body.purgedThrough = purgeRequest.purgedThrough;
      }
      return request<ConnectorPurgeOverflow | null>("/purged", {
        method: "POST",
        body,
      });
    },
    clearPurgeLedger(source) {
      // A DELETE **with** a body — the route requires `{source}`.
      return request<null>("/purged", { method: "DELETE", body: { source } });
    },
  };
}
