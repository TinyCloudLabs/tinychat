import { beforeEach, describe, expect, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { REPLICATION_COPY_KEY, REPLICATION_WIPE_PENDING_KEY, SDK_LOGOUT_MARKER_KEY } from "./replicationLocalStore";
import { signOutReplicaAware } from "./replicationSignOut";
import { resetReplicationStatus } from "./replicationStatus";

const ALICE = "did:pkh:eip155:1:0xaaaa";
const BOB = "did:pkh:eip155:1:0xbbbb";

function memoryStore(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

beforeEach(resetReplicationStatus);

describe("account-scoped replica sign-out", () => {
  test("SDK signOut owns replica erasure and clears completed markers", async () => {
    const store = memoryStore({
      [REPLICATION_COPY_KEY]: ALICE,
      [REPLICATION_WIPE_PENDING_KEY]: "1",
      [SDK_LOGOUT_MARKER_KEY]: "pending",
    });
    const order: string[] = [];
    let sdkDeniedGate = false;
    const tcw = {
      did: ALICE,
      signOut: async () => {
        order.push("sign-out");
        sdkDeniedGate = true;
        store.values.delete(SDK_LOGOUT_MARKER_KEY);
      },
      replication: {
        purgeLocalCopy: async () => sdkDeniedGate
          ? { ok: true }
          : { ok: false, retryNow: false, code: "principal_active" },
      },
    } as unknown as TinyCloudWeb;

    expect(await signOutReplicaAware(tcw, { store, remoteTimeoutMs: 10 })).toEqual({ ok: true });
    expect(order).toEqual(["sign-out"]);
    expect(store.values.size).toBe(0);
  });
  test("a hung SDK sign-out is bounded and does not claim the replica erase completed", async () => {
    const store = memoryStore({ [REPLICATION_COPY_KEY]: ALICE });
    let purgeCalls = 0;
    const tcw = {
      did: ALICE,
      signOut: () => new Promise<void>(() => {}),
      replication: {
        purgeLocalCopy: async () => { purgeCalls++; return { ok: true }; },
      },
    } as unknown as TinyCloudWeb;

    expect(await signOutReplicaAware(tcw, { store, remoteTimeoutMs: 1 })).toEqual({
      ok: false,
      message: expect.any(String),
      code: "REPLICA_SIGNOUT_FAILED",
    });
    expect(purgeCalls).toBe(0);
    expect(store.values.get(REPLICATION_COPY_KEY)).toBe(ALICE);
  });


  test("does not remove a different account's copy marker", async () => {
    const store = memoryStore({ [REPLICATION_COPY_KEY]: BOB });
    const tcw = {
      did: ALICE,
      signOut: async () => undefined,
      replication: { purgeLocalCopy: async () => ({ ok: true }) },
    } as unknown as TinyCloudWeb;

    expect(await signOutReplicaAware(tcw, { store })).toEqual({ ok: true });
    expect(store.values.get(REPLICATION_COPY_KEY)).toBe(BOB);
  });
});
