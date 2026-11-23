// Reads one secret from the owner's TinyCloud with an approved grant (node-sdk restoreSession + readSecret, as
// Courier does). One node client per request, kept while the request is approved and dropped when it is removed.
// Only the value or a classified failure comes back; node errors are never passed on.
//
// The client is held as a GrantNode: restoreSession and readSecret only. The gateway never delegates or attenuates
// a secret grant (TC-3284); the OpenKey grant is a CACAO the node can't mark terminal (TC-3810), so this is where
// that is kept.

import { TinyCloudNode } from "@tinycloud/node-sdk";
import type { GrantSession, LeaseCheck, ReadValue, RenewalPin, SecretReader } from "./secret-grants";

/** All the gateway may do with a grant. */
export type GrantNode = Pick<TinyCloudNode, "restoreSession" | "readSecret">;

/**
 * What a renewing (leased) grant adds, and no more (TC-4000): discover the node's public renewal identity, restore only
 * after the node reports a live admitted renewal stamp, and read the renewed end. Never createRenewalLease or a delegation.
 */
export type LeaseNode = GrantNode & Pick<TinyCloudNode, "renewalNodeIdentity" | "restoreSessionWithRenewal" | "sessionEnd">;

function tinyCloudNode(nodeOrigin: string): GrantNode {
  return new TinyCloudNode({ host: nodeOrigin, tinycloudFallbackHosts: [nodeOrigin], autoDiscoverLocalNode: false, enablePublicSpace: false });
}

const LEASE_WINDOW_MS = 7 * 24 * 60 * 60_000;

/** Codes of the SDK's errors that mean the lease is over, as opposed to a node that could not be reached. */
const LEASE_OVER = new Set(["RENEWAL_AUTHORITY_INACTIVE", "RENEWAL_LEASE_EXPIRED", "RENEWAL_RENEWER_CHANGED"]);

/**
 * Opens a leased grant afresh and returns the node with its end, or why not. A new client each time, never kept: the
 * node's status and its signed stamp chain are checked at every use, not at approval (never the stored expiry), and the
 * identity the node advertises must be the pinned one (the same check OpenKey makes).
 */
async function openLeased(nodeOrigin: string, newNode: (nodeOrigin: string) => LeaseNode, pin: RenewalPin, session: GrantSession, now: () => number): Promise<{ node: LeaseNode; end: number } | Exclude<LeaseCheck, { end: number }>> {
  if (!session.lease) return "ended";
  try {
    const node = newNode(nodeOrigin);
    const identity = await node.renewalNodeIdentity();
    if (identity.nodeDid !== pin.nodeDid || identity.renewerDid !== pin.renewerDid) return "unavailable";
    const { lease, ...restorable } = session;
    await node.restoreSessionWithRenewal({ ...restorable, tinycloudHosts: [nodeOrigin] }, lease.authorization);
    const reported = node.sessionEnd?.getTime();
    if (reported === undefined || !Number.isFinite(reported)) return "ended";
    // One renewal window is 7 days at most: a node that reports a longer one is not trusted, and the approval ends (a fresh ask).
    if (reported > now() + LEASE_WINDOW_MS + 60_000) return "ended";
    const end = Math.min(reported, Date.parse(lease.expiresAt));
    return end > now() ? { node, end } : "ended";
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? (error as { code: unknown }).code : undefined;
    return typeof code === "string" && LEASE_OVER.has(code) ? "ended" : "unavailable";
  }
}

export function nodeSecretReader(
  nodeOrigin: string,
  newNode: (nodeOrigin: string) => GrantNode = tinyCloudNode,
  leased?: { pin: RenewalPin; newNode?: (nodeOrigin: string) => LeaseNode; now?: () => number },
): SecretReader {
  const newLeaseNode = leased?.newNode ?? ((origin: string) => tinyCloudNode(origin) as LeaseNode);
  const sessions = new Map<string, Promise<GrantNode>>();
  const open = (id: string, session: GrantSession) => {
    let node = sessions.get(id);
    if (!node) {
      node = (async () => {
        const client = newNode(nodeOrigin);
        await client.restoreSession({ ...session, tinycloudHosts: [nodeOrigin] });
        return client;
      })();
      sessions.set(id, node);
      // A session that failed to open is tried afresh next time.
      node.catch(() => sessions.get(id) === node && sessions.delete(id));
    }
    return node;
  };
  return {
    async read(id, session, name): Promise<ReadValue> {
      if (session.lease) {
        if (!leased) return "unavailable";
        const opened = await openLeased(nodeOrigin, newLeaseNode, leased.pin, session, leased.now ?? Date.now);
        if (typeof opened === "string") return opened;
        try {
          const read = await opened.node.readSecret({ space: `tinycloud:pkh:eip155:${session.chainId}:${session.address}:secrets`, name });
          if (read.status === "ok") return { value: read.value };
          return read.status === "not_found" ? "missing" : "unavailable";
        } catch {
          return "unavailable";
        }
      }
      try {
        const node = await open(id, session);
        const read = await node.readSecret({ space: `tinycloud:pkh:eip155:${session.chainId}:${session.address}:secrets`, name });
        if (read.status === "ok") return { value: read.value };
        return read.status === "not_found" ? "missing" : "unavailable";
      } catch {
        return "unavailable";
      }
    },
    async leaseEnd(id, session): Promise<LeaseCheck> {
      if (!leased) return "unavailable";
      const opened = await openLeased(nodeOrigin, newLeaseNode, leased.pin, session, leased.now ?? Date.now);
      return typeof opened === "string" ? opened : { end: opened.end };
    },
    forget(id) {
      sessions.delete(id);
    },
  };
}
