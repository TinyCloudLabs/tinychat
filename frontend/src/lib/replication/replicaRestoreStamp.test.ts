// What keeps the saved copy bound to the restored session's account once the restore's wallet question
// is answered from the stored address (readOnlyAccountProvider.ts).
//
// These run the REAL replica lifecycle (`@tinycloud/replica/kv-storage`, the same code web-sdk wraps)
// against fake-indexeddb: `restoreSessionStamp(principal, persistedStamp)` of replica 0.3.0
// (js-sdk v3.3.0 packages/replica/src/kv-storage/lifecycle.ts:433-462; the checks under test are
// :437-453). The `principal` argument is the restored SESSION's account, taken from the persisted
// session data (node-sdk TinyCloudNode.ts ~4095-4108: `restoreReplicaSessionStamp(storage, principal,
// sessionData.replicaStamp)`), not from the wallet and not from the stamp, so the stored-address
// answer to `eth_accounts` cannot choose which account's copy is opened.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import { indexedDbReplicaStorage } from "@tinycloud/replica/kv-storage";

const ALICE = "did:pkh:eip155:1:0x00000000000000000000000000000000000000a1";
const BOB = "did:pkh:eip155:1:0x00000000000000000000000000000000000000b2";

interface Stamp { incarnation: string; lifecycleEpoch: number }
interface Lifecycle {
  establishSessionStamp(principal: string, options: { consentAnchor: { source: "siwe"; at: number } }): Promise<Stamp>;
  restoreSessionStamp(principal: string, persisted: unknown): Promise<Stamp>;
  // (`deny` is not used here: under fake-indexeddb its commit falls back to deleting the database, which
  // leaves no gate row to test. See the principalHash-null test.)
}

let factory: IDBFactory;
const originals = Object.fromEntries(["indexedDB", "localStorage", "navigator"].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));

function define(name: string, value: unknown) {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

function lifecycle(): Lifecycle {
  return (indexedDbReplicaStorage() as unknown as { lifecycle: Lifecycle }).lifecycle;
}

/**
 * Rewrites the gate row (store `gate`, key `account`), the row a persisted stamp is compared with.
 * Returns the row as it was before.
 */
async function rewriteGateRow(
  change: (row: { incarnation: string; lifecycleEpoch: number; principalHash: string | null }) => object,
): Promise<{ incarnation: string; lifecycleEpoch: number; principalHash: string | null }> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open("tinycloud-replica-kv");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise((resolve, reject) => {
      const store = db.transaction("gate", "readwrite").objectStore("gate");
      const read = store.get("account");
      read.onsuccess = () => {
        const before = read.result;
        store.put(change(before), "account");
        resolve(before);
      };
      read.onerror = () => reject(read.error);
    });
  } finally {
    db.close();
  }
}

/** The gate code a restore is refused with, or null when it is admitted. */
async function refusal(restore: Promise<unknown>): Promise<string | null> {
  try {
    await restore;
    return null;
  } catch (caught) {
    const error = caught as { code?: string; detail?: { gate?: string } };
    return `${error.code}/${error.detail?.gate}`;
  }
}

beforeEach(() => {
  factory = new IDBFactory();
  const storage = new Map<string, string>();
  define("indexedDB", factory);
  define("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
    removeItem: (key: string) => { storage.delete(key); },
  });
  define("navigator", { locks: { request: async (_name: string, a: unknown, b?: unknown) => (typeof a === "function" ? a : b as () => unknown)() } });
});

afterEach(() => {
  for (const [name, descriptor] of Object.entries(originals)) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
  }
});

describe("restoring a persisted replica stamp", () => {
  test("the account the stamp was established for is admitted", async () => {
    const lc = lifecycle();
    const stamp = await lc.establishSessionStamp(ALICE, { consentAnchor: { source: "siwe", at: Date.now() } });
    expect(await refusal(lc.restoreSessionStamp(ALICE, stamp))).toBeNull();
  });

  test("a different account (principalHash mismatch) still gates: principal_mismatch", async () => {
    const lc = lifecycle();
    const stamp = await lc.establishSessionStamp(ALICE, { consentAnchor: { source: "siwe", at: Date.now() } });
    expect(await refusal(lc.restoreSessionStamp(BOB, stamp))).toBe("REPLICA_GATED/principal_mismatch");
  });

  test("a stale incarnation still gates: stamp_stale", async () => {
    const lc = lifecycle();
    const stamp = await lc.establishSessionStamp(ALICE, { consentAnchor: { source: "siwe", at: Date.now() } });
    expect(await refusal(lc.restoreSessionStamp(ALICE, { ...stamp, incarnation: "a-previous-incarnation" }))).toBe("REPLICA_GATED/stamp_stale");
  });

  test("a stale lifecycle epoch still gates: stamp_stale", async () => {
    const lc = lifecycle();
    const stamp = await lc.establishSessionStamp(ALICE, { consentAnchor: { source: "siwe", at: Date.now() } });
    expect(await refusal(lc.restoreSessionStamp(ALICE, { ...stamp, lifecycleEpoch: stamp.lifecycleEpoch + 1 }))).toBe("REPLICA_GATED/stamp_stale");
  });

  test("no persisted stamp (a session made before the opt-in) still gates: not_established", async () => {
    const lc = lifecycle();
    await lc.establishSessionStamp(ALICE, { consentAnchor: { source: "siwe", at: Date.now() } });
    expect(await refusal(lc.restoreSessionStamp(ALICE, undefined))).toBe("REPLICA_GATED/not_established");
  });

  test("a gate with no active account (principalHash null) still gates: principal_mismatch", async () => {
    const lc = lifecycle();
    const stamp = await lc.establishSessionStamp(ALICE, { consentAnchor: { source: "siwe", at: Date.now() } });
    // The gate row a committed sign-out leaves behind: same incarnation, `principalHash: null`
    // (lifecycle.ts:573-580, `commitDeny`). A stamp that matches the row exactly passes the staleness
    // checks and meets the null binding (:449).
    await rewriteGateRow((row) => ({ ...row, principalHash: null }));
    expect(await refusal(lc.restoreSessionStamp(ALICE, stamp))).toBe("REPLICA_GATED/principal_mismatch");
  });
});
