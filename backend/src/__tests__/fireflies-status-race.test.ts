import { describe, expect, it } from "bun:test";
import { deriveFirefliesImportKeys, FIREFLIES_DELEGATE_KMS_PATH } from "../fireflies-import-identity.js";
import { FirefliesGrantReplacesMismatchError, FirefliesGrantStore, type FirefliesGrantKvPort } from "../services/fireflies-grant-store.js";
import { createMemoryGrantKv, HOST, mintGrantPair } from "./helpers/fireflies-grant-fixtures.js";

const NOW = Date.UTC(2026, 10, 22, 17, 30, 0);
const DAY = 86_400_000;

async function fixture(seed: number, wrap?: (kv: FirefliesGrantKvPort) => FirefliesGrantKvPort) {
  const keys = await deriveFirefliesImportKeys(
    { getKey: async (p) => Buffer.alloc(32, p === FIREFLIES_DELEGATE_KMS_PATH ? seed : seed + 1) },
    { host: HOST, env: {} },
  );
  const cidOf = keys.delegate.node.computeDelegationCid.bind(keys.delegate.node);
  const memory = createMemoryGrantKv();
  const kv = wrap ? wrap(memory.kv) : memory.kv;
  const store = new FirefliesGrantStore({ kv, kek: keys.grantKek, delegateDid: keys.delegate.did });
  const options = { configuredHost: HOST, deps: { computeDelegationCid: cidOf }, now: NOW };
  return { memory, store, options, grant: () => mintGrantPair(keys.delegate.did, cidOf, { now: NOW, ttlMs: 7 * DAY }) };
}

describe("a removal that lands while the owner's status is read", () => {
  it("never reports an active pair without its two ids", async () => {
    // The record is removed straight after the first read of it, as a purge on another request would.
    let removeAfterRead: (() => Promise<void>) | undefined;
    const f = await fixture(0xd1, (kv) => ({
      ...kv,
      async get(key) {
        const record = await kv.get(key);
        const remove = removeAfterRead;
        removeAfterRead = undefined;
        await remove?.();
        return record;
      },
    }));
    const mine = await f.grant();
    await f.store.store(mine.address, mine, mine.expiresAt);

    removeAfterRead = () => f.memory.kv.delete(`delegations/fireflies-import/${mine.address.toLowerCase()}`);
    const seen = await f.store.ownerStatus(mine.address, f.options);

    expect(seen.state === "active" ? seen.grantCids.length : 2).toBe(2);
    expect(seen.state === "none" ? seen.grantCids : []).toEqual([]);
  });

  it("makes the renewal that read the status before the removal fail, and stores nothing", async () => {
    const f = await fixture(0xd2);
    const mine = await f.grant();
    await f.store.store(mine.address, mine, mine.expiresAt);

    const before = await f.store.ownerStatus(mine.address, f.options);
    expect(before.state).toBe("active");
    expect(before.grantCids).toHaveLength(2);

    await f.store.remove(mine.address);

    const renewed = await f.grant();
    await expect(f.store.store(mine.address, renewed, renewed.expiresAt, before.grantCids)).rejects.toBeInstanceOf(
      FirefliesGrantReplacesMismatchError,
    );
    expect(await f.store.ownerStatus(mine.address, f.options)).toMatchObject({ state: "none", grantCids: [] });
  });
});
