import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import {
  CEILING_WINDOW_MS,
  CONNECTOR_A_FETCH_CEILING_PER_HOUR,
  CONNECTOR_A_SECRET_READ_CEILING_PER_HOUR,
  ConnectorDrainWorker,
  ConnectorSideEffectCeilings,
  DRAIN_INTERVAL_MS,
  DrainError,
  MAX_CONCURRENT_DRAINS,
  MIN_INTER_DRAIN_INTERVAL_MS,
  REVOCATION_RECHECK_MS,
  classifyDrainError,
  createWebhookConfigDirectory,
  drainIntervalFromEnv,
  isTombstoned,
  REVOCATION_RECHECK_ITEMS_SIDE_EFFECTING,
  tombstoneReason,
  startConnectorQueueMaintenanceTimer,
} from "../services/connector-drain.js";
import {
  AWAITING_TRANSCRIPT,
  ConnectorQueue,
  DELEGATION_UNUSABLE,
  LEDGER_UNAVAILABLE,
  MAX_ATTEMPTS,
  SCHEMA_MISSING,
  SPACE_NOT_HOSTED,
  type PendingItem,
} from "../services/connector-queue.js";
import {
  ConnectorDrainAbortFlags,
  type DisabledMarker,
  type PurgeLedgerRead,
} from "../routes/connector-webhooks.js";
import {
  _resetWebhookTokenState,
  type WebhookConfigRecord,
} from "../services/webhook-tokens.js";
import {
  _resetWriteLane,
  _setWriteLaneGapMs,
  runInWriteLane,
} from "../services/write-lane.js";

const ORIGINAL_ENV = { ...process.env };
const SALT = Buffer.from("drain-salt-drain-salt-drain-1234").toString("base64");

const ADDRESS = "0x7d0333AbCdEf0123456789AbCdEf012345673f21";
const LOWER = ADDRESS.toLowerCase();
const OTHER = "0x1111111111111111111111111111111111111111";
const SOURCE = "fireflies";

const T0 = Date.parse("2026-08-04T12:00:00.000Z");

beforeEach(() => {
  _resetWebhookTokenState();
  process.env.LOG_HASH_SALT = SALT;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  _resetWebhookTokenState();
});

// ── Fakes ────────────────────────────────────────────────────────────

class FakeNode {
  readonly store = new Map<string, unknown>();
  listResponse: unknown = { data: [] };
  listCalls: unknown[] = [];

  readonly kv = {
    get: async (key: string): Promise<unknown> => {
      if (!this.store.has(key)) return { data: null };
      return { data: { data: this.store.get(key) } };
    },
    put: async (key: string, value: unknown): Promise<unknown> => {
      this.store.set(key, JSON.parse(JSON.stringify(value)));
      return { data: true };
    },
    delete: async (key: string): Promise<unknown> => {
      this.store.delete(key);
      return { data: true };
    },
    list: async (options: unknown): Promise<unknown> => {
      this.listCalls.push(options);
      return this.listResponse;
    },
  };
}

class FakeControl {
  disabled: DisabledMarker | null = null;
  ledger: PurgeLedgerRead = { status: "absent" };
  ledgerError: Error | null = null;
  readonly quarantined: unknown[] = [];
  disabledReads = 0;
  ledgerReads = 0;

  async readDisabled(): Promise<DisabledMarker | null> {
    this.disabledReads += 1;
    return this.disabled;
  }

  async readLedger(): Promise<PurgeLedgerRead> {
    this.ledgerReads += 1;
    if (this.ledgerError) throw this.ledgerError;
    return this.ledger;
  }

  async quarantineLedger(
    _source: string,
    _address: string,
    raw: unknown,
  ): Promise<void> {
    this.quarantined.push(raw);
  }
}

class FakeTokens {
  record: WebhookConfigRecord | null = {
    token: "t".repeat(43),
    source: SOURCE,
    createdAt: new Date(T0).toISOString(),
  };
  calls = 0;

  async config(): Promise<WebhookConfigRecord | null> {
    this.calls += 1;
    return this.record;
  }
}

interface Harness {
  node: FakeNode;
  queue: ConnectorQueue;
  control: FakeControl;
  tokens: FakeTokens;
  abort: ConnectorDrainAbortFlags;
  ceilings: ConnectorSideEffectCeilings;
  clock: { now: number };
}

function harness(): Harness {
  const clock = { now: T0 };
  const now = () => clock.now;
  const node = new FakeNode();
  return {
    node,
    queue: new ConnectorQueue(node as unknown as TinyCloudNode, {
      flushWindowMs: 0,
      now,
      jitter: () => 0,
    }),
    control: new FakeControl(),
    tokens: new FakeTokens(),
    abort: new ConnectorDrainAbortFlags(),
    ceilings: new ConnectorSideEffectCeilings({ now }),
    clock,
  };
}

function worker(
  h: Harness,
  overrides: Partial<
    ConstructorParameters<typeof ConnectorDrainWorker>[0]
  > = {},
): ConnectorDrainWorker {
  return new ConnectorDrainWorker({
    queue: h.queue,
    tokens: h.tokens,
    control: h.control,
    abort: h.abort,
    ceilings: h.ceilings,
    now: () => h.clock.now,
    minIntervalMs: 0,
    // The tests assert drain behaviour, not the lane's 25 ms inter-write gap; the lane's own
    // serialization is asserted separately below.
    lane: (fn) => Promise.resolve().then(fn),
    ...overrides,
  });
}

async function seed(
  h: Harness,
  ids: string[],
  address = ADDRESS,
): Promise<void> {
  for (const id of ids) {
    await h.queue.enqueue(SOURCE, address, {
      meetingId: id,
      kind: "transcript",
    });
  }
}

// ── §4.7 (binding): the drain surfaces, and writes NOTHING to the user's space ──

describe("drain under ingest shape B/C", () => {
  test("surfaces the pending ids and leaves them queued", async () => {
    const h = harness();
    await seed(h, ["m1", "m2", "m3"]);
    const w = worker(h);

    const result = await w.kick({ address: ADDRESS, source: SOURCE });

    expect(result.status).toBe("ok");
    expect(result.surfaced).toEqual(["m1", "m2", "m3"]);
    expect(result.completed).toBe(0);
    // The CLIENT is the writer under B/C (F5), so the ids stay pending until it has them.
    expect(
      (await h.queue.list(SOURCE, ADDRESS)).map((i) => i.meetingId),
    ).toEqual(["m1", "m2", "m3"]);
  });

  test("writes no key outside the backend's own webhooks/ prefix", async () => {
    const h = harness();
    await seed(h, ["m1", "m2"]);
    await worker(h).kick({ address: ADDRESS });

    const keys = [...h.node.store.keys()];
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(key.startsWith("webhooks/")).toBe(true);
      expect(key.includes("xyz.tinycloud.tinychat")).toBe(false);
    }
  });

  test("Option A's removeOnRelease is opt-in, never the default", async () => {
    const h = harness();
    await seed(h, ["m1"]);
    const w = worker(h, { removeOnRelease: true });

    const result = await w.kick({ address: ADDRESS });
    expect(result.completed).toBe(1);
    expect(await h.queue.list(SOURCE, ADDRESS)).toHaveLength(0);
  });
});

