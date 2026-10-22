import { describe, expect, test } from "bun:test";
import { EXO_SYNC_GRANT_KIND, type DelegationStore } from "@tinyboilerplate/server";
import { GRANT_HOLDER_REFRESH_MS, GrantHolderIndex, createTrackedGrantStore } from "../exo/grant-holders.js";

const PREFIX = EXO_SYNC_GRANT_KIND.keyPrefix;
const HELD = `0x${"a".repeat(40)}`;
const HELD_MIXED = `0x${"A".repeat(40)}`;
const OTHER = `0x${"b".repeat(40)}`;

function addressFor(i: number): string {
  return `0x${i.toString(16).padStart(40, "0")}`;
}

/** A listing over fixed keys that records each prefix it was asked for. */
function listing(keys: string[]) {
  const calls: string[] = [];
  const source = {
    async list(prefix: string) {
      calls.push(prefix);
      return { ok: true, data: { keys: keys.filter((key) => key.startsWith(prefix)) } };
    },
  };
  return { calls, source };
}

/** Stands in for the grant store; only `load` result matters to the tracked wrapper. */
function backingStore(loaded: unknown) {
  return {
    async store() {},
    async load() {
      return loaded;
    },
    async remove() {},
  } as unknown as Pick<DelegationStore, "store" | "load" | "remove">;
}

describe("GrantHolderIndex", () => {
  test("seeds from the grant prefix, so an existing holder is found after restart", async () => {
    const { calls, source } = listing([`${PREFIX}${HELD}`]);
    const index = new GrantHolderIndex(source, () => 0);
    expect(await index.mayHold(HELD)).toBe(true);
    expect(await index.mayHold(OTHER)).toBe(false);
    expect(calls).toEqual([PREFIX]);
  });

  test("an owner outside the set costs one listing per refresh window, however many arrive", async () => {
    let t = 0;
    const { calls, source } = listing([]);
    const index = new GrantHolderIndex(source, () => t);
    await Promise.all(Array.from({ length: 1000 }, (_, i) => index.mayHold(addressFor(i))));
    expect(calls.length).toBe(1);

    t = GRANT_HOLDER_REFRESH_MS - 1;
    expect(await index.mayHold(OTHER)).toBe(false);
    expect(calls.length).toBe(1);

    t = GRANT_HOLDER_REFRESH_MS;
    expect(await index.mayHold(OTHER)).toBe(false);
    expect(calls.length).toBe(2);
  });

  test("a genuine owner is not held behind a listing that is still in progress", async () => {
    let t = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let listed = 0;
    const index = new GrantHolderIndex(
      {
        async list() {
          listed += 1;
          if (listed > 1) await gate;
          return { ok: true, data: { keys: [`${PREFIX}${HELD}`] } };
        },
      },
      () => t,
    );
    expect(await index.mayHold(HELD)).toBe(true);

    t = GRANT_HOLDER_REFRESH_MS;
    const stalled = index.mayHold(addressFor(1));
    expect(await index.mayHold(HELD)).toBe(true);

    release();
    expect(await stalled).toBe(false);
  });

  test("a failed listing fails closed for one window and is logged", async () => {
    let t = 0;
    let fail = true;
    const { source } = listing([`${PREFIX}${HELD}`]);
    const failing = {
      async list(prefix: string) {
        if (fail) throw new Error("kv down");
        return source.list(prefix);
      },
    };
    const logged: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args);
    };
    try {
      const index = new GrantHolderIndex(failing, () => t);
      expect(await index.mayHold(HELD)).toBe(false);
      fail = false;
      t = GRANT_HOLDER_REFRESH_MS - 1;
      expect(await index.mayHold(HELD)).toBe(false);
      t = GRANT_HOLDER_REFRESH_MS;
      expect(await index.mayHold(HELD)).toBe(true);
    } finally {
      console.error = original;
    }
    expect(logged.length).toBe(1);
  });
});

describe("createTrackedGrantStore", () => {
  test("a stored grant is held by the index without a listing, whatever the address case", async () => {
    const { calls, source } = listing([]);
    const index = new GrantHolderIndex(source, () => 0);
    const tracked = createTrackedGrantStore(backingStore(null), index);
    await tracked.store(HELD_MIXED, "serialized", {} as never);
    expect(await index.mayHold(HELD)).toBe(true);
    expect(calls).toEqual([]);
  });

  test("a removed grant is dropped from the index", async () => {
    const { calls, source } = listing([]);
    const index = new GrantHolderIndex(source, () => 0);
    const tracked = createTrackedGrantStore(backingStore(null), index);
    await tracked.store(HELD, "serialized", {} as never);
    await tracked.remove(HELD);
    expect(await index.mayHold(HELD)).toBe(false);
    expect(calls).toEqual([PREFIX]);
  });

  test("a load that finds a record adds the owner; a load that finds none drops it", async () => {
    const { calls, source } = listing([]);
    const index = new GrantHolderIndex(source, () => 0);
    const found = createTrackedGrantStore(backingStore({ serialized: "x" }), index);
    expect(await found.load(HELD)).toEqual({ serialized: "x" });
    expect(await index.mayHold(HELD)).toBe(true);
    expect(calls).toEqual([]);

    const missing = createTrackedGrantStore(backingStore(null), index);
    expect(await missing.load(HELD)).toBeNull();
    expect(await index.mayHold(HELD)).toBe(false);
    expect(calls).toEqual([PREFIX]);
  });
});
