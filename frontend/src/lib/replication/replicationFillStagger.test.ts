import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import {
  REPLICATION_FILL_FIRST_LOAD_DEADLINE_MS,
  REPLICATION_FILL_POOL_SIZE,
  REPLICATION_FILL_START_GAP_MS,
  startReplicationFill,
} from "./replicationClient";

const PREFIXES = ["a/", "b/", "c/", "d/", "e/", "f/", "g/", "h/"];

interface Harness {
  tcw: TinyCloudWeb;
  started: Array<{ prefix: string; at: number }>;
  inFlight: () => number;
  maxInFlight: () => number;
  finish: (prefix: string) => void;
  fail: (prefix: string) => void;
  sign: { out: boolean };
}

function harness(): Harness {
  const started: Array<{ prefix: string; at: number }> = [];
  const done = new Map<string, { resolve: () => void; reject: (e: Error) => void }>();
  let live = 0;
  let max = 0;
  const sign = { out: false };
  const replication = {
    sync: ({ prefix }: { prefix: string }) => {
      started.push({ prefix, at: Date.now() });
      live += 1;
      max = Math.max(max, live);
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      done.set(prefix, { resolve, reject });
      return promise.finally(() => { live -= 1; });
    },
  };
  const tcw = { did: "did:pkh:eip155:1:0xaaaa" } as unknown as TinyCloudWeb;
  Object.defineProperty(tcw, "replication", { get: () => (sign.out ? undefined : replication) });
  return {
    tcw, started, sign,
    inFlight: () => live,
    maxInFlight: () => max,
    finish: (prefix) => done.get(prefix)?.resolve(),
    fail: (prefix) => done.get(prefix)?.reject(new Error("gated")),
  };
}

/** Advances fake time in small steps, letting promise continuations run between them. */
async function advance(ms: number): Promise<void> {
  for (let elapsed = 0; elapsed < ms; elapsed += 50) {
    jest.advanceTimersByTime(Math.min(50, ms - elapsed));
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
  }
}

/** Finishes every started prefix as it appears, until all 8 are done or time runs out. */
async function drain(h: Harness): Promise<void> {
  for (let step = 0; step < 100; step += 1) {
    for (const { prefix } of h.started) h.finish(prefix);
    await advance(REPLICATION_FILL_START_GAP_MS);
  }
}

beforeEach(() => { jest.useFakeTimers(); });
afterEach(() => { jest.useRealTimers(); });

describe("replication fill: deferred and staggered", () => {
  test("nothing starts before the first-load signal; then all 8 start exactly once, in order", async () => {
    const h = harness();
    const firstLoad = Promise.withResolvers<void>();
    startReplicationFill(h.tcw, () => true, { firstLoadSettled: () => firstLoad.promise, prefixes: PREFIXES });
    await advance(REPLICATION_FILL_FIRST_LOAD_DEADLINE_MS - 1_000);
    expect(h.started).toEqual([]);
    firstLoad.resolve();
    await advance(10);
    expect(h.started.map((s) => s.prefix)).toEqual(["a/"]);
    await drain(h);
    expect(h.started.map((s) => s.prefix)).toEqual(PREFIXES);
  });

  test("never more than the pool size in flight", async () => {
    const h = harness();
    startReplicationFill(h.tcw, () => true, { firstLoadSettled: async () => {}, prefixes: PREFIXES });
    await advance(5_000);
    expect(REPLICATION_FILL_POOL_SIZE).toBeLessThanOrEqual(3); // the node's safe maximum per account
    expect(h.inFlight()).toBe(REPLICATION_FILL_POOL_SIZE);
    await drain(h);
    expect(h.started).toHaveLength(PREFIXES.length);
    expect(h.maxInFlight()).toBe(REPLICATION_FILL_POOL_SIZE);
  });

  test("starts are spaced by at least the gap", async () => {
    const h = harness();
    startReplicationFill(h.tcw, () => true, { firstLoadSettled: async () => {}, prefixes: PREFIXES });
    await drain(h);
    expect(h.started).toHaveLength(PREFIXES.length);
    for (let i = 1; i < h.started.length; i += 1) {
      expect(h.started[i]!.at - h.started[i - 1]!.at).toBeGreaterThanOrEqual(REPLICATION_FILL_START_GAP_MS);
    }
  });

  test("starts anyway after the bounded deadline when the first load never settles", async () => {
    const h = harness();
    startReplicationFill(h.tcw, () => true, { firstLoadSettled: () => new Promise<void>(() => {}), prefixes: PREFIXES });
    await advance(REPLICATION_FILL_FIRST_LOAD_DEADLINE_MS - 1_000);
    expect(h.started).toEqual([]);
    await advance(1_500);
    expect(h.started.length).toBeGreaterThan(0);
    await drain(h);
    expect(h.started).toHaveLength(PREFIXES.length);
  });

  test("a failing prefix does not stop the others", async () => {
    const h = harness();
    startReplicationFill(h.tcw, () => true, { firstLoadSettled: async () => {}, prefixes: PREFIXES });
    await advance(10);
    await advance(REPLICATION_FILL_START_GAP_MS * 2);
    h.fail("a/");
    h.fail("b/");
    await drain(h);
    expect(h.started.map((s) => s.prefix)).toEqual(PREFIXES);
  });

  test("sign-out cancels the prefixes not yet started and nothing starts after", async () => {
    const h = harness();
    startReplicationFill(h.tcw, () => true, { firstLoadSettled: async () => {}, prefixes: PREFIXES });
    await advance(10);
    h.sign.out = true;
    h.finish("a/");
    await advance(5_000);
    h.sign.out = false; // even if a controller reappears, the cancelled fill stays cancelled
    h.finish("b/");
    await drain(h);
    expect(h.started.map((s) => s.prefix)).toEqual(["a/"]);
  });

  test("switching the opt-in off cancels the prefixes not yet started", async () => {
    const h = harness();
    let enabled = true;
    startReplicationFill(h.tcw, () => enabled, { firstLoadSettled: async () => {}, prefixes: PREFIXES });
    await advance(10);
    enabled = false;
    await drain(h);
    expect(h.started.map((s) => s.prefix)).toEqual(["a/"]);
  });
});
