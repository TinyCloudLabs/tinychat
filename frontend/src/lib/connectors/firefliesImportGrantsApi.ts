import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { clearSessionAfterHandoff } from "../sessionSignedOut";
import { revokeImportGrants, type DisconnectImportGrants } from "./connectorLifecycle";
import type { ConnectorWebhooksResult } from "./webhooksApi";

/** The owner-scoped routes for the permissions the server holds to import Fireflies meetings. */
export const FIREFLIES_IMPORT_DELEGATION_PATH = "/api/connectors/fireflies/delegation";

const REQUEST_HEADER_NAME = "X-Requested-With";
const REQUEST_HEADER_VALUE = "XMLHttpRequest";

export interface FirefliesImportGrantsClient {
  /**
   * The ids of the two permissions the server currently holds for this owner: `[]` when none are
   * active. `feature-dark` means the server has the import off, so it holds nothing.
   */
  listGrantCids(): Promise<ConnectorWebhooksResult<string[]>>;
  /** Removes the stored permissions from the server. Idempotent: no stored permissions is `ok`. */
  removeGrant(): Promise<ConnectorWebhooksResult<null>>;
}

export function createFirefliesImportGrantsClient(
  backendUrl: string,
  config: { sessionStore: SessionStore; fetchImpl?: typeof fetch },
): FirefliesImportGrantsClient {
  const { sessionStore } = config;
  const fetchImpl = config.fetchImpl ?? fetch.bind(globalThis);

  async function request<T>(path: string, method: "GET" | "DELETE"): Promise<ConnectorWebhooksResult<T>> {
    const token = sessionStore.getToken();
    if (!token) return { status: "unauthenticated" };
    if (sessionStore.isExpired()) {
      await clearSessionAfterHandoff(sessionStore);
      return { status: "unauthenticated" };
    }
    let response: Response;
    try {
      response = await fetchImpl(`${backendUrl}${FIREFLIES_IMPORT_DELEGATION_PATH}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, [REQUEST_HEADER_NAME]: REQUEST_HEADER_VALUE },
      });
    } catch {
      return { status: "offline" };
    }
    if (response.status === 401) {
      await clearSessionAfterHandoff(sessionStore);
      return { status: "unauthenticated" };
    }
    // The routes are mounted only while the server import is on; a 404 means the server holds nothing.
    if (response.status === 404) return { status: "feature-dark" };
    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500;
      return { status: retryable ? "retryable" : "rejected", httpStatus: response.status, code: null };
    }
    if (response.status === 204) return { status: "ok", value: null as T };
    try {
      return { status: "ok", value: (await response.json()) as T };
    } catch {
      return { status: "rejected", httpStatus: response.status, code: null };
    }
  }

  return {
    async listGrantCids() {
      const result = await request<{ grantCids?: unknown }>("/grants", "GET");
      if (result.status !== "ok") return result;
      const cids = result.value?.grantCids;
      if (!Array.isArray(cids) || !cids.every((cid) => typeof cid === "string" && cid.length > 0)) {
        return { status: "rejected", httpStatus: 200, code: null };
      }
      return { status: "ok", value: cids as string[] };
    },
    removeGrant() {
      return request<null>("", "DELETE");
    },
  };
}

const PENDING_REVOKES_KEY_PREFIX = "tinychat:fireflies-import-pending-revokes:";
/** A permission ends on its own within 7 days; a day more covers clock drift before an entry is dropped. */
const PENDING_REVOKE_MAX_AGE_MS = 8 * 24 * 60 * 60 * 1000;

type PendingRevokeStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function defaultPendingRevokeStore(): PendingRevokeStore | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function readPendingRevokes(store: PendingRevokeStore, key: string, now: number): Array<{ cid: string; at: number }> {
  try {
    const parsed: unknown = JSON.parse(store.getItem(key) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is { cid: string; at: number } =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as { cid?: unknown }).cid === "string" &&
        typeof (entry as { at?: unknown }).at === "number" &&
        now - (entry as { at: number }).at < PENDING_REVOKE_MAX_AGE_MS,
    );
  } catch {
    return [];
  }
}

function writePendingRevokes(store: PendingRevokeStore, key: string, entries: Array<{ cid: string; at: number }>): void {
  try {
    if (entries.length === 0) store.removeItem(key);
    else store.setItem(key, JSON.stringify(entries));
  } catch {
    // Storage can be full or blocked; the server-side list is still the main source.
  }
}

/**
 * Keeps the ids of the permissions this browser has been told about until each is confirmed withdrawn at the node,
 * per account. A disconnect that stops after the server dropped its copy still revokes them on the next try.
 */
export function withPendingRevokes(
  inner: DisconnectImportGrants,
  options: { accountKey: string; store?: PendingRevokeStore | null; now?: () => number },
): DisconnectImportGrants {
  const store = options.store === undefined ? defaultPendingRevokeStore() : options.store;
  if (!store) return inner;
  const key = `${PENDING_REVOKES_KEY_PREFIX}${options.accountKey}`;
  const now = options.now ?? Date.now;
  return {
    async listGrantCids() {
      const listed = await inner.listGrantCids();
      // A server that holds nothing (import off) can still leave an earlier run's permissions to withdraw.
      if (listed.status !== "ok" && listed.status !== "feature-dark") return listed;
      const at = now();
      const entries = readPendingRevokes(store, key, at);
      const known = new Set(entries.map((entry) => entry.cid));
      for (const cid of listed.status === "ok" ? listed.value : []) {
        if (!known.has(cid)) entries.push({ cid, at });
      }
      writePendingRevokes(store, key, entries);
      return { status: "ok", value: entries.map((entry) => entry.cid) };
    },
    async revoke(cid) {
      const revoked = await inner.revoke(cid);
      if (revoked) {
        writePendingRevokes(
          store,
          key,
          readPendingRevokes(store, key, now()).filter((entry) => entry.cid !== cid),
        );
      }
      return revoked;
    },
  };
}

/**
 * What a Fireflies teardown needs to withdraw the import permissions: the server lists the two it
 * holds, and each is revoked at the node with the owner's own session.
 */
export function createFirefliesImportGrantsTeardown(
  tcw: Pick<TinyCloudWeb, "revokeDelegation">,
  backendUrl: string,
  sessionStore: SessionStore,
): DisconnectImportGrants {
  const client = createFirefliesImportGrantsClient(backendUrl, { sessionStore });
  const inner: DisconnectImportGrants = {
    listGrantCids: () => client.listGrantCids(),
    revoke: async (cid) => (await tcw.revokeDelegation(cid)).ok,
  };
  const address = sessionStore.getAddress?.()?.toLowerCase();
  return address ? withPendingRevokes(inner, { accountKey: address }) : inner;
}

export type AccountImportRemoval =
  | { status: "done"; unconfirmed: boolean }
  | { status: "failed"; failure: Exclude<ConnectorWebhooksResult<never>, { status: "ok" | "feature-dark" }> };

/**
 * Account deletion's part of the Fireflies import: list the two permission ids (the server's and any this browser
 * still owes a revoke), take the server's copy away, then revoke each at the node. A server that has the import off
 * holds nothing. A failure before the server's copy is gone stops with nothing changed, so the step can be retried;
 * `unconfirmed` means the server's copy is gone but a permission could not be confirmed withdrawn.
 */
export async function removeFirefliesImportForAccountDeletion(
  client: Pick<FirefliesImportGrantsClient, "removeGrant">,
  teardown?: DisconnectImportGrants,
): Promise<AccountImportRemoval> {
  let cids: string[] = [];
  if (teardown) {
    const listed = await teardown.listGrantCids();
    if (listed.status === "ok") cids = listed.value;
    else if (listed.status !== "feature-dark") return { status: "failed", failure: listed };
  }
  const removed = await client.removeGrant();
  if (removed.status !== "ok" && removed.status !== "feature-dark") return { status: "failed", failure: removed };
  if (!teardown || cids.length === 0) return { status: "done", unconfirmed: false };
  return { status: "done", unconfirmed: await revokeImportGrants(teardown, cids) };
}