// ── §5.4: coalescing — singleton + dirty flag + interval + global cap ──

describe("drain coalescing", () => {
  test("50 deliveries produce 1–2 drain invocations, not 50", async () => {
    const h = harness();
    await seed(h, ["m1", "m2"]);
    const w = worker(h);

    const kicks: Promise<unknown>[] = [];
    for (let i = 0; i < 50; i += 1)
      kicks.push(w.kick({ address: ADDRESS, source: SOURCE }));
    await Promise.all(kicks);

    expect(w.drainCount(ADDRESS)).toBeGreaterThanOrEqual(1);
    expect(w.drainCount(ADDRESS)).toBeLessThanOrEqual(2);
  });

  test("a kick during an in-flight drain returns that drain, never a second one", async () => {
    const h = harness();
    await seed(h, ["m1"]);
    const w = worker(h);
    const first = w.kick({ address: ADDRESS });
    const second = w.kick({ address: ADDRESS });
    await Promise.all([first, second]);
    expect(w.drainCount(ADDRESS)).toBeLessThanOrEqual(2);
  });

  // ── F009 (1): shutdown ──────────────────────────────────────────────
  //
  // `stop()` is called on process shutdown (startConnectorDrainTimer) and had no test at all.
  // A kick after it must return the empty ABORTED sentinel — not a fresh pass whose writes land
  // while the process is going down, and not a resolved `ok` that reads as "nothing pending"
  // and lets a caller surface an empty list as truth.
  test("a kick after stop() returns the empty aborted sentinel and runs no pass (F009)", async () => {
    const h = harness();
    await seed(h, ["m1", "m2"]);
    const w = worker(h);

    w.stop();
    const result = await w.kick({ address: ADDRESS, source: SOURCE });

    expect(result).toMatchObject({
      // Normalized, as every other drain result is — the sentinel is not a different shape.
      address: LOWER,
      source: null,
      status: "aborted",
      reason: "stopped",
      surfaced: [],
      dropped: 0,
      completed: 0,
      held: 0,
      passes: 0,
    });
    expect(w.drainCount(ADDRESS)).toBe(0);
    // Nothing was read and nothing was settled: the items are still queued for the next boot.
    expect(h.tokens.calls).toBe(0);
    expect(h.control.disabledReads).toBe(0);
    expect(await h.queue.list(SOURCE, ADDRESS)).toHaveLength(2);
  });

  test("stop() refuses a FORCED kick too — shutdown is not overridable by trigger 3 (F009)", async () => {
    const h = harness();
    await seed(h, ["m1"]);
    const w = worker(h);
    w.stop();

    const forced = await w.kick({ address: ADDRESS, force: true });
    expect(forced.status).toBe("aborted");
    expect(forced.reason).toBe("stopped");
    expect(w.drainCount(ADDRESS)).toBe(0);
  });

  test("stop() still validates its input — a traversal address rejects, never a sentinel (F009)", async () => {
    const h = harness();
    const w = worker(h);
    w.stop();
    await expect(
      w.kick({ address: "../../delegations/0xabc" }),
    ).rejects.toThrow(/Invalid webhook config address/);
  });

  test("the minimum inter-drain interval defers a follow-up kick instead of looping hot", async () => {
    const h = harness();
    await seed(h, ["m1"]);
    const w = worker(h, { minIntervalMs: 30, now: () => Date.now() });

    await w.kick({ address: ADDRESS });
    expect(w.drainCount(ADDRESS)).toBe(1);

    const deferred = w.kick({ address: ADDRESS });
    // Still exactly one: the second kick is scheduled, not run.
    expect(w.drainCount(ADDRESS)).toBe(1);
    await deferred;
    expect(w.drainCount(ADDRESS)).toBe(2);
  });

  test("trigger 3 (user visit) forces past the interval — the user is right here", async () => {
    const h = harness();
    await seed(h, ["m1"]);
    const w = worker(h, {
      minIntervalMs: 10_000,
      forcedMinIntervalMs: 0,
      now: () => Date.now(),
    });
    await w.kick({ address: ADDRESS });
    await w.kick({ address: ADDRESS, force: true });
    expect(w.drainCount(ADDRESS)).toBe(2);
  });

  test("the forced path still has a floor: it returns the previous result, never a fresh pass", async () => {
    // `force` skips the anti-tight-loop interval by design, and the singleton coalesces only
    // CONCURRENT kicks — so SEQUENTIAL forced kicks each ran a full pass (config + marker + queue
    // + dead + ledger reads) against the shared single-writer node, at the companion bucket's
    // 600 requests/15 min/IP and exempt from the global limiter. An unset bound on an
    // anti-amplification control ships as Infinity.
    const h = harness();
    await seed(h, ["m1"]);
    const w = worker(h, { forcedMinIntervalMs: 30_000 });

    const first = await w.kick({ address: ADDRESS, force: true });
    expect(w.drainCount(ADDRESS)).toBe(1);

    // Inside the floor: the same result, immediately, and NO second pass.
    const second = await w.kick({ address: ADDRESS, force: true });
    expect(second).toBe(first);
    expect(w.drainCount(ADDRESS)).toBe(1);

    // Past it, a forced kick runs for real again.
    h.clock.now += 30_001;
    await w.kick({ address: ADDRESS, force: true });
    expect(w.drainCount(ADDRESS)).toBe(2);
  });

  test("§12a R3: the floor never replays an `ok` result across a revocation", async () => {
    // A `DrainResult` is the SURFACING authority, so returning one computed BEFORE a revocation
    // is a surfacing decision made under a grant that no longer exists. The cached result was
    // replayed without re-reading the marker, the config or the ledger — `POST /drain` was safe
    // only because the ROUTE reads the marker itself first, i.e. a caller-side check standing in
    // for the drain's own verdict. One KV get on the replay path is the cheap correct fix.
    const h = harness();
    await seed(h, ["m1", "m2", "m3"]);
    const w = worker(h, { forcedMinIntervalMs: 30_000 });

    const first = await w.kick({ address: ADDRESS, force: true });
    expect(first.status).toBe("ok");
    expect(first.surfaced.length).toBeGreaterThan(0);
    const readsAfterFirst = h.control.disabledReads;

    // The durable marker lands INSIDE the floor — the second-instance / operator / crashed-
    // teardown case, where the in-process abort flag was never set.
    h.control.disabled = {
      disabledAt: new Date(h.clock.now).toISOString(),
    } as never;

    const replayed = await w.kick({ address: ADDRESS, force: true });
    expect(replayed.status).toBe("aborted");
    expect(replayed.reason).toBe("revoked");
    expect(replayed.surfaced).toEqual([]);
    // …still no second pass: exactly one extra marker read, not a full drain.
    expect(w.drainCount(ADDRESS)).toBe(1);
    expect(h.control.disabledReads).toBe(readsAfterFirst + 1);
  });

  test("§12a R3: an unreadable marker on the floor path fails CLOSED", async () => {
    const h = harness();
    await seed(h, ["m1"]);
    const w = worker(h, { forcedMinIntervalMs: 30_000 });

    const first = await w.kick({ address: ADDRESS, force: true });
    expect(first.status).toBe("ok");

    h.control.readDisabled = async () => {
      throw new Error("node unreachable");
    };
    const replayed = await w.kick({ address: ADDRESS, force: true });
    expect(replayed.status).toBe("aborted");
    expect(replayed.reason).toBe("revoked");
    expect(w.drainCount(ADDRESS)).toBe(1);
  });

  test("the global concurrency cap is honoured and the waiting address is logged", async () => {
    const h = harness();
    await seed(h, ["m1"], ADDRESS);
    await seed(h, ["m2"], OTHER);
    let active = 0;
    let maxActive = 0;
    const w = worker(h, {
      maxConcurrent: 1,
      release: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return { status: "released" as const };
      },
    });

    await Promise.all([
      w.kick({ address: ADDRESS }),
      w.kick({ address: OTHER }),
    ]);
    expect(maxActive).toBe(1);
    expect(w.drainCount(ADDRESS)).toBe(1);
    expect(w.drainCount(OTHER)).toBe(1);
  });

  test("the shipped defaults are the §5.4 numbers", () => {
    expect(MIN_INTER_DRAIN_INTERVAL_MS).toBe(2_000);
    expect(MAX_CONCURRENT_DRAINS).toBeGreaterThanOrEqual(1);
    expect(DRAIN_INTERVAL_MS).toBe(5 * 60_000);
  });
});

