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

export interface ConnectorWebhooksClient {
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
): ConnectorWebhooksClient {
  const { sessionStore } = config;
  // Bound, so calling it as a property does not rebind `this` (firefliesClient.ts).
  const fetchImpl = config.fetchImpl ?? fetch.bind(globalThis);

  async function request<T>(
    path: string,
    init: { method: "GET" | "POST" | "DELETE"; body?: unknown },
  ): Promise<ConnectorWebhooksResult<T>> {
    // `createApiClient`'s two pre-flight checks. It throws on both; a defined
    // signed-out state is not an exception here, so they resolve instead.
    const token = sessionStore.getToken();
    if (!token) return { status: "unauthenticated" };
    if (sessionStore.isExpired()) {
      sessionStore.clear();
      return { status: "unauthenticated" };
    }

    const hasBody = init.body !== undefined;
    let response: Response;
    try {
      response = await fetchImpl(`${backendUrl}${CONNECTOR_WEBHOOKS_BASE_PATH}${path}`, {
        method: init.method,
        headers: {
          ...(hasBody ? { "Content-Type": "application/json" } : {}),
          Authorization: `Bearer ${token}`,
          [REQUEST_HEADER_NAME]: REQUEST_HEADER_VALUE,
        },
        ...(hasBody ? { body: JSON.stringify(init.body) } : {}),
      });
    } catch {
      // The error is not narrated: it can carry the delivery URL, and no
      // connector identifier reaches a log from this module (§6.3's browser half).
      return { status: "offline" };
    }

    // 401 clears the session, exactly as `createApiClient` does — SIWE has no
    // silent refresh, so the caller has to sign in again.
    if (response.status === 401) {
      sessionStore.clear();
      return { status: "unauthenticated" };
    }
    // The router is mounted only when the feature flag is on, and every path
    // inside it exists. A 404 therefore means DARK, which is a product state:
    // do not show a setup control merely because the bundle contains one.
    if (response.status === 404) return { status: "feature-dark" };

    if (!response.ok) {
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
