import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  IngestInstanceGuard,
  IngestInstanceSupervisor,
  INGEST_INSTANCE_ID_ENV,
  INGEST_INSTANCE_LEASE_KEY,
  INSTANCE_HEARTBEAT_MS,
  INSTANCE_LEASE_TTL_MS,
  parseInstanceLease,
  resolveInstanceId,
  type InstanceLeaseRecord,
  type InstanceLeaseStore,
} from "../services/ingest-instance.js";
import {
  ConnectorFetchWorker,
  _resetFetchWorkerSingleton,
} from "../services/fetch-worker.js";
import {
  _resetFetchWorkerNudge,
  ingestNudgeStats,
} from "../services/ingest-nudge.js";

/**
 * W9 — §8.2 **delta item 11, distributed serialization** (backend-ingest plan §8.1 W9; D4 =
 * `single-instance`).
 *
 * D4 chose the bounded first cut: ONE backend instance consumes the cohort's delivery queues.
 * The plan's acceptance test for that choice is *"startup guard test (second instance with same
 * config refuses or is provably inert) + documented constraint"* — so this file proves both
 * halves, at both boundaries:
 *
 *  - **In-process** (already enforced by W3's worker seat): a second `ConnectorFetchWorker`
 *    refuses to start.
 *  - **Cross-process** (this task): a second *process* — a second CVM, a rolling deploy that
 *    overlaps, a stray `bun run` against the same backend space — takes a durable lease before it
 *    consumes anything, and stays provably inert when the lease is held elsewhere.
 *
 * And the constraint itself is written down, because "single instance" that lives only in a
 * comment is a constraint the next operator scales straight through.
 */

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const CONSTRAINT_DOC = resolve(
  REPO_ROOT,
  "docs/connector-webhooks-single-instance.md",
);

// ── A shared substrate two "processes" both see ──────────────────────

class FakeLeaseStore implements InstanceLeaseStore {
  value: unknown = null;
  reads = 0;
  writes = 0;
  failRead = false;
  failWrite = false;
  /** Simulates the OTHER process winning the write-then-verify race. */
  onWrite: ((record: InstanceLeaseRecord) => void) | null = null;

  async read(): Promise<unknown> {
    this.reads += 1;
    if (this.failRead) throw new Error("lease read refused");
    return this.value;
  }

  async write(record: InstanceLeaseRecord): Promise<void> {
    this.writes += 1;
    if (this.failWrite) throw new Error("lease write refused");
    this.value = { ...record };
    this.onWrite?.(record);
  }

  async clear(): Promise<void> {
    this.value = null;
  }
}

/** The `{start,stop,isRunning}` slice the supervisor drives. */
function fakeWorker() {
  let running = false;
  return {
    starts: 0,
    stops: 0,
    start(): void {
      running = true;
      (this as { starts: number }).starts += 1;
    },
    stop(): void {
      running = false;
      (this as { stops: number }).stops += 1;
    },
    isRunning: () => running,
  };
}

/** A clock the tests advance by hand — no lease test may wait out a 90 s TTL. */
function clock(start = 1_800_000_000_000) {
  let t = start;
  return {
    now: () => t,
    advance(ms: number) {
      t += ms;
    },
  };
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  _resetFetchWorkerSingleton();
  _resetFetchWorkerNudge();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  _resetFetchWorkerSingleton();
  _resetFetchWorkerNudge();
});

// ── The cross-process seat ───────────────────────────────────────────

