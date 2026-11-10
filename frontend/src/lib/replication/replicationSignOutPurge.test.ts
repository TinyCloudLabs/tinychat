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
  test("purges its local replica before a bounded SDK sign-out and clears completed purge markers", async () => {
    const store = memoryStore({
      [REPLICATION_COPY_KEY]: ALICE,
      [REPLICATION_WIPE_PENDING_KEY]: "1",
      [SDK_LOGOUT_MARKER_KEY]: "pending",
    });
    const order: string[] = [];
    const tcw = {
      did: ALICE,
      signOut: () => { order.push("sign-out"); return new Promise<void>(() => {}); },
      replication: {
        purgeLocalCopy: async () => { order.push("purge-local-copy"); return { ok: true }; },
      },
    } as unknown as TinyCloudWeb;

    expect(await signOutReplicaAware(tcw, { store, remoteTimeoutMs: 1 })).toEqual({ ok: true });
    expect(order).toEqual(["purge-local-copy", "sign-out"]);
    expect(store.values.size).toBe(0);
  });

  test("retries one account-local purge when the SDK says device keys may remain", async () => {
    let attempts = 0;
    const tcw = {
      did: ALICE,
      signOut: async () => undefined,
      replication: {
        purgeLocalCopy: async () => ++attempts === 1
          ? { ok: false, retryNow: true, code: "STORAGE_ERROR" }
          : { ok: true },
      },
    } as unknown as TinyCloudWeb;

    expect(await signOutReplicaAware(tcw, { store: memoryStore() })).toEqual({ ok: true });
    expect(attempts).toBe(2);
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
