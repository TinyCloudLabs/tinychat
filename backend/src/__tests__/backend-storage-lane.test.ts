import { describe, expect, jest, test } from "bun:test";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import {
  BackendStorageLane, BackendStorageLaneTimeout, FOREGROUND_BURST, REQUEST_LANE_WAIT_MS,
} from "../services/backend-storage-lane.js";
import { CalendarAutojoinConnection } from "../services/calendar-autojoin-connection.js";
import {
  KvCalendarAutojoinStore, TenantCoordinator, type CalendarConnection, type CalendarOccurrence,
} from "../services/calendar-autojoin-store.js";
import type { CredentialStore } from "../services/credential-store.js";
import type { GoogleOAuthPort } from "../services/google-oauth.js";
import { JsonTranscriberIndexStore, type JsonKv } from "../services/transcriber-index.js";

function gate() {
  let open!: () => void;
  const opened = new Promise<void>(resolve => { open = resolve; });
  return { open, opened };
}

describe("backend storage lane", () => {
  test("runs one job at a time", async () => {
    const lane = new BackendStorageLane();
    let active = 0;
    let peak = 0;
    await Promise.all(Array.from({ length: 5 }, () => lane.run(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 2));
      active--;
    })));
    expect(peak).toBe(1);
  });

  test("a waiting foreground job starts before waiting background jobs", async () => {
    const lane = new BackendStorageLane();
    const first = gate();
    const order: string[] = [];
    const running = lane.run(async () => { order.push("bg-running"); await first.opened; }, { priority: "background" });
    const bg1 = lane.run(async () => { order.push("bg-1"); }, { priority: "background" });
    const bg2 = lane.run(async () => { order.push("bg-2"); }, { priority: "background" });
    const fg = lane.run(async () => { order.push("fg"); });
    await Promise.resolve();
    first.open();
    await Promise.all([running, bg1, bg2, fg]);
    expect(order).toEqual(["bg-running", "fg", "bg-1", "bg-2"]);
  });

  test("a job that has not started within its wait budget rejects and never runs", async () => {
    const lane = new BackendStorageLane();
    const first = gate();
    const blocker = lane.run(() => first.opened);
    let ran = false;
    const waiting = lane.run(async () => { ran = true; }, { waitTimeoutMs: 20 });
    await expect(waiting).rejects.toBeInstanceOf(BackendStorageLaneTimeout);
    first.open();
    await blocker;
    expect(await lane.run(async () => "next")).toBe("next");
    expect(ran).toBe(false);
  });

  test("a started job is not cut off by its wait budget", async () => {
    const lane = new BackendStorageLane();
    const result = lane.run(async () => {
      await new Promise(resolve => setTimeout(resolve, 40));
      return "done";
    }, { waitTimeoutMs: 10 });
    expect(await result).toBe("done");
  });

  test("a rejected job does not poison the lane", async () => {
    const lane = new BackendStorageLane();
    await expect(lane.run(async () => { throw new Error("write failed"); })).rejects.toThrow("write failed");
    expect(await lane.run(async () => "recovered")).toBe("recovered");
  });

  test("a job that throws synchronously rejects its caller and frees the lane", async () => {
    const lane = new BackendStorageLane();
    const throwing = (() => { throw new Error("sync failure"); }) as unknown as () => Promise<void>;
    await expect(lane.run(throwing)).rejects.toThrow("sync failure");
    expect(await lane.run(async () => "next")).toBe("next");
  });

  test("a budgeted listing rejects once the whole listing exceeds the budget", async () => {
    const keys = Array.from({ length: 10 }, (_, i) => `calendar-autojoin/v1/connections/${i}`);
    let reads = 0;
    const node = { kv: {
      async get() { reads++; await new Promise(resolve => setTimeout(resolve, 25)); return { ok: true, data: { data: { tenant: "t" } } }; },
      async list() { return { ok: true, data: { keys } }; },
    } } as unknown as TinyCloudNode;
    const store = new KvCalendarAutojoinStore(node, new BackendStorageLane(), { waitTimeoutMs: 60 });
    await expect(store.listConnections()).rejects.toBeInstanceOf(BackendStorageLaneTimeout);
    // Ten 25 ms reads would take 250 ms; the 60 ms budget stops the listing well before that.
    expect(reads).toBeLessThan(keys.length);
  });

  test("one deadline bounds a whole status read: connection row plus occurrence listing", async () => {
    const tenant = "0xalice";
    const values = new Map<string, unknown>();
    let reads = 0;
    const node = { kv: {
      async get(key: string) {
        reads++;
        await new Promise(resolve => setTimeout(resolve, 25));
        return { ok: true, data: { data: values.get(key) ?? { tenant, state: "enabled", generation: 1, scopes: [], nextScanAt: 0, scanComplete: true } } };
      },
      async list() { return { ok: true, data: { keys: Array.from({ length: 10 }, (_, i) => `calendar-autojoin/v1/occurrences/x/${i}`) } }; },
    } } as unknown as TinyCloudNode;
    const store = new KvCalendarAutojoinStore(node, new BackendStorageLane());
    const connection = new CalendarAutojoinConnection({
      store, credentials: {} as CredentialStore, oauth: {} as GoogleOAuthPort,
      coordinator: new TenantCoordinator(), calendar: { async probePrimary() {} }, statusBudgetMs: 60,
    });
    await expect(connection.getStatus(tenant)).rejects.toBeInstanceOf(BackendStorageLaneTimeout);
    // 1 connection read + 10 occurrence reads at 25 ms each would take 275 ms.
    expect(reads).toBeLessThan(11);
  });

  test("a background listing yields the lane between keys", async () => {
    const values = new Map<string, unknown>(
      ["a", "b", "c"].map(id => [`calendar-autojoin/v1/connections/${id}`, { tenant: id }]),
    );
    const reads: string[] = [];
    const node = { kv: {
      async get(key: string) { reads.push(key); return { ok: true, data: { data: values.get(key) } }; },
      async list({ prefix }: { prefix: string }) { return { ok: true, data: { keys: [...values.keys()].filter(key => key.startsWith(prefix)) } }; },
    } } as unknown as TinyCloudNode;
    const lane = new BackendStorageLane();
    const workerStore = new KvCalendarAutojoinStore(node, lane, { priority: "background" });
    const listing = workerStore.listConnections();
    await Promise.resolve();
    await Promise.resolve();
    let foregroundAfterReads = -1;
    const foreground = lane.run(async () => { foregroundAfterReads = reads.length; });
    await Promise.all([listing, foreground]);
    expect(reads.length).toBe(3);
    expect(foregroundAfterReads).toBeLessThan(3);
  });
});

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** A backend node whose KV calls each take `delay.ms`: a prod node call (~2 s), scaled down. */
function slowNode(values: Map<string, unknown>, delay: { ms: number }) {
  const gets: string[] = [];
  const puts: { key: string; value: unknown }[] = [];
  const node = { kv: {
    async get(key: string) {
      await sleep(delay.ms);
      gets.push(key);
      return { ok: true, data: { data: structuredClone(values.get(key)) } };
    },
    async put(key: string, value: unknown) {
      await sleep(delay.ms);
      puts.push({ key, value: structuredClone(value) });
      values.set(key, structuredClone(value));
      return { ok: true, data: {} };
    },
    async list({ prefix }: { prefix: string }) {
      await sleep(delay.ms);
      return { ok: true, data: { keys: [...values.keys()].filter(key => key.startsWith(prefix)) } };
    },
  } } as unknown as TinyCloudNode;
  return { node, gets, puts };
}

