// TC-524 location spike storage. Rules:
//   1. batches live under the granted connectors/ KV prefix, per install and UTC day, keyed by the first queue seq
//      (zero-padded), so keys sort in capture order and a re-upload overwrites instead of duplicating;
//   2. a page is acked only after its write succeeded; a failed write leaves it queued on the device;
//   3. samples and OS-state events travel together, in seq order;
//   4. one sync at a time.

import { beforeEach, describe, expect, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { APP_ID } from "../threadStore";
import {
  buildLocationBatch,
  listLocationBatchKeys,
  locationBatchKvKey,
  syncLocationQueue,
  utcDay,
  type LocationBatch,
} from "./locationStore";
import type { LocationQueueEntry, LocationSample, LocationStateEvent } from "./nativeLocation";

const T0 = Date.parse("2026-10-04T08:00:00.000Z");
const device = { platform: "android", installId: "inst-1" };

function sample(seq: number, at = T0 + seq * 1000): LocationQueueEntry {
  const s: LocationSample & { seq: number } = {
    kind: "sample",
    seq,
    at,
    receivedAt: at + 50,
    lat: 52.52 + seq / 1000,
    lon: 13.405,
    accuracyM: 8,
    provider: "fused",
    mock: false,
    accuracyAuthorization: "precise",
    mode: "continuous",
    appVisible: true,
  };
  return s;
}

function stateEvent(seq: number, reason: string): LocationQueueEntry {
  const e: LocationStateEvent & { seq: number } = {
    kind: "state",
    seq,
    at: T0 + seq * 1000,
    change: "tracking",
    reason,
    state: { permission: "foreground", accuracy: "precise", servicesEnabled: true, lowPowerMode: false, appVisible: false },
  };
  return e;
}

/** A native queue double: pending() pages from the front, ack() drops through a seq. */
function fakeQueue(entries: LocationQueueEntry[], opts: { failAck?: boolean } = {}) {
  let queue = [...entries];
  const acks: number[] = [];
  return {
    acks,
    get queue() {
      return queue;
    },
    plugin: {
      async pending(options?: { limit?: number }) {
        return { entries: queue.slice(0, options?.limit ?? 200), pending: queue.length };
      },
      async ack({ throughSeq }: { throughSeq: number }) {
        if (opts.failAck) throw new Error("bridge gone");
        acks.push(throughSeq);
        queue = queue.filter((e) => e.seq > throughSeq);
        return { pending: queue.length };
      },
    },
  };
}

function fakeTcw(opts: { putOk?: boolean; keys?: unknown[] } = {}) {
  const puts: Array<{ key: string; value: string }> = [];
  const lists: string[] = [];
  const tcw = {
    kv: {
      async put(key: string, value: string) {
        puts.push({ key, value });
        return opts.putOk === false ? { ok: false, error: { code: "KV_ERROR", message: "boom" } } : { ok: true, data: {} };
      },
      async list({ path }: { path: string }) {
        lists.push(path);
        return { ok: true, data: { keys: opts.keys ?? [] } };
      },
    },
  };
  return { tcw: tcw as unknown as TinyCloudWeb, puts, lists };
}

describe("location batch keys", () => {
  test("live under the granted connectors/ prefix, per install and UTC day, sorted by first seq", () => {
    expect(locationBatchKvKey("inst-1", T0, 42)).toBe(`${APP_ID}/connectors/exo-location/inst-1/2026-10-04/000000000042`);
    expect(utcDay(Date.parse("2026-10-04T23:59:59.999Z"))).toBe("2026-10-04");
    const keys = [locationBatchKvKey("i", T0, 1000), locationBatchKvKey("i", T0, 99)];
    expect([...keys].sort()).toEqual([locationBatchKvKey("i", T0, 99), locationBatchKvKey("i", T0, 1000)]);
  });

  test("a batch splits samples from state events, in seq order", () => {
    const { key, batch } = buildLocationBatch(device, [sample(3), stateEvent(1, "started"), sample(2)], new Date(T0));
    expect(key).toBe(locationBatchKvKey("inst-1", T0 + 1000, 1));
    expect(batch).toMatchObject({ v: 1, kind: "exo-location-batch", spike: "TC-524", platform: "android", firstSeq: 1, lastSeq: 3 });
    expect(batch.samples.map((s) => s.seq)).toEqual([2, 3]);
    expect(batch.events.map((e) => e.reason)).toEqual(["started"]);
  });
});

describe("syncLocationQueue", () => {
  beforeEach(() => {
    // Nothing global to reset: the single-flight slot clears when a run settles.
  });

  test("writes one batch per page, acks after each write, and empties the queue", async () => {
    const queue = fakeQueue([stateEvent(1, "started"), ...Array.from({ length: 4 }, (_, i) => sample(i + 2))]);
    const { tcw, puts } = fakeTcw();
    const res = await syncLocationQueue(tcw, queue.plugin, device, { limit: 2, now: () => new Date(T0) });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toMatchObject({ batches: 3, entries: 5, pending: 0 });
    expect(queue.acks).toEqual([2, 4, 5]);
    expect(puts.map((p) => p.key)).toEqual([
      locationBatchKvKey("inst-1", T0 + 1000, 1),
      locationBatchKvKey("inst-1", T0 + 3000, 3),
      locationBatchKvKey("inst-1", T0 + 5000, 5),
    ]);
    const first = JSON.parse(puts[0].value) as LocationBatch;
    expect(first.events).toHaveLength(1);
    expect(first.samples).toHaveLength(1);
  });

  test("a failed write acks nothing: the page stays on the device", async () => {
    const queue = fakeQueue([sample(1), sample(2)]);
    const { tcw } = fakeTcw({ putOk: false });
    const res = await syncLocationQueue(tcw, queue.plugin, device);
    expect(res.ok).toBe(false);
    expect(queue.acks).toEqual([]);
    expect(queue.queue).toHaveLength(2);
  });

  test("saved but not acked: the retry rewrites the same key with a superset", async () => {
    const lost = fakeQueue([sample(1), sample(2)], { failAck: true });
    const first = fakeTcw();
    expect((await syncLocationQueue(first.tcw, lost.plugin, device)).ok).toBe(false);

    const retry = fakeQueue([sample(1), sample(2), sample(3)]);
    const second = fakeTcw();
    expect((await syncLocationQueue(second.tcw, retry.plugin, device)).ok).toBe(true);
    expect(second.puts[0].key).toBe(first.puts[0].key);
    expect((JSON.parse(second.puts[0].value) as LocationBatch).lastSeq).toBe(3);
  });

  test("an empty queue writes nothing", async () => {
    const { tcw, puts } = fakeTcw();
    const res = await syncLocationQueue(tcw, fakeQueue([]).plugin, device);
    expect(res.ok && res.data).toMatchObject({ batches: 0, entries: 0, pending: 0 });
    expect(puts).toHaveLength(0);
  });

  test("single-flight: a second call while one runs joins it", async () => {
    const queue = fakeQueue([sample(1)]);
    const { tcw, puts } = fakeTcw();
    const [a, b] = [syncLocationQueue(tcw, queue.plugin, device), syncLocationQueue(tcw, queue.plugin, device)];
    expect(a).toBe(b);
    await a;
    expect(puts).toHaveLength(1);
  });
});

describe("listLocationBatchKeys", () => {
  test("lists one install's day and keeps only keys under it, sorted", async () => {
    const prefix = `${APP_ID}/connectors/exo-location/inst-1/2026-10-04/`;
    const { tcw, lists } = fakeTcw({ keys: [`${prefix}000000000009`, `${prefix}000000000001`, "elsewhere/x", 7] });
    const res = await listLocationBatchKeys(tcw, "inst-1", "2026-10-04");
    expect(lists).toEqual([prefix]);
    expect(res.ok && res.data).toEqual([`${prefix}000000000001`, `${prefix}000000000009`]);
  });
});