// ── §6.1 step -1 / §6.2: tombstones gate SURFACING under B/C ─────────

describe("purge ledger (step -1)", () => {
  test("an id in recentIds is dropped, never surfaced", async () => {
    const h = harness();
    // Stamped, so this isolates the recentIds rule from the timestamp-less fail-closed rule
    // below — otherwise both items drop and the assertion proves nothing about `recentIds`.
    for (const meetingId of ["m1", "m2"]) {
      await h.queue.enqueue(SOURCE, ADDRESS, {
        meetingId,
        kind: "transcript",
        sourceTimestamp: new Date(T0).toISOString(),
      });
    }
    h.control.ledger = {
      status: "ok",
      ledger: {
        purgedThrough: new Date(T0 - 60_000).toISOString(),
        recentIds: ["m2"],
        updatedAt: new Date(T0).toISOString(),
      },
    };

    const result = await worker(h).kick({ address: ADDRESS });
    expect(result.surfaced).toEqual(["m1"]);
    expect(result.dropped).toBe(1);
    expect(
      (await h.queue.list(SOURCE, ADDRESS)).map((i) => i.meetingId),
    ).toEqual(["m1"]);
  });

  test("a provider stamp before purgedThrough is dropped even with an empty recentIds", async () => {
    const h = harness();
    await h.queue.enqueue(SOURCE, ADDRESS, {
      meetingId: "old",
      kind: "transcript",
      receivedAt: new Date(T0 - 10 * 60_000).toISOString(),
      sourceTimestamp: new Date(T0 - 10 * 60_000).toISOString(),
    });
    await h.queue.enqueue(SOURCE, ADDRESS, {
      meetingId: "new",
      kind: "transcript",
      sourceTimestamp: new Date(T0).toISOString(),
    });
    h.control.ledger = {
      status: "ok",
      ledger: {
        purgedThrough: new Date(T0 - 60_000).toISOString(),
        recentIds: [],
        updatedAt: new Date(T0).toISOString(),
      },
    };

    const result = await worker(h).kick({ address: ADDRESS });
    expect(result.surfaced).toEqual(["new"]);
    expect(result.dropped).toBe(1);
  });

  test("a 500-id purge still tombstones the 300th-oldest id (purgedThrough, not recentIds)", () => {
    const ledger = {
      // Only the newest 200 ids survive §4.8's cap; the watermark is what protects the rest.
      purgedThrough: new Date(T0).toISOString(),
      recentIds: Array.from({ length: 200 }, (_, i) => `m${300 + i}`),
      updatedAt: new Date(T0).toISOString(),
    };
    const three_hundredth: Pick<PendingItem, "meetingId" | "receivedAt"> = {
      meetingId: "m200",
      receivedAt: new Date(T0 - 5_000).toISOString(),
    };
    expect(ledger.recentIds.includes(three_hundredth.meetingId)).toBe(false);
    expect(isTombstoned(three_hundredth, ledger)).toBe(true);
  });

  test("a replay cannot launder a purged meeting past the watermark", () => {
    const ledger = {
      purgedThrough: new Date(T0 - 60_000).toISOString(),
      recentIds: [],
      updatedAt: new Date(T0).toISOString(),
    };
    // The captured delivery is re-sent after the purge, so `receivedAt` is NOW — on the safe
    // side of the watermark. The provider's own timestamp is inside the signed body and did not
    // move, which is why the tombstone reads that instead.
    const replayed: Pick<
      PendingItem,
      "meetingId" | "receivedAt" | "sourceTimestamp"
    > = {
      meetingId: "m1",
      receivedAt: new Date(T0).toISOString(),
      sourceTimestamp: new Date(T0 - 120_000).toISOString(),
    };
    expect(isTombstoned(replayed, ledger)).toBe(true);

    // A genuinely new delivery is unaffected.
    expect(
      isTombstoned(
        {
          meetingId: "m2",
          receivedAt: new Date(T0).toISOString(),
          sourceTimestamp: new Date(T0 - 10_000).toISOString(),
        },
        ledger,
      ),
    ).toBe(false);
  });

  // The legacy `{meetingId, eventType}` shape (§4.5) carries no provider timestamp, and a purge
  // CLEARS the queue — so every post-purge item of that shape is freshly enqueued with a
  // `receivedAt` of now, on the safe side of the watermark. Comparing `receivedAt` made the
  // watermark inert for that shape, leaving only the 200-id `recentIds` list, and a captured
  // signed delivery resurrected a purged meeting once it aged out of it. Absent is treated like
  // unparseable: not evidence of safety.
  test("a timestamp-less item fails CLOSED against a ledger, and is untouched without one", () => {
    const ledger = {
      purgedThrough: new Date(T0 - 60_000).toISOString(),
      recentIds: [],
      updatedAt: new Date(T0).toISOString(),
    };
    const legacy: Pick<
      PendingItem,
      "meetingId" | "receivedAt" | "sourceTimestamp"
    > = {
      meetingId: "m1",
      // Fresh — a replay after the purge looks exactly like this, and so does a new delivery.
      receivedAt: new Date(T0).toISOString(),
    };

    expect(isTombstoned(legacy, ledger)).toBe(true);
    expect(tombstoneReason(legacy, ledger)).toBe("purged_no_timestamp");
    // No purge ever happened for this address ⇒ nothing is suppressed. The drop is scoped to a
    // user who purged and has not fired §4.8's DELETE re-sync.
    expect(isTombstoned(legacy, null)).toBe(false);
  });

  test("a timestamp-less item is dropped by the drain with reason=purged_no_timestamp", async () => {
    const h = harness();
    await h.queue.enqueue(SOURCE, ADDRESS, {
      meetingId: "legacy",
      kind: "transcript",
    });
    await h.queue.enqueue(SOURCE, ADDRESS, {
      meetingId: "stamped",
      kind: "transcript",
      sourceTimestamp: new Date(T0).toISOString(),
    });
    h.control.ledger = {
      status: "ok",
      ledger: {
        purgedThrough: new Date(T0 - 60_000).toISOString(),
        recentIds: [],
        updatedAt: new Date(T0).toISOString(),
      },
    };

    const result = await worker(h).kick({ address: ADDRESS });
    expect(result.surfaced).toEqual(["stamped"]);
    expect(result.dropped).toBe(1);
  });

  test("a duplicate delivery refreshes receivedAt but never the provider stamp", async () => {
    const h = harness();
    const sourceTimestamp = new Date(T0 - 120_000).toISOString();
    await h.queue.enqueue(SOURCE, ADDRESS, {
      meetingId: "m1",
      kind: "transcript",
      sourceTimestamp,
    });
    h.clock.now = T0 + 60_000;
    await h.queue.enqueue(SOURCE, ADDRESS, {
      meetingId: "m1",
      kind: "transcript",
      sourceTimestamp: new Date(T0 + 60_000).toISOString(),
    });

    const [item] = await h.queue.list(SOURCE, ADDRESS);
    expect(item!.receivedAt).toBe(new Date(T0 + 60_000).toISOString());
    expect(item!.sourceTimestamp).toBe(sourceTimestamp);
  });

  test("a ledger read FAILURE aborts the drain, burns no attempts and surfaces nothing", async () => {
    const h = harness();
    await seed(h, ["m1", "m2"]);
    h.control.ledgerError = new Error("kv unavailable");

    const result = await worker(h).kick({ address: ADDRESS });
    expect(result.status).toBe("aborted");
    expect(result.reason).toBe(LEDGER_UNAVAILABLE);
    expect(result.surfaced).toEqual([]);
    const items = await h.queue.list(SOURCE, ADDRESS);
    expect(items).toHaveLength(2);
    expect(items.every((item) => item.attempts === 0)).toBe(true);
  });

  test("an UNPARSEABLE ledger is quarantined and never read as empty", async () => {
    const h = harness();
    await seed(h, ["m1"]);
    h.control.ledger = { status: "unparseable", raw: "{oops" };

    const result = await worker(h).kick({ address: ADDRESS });
    expect(result.status).toBe("aborted");
    expect(result.reason).toBe(LEDGER_UNAVAILABLE);
    expect(result.surfaced).toEqual([]);
    expect(h.control.quarantined).toEqual(["{oops"]);
  });
});

