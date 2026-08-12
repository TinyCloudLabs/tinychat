import type { SessionStore } from "@tinyboilerplate/client";
import type { ConnectorWebhooksResult } from "./webhooksApi";

/**
 * The typed client for W5's authenticated READ API
 * (`backend/src/routes/connector-meetings.ts` + `backend/openapi.yaml`).
 *
 * This is the module the goal is stated in: for an address in the dark
 * backend-ingest cohort, the backend already holds the meeting, so a device that
 * has never opened the app can see it after nothing but a sign-in — **no vault,
 * no Fireflies key, no wallet prompt**. Nothing in this file touches the
 * TinyCloud handle, the browser vault or a connector key, and nothing it returns
 * is persisted: the meetings view holds the page in component state and re-reads
 * it.
 *
 * Three routes, mirroring the backend contract exactly:
 *
 *   `list()`           `GET  /api/connectors/meetings`                         (metadata, paginated)
 *   `read()`           `GET  /api/connectors/meetings/:source/:sourceId`       (one meeting's content)
 *   `markReconciled()` `POST /api/connectors/meetings/:source/:sourceId/reconciled`
 *
 * ── The two meanings of 404 ──
 *
 * The router is mounted only when the dark flag is armed and answers 404 for
 * every address outside the cohort, so a 404 on the LIST means the surface does
 * not exist for this user: `feature-dark`, hide it, retry nothing. A 404 on ONE
 * meeting means that meeting is gone (retention swept it between the list and
 * the click, or a purge removed it) — reading THAT as `feature-dark` would hide
 * a working archive because one row aged out, so it is its own `not-found`.
 *
 * ── Why the transport is spelled out again ──
 *
 * The bearer + CSRF construction is `createApiClient`'s, byte for byte, for the
 * same two reasons `webhooksApi.ts` gives: `createApiClient` collapses every
 * non-2xx into a thrown Error (so dark, retryable and rejected become one
 * message), and this surface has to tell those apart to decide between hiding
 * itself, retrying, and telling the user. `webhooksApi.ts`'s own transport is
 * closure-private and bound to its base path; copying the twenty lines is
 * cheaper than widening a frozen module's surface.
 */

/** One stored meeting's metadata. The transcript and summary never ride the list. */
export interface ConnectorMeetingMeta {
  sourceId: string;
  title?: string;
  /** The provider's own meeting timestamp, when it gave one. */
  ts?: string;
  transcriptStoredAt?: string;
  summaryStoredAt?: string;
  /** Set once the browser copied this meeting into the user's OWN space (W6). */
  reconciledAt?: string;
  sizeBytes: number;
  storedAt: string;
  updatedAt: string;
  /** A partial row is legal: a summary can arrive before — or without — a transcript. */
  hasTranscript: boolean;
  hasSummary: boolean;
}

export interface ConnectorMeetingList {
  source: string;
  meetings: ConnectorMeetingMeta[];
  /** The last id on this page, or null when there is no next page. */
  nextCursor: string | null;
  hasMore: boolean;
}

export interface ConnectorMeetingContent {
  source: string;
  sourceId: string;
  meta: ConnectorMeetingMeta;
  /** Either half may be absent. Both are provider payloads — treated as opaque. */
  content: { transcript?: unknown; summary?: unknown };
}

export interface ConnectorMeetingReconciled {
  reconciled: true;
  source: string;
  sourceId: string;
}

/**
 * `webhooksApi`'s envelope plus one member: a single meeting that is gone. Every
 * call resolves; a resolved non-`ok` result is a FAILURE the caller must handle.
 */
export type ConnectorMeetingsResult<T> =
  | ConnectorWebhooksResult<T>
  | { status: "not-found" };

export const CONNECTOR_MEETINGS_BASE_PATH = "/api/connectors/meetings";

// `createApiClient`'s CSRF header, spelled here for the same reason chatApi.ts
// and webhooksApi.ts spell it: the constants are not exported from the client.
const REQUEST_HEADER_NAME = "X-Requested-With";
const REQUEST_HEADER_VALUE = "XMLHttpRequest";