function slowJson(values: Map<string, unknown>, delay: { ms: number }, reads = { count: 0 }): JsonKv {
  return {
    async get<T>(key: string) { await sleep(delay.ms); reads.count++; return structuredClone(values.get(key) ?? null) as T | null; },
    async put(key, value) { await sleep(delay.ms); values.set(key, structuredClone(value)); },
    async remove(key) { await sleep(delay.ms); values.delete(key); },
    async keys(prefix) { await sleep(delay.ms); return [...values.keys()].filter(key => key.startsWith(prefix)); },
  };
}

const connectionRow = (tenant: string): CalendarConnection => ({
  tenant, subject: "google-subject", state: "enabled", generation: 1, scopes: [], nextScanAt: 0, scanComplete: true,
});

const occurrenceRow = (tenant: string, id: string, extra: Partial<CalendarOccurrence> = {}): CalendarOccurrence => ({
  id, tenant, subject: "google-subject", eventId: `event-${id}`, start: 1_000, end: 2_000,
  meetingUrl: "https://meet.google.com/abc-defg-hij", title: id, phase: "pending", nextAttemptAt: 0,
  attemptCount: 0, stopRequested: false, updatedAt: 0, ...extra,
});

/** Occupies the lane until `release()`; resolves once the job has actually started. */
async function holdLane(lane: BackendStorageLane) {
  const started = gate();
  const held = gate();
  const job = lane.run(async () => { started.open(); await held.opened; }, { priority: "background" });
  await started.opened;
  return async () => { held.open(); await job; };
}

