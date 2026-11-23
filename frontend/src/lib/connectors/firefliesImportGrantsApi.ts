import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { clearSessionAfterHandoff } from "../sessionSignedOut";
import type { DisconnectImportGrants } from "./connectorLifecycle";
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
  return {
    listGrantCids: () => client.listGrantCids(),
    revoke: async (cid) => (await tcw.revokeDelegation(cid)).ok,
  };
}
