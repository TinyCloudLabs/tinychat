import type { TinyCloudNode } from "@tinycloud/node-sdk";
import type { BackendStorageLane } from "./backend-storage-lane.js";
import { createKvFirefliesGrantPort, removeAllFirefliesGrants } from "./fireflies-grant-store.js";

/**
 * Start-up cleanup while the server import is off: removes every stored Fireflies import record and returns how many.
 * It reads and deletes by key name only, so it needs neither the delegate key nor the grant-store key (and no KMS).
 */
export function removeFirefliesGrantsWhileOff(node: TinyCloudNode, storageLane: BackendStorageLane): Promise<number> {
  return removeAllFirefliesGrants(createKvFirefliesGrantPort(node, storageLane));
}