function statusService(store: KvCalendarAutojoinStore) {
  return new CalendarAutojoinConnection({
    store, credentials: {} as CredentialStore, oauth: {} as GoogleOAuthPort,
    coordinator: new TenantCoordinator(), calendar: { async probePrimary() {} },
  });
}

describe("TC-1006: request reads do not queue behind the auto-join worker", () => {
  test("meetings and auto-join status reads finish while the worker lists many slow rows", async () => {
    const lane = new BackendStorageLane();
    const values = new Map<string, unknown>();
    const delay = { ms: 0 };
    const { node, gets } = slowNode(values, delay);
    // Production wiring: one lane, the worker's store in the background, the request store foreground.
    const workerStore = new KvCalendarAutojoinStore(node, lane, { priority: "background" });
    const requestStore = new KvCalendarAutojoinStore(node, lane, { waitTimeoutMs: REQUEST_LANE_WAIT_MS });
    // The worker reconciles 4 tenants at once; each listing is ROWS sequential node reads.
    const ROWS = 30;
    const busy = ["0xbusy1", "0xbusy2", "0xbusy3", "0xbusy4"];
    for (const tenant of busy) {
      for (let i = 0; i < ROWS; i++) await workerStore.putOccurrence(occurrenceRow(tenant, `row-${i}`, { phase: "terminal", disposition: "not_accepted" }));
    }
    await requestStore.putConnection(connectionRow("0xalice"));
    await requestStore.putOccurrence(occurrenceRow("0xalice", "missed-1", { phase: "terminal", disposition: "missed" }));
    const indexValues = new Map<string, unknown>();
    await new JsonTranscriberIndexStore(slowJson(indexValues, delay), lane).add("0xalice", "meeting-1");
    // A fresh instance has a cold cache, so its reads must take a lane slot like after a restart.
    const index = new JsonTranscriberIndexStore(slowJson(indexValues, delay), lane);
    const status = statusService(requestStore);

    delay.ms = 10;
    const busyReads = () => gets.filter(key => busy.includes((values.get(key) as { tenant?: string } | undefined)?.tenant ?? "")).length;
    const listings = busy.map(tenant => workerStore.listOccurrences(tenant));
    while (busyReads() < 8) await sleep(1);
    const before = busyReads();

    const [pending, entries, autojoin] = await Promise.all([
      index.listPending("0xalice"), index.entries("0xalice"), status.getStatus("0xalice"),
    ]);
    const workerReadsWhileRequestWaited = busyReads() - before;

    expect(pending).toEqual([]);
    expect(entries.ids).toEqual(["meeting-1"]);
    expect(autojoin.outcomes.map(row => row.id)).toEqual(["missed-1"]);
    // The old lane held one slot for a whole listing (ROWS reads); FIFO with per-key slots still puts
    // each request hop behind every tenant's queued read. Now a request waits for at most the read
    // in flight plus one background read per FOREGROUND_BURST request reads.
    expect(workerReadsWhileRequestWaited).toBeLessThanOrEqual(3);
    // Every background listing still completes with all its rows.
    for (const rows of await Promise.all(listings)) expect(rows).toHaveLength(ROWS);
  });

  test("a cached index read is answered without waiting for the lane", async () => {
    const lane = new BackendStorageLane();
    const index = new JsonTranscriberIndexStore(slowJson(new Map(), { ms: 0 }), lane);
    await index.add("0xalice", "meeting-1");
    const release = await holdLane(lane);
    const read = await Promise.race([index.entries("0xalice"), sleep(200).then(() => "blocked" as const)]);
    // Read-your-writes: the awaited add refreshed the cache this read is answered from.
    expect(read).toEqual({ ids: ["meeting-1"], shared: {} });
    expect(await index.list("0xalice")).toEqual(["meeting-1"]);
    await release();
  });

  test("an uncached index read that cannot start within the request budget rejects and reads nothing", async () => {
    jest.useFakeTimers();
    try {
      const lane = new BackendStorageLane();
      const reads = { count: 0 };
      const index = new JsonTranscriberIndexStore(slowJson(new Map(), { ms: 0 }, reads), lane);
      const release = await holdLane(lane);
      let settled = false;
      const read = index.entries("0xalice");
      void read.then(() => { settled = true; }, () => { settled = true; });
      jest.advanceTimersByTime(REQUEST_LANE_WAIT_MS - 1);
      await Promise.resolve();
      expect(settled).toBe(false);
      jest.advanceTimersByTime(1);
      await expect(read).rejects.toBeInstanceOf(BackendStorageLaneTimeout);
      expect(reads.count).toBe(0);
      await release();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("TC-1006: background work is not starved", () => {
  test("background jobs still start under a steady stream of foreground jobs", async () => {
    const lane = new BackendStorageLane();
    const order: string[] = [];
    const stream: Promise<void>[] = [];
    let remaining = 40;
    // Each foreground job queues the next one, so foreground work is waiting at every pick.
    const foreground = (): Promise<void> => lane.run(async () => {
      order.push("fg");
      if (--remaining > 0) stream.push(foreground());
    });
    stream.push(foreground(), foreground());
    const background = Array.from({ length: 3 }, (_, i) =>
      lane.run(async () => { order.push(`bg${i}`); }, { priority: "background" }));
    await Promise.all(background);
    while (remaining > 0) await Promise.all(stream);
    await Promise.all(stream);

    const positions = ["bg0", "bg1", "bg2"].map(name => order.indexOf(name));
    // All background jobs ran while the foreground stream was still going.
    expect(positions[2]).toBeLessThan(order.lastIndexOf("fg"));
    // The first waits for the job already running plus one burst; later ones for one burst each.
    expect(positions[0]).toBeLessThanOrEqual(FOREGROUND_BURST + 1);
    expect(positions[1] - positions[0] - 1).toBeLessThanOrEqual(FOREGROUND_BURST);
    expect(positions[2] - positions[1] - 1).toBeLessThanOrEqual(FOREGROUND_BURST);
  });
});

describe("TC-1006: write ordering and consistency", () => {
  test("same-key writes from one store land in issue order while foreground reads overtake them", async () => {
    const lane = new BackendStorageLane();
    const values = new Map<string, unknown>();
    const { node, puts } = slowNode(values, { ms: 1 });
    const workerStore = new KvCalendarAutojoinStore(node, lane, { priority: "background" });
    const requestStore = new KvCalendarAutojoinStore(node, lane);
    await requestStore.putConnection(connectionRow("0xalice"));
    const before = puts.length;
    const writes = [1, 2, 3, 4, 5].map(attemptCount => workerStore.putOccurrence(occurrenceRow("0xalice", "o1", { attemptCount })));
    const reads = [1, 2, 3].map(() => requestStore.getConnection("0xalice"));
    await Promise.all([...writes, ...reads]);
    expect(puts.slice(before).map(put => (put.value as CalendarOccurrence).attemptCount)).toEqual([1, 2, 3, 4, 5]);
    // Read-your-writes across priorities: an awaited background write is visible to a request read.
    expect((await requestStore.getOccurrence("0xalice", "o1"))?.attemptCount).toBe(5);
  });

  test("concurrent read-modify-write updates from both priorities are all applied", async () => {
    const lane = new BackendStorageLane();
    const values = new Map<string, unknown>();
    const { node } = slowNode(values, { ms: 1 });
    const workerStore = new KvCalendarAutojoinStore(node, lane, { priority: "background" });
    const requestStore = new KvCalendarAutojoinStore(node, lane);
    await workerStore.putOccurrence(occurrenceRow("0xalice", "o1"));
    await Promise.all([
      ...[1, 2, 3].map(() => workerStore.updateOccurrence("0xalice", "o1", row => row && { ...row, attemptCount: row.attemptCount + 1 })),
      requestStore.updateOccurrence("0xalice", "o1", row => row && { ...row, stopRequested: true }),
    ]);
    const row = await requestStore.getOccurrence("0xalice", "o1");
    expect(row?.attemptCount).toBe(3);
    expect(row?.stopRequested).toBe(true);
  });

  test("index writes keep issue order while background work waits, and reads see them", async () => {
    const lane = new BackendStorageLane();
    const values = new Map<string, unknown>();
    const index = new JsonTranscriberIndexStore(slowJson(values, { ms: 1 }), lane);
    const background = Array.from({ length: 3 }, () => lane.run(() => sleep(1), { priority: "background" }));
    await Promise.all([
      index.add("0xalice", "a"), index.add("0xalice", "b"), index.remove("0xalice", "a"), index.add("0xalice", "c"),
      ...background,
    ]);
    expect(await index.list("0xalice")).toEqual(["c", "b"]);
    // A cold reader sees the same committed document.
    expect(await new JsonTranscriberIndexStore(slowJson(values, { ms: 0 }), lane).list("0xalice")).toEqual(["c", "b"]);
  });
});
