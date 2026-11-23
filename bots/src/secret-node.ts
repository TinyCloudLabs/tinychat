// Reads one secret from the owner's TinyCloud with an approved grant (node-sdk restoreSession + readSecret, as
// Courier does). One node client per request, kept while the request is approved and dropped when it is removed.
// Only the value or a classified failure comes back; node errors are never passed on.
//
// The client is held as a GrantNode: restoreSession and readSecret only. The gateway never delegates or attenuates
// a secret grant (TC-3284); the OpenKey grant is a CACAO the node can't mark terminal (TC-3810), so this is where
// that is kept.

import { TinyCloudNode } from "@tinycloud/node-sdk";
import type { GrantSession, ReadValue, SecretReader } from "./secret-grants";

/** All the gateway may do with a grant. */
export type GrantNode = Pick<TinyCloudNode, "restoreSession" | "readSecret">;

function tinyCloudNode(nodeOrigin: string): GrantNode {
  return new TinyCloudNode({ host: nodeOrigin, tinycloudFallbackHosts: [nodeOrigin], autoDiscoverLocalNode: false, enablePublicSpace: false });
}

export function nodeSecretReader(nodeOrigin: string, newNode: (nodeOrigin: string) => GrantNode = tinyCloudNode): SecretReader {
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
      try {
        const node = await open(id, session);
        const read = await node.readSecret({ space: `tinycloud:pkh:eip155:${session.chainId}:${session.address}:secrets`, name });
        if (read.status === "ok") return { value: read.value };
        return read.status === "not_found" ? "missing" : "unavailable";
      } catch {
        return "unavailable";
      }
    },
    forget(id) {
      sessions.delete(id);
    },
  };
}