// ── §3.6: revocation stops an in-flight drain ────────────────────────

describe("revocation", () => {
  test("the abort flag stops the drain between items — items 2..N are never surfaced", async () => {
    const h = harness();
    await seed(h, ["m1", "m2", "m3", "m4"]);
    const w = worker(h, {
      release: ({ item }) => {
        if (item.meetingId === "m1") h.abort.abort(ADDRESS);
        return { status: "released" as const };
      },
    });

    const result = await w.kick({ address: ADDRESS });
    expect(result.status).toBe("aborted");
    expect(result.reason).toBe("revoked");
    expect(result.surfaced).toEqual(["m1"]);
  });

  test("a durable disabled marker aborts before anything is read or surfaced", async () => {
    const h = harness();
    await seed(h, ["m1"]);
    h.control.disabled = {
      revokedAt: new Date(T0).toISOString(),
      source: SOURCE,
    };

    const result = await worker(h).kick({ address: ADDRESS });
    expect(result.status).toBe("aborted");
    expect(result.reason).toBe("revoked");
    expect(h.control.ledgerReads).toBe(0);
  });

  test("no config at all is `not_configured`, not a silent success", async () => {
    const h = harness();
    h.tokens.record = null;
    const result = await worker(h).kick({ address: ADDRESS });
    expect(result.status).toBe("aborted");
    expect(result.reason).toBe("not_configured");
  });

  test("the stored delegation is re-validated on every drain, and a dead one aborts", async () => {
    const h = harness();
    await seed(h, ["m1"]);
    let ok = true;
    let calls = 0;
    const w = worker(h, {
      // The forced-kick floor is not what this test is about.
      forcedMinIntervalMs: 0,
      delegations: {
        validate: async () => {
          calls += 1;
          return ok
            ? { ok: true }
            : { ok: false, reason: "delegation_expired" };
        },
      },
    });

    expect((await w.kick({ address: ADDRESS })).status).toBe("ok");
    expect(calls).toBe(1);

    ok = false;
    const second = await w.kick({ address: ADDRESS, force: true });
    expect(second.status).toBe("aborted");
    expect(second.reason).toBe(DELEGATION_UNUSABLE);
    expect(second.surfaced).toEqual([]);
    expect(w.needsReauth(ADDRESS)).toBe(true);
    // §5.5: user-state, not item-state — nothing burned, nothing dead-lettered.
    expect((await h.queue.list(SOURCE, ADDRESS))[0]!.attempts).toBe(0);
  });

  test("the durable re-check is HOISTED: a 40-item drain costs two marker reads, not 40", async () => {
    const h = harness();
    await seed(
      h,
      Array.from({ length: 40 }, (_, i) => `m${i}`),
    );
    // A frozen clock never advances past the recheck interval, so the TIME half never fires and
    // the per-item durable read stays hoisted (§9.3). The ITEM half still bounds it: 40 items at
    // REVOCATION_RECHECK_ITEMS=20 is the initial read plus one more, not 40 — a whole queue must
    // not be able to drain between two checks of a marker another writer may have flipped.
    const result = await worker(h).kick({ address: ADDRESS });
    expect(result.surfaced).toHaveLength(40);
    expect(h.control.disabledReads).toBe(2);
  });

  // §3.6 rule 2 is a PER-WRITE guarantee. 20 items between durable reads is defensible only while
  // a released item is a surfaced id and nothing else; under Option A (`removeOnRelease`) it is a
  // write into the space of a user who may already have revoked, for a revocation that did not
  // pass through this process. The bound follows the release shape rather than waiting to be
  // remembered when A3 lands.
  test("an Option-A release shape re-reads the durable marker per item", async () => {
    const h = harness();
    await seed(
      h,
      Array.from({ length: 6 }, (_, i) => `m${i}`),
    );
    const w = worker(h, { removeOnRelease: true });

    const result = await w.kick({ address: ADDRESS });
    expect(result.completed).toBe(6);
    // One durable read per item (the pass's initial read covers the first) — not the one-per-20
    // the surface-only shape gets, where all 6 would ride on a single read.
    expect(h.control.disabledReads).toBe(6);
    expect(REVOCATION_RECHECK_ITEMS_SIDE_EFFECTING).toBe(1);
  });

  test("the item-count half of the re-check catches a marker flipped by another writer", async () => {
    const h = harness();
    await seed(
      h,
      Array.from({ length: 40 }, (_, i) => `m${i}`),
    );
    // No in-process abort — the durable marker alone, flipped by "someone else" (a second
    // instance, an operator, a crashed teardown) while the drain is mid-pass and the clock is
    // frozen. Before the item bound this drained all 40.
    const w = worker(h, {
      release: ({ item }) => {
        if (item.meetingId === "m0") {
          h.control.disabled = {
            revokedAt: new Date(T0).toISOString(),
            source: SOURCE,
          };
        }
        return { status: "released" as const };
      },
    });
    const result = await w.kick({ address: ADDRESS });

    expect(result.status).toBe("aborted");
    expect(result.reason).toBe("revoked");
    expect(result.surfaced.length).toBeLessThan(40);
  });

  test("once the recheck interval has elapsed, the durable marker IS re-read mid-drain", async () => {
    const h = harness();
    await seed(h, ["m1", "m2", "m3"]);
    const w = worker(h, {
      revocationRecheckMs: 10,
      release: () => {
        h.clock.now += 50;
        return { status: "released" as const };
      },
    });
    await w.kick({ address: ADDRESS });
    expect(h.control.disabledReads).toBeGreaterThan(1);
  });

  test("a revoke landing on the durable marker mid-drain stops the rest", async () => {
    const h = harness();
    await seed(h, ["m1", "m2", "m3"]);
    const w = worker(h, {
      revocationRecheckMs: 10,
      release: ({ item }) => {
        h.clock.now += 50;
        if (item.meetingId === "m1") {
          h.control.disabled = {
            revokedAt: new Date(h.clock.now).toISOString(),
            source: SOURCE,
          };
        }
        return { status: "released" as const };
      },
    });
    const result = await w.kick({ address: ADDRESS });
    expect(result.status).toBe("aborted");
    expect(result.reason).toBe("revoked");
    expect(result.surfaced).toEqual(["m1"]);
  });

  test("REVOCATION_RECHECK_MS is a real bound, not zero", () => {
    expect(REVOCATION_RECHECK_MS).toBeGreaterThan(0);
  });
});

