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

/** A listing over the given keys array, which the test may mutate. Records each prefix it was asked for. */
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
  test("refresh seeds from the grant prefix, so an existing holder is held after restart", async () => {
    const { calls, source } = listing([`${PREFIX}${HELD}`]);
    const index = new GrantHolderIndex(source, () => 0);
    await index.refresh();
    expect(index.mayHold(HELD)).toBe(true);
    expect(index.mayHold(OTHER)).toBe(false);
    expect(calls).toEqual([PREFIX]);
  });

  test("mayHold reads memory only, so an unknown owner costs no listing", () => {
    const { calls, source } = listing([]);
    const index = new GrantHolderIndex(source, () => 0);
    for (let i = 0; i < 1000; i++) expect(index.mayHold(addressFor(i))).toBe(false);
    expect(calls).toEqual([]);
  });

  test("refreshIfStale lists at most once per window, however many unknown owners arrive", async () => {
    let t = 0;
    const { calls, source } = listing([]);
    const index = new GrantHolderIndex(source, () => t);
    for (let i = 0; i < 1000; i++) index.refreshIfStale();
    expect(calls.length).toBe(1);
    await index.refresh();
    expect(calls.length).toBe(1);

    t = GRANT_HOLDER_REFRESH_MS - 1;
    index.refreshIfStale();
    expect(calls.length).toBe(1);

    t = GRANT_HOLDER_REFRESH_MS;
    index.refreshIfStale();
    expect(calls.length).toBe(2);
    await index.refresh();
  });

  test("a held owner is answered while a background listing is in progress", async () => {
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
    await index.refresh();

    t = GRANT_HOLDER_REFRESH_MS;
    index.refreshIfStale();
    expect(index.mayHold(HELD)).toBe(true);

    release();
    await index.refresh();
    expect(index.mayHold(HELD)).toBe(true);
  });

  test("a failed listing is logged once and leaves membership unchanged", async () => {
    let t = 0;
    let fail = false;
    const { source } = listing([`${PREFIX}${HELD}`]);
    const flaky = {
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
      const index = new GrantHolderIndex(flaky, () => t);
      await index.refresh();
      fail = true;
      t = GRANT_HOLDER_REFRESH_MS;
      index.refreshIfStale();
      await index.refresh();
      expect(index.mayHold(HELD)).toBe(true);
    } finally {
      console.error = original;
    }
    expect(logged.length).toBe(1);
  });

  test("an owner granted by another process is held after the next window's listing", async () => {
    let t = 0;
    const keys: string[] = [];
    const { source } = listing(keys);
    const index = new GrantHolderIndex(source, () => t);
    await index.refresh();

    keys.push(`${PREFIX}${OTHER}`);
    expect(index.mayHold(OTHER)).toBe(false);

    t = GRANT_HOLDER_REFRESH_MS;
    index.refreshIfStale();
    await index.refresh();
    expect(index.mayHold(OTHER)).toBe(true);
  });
});

describe("createTrackedGrantStore", () => {
  test("a stored grant is held by the index without a listing, whatever the address case", async () => {
    const { calls, source } = listing([]);
    const index = new GrantHolderIndex(source, () => 0);
    const tracked = createTrackedGrantStore(backingStore(null), index);
    await tracked.store(HELD_MIXED, "serialized", {} as never);
    expect(index.mayHold(HELD)).toBe(true);
    expect(calls).toEqual([]);
  });

  test("a removed grant is dropped from the index", async () => {
    const { calls, source } = listing([]);
    const index = new GrantHolderIndex(source, () => 0);
    const tracked = createTrackedGrantStore(backingStore(null), index);
    await tracked.store(HELD, "serialized", {} as never);
    await tracked.remove(HELD);
    expect(index.mayHold(HELD)).toBe(false);
    expect(calls).toEqual([]);
  });

  test("a load that finds a record adds the owner; a load that finds none drops it", async () => {
    const { calls, source } = listing([]);
    const index = new GrantHolderIndex(source, () => 0);
    const found = createTrackedGrantStore(backingStore({ serialized: "x" }), index);
    expect(await found.load(HELD)).toEqual({ serialized: "x" });
    expect(index.mayHold(HELD)).toBe(true);

    const missing = createTrackedGrantStore(backingStore(null), index);
    expect(await missing.load(HELD)).toBeNull();
    expect(index.mayHold(HELD)).toBe(false);
    expect(calls).toEqual([]);
  });
});