describe("W9 — D4 single-instance serialization guard", () => {
  test("[delta-11] a second instance with the same config is REFUSED the seat and stays provably inert", async () => {
    const store = new FakeLeaseStore();
    const time = clock();
    const first = new IngestInstanceSupervisor({
      guard: new IngestInstanceGuard(store, {
        instanceId: "instance-a",
        now: time.now,
      }),
      worker: fakeWorker(),
      now: time.now,
    });
    const second = new IngestInstanceSupervisor({
      guard: new IngestInstanceGuard(store, {
        instanceId: "instance-b",
        now: time.now,
      }),
      worker: fakeWorker(),
      now: time.now,
    });

    expect(await first.tick()).toBe("holder");
    expect(first.worker.isRunning()).toBe(true);

    // Same substrate, same config, a heartbeat ago: the second instance must not become a
    // second consumer of the same queues.
    time.advance(INSTANCE_HEARTBEAT_MS);
    expect(await second.tick()).toBe("inert");

    // "Provably inert" is the assertion, not "refuses loudly": it started no worker, it never
    // claimed the seat, and — the property that actually matters — it consumed nothing.
    expect(second.worker.isRunning()).toBe(false);
    expect(second.worker.starts).toBe(0);
    expect(second.guard.isHolder()).toBe(false);
    expect(parseInstanceLease(store.value)?.instanceId).toBe("instance-a");
  });

  test("[delta-11] an unreadable or unparseable lease FAILS CLOSED — the seat is refused, never assumed free", async () => {
    const time = clock();
    const unreadable = new FakeLeaseStore();
    unreadable.failRead = true;
    const onUnreadable = new IngestInstanceSupervisor({
      guard: new IngestInstanceGuard(unreadable, {
        instanceId: "instance-a",
        now: time.now,
      }),
      worker: fakeWorker(),
      now: time.now,
    });

    // A read that failed says NOTHING about who holds the seat. Reading it as "empty" is exactly
    // how a second consumer starts silently.
    expect(await onUnreadable.tick()).toBe("inert");
    expect(onUnreadable.worker.isRunning()).toBe(false);
    expect(unreadable.writes).toBe(0);

    const garbage = new FakeLeaseStore();
    garbage.value = { instanceId: 42, heartbeatAt: "yesterday" };
    const onGarbage = new IngestInstanceSupervisor({
      guard: new IngestInstanceGuard(garbage, {
        instanceId: "instance-a",
        now: time.now,
      }),
      worker: fakeWorker(),
      now: time.now,
    });

    expect(await onGarbage.tick()).toBe("inert");
    expect(onGarbage.worker.isRunning()).toBe(false);
    expect(garbage.writes).toBe(0);
  });

  test("[delta-11] the in-process seat is the second boundary: a second worker in ONE process refuses too", () => {
    const deps = {
      queue: { due: async () => [], settle: async () => ({ status: "done" }) },
      modes: {
        cohort: async () => new Set<string>(),
        mode: async () => "backend" as const,
      },
      credentials: { getCredential: async () => null },
      fetcher: {
        fetchMeeting: async () => ({
          ok: false as const,
          error: { code: "upstream_error" },
        }),
      },
      content: { upsert: async () => ({ ok: false as const, code: "unused" }) },
    } as unknown as ConstructorParameters<typeof ConnectorFetchWorker>[0];

    const first = new ConnectorFetchWorker(deps);
    const second = new ConnectorFetchWorker(deps);
    first.start();
    try {
      expect(() => second.start()).toThrow(/single instance/i);
      expect(second.isRunning()).toBe(false);
      // One registration, so one nudge target — the seam cannot fan a delivery to two consumers.
      expect(ingestNudgeStats().noWorker).toBe(0);
    } finally {
      first.stop();
      second.stop();
    }
  });

  test("[delta-11] the single-instance constraint is DOCUMENTED, not merely coded", () => {
    const doc = readFileSync(CONSTRAINT_DOC, "utf8");

    // The decision, its owner and its blast radius — the three things an operator scaling the
    // service to two replicas needs to find BEFORE they do it.
    expect(doc).toContain("D4");
    expect(doc).toMatch(/single[- ]instance/i);
    expect(doc).toContain(INGEST_INSTANCE_LEASE_KEY);
    expect(doc).toContain(INGEST_INSTANCE_ID_ENV);
    // Honest about what the lease is NOT: TinyCloud KV has no compare-and-set, so this is a
    // detector, not a distributed mutex. A doc that claimed otherwise would be worse than none.
    expect(doc).toMatch(/compare-and-set|CAS/i);
    // And the exit: what has to change to lift the constraint (D4 = multi-instance).
    expect(doc).toMatch(/multi-instance/i);
  });
});

// ── Lease mechanics ──────────────────────────────────────────────────