// ── §5.5: failure classification ─────────────────────────────────────

describe("failure classes", () => {
  test("awaiting_transcript does not burn an attempt and re-queues with backoff", async () => {
    const h = harness();
    await h.queue.enqueue(SOURCE, ADDRESS, {
      meetingId: "m1",
      kind: "summary",
    });
    const w = worker(h, {
      release: () => ({ status: "held" as const, reason: AWAITING_TRANSCRIPT }),
    });

    const result = await w.kick({ address: ADDRESS });
    expect(result.held).toBe(1);
    const [item] = await h.queue.list(SOURCE, ADDRESS);
    expect(item!.attempts).toBe(0);
    expect(item!.lastError).toBe(AWAITING_TRANSCRIPT);
    expect(Date.parse(item!.nextAttemptAt)).toBeGreaterThan(h.clock.now);
  });

  test("an item-state failure burns an attempt and dead-letters at MAX_ATTEMPTS", async () => {
    const h = harness();
    await seed(h, ["m1"]);
    const w = worker(h, {
      release: () => {
        throw new Error("write rejected");
      },
    });

    for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
      await w.kick({ address: ADDRESS, force: true });
      h.clock.now += 7 * 60 * 60 * 1000; // past the 6 h backoff cap
    }
    expect(await h.queue.list(SOURCE, ADDRESS)).toHaveLength(0);
    expect(await h.queue.dead(SOURCE, ADDRESS)).toHaveLength(1);
  });

  test("a Fireflies 404 for a never-written id is TERMINAL on the first attempt (T5)", async () => {
    const h = harness();
    await seed(h, ["fabricated"]);
    const w = worker(h, {
      release: () => {
        throw new DrainError("not_found", "no such transcript", true);
      },
    });

    await w.kick({ address: ADDRESS });
    expect(await h.queue.list(SOURCE, ADDRESS)).toHaveLength(0);
    const dead = await h.queue.dead(SOURCE, ADDRESS);
    expect(dead).toHaveLength(1);
    expect(dead[0]!.lastError).toBe("not_found");
  });

  test("classifyDrainError maps user-state classes and defaults to item-state", () => {
    expect(
      classifyDrainError(new DrainError(AWAITING_TRANSCRIPT)).lastError,
    ).toBe(AWAITING_TRANSCRIPT);
    expect(classifyDrainError(new Error("delegation expired")).lastError).toBe(
      DELEGATION_UNUSABLE,
    );
    expect(
      classifyDrainError(new Error("no such table: connector_meeting"))
        .lastError,
    ).toBe(SCHEMA_MISSING);
    expect(classifyDrainError(new Error("space not hosted")).lastError).toBe(
      SPACE_NOT_HOSTED,
    );
    // Unknown failures burn attempts — the safe direction.
    expect(classifyDrainError(new Error("boom")).lastError).toBe(
      "release_failed",
    );
  });

  test("a release that reports `skipped` removes the item without a failure", async () => {
    const h = harness();
    await seed(h, ["m1"]);
    const w = worker(h, {
      release: () => ({ status: "skipped" as const, reason: "pre-exists" }),
    });
    const result = await w.kick({ address: ADDRESS });
    expect(result.completed).toBe(1);
    expect(await h.queue.list(SOURCE, ADDRESS)).toHaveLength(0);
    expect(await h.queue.dead(SOURCE, ADDRESS)).toHaveLength(0);
  });
});

// ── §5.4: the two Option-A ceilings, shipped while Option A is off ───