export interface ConnectorMeetingsClientConfig {
  sessionStore: SessionStore;
  /** Injectable for tests, as the sibling clients do. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

export interface ConnectorMeetingsClient {
  /** One page of metadata, newest first. Strictly a read — the route writes nothing. */
  list(options?: {
    source?: string;
    limit?: number;
    cursor?: string;
    /**
     * W6's discovery filter (plan §5.3: reconcile discovery IS a read-API list
     * filter). `false` = only the rows this space has not copied yet. Omitted =
     * both, which is what the meetings view wants.
     */
    reconciled?: boolean;
  }): Promise<ConnectorMeetingsResult<ConnectorMeetingList>>;
  /** One meeting's content, decrypted backend-side for its owner. Also a pure read. */
  read(
    source: string,
    sourceId: string,
  ): Promise<ConnectorMeetingsResult<ConnectorMeetingContent>>;
  /**
   * The reconcile-ack — the ONE mutation. W6 calls it only AFTER the user-space
   * write succeeded (storage-before-ack), never before.
   */
  markReconciled(
    source: string,
    sourceId: string,
  ): Promise<ConnectorMeetingsResult<ConnectorMeetingReconciled>>;
}

export function createConnectorMeetingsClient(
  backendUrl: string,
  config: ConnectorMeetingsClientConfig,
): ConnectorMeetingsClient {
  const { sessionStore } = config;
  // Bound, so calling it as a property does not rebind `this` (the house idiom).
  const fetchImpl = config.fetchImpl ?? fetch.bind(globalThis);

  async function request<T>(
    path: string,
    init: {
      method: "GET" | "POST";
      /** What a 404 MEANS on this route — the two readings are not interchangeable. */
      missing: "feature-dark" | "not-found";
    },
  ): Promise<ConnectorMeetingsResult<T>> {
    // `createApiClient`'s two pre-flight checks. It throws on both; a defined
    // signed-out state is not an exception here, so they resolve instead.
    const token = sessionStore.getToken();
    if (!token) return { status: "unauthenticated" };
    if (sessionStore.isExpired()) {
      sessionStore.clear();
      return { status: "unauthenticated" };
    }

    let response: Response;
    try {
      response = await fetchImpl(`${backendUrl}${CONNECTOR_MEETINGS_BASE_PATH}${path}`, {
        method: init.method,
        headers: {
          Authorization: `Bearer ${token}`,
          [REQUEST_HEADER_NAME]: REQUEST_HEADER_VALUE,
        },
      });
    } catch {
      // Not narrated: a connector identifier must never reach a log from the
      // browser half either (§6.3).
      return { status: "offline" };
    }

    if (response.status === 401) {
      sessionStore.clear();
      return { status: "unauthenticated" };
    }
    if (response.status === 404) {
      return init.missing === "feature-dark"
        ? { status: "feature-dark" }
        : { status: "not-found" };
    }

    if (!response.ok) {
      const code = await readErrorCode(response);
      if (response.status === 429 || response.status >= 500) {
        return { status: "retryable", httpStatus: response.status, code };
      }
      return { status: "rejected", httpStatus: response.status, code };
    }

    try {
      return { status: "ok", value: (await response.json()) as T };
    } catch {
      // A 2xx we cannot read is a failure, never an empty archive.
      return { status: "rejected", httpStatus: response.status, code: null };
    }
  }

  async function readErrorCode(response: Response): Promise<string | null> {
    try {
      const body = (await response.json()) as { error?: unknown };
      return typeof body?.error === "string" ? body.error : null;
    } catch {
      return null;
    }
  }

  return {
    list(options = {}) {
      const query = new URLSearchParams();
      // Only the three documented parameters are ever sent. There is no address
      // parameter to send: the tenant is the session, and a client that can name
      // one is where the cross-tenant bug starts.
      if (options.source !== undefined) query.set("source", options.source);
      if (options.limit !== undefined) query.set("limit", String(options.limit));
      if (options.cursor !== undefined) query.set("cursor", options.cursor);
      // Exactly the two literals the route accepts — it 400s anything else rather
      // than ignoring the filter, so `String(boolean)` is the contract, not a guess.
      if (options.reconciled !== undefined) {
        query.set("reconciled", options.reconciled ? "true" : "false");
      }
      const suffix = query.size === 0 ? "" : `?${query.toString()}`;
      return request<ConnectorMeetingList>(suffix, {
        method: "GET",
        missing: "feature-dark",
      });
    },
    read(source, sourceId) {
      return request<ConnectorMeetingContent>(
        `/${encodeURIComponent(source)}/${encodeURIComponent(sourceId)}`,
        { method: "GET", missing: "not-found" },
      );
    },
    markReconciled(source, sourceId) {
      return request<ConnectorMeetingReconciled>(
        `/${encodeURIComponent(source)}/${encodeURIComponent(sourceId)}/reconciled`,
        { method: "POST", missing: "not-found" },
      );
    },
  };
}