describe("W9 — the ingest instance lease", () => {
  test("an EXPIRED lease is taken over, so a redeploy is not a permanent outage", async () => {
    const store = new FakeLeaseStore();
    const time = clock();
    const survivor = new IngestInstanceSupervisor({
      guard: new IngestInstanceGuard(store, {
        instanceId: "instance-b",
        now: time.now,
      }),
      worker: fakeWorker(),
      now: time.now,
    });

    store.value = {
      instanceId: "instance-a",
      claimedAt: new Date(time.now()).toISOString(),
      heartbeatAt: new Date(time.now()).toISOString(),
    };

    expect(await survivor.tick()).toBe("inert");

    // The holder died without releasing (SIGKILL, a crashed CVM). Once its heartbeat is older
    // than the TTL the seat is free — otherwise a hard crash would take ingest down until an
    // operator noticed.
    time.advance(INSTANCE_LEASE_TTL_MS + 1);
    expect(await survivor.tick()).toBe("holder");
    expect(survivor.worker.isRunning()).toBe(true);
    expect(parseInstanceLease(store.value)?.instanceId).toBe("instance-b");
  });

  test("the holder renews on every tick, so a live instance is never displaced", async () => {
    const store = new FakeLeaseStore();
    const time = clock();
    const holder = new IngestInstanceSupervisor({
      guard: new IngestInstanceGuard(store, {
        instanceId: "instance-a",
        now: time.now,
      }),
      worker: fakeWorker(),
      now: time.now,
    });
    const rival = new IngestInstanceSupervisor({
      guard: new IngestInstanceGuard(store, {
        instanceId: "instance-b",
        now: time.now,
      }),
      worker: fakeWorker(),
      now: time.now,
    });

    await holder.tick();
    for (let i = 0; i < 6; i += 1) {
      time.advance(INSTANCE_HEARTBEAT_MS);
      expect(await holder.tick()).toBe("holder");
      expect(await rival.tick()).toBe("inert");
    }
    // One start, not one per tick.
    expect(holder.worker.starts).toBe(1);
  });

  test("a holder that LOSES the lease stops its worker rather than running unseated", async () => {
    const store = new FakeLeaseStore();
    const time = clock();
    const holder = new IngestInstanceSupervisor({
      guard: new IngestInstanceGuard(store, {
        instanceId: "instance-a",
        now: time.now,
      }),
      worker: fakeWorker(),
      now: time.now,
    });

    await holder.tick();
    expect(holder.worker.isRunning()).toBe(true);

    // Someone else took the seat (an operator forced it, or our own write was lost).
    store.value = {
      instanceId: "instance-b",
      claimedAt: new Date(time.now()).toISOString(),
      heartbeatAt: new Date(time.now()).toISOString(),
    };

    expect(await holder.tick()).toBe("inert");
    expect(holder.worker.isRunning()).toBe(false);
    expect(holder.guard.isHolder()).toBe(false);
  });

  test("an unwritable lease refuses the seat; the write is never assumed to have landed", async () => {
    const store = new FakeLeaseStore();
    store.failWrite = true;
    const guard = new IngestInstanceGuard(store, { instanceId: "instance-a" });

    const claim = await guard.claim();

    expect(claim.status).toBe("refused");
    expect(guard.isHolder()).toBe(false);
  });

  test("write-then-verify: a lost race is detected rather than double-consumed", async () => {
    const store = new FakeLeaseStore();
    const guard = new IngestInstanceGuard(store, { instanceId: "instance-a" });
    // The other instance's write lands between ours and our confirming read — the exact window
    // a CAS-less substrate leaves open.
    store.onWrite = () => {
      store.value = {
        instanceId: "instance-b",
        claimedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
      };
    };

    const claim = await guard.claim();

    expect(claim.status).toBe("refused");
    expect(guard.isHolder()).toBe(false);
  });

  test("release frees the seat for the next instance, and only ever deletes OUR lease", async () => {
    const store = new FakeLeaseStore();
    const time = clock();
    const first = new IngestInstanceGuard(store, {
      instanceId: "instance-a",
      now: time.now,
    });
    expect((await first.claim()).status).toBe("held");

    await first.release();
    expect(first.isHolder()).toBe(false);
    expect(store.value).toBeNull();

    const second = new IngestInstanceGuard(store, {
      instanceId: "instance-b",
      now: time.now,
    });
    expect((await second.claim()).status).toBe("held");

    // A stale instance's release must not evict the live holder.
    await first.release();
    expect(parseInstanceLease(store.value)?.instanceId).toBe("instance-b");
  });

  test("the instance id is per-process and unguessable by default, and pinnable for a rolling redeploy", () => {
    delete process.env[INGEST_INSTANCE_ID_ENV];
    const a = resolveInstanceId();
    const b = resolveInstanceId();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[a-f0-9]{16,}$/);

    // Pinned: a redeploy that keeps the id reclaims its OWN lease immediately instead of waiting
    // out the TTL (the same-id arm of `claim`).
    process.env[INGEST_INSTANCE_ID_ENV] = "prod-ingest-1";
    expect(resolveInstanceId()).toBe("prod-ingest-1");
    // Junk is refused rather than silently becoming a shared id every instance would answer to.
    process.env[INGEST_INSTANCE_ID_ENV] = "  ";
    expect(resolveInstanceId()).not.toBe("  ");
  });

  test("the same instance reclaims its own lease without waiting out the TTL", async () => {
    const store = new FakeLeaseStore();
    const time = clock();
    store.value = {
      instanceId: "prod-ingest-1",
      claimedAt: new Date(time.now()).toISOString(),
      heartbeatAt: new Date(time.now()).toISOString(),
    };
    const restarted = new IngestInstanceGuard(store, {
      instanceId: "prod-ingest-1",
      now: time.now,
    });

    expect((await restarted.claim()).status).toBe("held");
  });

  test("neither the lease record nor its log line carries an address, a meeting or a secret", async () => {
    const store = new FakeLeaseStore();
    const lines: string[] = [];
    const originalLog = console.log;
    const originalWarn = console.warn;
    console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
    console.warn = (...args: unknown[]) => lines.push(args.map(String).join(" "));
    try {
      const a = new IngestInstanceGuard(store, { instanceId: "instance-a" });
      await a.claim();
      const b = new IngestInstanceGuard(store, { instanceId: "instance-b" });
      await b.claim();
    } finally {
      console.log = originalLog;
      console.warn = originalWarn;
    }

    // The record is three fields: who, since when, alive when. Nothing tenant-shaped.
    expect(Object.keys(parseInstanceLease(store.value) ?? {}).sort()).toEqual([
      "claimedAt",
      "heartbeatAt",
      "instanceId",
    ]);
    for (const line of lines) {
      expect(line).not.toMatch(/0x[a-fA-F0-9]{40}/);
    }
    expect(lines.join("\n")).toMatch(/op=instance-lease/);
  });
});