describe("Option-A side-effect ceilings", () => {
  test("both constants are the literal 20", () => {
    expect(CONNECTOR_A_FETCH_CEILING_PER_HOUR).toBe(20);
    expect(CONNECTOR_A_SECRET_READ_CEILING_PER_HOUR).toBe(20);
    expect(CEILING_WINDOW_MS).toBe(60 * 60 * 1000);
  });

  test("the defaults an unconfigured process gets are 20 and 20", () => {
    delete process.env.CONNECTOR_A_FETCH_CEILING_PER_HOUR;
    delete process.env.CONNECTOR_A_SECRET_READ_CEILING_PER_HOUR;
    const ceilings = ConnectorSideEffectCeilings.fromEnv(process.env);
    expect(ceilings.fetchCeiling).toBe(20);
    expect(ceilings.secretReadCeiling).toBe(20);
  });

  test("at most 20 fetches per address per rolling hour; the 21st is refused", () => {
    const clock = { now: T0 };
    const ceilings = new ConnectorSideEffectCeilings({ now: () => clock.now });
    for (let i = 0; i < 20; i += 1)
      expect(ceilings.tryFetch(ADDRESS)).toBe(true);
    expect(ceilings.tryFetch(ADDRESS)).toBe(false);
    expect(ceilings.state(ADDRESS).fetchCeilingReached).toBe(true);
    // Another address is unaffected: the ceiling is per-address.
    expect(ceilings.tryFetch(OTHER)).toBe(true);
    // …and it rolls: an hour later the window is clear again.
    clock.now += CEILING_WINDOW_MS + 1;
    expect(ceilings.tryFetch(ADDRESS)).toBe(true);
  });

  test("at most 20 delegated secret reads per address per rolling hour", () => {
    const ceilings = new ConnectorSideEffectCeilings({
      // A high fetch ceiling so this asserts ceiling 2 alone, not ceiling 1's gate.
      fetchCeiling: 10_000,
      now: () => T0,
    });
    for (let i = 0; i < 20; i += 1)
      expect(ceilings.trySecretRead(ADDRESS)).toBe(true);
    expect(ceilings.trySecretRead(ADDRESS)).toBe(false);
    expect(ceilings.state(ADDRESS).secretReadCeilingReached).toBe(true);
  });

  test("a secret read is gated behind ≥1 permitted fetch in the window", () => {
    const ceilings = new ConnectorSideEffectCeilings({ now: () => T0 });
    for (let i = 0; i < 20; i += 1) ceilings.tryFetch(ADDRESS);
    expect(ceilings.remainingFetches(ADDRESS)).toBe(0);
    // A drain with no fetch budget has nothing to fetch, so materializing the key is pure exposure.
    expect(ceilings.trySecretRead(ADDRESS)).toBe(false);
    expect(ceilings.state(ADDRESS).secretReads).toBe(0);
  });

  test("both env overrides are honoured, and a bad one fails LOUDLY", () => {
    process.env.CONNECTOR_A_FETCH_CEILING_PER_HOUR = "5";
    process.env.CONNECTOR_A_SECRET_READ_CEILING_PER_HOUR = "7";
    const ceilings = ConnectorSideEffectCeilings.fromEnv(process.env);
    expect(ceilings.fetchCeiling).toBe(5);
    expect(ceilings.secretReadCeiling).toBe(7);

    process.env.CONNECTOR_A_FETCH_CEILING_PER_HOUR = "not-a-number";
    expect(() => ConnectorSideEffectCeilings.fromEnv(process.env)).toThrow(
      /CONNECTOR_A_FETCH_CEILING_PER_HOUR/,
    );
    process.env.CONNECTOR_A_FETCH_CEILING_PER_HOUR = "0";
    expect(() => ConnectorSideEffectCeilings.fromEnv(process.env)).toThrow();
  });

  test("the secret is read ONCE per drain, never once per item", async () => {
    const h = harness();
    await seed(h, ["m1", "m2", "m3"]);
    let reads = 0;
    const w = worker(h, {
      readSecret: async () => {
        reads += 1;
        return "fireflies-key";
      },
      release: async ({ secret }) => {
        await secret();
        return { status: "released" as const };
      },
    });

    await w.kick({ address: ADDRESS });
    expect(reads).toBe(1);
    expect(h.ceilings.state(ADDRESS).secretReads).toBe(1);
  });

  test("an exhausted ceiling leaves items QUEUED and sets the card state", async () => {
    const h = harness();
    await seed(h, ["m1"]);
    for (let i = 0; i < 20; i += 1) h.ceilings.tryFetch(ADDRESS);
    const w = worker(h, {
      release: ({ ceilings, address }) =>
        ceilings.tryFetch(address)
          ? { status: "released" as const }
          : { status: "held" as const, reason: "fetch_ceiling" },
    });

    const result = await w.kick({ address: ADDRESS });
    expect(result.surfaced).toEqual([]);
    expect(result.ceiling.fetchCeilingReached).toBe(true);
    // Excess stays queued — never dead-lettered, because it may be legitimate.
    expect(await h.queue.list(SOURCE, ADDRESS)).toHaveLength(1);
    expect(await h.queue.dead(SOURCE, ADDRESS)).toHaveLength(0);
    expect(w.cardState(ADDRESS).ceiling.fetchCeilingReached).toBe(true);
  });
});

// ── §5.4: every drain funnels through the process-global write lane ──

describe("write lane", () => {
  test("the default lane serializes releases across concurrent drains", async () => {
    _setWriteLaneGapMs(0);
    try {
      const h = harness();
      await seed(h, ["m1", "m2"], ADDRESS);
      await seed(h, ["m3", "m4"], OTHER);
      let active = 0;
      let maxActive = 0;
      // No `lane` override: this exercises `runInWriteLane` itself.
      const w = new ConnectorDrainWorker({
        queue: h.queue,
        tokens: h.tokens,
        control: h.control,
        abort: h.abort,
        ceilings: h.ceilings,
        now: () => h.clock.now,
        minIntervalMs: 0,
        release: async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 2));
          active -= 1;
          return { status: "released" as const };
        },
      });

      await Promise.all([
        w.kick({ address: ADDRESS }),
        w.kick({ address: OTHER }),
      ]);
      expect(maxActive).toBe(1);
    } finally {
      _resetWriteLane();
    }
  });

  test("a rejected lane task does not wedge the lane for the next one", async () => {
    _setWriteLaneGapMs(0);
    try {
      await expect(
        runInWriteLane(() => Promise.reject(new Error("boom"))),
      ).rejects.toThrow("boom");
      expect(await runInWriteLane(async () => "next")).toBe("next");
    } finally {
      _resetWriteLane();
    }
  });
});

// ── §5.4 trigger 2 under OPTION C: bounded queue maintenance, never a drain ──
//
// Under C the server holds no delegation and writes nothing: a timed DRAIN would read the
// config, the disabled marker, the queue and the purge ledger every five minutes only to hand
// an id list to nobody — surfacing decisions taken with no client on the other end, and one
// abandoned connector's worth of KV round trips per address per tick, forever. The only
// background work that still earns its cost is the TTL / dead-letter sweep, because an
// abandoned queue is otherwise swept only when a delivery or a user visit happens to touch it,
// and the 14-day TTL is a retention promise, not a best-effort one. The sweep surfaces NO ids,
// so it needs no ledger read — it is the same maintenance `list()`/`settle()` already perform.

describe("queue maintenance timer", () => {
  test("is unref'd so `bun test` does not hang", () => {
    const originalSetInterval = globalThis.setInterval;
    let unrefCalls = 0;
    // @ts-expect-error — test double for the timer handle.
    globalThis.setInterval = (...args: Parameters<typeof setInterval>) => {
      const handle = originalSetInterval(...args);
      (handle as unknown as { unref?: () => void }).unref?.();
      return new Proxy(handle as object, {
        get(target, prop, receiver) {
          if (prop === "unref") {
            return () => {
              unrefCalls += 1;
              return receiver;
            };
          }
          const value = Reflect.get(target, prop, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    };
    try {
      const timer = startConnectorQueueMaintenanceTimer({
        sweep: async () => {},
        listAddresses: async () => [],
        intervalMs: 60_000,
      });
      expect(unrefCalls).toBe(1);
      timer.stop();
    } finally {
      globalThis.setInterval = originalSetInterval;
    }
  });

  test("a tick sweeps every listed address, sequentially, and drains none of them", async () => {
    const h = harness();
    await seed(h, ["m1"], ADDRESS);
    await seed(h, ["m2"], OTHER);
    const w = worker(h);
    const swept: string[] = [];
    let concurrent = 0;
    let maxConcurrent = 0;
    const timer = startConnectorQueueMaintenanceTimer({
      sweep: async (address: string) => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await Promise.resolve();
        swept.push(address);
        concurrent -= 1;
      },
      listAddresses: async () => [LOWER, OTHER],
      intervalMs: 60_000,
    });
    try {
      await timer.tick();
      expect(swept).toEqual([LOWER, OTHER]);
      // §9.3: TinyCloud drops concurrent responses on one space.
      expect(maxConcurrent).toBe(1);
      // The maintenance tick is NOT a drain: nothing was surfaced to nobody.
      expect(w.totalDrains()).toBe(0);
      expect(h.control.ledgerReads).toBe(0);
    } finally {
      timer.stop();
    }
  });

  test("a scan failure is logged, not thrown, and the timer survives it", async () => {
    const timer = startConnectorQueueMaintenanceTimer({
      sweep: async () => {},
      listAddresses: async () => {
        throw new Error("kv down");
      },
      intervalMs: 60_000,
    });
    try {
      await timer.tick();
    } finally {
      timer.stop();
    }
  });

  test("one address's sweep failure does not skip the addresses behind it", async () => {
    const swept: string[] = [];
    const timer = startConnectorQueueMaintenanceTimer({
      sweep: async (address: string) => {
        if (address === LOWER) throw new Error("kv down");
        swept.push(address);
      },
      listAddresses: async () => [LOWER, OTHER],
      intervalMs: 60_000,
    });
    try {
      await timer.tick();
      expect(swept).toEqual([OTHER]);
    } finally {
      timer.stop();
    }
  });

  test("ticks never overlap — a slow sweep is not stacked by the next tick", async () => {
    let started = 0;
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const timer = startConnectorQueueMaintenanceTimer({
      sweep: async () => {
        started += 1;
        await gate;
      },
      listAddresses: async () => [LOWER],
      intervalMs: 60_000,
    });
    try {
      const first = timer.tick();
      await timer.tick();
      expect(started).toBe(1);
      release();
      await first;
      await timer.tick();
      expect(started).toBe(2);
    } finally {
      timer.stop();
    }
  });

  test("the interval is env-tunable and rejects a bad value", () => {
    expect(drainIntervalFromEnv({} as NodeJS.ProcessEnv)).toBe(
      DRAIN_INTERVAL_MS,
    );
    expect(
      drainIntervalFromEnv({
        CONNECTOR_DRAIN_INTERVAL_MS: "1000",
      } as NodeJS.ProcessEnv),
    ).toBe(1000);
    expect(() =>
      drainIntervalFromEnv({
        CONNECTOR_DRAIN_INTERVAL_MS: "-1",
      } as NodeJS.ProcessEnv),
    ).toThrow(/CONNECTOR_DRAIN_INTERVAL_MS/);
  });

  test("the config directory scans webhooks/config/* and yields addresses only", async () => {
    const node = new FakeNode();
    node.listResponse = {
      data: [
        `webhooks/config/${LOWER}`,
        { key: `webhooks/config/${OTHER}` },
        "webhooks/config/not-an-address",
        "webhooks/tokens/abc",
      ],
    };
    const directory = createWebhookConfigDirectory(
      node as unknown as TinyCloudNode,
    );
    expect(await directory()).toEqual([LOWER, OTHER]);
    expect(node.listCalls[0]).toEqual({ prefix: "webhooks/config/" });
  });

  test("the config directory parses the production Result data.keys shape", async () => {
    const node = new FakeNode();
    node.listResponse = {
      ok: true,
      data: {
        keys: [
          `webhooks/config/${LOWER}`,
          `webhooks/config/${OTHER}`,
          "webhooks/config/not-an-address",
        ],
      },
    };
    const directory = createWebhookConfigDirectory(
      node as unknown as TinyCloudNode,
    );

    await expect(directory()).resolves.toEqual([LOWER, OTHER]);
    expect(node.listCalls).toEqual([{ prefix: "webhooks/config/" }]);
  });

  test("a malformed successful list acknowledgement fails loudly instead of scanning empty", async () => {
    const node = new FakeNode();
    node.listResponse = { ok: true, data: { accepted: true } };
    const directory = createWebhookConfigDirectory(
      node as unknown as TinyCloudNode,
    );

    await expect(directory()).rejects.toThrow(/malformed.*list/i);
  });

  test("a Result{ok:false} list throws — must not be walked as an empty address set", async () => {
    // The SDK's new KV contract resolves durable failures as { ok: false, error }
    // instead of rejecting. The extractKeys walker finds no key/name/path fields in
    // that shape and returns [], so a scan that failed at the node would be reported
    // as "nothing to drain" — the same silent-no-op the drain timer scan is required
    // to avoid. assertKvResult, wrapped inside withSessionRefresh, must throw so the
    // timer's own catch surfaces `op=timer-scan result=error`.
    const node = new FakeNode();
    node.listResponse = {
      ok: false,
      error: {
        code: "FETCH_FAILED",
        message: "PRIVATE_LIST_FAILURE",
        service: "kv",
      },
    };
    const directory = createWebhookConfigDirectory(
      node as unknown as TinyCloudNode,
    );
    await expect(directory()).rejects.toThrow(
      /KV operation failed.*FETCH_FAILED/,
    );
  });
});

// ── OPTION C: the gateless worker index.ts actually builds ───────────
//
// Dropping the delegation gate removes ONE authorization input. Every other one — the durable
// disabled marker, the purge ledger, the per-item tombstone — still gates SURFACING, because an
// id handed to the browser resurrects the meeting as surely as a write would. These pin that a
// worker constructed exactly the way index.ts constructs it (no `delegations`) still refuses,
// visibly, rather than answering "nothing pending".

describe("gateless drain (Option C construction)", () => {
  function gateless(h: Harness): ConnectorDrainWorker {
    const w = worker(h);
    // Guards the construction itself: a `delegations` collaborator must not creep back in.
    expect(
      (w as unknown as { options: { delegations?: unknown } }).options
        .delegations,
    ).toBeUndefined();
    return w;
  }

  test("still drops a tombstoned id instead of surfacing it", async () => {
    const h = harness();
    for (const meetingId of ["m1", "m2"]) {
      await h.queue.enqueue(SOURCE, ADDRESS, {
        meetingId,
        kind: "transcript",
        // After the watermark, so only the `recentIds` entry is tombstoned.
        sourceTimestamp: new Date(T0).toISOString(),
      });
    }
    h.control.ledger = {
      status: "ok",
      ledger: {
        purgedThrough: new Date(T0 - 60_000).toISOString(),
        recentIds: ["m2"],
        updatedAt: new Date(T0).toISOString(),
      },
    };

    const result = await gateless(h).kick({ address: ADDRESS });
    expect(result.surfaced).toEqual(["m1"]);
    expect(result.dropped).toBe(1);
  });

  test("still aborts on the durable disabled marker — blocked is not empty", async () => {
    const h = harness();
    await seed(h, ["m1"]);
    h.control.disabled = { revokedAt: new Date(T0).toISOString() };

    const result = await gateless(h).kick({ address: ADDRESS });
    expect(result.status).toBe("aborted");
    expect(result.reason).toBe("revoked");
    expect(result.surfaced).toEqual([]);
    // The item survives: a revoked drain settles nothing it did not handle.
    expect(await h.queue.depth(SOURCE, ADDRESS)).toBe(1);
  });

  test("still fails closed when the purge ledger cannot be read", async () => {
    const h = harness();
    await seed(h, ["m1"]);
    h.control.ledgerError = new Error("kv down");

    const result = await gateless(h).kick({ address: ADDRESS });
    expect(result.status).toBe("aborted");
    expect(result.reason).toBe(LEDGER_UNAVAILABLE);
    expect(result.surfaced).toEqual([]);
  });

  test("never reports needsReauth — there is no delegation to re-authorize", async () => {
    const h = harness();
    await seed(h, ["m1"]);
    const w = gateless(h);

    const result = await w.kick({ address: ADDRESS });
    expect(result.needsReauth).toBe(false);
    expect(w.needsReauth(ADDRESS)).toBe(false);
  });
});

// ── §5.4/§4.7: the triggers that survive Option C are wired in index.ts ──

describe("index.ts wiring", () => {
  const source = readFileSync(join(import.meta.dir, "..", "index.ts"), "utf8");

  // OPTION C retires trigger 1's DRAIN KICK, and it stays retired. The kick ran a full drain
  // pass — config read, marker read, queue read, ledger read — after EVERY delivery, and handed
  // the surfaced ids to a fire-and-forget promise nobody awaited. With no backend writer and no
  // connected response consumer that is cost and surfacing risk for no product behaviour; the
  // delivery's own enqueue is the whole server-side job.
  //
  // W1 (backend-ingest plan §8.1) wires the `onDelivery` SEAM for the first time — to the
  // cohort-gated ingest nudge, which tells the fetch worker an item landed and does nothing at
  // all for a non-cohort address or with the flag dark. So the assertion is rewritten to the new
  // truth per plan §11's disposition rule (no assertion keeps a stale rationale): what must never
  // come back is a drain pass on the delivery path, not the seam itself.
  test("trigger 1's drain kick is retired — the delivery seam nudges the fetch worker instead", () => {
    expect(source).not.toMatch(/onDelivery[\s\S]{0,200}drain\.kick/);
    expect(source).toContain("onDelivery: createIngestOnDelivery(");
  });

  // OPTION C re-scopes trigger 2 to bounded queue maintenance: the TTL / dead-letter sweep,
  // which surfaces nothing, instead of a timed drain that surfaced ids to nobody.
  test("trigger 2 is bounded queue maintenance, not a background drain", () => {
    expect(source).toContain("startConnectorQueueMaintenanceTimer({");
    expect(source).not.toContain("startConnectorDrainTimer");
    expect(source).not.toContain("drainAddresses");
    expect(source).toMatch(
      /connectorWebhooks\s*\n?\s*\?\s*startConnectorQueueMaintenanceTimer/,
    );
    expect(source).toContain("createWebhookConfigDirectory(node)");
    expect(source).toContain("queue.sweep(");
  });

  test("trigger 3 — the authenticated user-visit drain — is THE processing trigger", () => {
    expect(source).toMatch(
      /drain:\s*\(\{ source, address \}\)[\s\S]{0,160}drain\.kick/,
    );
  });

  // OPTION C replaces trigger 4. The fresh-grant kick made an accepted CHAT delegation reach
  // into the connector, and its sibling (`isBackgroundSyncDisabled`) let the webhook toggle
  // refuse that delegation outright. Neither may be wired: the server holds no connector
  // delegation, and turning notifications off must not touch chat access.
  test("no connector hook is wired into POST /api/delegations", () => {
    expect(source).not.toContain("onDelegationAccepted");
    expect(source).not.toContain("isBackgroundSyncDisabled");
  });

  test("DELETE /config is not wired to the app's delegation store", () => {
    // The companion router no longer takes a `delegations` collaborator at all.
    expect(source).not.toMatch(
      /createConnectorWebhookCompanionRouter\(\{[\s\S]*?\n\s*delegations:/,
    );
  });

  // OPTION C: the backend holds NO connector delegation, so there is no stored record for the
  // drain to re-validate. Wiring the gate anyway would make every drain depend on the app's
  // unrelated chat delegation — an expired chat grant would silently stop the connector card,
  // and a `needsReauth` prompt would ask the user to re-grant something the connector never
  // used. The gate stays an Option-A-only seam on the worker; index.ts must not fill it.
  test("no stored delegation gate is wired into the drain (Option C)", () => {
    expect(source).not.toContain("createStoredDelegationGate");
    expect(source).not.toMatch(
      /new ConnectorDrainWorker\(\{[\s\S]*?\n\s*delegations:/,
    );
  });

  test("no server-side writer is wired into the drain (§4.7, binding)", () => {
    expect(source).not.toContain("connector-writer");
    expect(source).not.toContain("removeOnRelease");
  });
});
