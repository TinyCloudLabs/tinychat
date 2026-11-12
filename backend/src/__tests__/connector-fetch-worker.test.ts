import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import { BackendStorageLane } from "../services/backend-storage-lane.js";
import {
  BACKOFF_BASE_MS,
  ConnectorQueue,
  MAX_ATTEMPTS,
  type PendingKind,
} from "../services/connector-queue.js";
import { KvContentBlobStore } from "../services/content-store.js";
import {
  CredentialStore,
  InMemoryCredentialRowStore,
  type CredentialSecret,
} from "../services/credential-store.js";
import { createRefreshingCredentialLookup } from "../services/fireflies-oauth.js";
import type { IngestMode } from "../services/ingest-mode.js";
import {
  _resetFetchWorkerNudge,
  ingestNudgeStats,
} from "../services/ingest-nudge.js";
import {
  ConnectorFetchWorker,
  _resetFetchWorkerSingleton,
  DEFAULT_UPSTREAM_CONCURRENCY,
  FETCH_SLA_MS,
  FETCH_TIMEOUT_MS,
  MIN_USER_SPACING_MS,
  UPSTREAM_CONCURRENCY_ENV,
  resolveUpstreamConcurrency,
  stripExpiringLinks,
  type ContentSink,
  type ContentUpsertInput,
  type ContentUpsertResult,
  type MeetingFetchRequest,
  type MeetingFetchResult,
  type MeetingFetcher,
  type WorkerCredentialLookup,
} from "../services/fetch-worker.js";
import { _resetWebhookTokenState } from "../services/webhook-tokens.js";

/**
 * W3 — the FETCH WORKER (backend-ingest plan §8.1 W3; §8.2 delta items 1, 2, 4, 5, 7, 8, 10;
 * §9 anti-patterns 1, 2, 4, 6).
 *
 * The worker is the cohort's sole queue consumer: it claims `pending` items, refetches the
 * meeting BY ID with that user's own credential, hands the content to the (W4) server store and
 * only then removes the item. Every test below is written against that one sentence, because
 * every way of getting it wrong is a way Listen got it wrong:
 *
 *  - a module-level "current user" (AP 1) — excluded by the interleaved A/B/A tests;
 *  - a fetch inside the delivery window (AP 2) — excluded structurally: nothing here runs before
 *    a 202, and W1's own suite pins the ack latency;
 *  - an unbounded consumer with no dedup/cap/DLQ (AP 4) — the shipped queue physics are REUSED,
 *    asserted here against a real `ConnectorQueue`, not a stub;
 *  - no backpressure on the shared upstream (AP 6) — per-user serial + ≥800 ms spacing + a global
 *    concurrency cap + 429/Retry-After gating.
 *
 * FAIL CLOSED is the load-bearing property (delta 10): a resolved `{ok:false}` from the content
 * store is a FAILURE. The item retries; it is never removed; "stored" is not a thing the worker
 * can believe without a `{ok:true}` in hand.
 */

const ORIGINAL_ENV = { ...process.env };

const SOURCE = "fireflies";
const ADDRESS_A = "0x7d033300000000000000000000000000000073f2";
const ADDRESS_B = "0xb1b1b10000000000000000000000000000001111";
const SALT = Buffer.from("worker-salt-worker-salt-worker12").toString("base64");
const T0 = Date.parse("2026-08-10T12:00:00.000Z");

const SECRET_A: CredentialSecret = {
  kind: "oauth",
  accessToken: "ff-access-token-AAAAAAAAAAAAAAAAAAAA",
  refreshToken: "ff-refresh-token-AAAAAAAAAAAAAAAAAA",
};
const SECRET_B: CredentialSecret = {
  kind: "oauth",
  accessToken: "ff-access-token-BBBBBBBBBBBBBBBBBBBB",
};

beforeEach(() => {
  _resetWebhookTokenState();
  _resetFetchWorkerNudge();
  _resetFetchWorkerSingleton();
  process.env.LOG_HASH_SALT = SALT;
  delete process.env[UPSTREAM_CONCURRENCY_ENV];
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  _resetWebhookTokenState();
  _resetFetchWorkerNudge();
  _resetFetchWorkerSingleton();
});

// ── Fakes ────────────────────────────────────────────────────────────
//
// The QUEUE is real. Delta items 4 and 5 are claims about the shipped retry physics, and a stub
// queue would let the worker assert them about itself.

class FakeNode {
  readonly store = new Map<string, unknown>();
  readonly calls: Array<{ op: string; key: string }> = [];
  maxConcurrent = 0;
  private inFlight = 0;
  overridePutResult: unknown | null = null;

  readonly kv = {
    get: async (key: string): Promise<unknown> => {
      await this.enter("get", key);
      try {
        if (!this.store.has(key)) return { data: null };
        return { data: { data: this.store.get(key) } };
      } finally {
        this.exit();
      }
    },
    put: async (key: string, value: unknown): Promise<unknown> => {
      await this.enter("put", key);
      try {
        if (this.overridePutResult !== null) return this.overridePutResult;
        this.store.set(key, JSON.parse(JSON.stringify(value)));
        return { data: true };
      } finally {
        this.exit();
      }
    },
    delete: async (key: string): Promise<unknown> => {
      await this.enter("delete", key);
      try {
        this.store.delete(key);
        return { data: true };
      } finally {
        this.exit();
      }
    },
  };

  async signIn(): Promise<void> {}

  private async enter(op: string, key: string): Promise<void> {
    this.calls.push({ op, key });
    this.inFlight += 1;
    if (this.inFlight > this.maxConcurrent) this.maxConcurrent = this.inFlight;
    await Promise.resolve();
  }

  private exit(): void {
    this.inFlight -= 1;
  }
}

function asNode(node: FakeNode): TinyCloudNode {
  return node as unknown as TinyCloudNode;
}

class FakeModes {
  constructor(private readonly addresses: string[]) {}
  failCohort = false;
  async cohort(): Promise<ReadonlySet<string>> {
    if (this.failCohort) throw new Error("cohort unreadable");
    return new Set(this.addresses.map((a) => a.toLowerCase()));
  }
  async mode(address: string): Promise<IngestMode> {
    return (await this.cohort()).has(address.toLowerCase())
      ? "backend"
      : "browser";
  }
}

class FakeCredentials {
  readonly reads: Array<{ address: string; purpose: string }> = [];
  readonly used: string[] = [];
  constructor(private readonly rows: Map<string, CredentialSecret>) {}
  async getCredential(
    _source: string,
    address: string,
    purpose: string,
  ): Promise<CredentialSecret | null> {
    this.reads.push({ address: address.toLowerCase(), purpose });
    return this.rows.get(address.toLowerCase()) ?? null;
  }
  async markUsed(_source: string, address: string): Promise<void> {
    this.used.push(address.toLowerCase());
  }
}

interface FetchCall {
  meetingId: string;
  kind: PendingKind;
  token: string;
}

class FakeFetcher implements MeetingFetcher {
  readonly calls: FetchCall[] = [];
  peakConcurrent = 0;
  private inFlight = 0;
  /** Per-meeting scripted behaviour; the default is a successful transcript. */
  behaviour = new Map<string, MeetingFetchResult | "hang" | "throw">();
  /** Real overlap so the concurrency cap is observable rather than theoretical. */
  latencyMs = 0;

  async fetchMeeting(request: MeetingFetchRequest): Promise<MeetingFetchResult> {
    const secret = request.secret;
    this.calls.push({
      meetingId: request.meetingId,
      kind: request.kind,
      token:
        secret.kind === "oauth" ? secret.accessToken : secret.apiKey,
    });
    this.inFlight += 1;
    if (this.inFlight > this.peakConcurrent) this.peakConcurrent = this.inFlight;
    try {
      if (this.latencyMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
      }
      const scripted = this.behaviour.get(request.meetingId);
      if (scripted === "hang") {
        // Never resolves on its own — only the worker's own timeout ends it.
        await new Promise<void>((resolve) => {
          request.signal.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
        throw new Error("aborted");
      }
      if (scripted === "throw") throw new Error("upstream exploded");
      if (scripted !== undefined) return scripted;
      return {
        ok: true,
        content: {
          sourceId: request.meetingId,
          title: `Meeting ${request.meetingId}`,
          ts: new Date(T0).toISOString(),
          payload: { id: request.meetingId, sentences: [{ text: "hello" }] },
        },
      };
    } finally {
      this.inFlight -= 1;
    }
  }
}

class FakeSink implements ContentSink {
  readonly writes: ContentUpsertInput[] = [];
  /**
   * When set, `upsert` resolves `override.value` verbatim — including shapes that are not a
   * Result at all. It is a BOX rather than a bare field so `null` and `undefined` are things the
   * store can answer, not "no override configured".
   */
  override: { value: unknown } | null = null;
  throwOn: string | null = null;

  async upsert(input: ContentUpsertInput): Promise<ContentUpsertResult> {
    if (this.throwOn !== null && input.sourceId === this.throwOn) {
      throw new Error("content store exploded");
    }
    if (this.override !== null) {
      this.writes.push(input);
      return this.override.value as ContentUpsertResult;
    }
    this.writes.push(input);
    return { ok: true, stored: "created" };
  }

  rowsFor(address: string): ContentUpsertInput[] {
    return this.writes.filter(
      (w) => w.address.toLowerCase() === address.toLowerCase(),
    );
  }
}

interface Harness {
  node: FakeNode;
  queue: ConnectorQueue;
  modes: FakeModes;
  credentials: FakeCredentials;
  fetcher: FakeFetcher;
  sink: FakeSink;
  worker: ConnectorFetchWorker;
  clock: () => number;
  advance: (ms: number) => void;
  sleeps: number[];
}

function harness(
  options: {
    addresses?: string[];
    concurrency?: number;
    spacingMs?: number;
    fetchTimeoutMs?: number;
    credentials?: Map<string, CredentialSecret>;
    /**
     * The REAL lookup the process wires (§6.2 "rotate"), instead of the fake map — this is how the
     * rotation-before-use tests exercise the seam `index.ts` actually hands the worker.
     */
    credentialLookup?: WorkerCredentialLookup;
    retention?: {
      tombstoned(input: {
        source: string;
        address: string;
        meetingId: string;
      }): Promise<boolean>;
    };
  } = {},
): Harness {
  let clock = T0;
  const now = () => clock;
  const sleeps: number[] = [];
  // A fake sleep ADVANCES the clock instead of burning wall time, so the ≥800 ms spacing and the
  // SLA are asserted exactly rather than approximately.
  const sleep = async (ms: number): Promise<void> => {
    sleeps.push(ms);
    clock += ms;
    await Promise.resolve();
  };

  const node = new FakeNode();
  const queue = new ConnectorQueue(asNode(node), {
    now,
    jitter: () => 0,
    flushWindowMs: 1,
  });
  const addresses = options.addresses ?? [ADDRESS_A, ADDRESS_B];
  const modes = new FakeModes(addresses);
  const credentials = new FakeCredentials(
    options.credentials ??
      new Map([
        [ADDRESS_A, SECRET_A],
        [ADDRESS_B, SECRET_B],
      ]),
  );
  const fetcher = new FakeFetcher();
  const sink = new FakeSink();
  const worker = new ConnectorFetchWorker(
    {
      queue,
      modes,
      credentials: options.credentialLookup ?? credentials,
      fetcher,
      content: sink,
      ...(options.retention ? { retention: options.retention } : {}),
    },
    {
      now,
      sleep,
      ...(options.concurrency !== undefined
        ? { concurrency: options.concurrency }
        : {}),
      ...(options.spacingMs !== undefined
        ? { spacingMs: options.spacingMs }
        : {}),
      ...(options.fetchTimeoutMs !== undefined
        ? { fetchTimeoutMs: options.fetchTimeoutMs }
        : {}),
    },
  );

  return {
    node,
    queue,
    modes,
    credentials,
    fetcher,
    sink,
    worker,
    clock: now,
    advance: (ms: number) => {
      clock += ms;
    },
    sleeps,
  };
}

async function enqueue(
  queue: ConnectorQueue,
  address: string,
  meetingId: string,
  kind: PendingKind = "transcript",
): Promise<void> {
  await queue.enqueue(SOURCE, address, { meetingId, kind });
}

function captureLogs(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  const record = (...args: unknown[]) => {
    lines.push(
      args.map((a) => (typeof a === "string" ? a : String(a))).join(" "),
    );
  };
  console.log = record;
  console.warn = record;
  return {
    lines,
    restore: () => {
      console.log = originalLog;
      console.warn = originalWarn;
    },
  };
}

const WORKER_SOURCE = readFileSync(
  join(import.meta.dir, "..", "services", "fetch-worker.ts"),
  "utf8",
);

// ── Delta 1 — per-delivery tenant resolution ─────────────────────────

describe("W3 fetch worker — tenant resolution (delta 1, AP 1)", () => {
  test("[delta-01] each item is fetched with ITS OWN user's credential and stored only under that address", async () => {
    const h = harness();
    await enqueue(h.queue, ADDRESS_A, "mtgA1");
    await enqueue(h.queue, ADDRESS_B, "mtgB1");
    await enqueue(h.queue, ADDRESS_A, "mtgA2");

    await h.worker.runOnce();

    const aRows = h.sink.rowsFor(ADDRESS_A);
    const bRows = h.sink.rowsFor(ADDRESS_B);
    expect(aRows.map((r) => r.sourceId).sort()).toEqual(["mtgA1", "mtgA2"]);
    expect(bRows.map((r) => r.sourceId)).toEqual(["mtgB1"]);

    // The credential used per meeting is the credential of the address that meeting was queued
    // under — a module-level "latest secret" cannot produce this mapping.
    const byMeeting = new Map(h.fetcher.calls.map((c) => [c.meetingId, c.token]));
    expect(byMeeting.get("mtgA1")).toBe(SECRET_A.accessToken);
    expect(byMeeting.get("mtgA2")).toBe(SECRET_A.accessToken);
    expect(byMeeting.get("mtgB1")).toBe(SECRET_B.accessToken);
  });

  test("[delta-01] a delivery for A leaves B's store completely empty", async () => {
    const h = harness();
    await enqueue(h.queue, ADDRESS_A, "onlyA");
    await h.worker.runOnce();

    expect(h.sink.rowsFor(ADDRESS_B)).toHaveLength(0);
    expect(h.credentials.reads.every((r) => r.address === ADDRESS_A)).toBe(true);
    expect(h.credentials.reads[0]?.purpose).toBe("fetch-worker");
  });

  test("[delta-01] an address outside the cohort is never claimed, even when nudged directly", async () => {
    const h = harness({ addresses: [ADDRESS_A] });
    await enqueue(h.queue, ADDRESS_B, "mtgB1");

    await h.worker.nudge({ source: SOURCE, address: ADDRESS_B });

    expect(h.fetcher.calls).toHaveLength(0);
    expect(h.sink.writes).toHaveLength(0);
    // Still queued: Option C's browser drain is the consumer for a non-cohort address.
    expect(await h.queue.depth(SOURCE, ADDRESS_B)).toBe(1);
  });

  test("[delta-01] review note: the worker holds no module-level current user, address or secret", () => {
    // The Listen failure is a module-scope mutable that the NEXT delivery reads. Every module
    // binding here is either a constant or a per-instance field.
    const moduleLets = WORKER_SOURCE.split("\n").filter((line) =>
      /^(let|var) /.test(line),
    );
    expect(moduleLets).toEqual([]);
    expect(WORKER_SOURCE).not.toMatch(/^const\s+current\w*\s*=/m);
  });
});

// ── Delta 2 — fair queue + shared upstream budget ────────────────────

describe("W3 fetch worker — fairness and the upstream budget (delta 2, AP 6)", () => {
  test("[delta-02] a 50-item burst for A does not starve B: B's 5 reach fetched well inside the SLA", async () => {
    const h = harness({ concurrency: 3 });
    for (let i = 0; i < 50; i += 1) {
      await enqueue(h.queue, ADDRESS_A, `mtgA${i}`);
    }
    for (let i = 0; i < 5; i += 1) {
      await enqueue(h.queue, ADDRESS_B, `mtgB${i}`);
    }

    await h.worker.runOnce();

    expect(h.sink.rowsFor(ADDRESS_B)).toHaveLength(5);
    expect(h.sink.rowsFor(ADDRESS_A)).toHaveLength(50);

    // Not starved: B's last fetch happens long before A's tail. A strictly per-address-serial
    // scheduler that ran A to completion first would put B's last call at index >= 50.
    const lastB = h.fetcher.calls
      .map((c, i) => ({ id: c.meetingId, i }))
      .filter((c) => c.id.startsWith("mtgB"))
      .at(-1)!.i;
    expect(lastB).toBeLessThan(20);

    // And the SLA the plan proposes (p95 webhook → fetched < 5 min) is not breached for B.
    const bLags = h.sink
      .rowsFor(ADDRESS_B)
      .map((r) => Date.parse(r.fetchedAt) - T0);
    for (const lag of bLags) expect(lag).toBeLessThan(FETCH_SLA_MS);
    expect(h.worker.stats().slaBreaches).toBe(0);
  });

  test("[delta-02] concurrent upstream calls never exceed the global cap, while storage stays sequential", async () => {
    const addresses = Array.from(
      { length: 6 },
      (_, i) => `0xcc${i.toString(16).padStart(38, "0")}`,
    );
    const h = harness({
      addresses,
      concurrency: 3,
      credentials: new Map(
        addresses.map((address) => [
          address,
          { kind: "oauth", accessToken: `ff-token-${address}` } as const,
        ]),
      ),
    });
    h.fetcher.latencyMs = 5;
    for (const address of addresses) {
      await enqueue(h.queue, address, `m${address.slice(-4)}a`);
      await enqueue(h.queue, address, `m${address.slice(-4)}b`);
    }

    await h.worker.runOnce();

    expect(h.fetcher.calls).toHaveLength(12);
    expect(h.fetcher.peakConcurrent).toBeLessThanOrEqual(3);
    // The cap is real parallelism, not an accident of a serial loop.
    expect(h.fetcher.peakConcurrent).toBeGreaterThan(1);
    expect(h.worker.stats().peakUpstreamConcurrency).toBeLessThanOrEqual(3);
    // §9.3: TinyCloud drops concurrent responses on one space. Parallel USER lanes must never
    // become parallel node calls.
    expect(h.node.maxConcurrent).toBe(1);
  });

  test("[delta-02] KV writes from the queue and content store share ONE lane against the backend node", async () => {
    // Code-audit regression: fetch-worker.ts once claimed every user-lane node call funnelled
    // through ConnectorQueue's per-instance lane, but KvContentBlobStore held its own private
    // lane. A queue settle for user A and a content upsert for user B could then hit the shared
    // backend space concurrently — TinyCloud drops the second response as a duplicate. The fix is
    // a BackendStorageLane injected into every component that writes to the backend node.
    const node = new FakeNode();
    const shared = new BackendStorageLane();
    const q = new ConnectorQueue(asNode(node), {
      jitter: () => 0,
      flushWindowMs: 1,
      storageLane: shared,
    });
    const contentBlob = new KvContentBlobStore(asNode(node), shared);

    // Interleave queue writes and content writes concurrently. Without the shared lane, the
    // FakeNode's maxConcurrent tracker would go above 1.
    await Promise.all([
      q.enqueue(SOURCE, ADDRESS_A, { meetingId: "mA1", kind: "transcript" }),
      contentBlob.writeIndex(SOURCE, ADDRESS_A, {
        ciphertext: "ct",
        wrappedDEK: "dek",
        updatedAt: new Date(T0).toISOString(),
      }),
      q.enqueue(SOURCE, ADDRESS_B, { meetingId: "mB1", kind: "transcript" }),
      contentBlob.writeIndex(SOURCE, ADDRESS_B, {
        ciphertext: "ct2",
        wrappedDEK: "dek2",
        updatedAt: new Date(T0).toISOString(),
      }),
      contentBlob.write(SOURCE, ADDRESS_A, "mA1", {
        ciphertext: "cta1",
        wrappedDEK: "deka1",
        updatedAt: new Date(T0).toISOString(),
      }),
    ]);

    // The audit-flagged race would show up as maxConcurrent >= 2 here.
    expect(node.maxConcurrent).toBe(1);
  });

  test("[delta-02] one user's fetches are serial and spaced by at least 800 ms", async () => {
    const h = harness({ concurrency: 3 });
    for (let i = 0; i < 4; i += 1) await enqueue(h.queue, ADDRESS_A, `mtgA${i}`);

    await h.worker.runOnce();

    // 4 items, 3 gaps, each at the configured spacing.
    const spacingSleeps = h.sleeps.filter((ms) => ms === MIN_USER_SPACING_MS);
    expect(spacingSleeps).toHaveLength(3);
    expect(MIN_USER_SPACING_MS).toBe(800);
    expect(h.fetcher.peakConcurrent).toBe(1);
  });

  test("[delta-02] the global cap defaults to 3 and is tunable by env, refusing junk", () => {
    expect(DEFAULT_UPSTREAM_CONCURRENCY).toBe(3);
    expect(resolveUpstreamConcurrency({})).toBe(3);
    expect(
      resolveUpstreamConcurrency({ [UPSTREAM_CONCURRENCY_ENV]: "8" }),
    ).toBe(8);
    expect(
      resolveUpstreamConcurrency({ [UPSTREAM_CONCURRENCY_ENV]: "0" }),
    ).toBe(3);
    expect(
      resolveUpstreamConcurrency({ [UPSTREAM_CONCURRENCY_ENV]: "banana" }),
    ).toBe(3);
  });
});

// ── Delta 4 — retry / backoff / poison / DLQ ─────────────────────────

describe("W3 fetch worker — retry physics (delta 4, AP 4)", () => {
  test("[delta-04] a 500-ing upstream retries on the shipped backoff and dead-letters at 5 attempts with a short code", async () => {
    const h = harness({ addresses: [ADDRESS_A] });
    h.fetcher.behaviour.set("mtgFail", {
      ok: false,
      error: { code: "upstream_error" },
    });
    await enqueue(h.queue, ADDRESS_A, "mtgFail");

    const schedule: number[] = [];
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      await h.worker.runOnce();
      const [item] = await h.queue.list(SOURCE, ADDRESS_A);
      if (item !== undefined) {
        schedule.push(Date.parse(item.nextAttemptAt) - h.clock());
        // Jump to the scheduled retry so the next pass finds the item due.
        h.advance(Date.parse(item.nextAttemptAt) - h.clock());
      }
    }

    // min(2^n · 60s, 6h) for n = 1..4, jitter pinned to 0 and bounded by 10% when it is not.
    expect(schedule).toEqual([
      2 * BACKOFF_BASE_MS,
      4 * BACKOFF_BASE_MS,
      8 * BACKOFF_BASE_MS,
      16 * BACKOFF_BASE_MS,
    ]);

    expect(await h.queue.depth(SOURCE, ADDRESS_A)).toBe(0);
    const dead = await h.queue.dead(SOURCE, ADDRESS_A);
    expect(dead).toHaveLength(1);
    expect(dead[0]!.meetingId).toBe("mtgFail");
    expect(dead[0]!.attempts).toBe(MAX_ATTEMPTS);
    expect(dead[0]!.lastError).toBe("upstream_error");
    // A short code, never a payload fragment.
    expect(dead[0]!.lastError!.length).toBeLessThanOrEqual(64);
    expect(h.sink.writes).toHaveLength(0);
    expect(h.worker.stats().deadLettered).toBe(1);
  });

  test("[delta-04] jitter stays additive and inside 10% of the delay", async () => {
    const h = harness({ addresses: [ADDRESS_A] });
    // A worker-level assertion on the SHIPPED schedule: the queue owns jitter, so the worker's
    // job is to not invent a second one. Replay the schedule with the real jitter source.
    const node = new FakeNode();
    const jittered = new ConnectorQueue(asNode(node), {
      now: () => T0,
      flushWindowMs: 1,
    });
    await jittered.enqueue(SOURCE, ADDRESS_A, {
      meetingId: "mtgJ",
      kind: "transcript",
    });
    await jittered.fail(SOURCE, ADDRESS_A, "mtgJ", "transcript", "upstream_error");
    const [item] = await jittered.list(SOURCE, ADDRESS_A);
    const delay = Date.parse(item!.nextAttemptAt) - T0;
    expect(delay).toBeGreaterThanOrEqual(2 * BACKOFF_BASE_MS);
    expect(delay).toBeLessThanOrEqual(2 * BACKOFF_BASE_MS * 1.1);
    expect(h.worker.stats().fetched).toBe(0);
  });

  test("[delta-04] poison content is quarantined terminally and the worker continues with the other items", async () => {
    const h = harness({ addresses: [ADDRESS_A] });
    h.fetcher.behaviour.set("mtgPoison", {
      ok: true,
      // The upstream answered, but not with the meeting we asked for.
      content: { sourceId: "someone-elses-id", payload: { nope: true } },
    });
    await enqueue(h.queue, ADDRESS_A, "mtgPoison");
    await enqueue(h.queue, ADDRESS_A, "mtgGood");

    await h.worker.runOnce();

    expect(h.sink.rowsFor(ADDRESS_A).map((r) => r.sourceId)).toEqual([
      "mtgGood",
    ]);
    const dead = await h.queue.dead(SOURCE, ADDRESS_A);
    expect(dead.map((d) => d.meetingId)).toEqual(["mtgPoison"]);
    // Terminal on the FIRST attempt — a fabricated id is not a transient failure.
    expect(dead[0]!.attempts).toBe(1);
    expect(dead[0]!.lastError).toBe("unparseable_content");
    expect(await h.queue.depth(SOURCE, ADDRESS_A)).toBe(0);
  });

  test("[delta-04] an upstream that throws is a failure, not a crash: the lane survives it", async () => {
    const h = harness({ addresses: [ADDRESS_A] });
    h.fetcher.behaviour.set("mtgBoom", "throw");
    await enqueue(h.queue, ADDRESS_A, "mtgBoom");
    await enqueue(h.queue, ADDRESS_A, "mtgOk");

    await h.worker.runOnce();

    expect(h.sink.rowsFor(ADDRESS_A).map((r) => r.sourceId)).toEqual(["mtgOk"]);
    const [remaining] = await h.queue.list(SOURCE, ADDRESS_A);
    expect(remaining?.meetingId).toBe("mtgBoom");
    expect(remaining?.attempts).toBe(1);
    // The provider's message never becomes the stored error code.
    expect(remaining?.lastError).toBe("fetch_failed");
  });

  test("[delta-04] a dead-lettered item's error code never carries payload or credential text", async () => {
    const capture = captureLogs();
    try {
      const h = harness({ addresses: [ADDRESS_A] });
      h.fetcher.behaviour.set("mtgSecret", {
        ok: false,
        error: { code: "boom: token ff-access-token-AAAAAAAAAAAAAAAAAAAA" },
      });
      await enqueue(h.queue, ADDRESS_A, "mtgSecret");
      await h.worker.runOnce();
      const [item] = await h.queue.list(SOURCE, ADDRESS_A);
      expect(item!.lastError).not.toContain("ff-access-token");
      expect(item!.lastError).not.toContain(" ");
    } finally {
      capture.restore();
    }
    for (const line of capture.lines) {
      expect(line).not.toContain(SECRET_A.accessToken);
      expect(line).not.toContain(ADDRESS_A);
    }
  });
});

// ── Delta 5 — idempotency / dedup ────────────────────────────────────

describe("W3 fetch worker — idempotency (delta 5)", () => {
  test("[delta-05] the same delivery twice is one upstream fetch and one store row", async () => {
    const h = harness({ addresses: [ADDRESS_A] });
    await enqueue(h.queue, ADDRESS_A, "mtgDup");
    await enqueue(h.queue, ADDRESS_A, "mtgDup");

    expect(await h.queue.depth(SOURCE, ADDRESS_A)).toBe(1);
    await h.worker.runOnce();

    expect(h.fetcher.calls).toHaveLength(1);
    expect(h.sink.writes).toHaveLength(1);
    expect(h.sink.writes[0]!.sourceId).toBe("mtgDup");
    expect(await h.queue.depth(SOURCE, ADDRESS_A)).toBe(0);
  });

  test("[delta-05] a nudge storm cannot double-claim an in-flight item", async () => {
    const h = harness({ addresses: [ADDRESS_A] });
    h.fetcher.latencyMs = 5;
    await enqueue(h.queue, ADDRESS_A, "mtgOnce");

    await Promise.all([
      h.worker.nudge({ source: SOURCE, address: ADDRESS_A }),
      h.worker.nudge({ source: SOURCE, address: ADDRESS_A }),
      h.worker.nudge({ source: SOURCE, address: ADDRESS_A }),
    ]);

    expect(h.fetcher.calls.filter((c) => c.meetingId === "mtgOnce")).toHaveLength(
      1,
    );
    expect(h.sink.writes).toHaveLength(1);
  });

  test("[delta-05] the content upsert is keyed (source, source_id) so a replay refreshes rather than duplicates", async () => {
    const h = harness({ addresses: [ADDRESS_A] });
    await enqueue(h.queue, ADDRESS_A, "mtgReplay");
    await h.worker.runOnce();
    expect(h.fetcher.calls).toHaveLength(1);

    // The provider replays the same delivery hours later; the item was already fetched and
    // removed, so this is a fresh enqueue → at most ONE further, rate-limited refetch.
    h.advance(6 * 60 * 60 * 1000);
    await enqueue(h.queue, ADDRESS_A, "mtgReplay");
    await h.worker.runOnce();
    await h.worker.runOnce();

    expect(h.fetcher.calls).toHaveLength(2);
    expect(h.sink.writes).toHaveLength(2);
    const keys = new Set(
      h.sink.writes.map((w) => `${w.source}:${w.sourceId}:${w.address}`),
    );
    expect(keys.size).toBe(1);
  });

  test("[delta-05] a retention-tombstoned id is never refetched and never re-stored", async () => {
    const tombstoned = new Set(["mtgSwept"]);
    const seen: string[] = [];
    const h = harness({
      addresses: [ADDRESS_A],
      retention: {
        tombstoned: async (input) => {
          seen.push(input.meetingId);
          return tombstoned.has(input.meetingId);
        },
      },
    });
    await enqueue(h.queue, ADDRESS_A, "mtgSwept");
    await enqueue(h.queue, ADDRESS_A, "mtgLive");

    await h.worker.runOnce();

    expect(h.fetcher.calls.map((c) => c.meetingId)).toEqual(["mtgLive"]);
    expect(h.sink.writes.map((w) => w.sourceId)).toEqual(["mtgLive"]);
    expect(seen).toContain("mtgSwept");
    // Tombstoned items leave the queue: a redelivery must not re-queue work forever.
    expect(await h.queue.depth(SOURCE, ADDRESS_A)).toBe(0);
    expect(h.worker.stats().tombstoned).toBe(1);
  });

  test("[delta-05] a retention check that FAILS holds the item instead of storing it", async () => {
    const h = harness({
      addresses: [ADDRESS_A],
      retention: {
        tombstoned: async () => {
          throw new Error("ledger unavailable");
        },
      },
    });
    await enqueue(h.queue, ADDRESS_A, "mtgHeld");

    await h.worker.runOnce();

    expect(h.fetcher.calls).toHaveLength(0);
    expect(h.sink.writes).toHaveLength(0);
    expect(await h.queue.depth(SOURCE, ADDRESS_A)).toBe(1);
  });
});

// ── Delta 7 — capture-before-ack, refetch by id, SLA ─────────────────

describe("W3 fetch worker — refetch by id and the SLA (delta 7, AP 2)", () => {
  test("[delta-07] the worker refetches BY ID and stores no URL or expiring link", async () => {
    const h = harness({ addresses: [ADDRESS_A] });
    h.fetcher.behaviour.set("mtgLink", {
      ok: true,
      content: {
        sourceId: "mtgLink",
        title: "Signed links everywhere",
        payload: {
          id: "mtgLink",
          audio_url:
            "https://cdn.fireflies.ai/audio/mtgLink.mp3?X-Amz-Expires=900&X-Amz-Signature=deadbeef",
          transcript_url: "https://app.fireflies.ai/view/mtgLink?token=abc",
          sentences: [{ text: "no link here" }],
        },
      },
    });
    await enqueue(h.queue, ADDRESS_A, "mtgLink");

    await h.worker.runOnce();

    const [row] = h.sink.rowsFor(ADDRESS_A);
    expect(row!.sourceId).toBe("mtgLink");
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain("http://");
    expect(serialized).not.toContain("https://");
    expect(serialized).not.toContain("X-Amz-Signature");
    expect(serialized).toContain("no link here");

    // The request carried an id, never a URL.
    expect(h.fetcher.calls[0]!.meetingId).toBe("mtgLink");
    // Substitution, not deletion: keys and array indices are preserved so the mutation is
    // observable, and prose that merely names "token=" is untouched.
    expect(stripExpiringLinks({ a: "https://x/y", b: { c: 1 } })).toEqual({
      a: "[link removed]",
      b: { c: 1 },
    });
    expect(
      stripExpiringLinks({ text: "Use the token=abc auth header." }),
    ).toEqual({ text: "Use the token=abc auth header." });
    expect(
      stripExpiringLinks(["https://drop.me", "keep this"]),
    ).toEqual(["[link removed]", "keep this"]);
  });

  test("[delta-07] an item enqueued before a crash survives the restart and reaches fetched", async () => {
    const h = harness({ addresses: [ADDRESS_A] });
    await enqueue(h.queue, ADDRESS_A, "mtgSurvivor");
    // "Kill the process": the worker instance goes away; the durable queue does not.
    const restarted = new ConnectorFetchWorker(
      {
        queue: h.queue,
        modes: h.modes,
        credentials: h.credentials,
        fetcher: h.fetcher,
        content: h.sink,
      },
      { now: h.clock },
    );

    await restarted.runOnce();

    expect(h.sink.rowsFor(ADDRESS_A).map((r) => r.sourceId)).toEqual([
      "mtgSurvivor",
    ]);
    expect(await h.queue.depth(SOURCE, ADDRESS_A)).toBe(0);
  });

  test("[delta-07] the SLA metric exists, is measured webhook → fetched, and carries no identifier", async () => {
    const h = harness({ addresses: [ADDRESS_A] });
    await enqueue(h.queue, ADDRESS_A, "mtgSla");
    h.advance(90_000);
    await h.worker.runOnce();

    const stats = h.worker.stats();
    expect(stats.fetched).toBe(1);
    expect(stats.p95LagMs).toBeGreaterThanOrEqual(90_000);
    expect(stats.slaBreaches).toBe(0);
    expect(FETCH_SLA_MS).toBe(5 * 60_000);

    const serialized = JSON.stringify(stats);
    expect(serialized).not.toContain("mtgSla");
    expect(serialized).not.toContain(ADDRESS_A);
  });

  test("[delta-07] an item that breaches the SLA is counted, still without an identifier", async () => {
    const h = harness({ addresses: [ADDRESS_A] });
    await enqueue(h.queue, ADDRESS_A, "mtgLate");
    h.advance(FETCH_SLA_MS + 1_000);
    await h.worker.runOnce();

    expect(h.worker.stats().slaBreaches).toBe(1);
    expect(JSON.stringify(h.worker.stats())).not.toContain("mtgLate");
  });

  test("[delta-07] a hung upstream is abandoned at the fetch timeout and the lane continues", async () => {
    const h = harness({ addresses: [ADDRESS_A], fetchTimeoutMs: 25 });
    h.fetcher.behaviour.set("mtgHang", "hang");
    await enqueue(h.queue, ADDRESS_A, "mtgHang");
    await enqueue(h.queue, ADDRESS_A, "mtgFine");

    await h.worker.runOnce();

    expect(h.sink.rowsFor(ADDRESS_A).map((r) => r.sourceId)).toEqual(["mtgFine"]);
    const [held] = await h.queue.list(SOURCE, ADDRESS_A);
    expect(held?.meetingId).toBe("mtgHang");
    expect(held?.lastError).toBe("fetch_timeout");
    expect(h.worker.stats().timeouts).toBe(1);
    expect(FETCH_TIMEOUT_MS).toBe(30_000);
  });
});

// ── Delta 8 — backpressure ───────────────────────────────────────────

describe("W3 fetch worker — backpressure (delta 8, AP 6)", () => {
  test("[delta-08] a 429 with Retry-After pauses that user's lane for exactly that long and burns no attempt", async () => {
    const h = harness({ addresses: [ADDRESS_A, ADDRESS_B] });
    h.fetcher.behaviour.set("mtgLimited", {
      ok: false,
      error: { code: "rate_limited", retryAfterMs: 120_000 },
    });
    await enqueue(h.queue, ADDRESS_A, "mtgLimited");
    await enqueue(h.queue, ADDRESS_A, "mtgAfter");
    await enqueue(h.queue, ADDRESS_B, "mtgB");

    await h.worker.runOnce();

    // The 429 stopped A's lane dead — the second A item was NOT attempted...
    expect(
      h.fetcher.calls.filter((c) => c.meetingId === "mtgAfter"),
    ).toHaveLength(0);
    // ...but B, on a different credential, is unaffected.
    expect(h.sink.rowsFor(ADDRESS_B).map((r) => r.sourceId)).toEqual(["mtgB"]);

    const items = await h.queue.list(SOURCE, ADDRESS_A);
    expect(items).toHaveLength(2);
    // No attempt burned: a provider throttle is not the item's fault.
    for (const item of items) expect(item.attempts).toBe(0);

    // A pass before the Retry-After elapses makes no upstream call for A at all.
    const before = h.fetcher.calls.length;
    h.advance(60_000);
    await h.worker.runOnce();
    expect(h.fetcher.calls).toHaveLength(before);
    expect(h.worker.stats().rateLimited).toBe(1);

    // Once it elapses the lane resumes.
    h.advance(61_000);
    h.fetcher.behaviour.delete("mtgLimited");
    await h.worker.runOnce();
    expect(h.sink.rowsFor(ADDRESS_A).map((r) => r.sourceId).sort()).toEqual([
      "mtgAfter",
      "mtgLimited",
    ]);
  });

  test("[delta-08] a 429 without Retry-After still pauses the lane on the documented fallback", async () => {
    const h = harness({ addresses: [ADDRESS_A] });
    h.fetcher.behaviour.set("mtgNoHeader", {
      ok: false,
      error: { code: "rate_limited" },
    });
    await enqueue(h.queue, ADDRESS_A, "mtgNoHeader");
    await enqueue(h.queue, ADDRESS_A, "mtgSecond");

    await h.worker.runOnce();
    expect(h.fetcher.calls).toHaveLength(1);

    h.advance(59_000);
    await h.worker.runOnce();
    expect(h.fetcher.calls).toHaveLength(1);
  });

  test("[delta-08] a missing credential holds the whole lane without burning attempts or leaking a reason", async () => {
    const capture = captureLogs();
    try {
      const h = harness({
        addresses: [ADDRESS_A],
        credentials: new Map(),
      });
      await enqueue(h.queue, ADDRESS_A, "mtgNoCred");

      await h.worker.runOnce();

      expect(h.fetcher.calls).toHaveLength(0);
      const [item] = await h.queue.list(SOURCE, ADDRESS_A);
      expect(item?.attempts).toBe(0);
      expect(h.worker.stats().credentialUnavailable).toBe(1);
    } finally {
      capture.restore();
    }
    for (const line of capture.lines) expect(line).not.toContain(ADDRESS_A);
  });

  test("[delta-08] a single pass is bounded: one in-flight fetch per user and a capped batch", async () => {
    const h = harness({ addresses: [ADDRESS_A], concurrency: 3 });
    h.fetcher.latencyMs = 2;
    for (let i = 0; i < 12; i += 1) await enqueue(h.queue, ADDRESS_A, `mtgP${i}`);

    await h.worker.runOnce();

    expect(h.fetcher.peakConcurrent).toBe(1);
    expect(h.worker.stats().claimed).toBe(12);
  });
});

// ── Delta 10 — fail-closed write-result checking ─────────────────────

describe("W3 fetch worker — fail closed (delta 10)", () => {
  test("[delta-10] a resolved {ok:false} store result is a FAILURE: the item retries and is not marked fetched", async () => {
    const h = harness({ addresses: [ADDRESS_A] });
    h.sink.override = { value: { ok: false, code: "substrate_unavailable" } };
    await enqueue(h.queue, ADDRESS_A, "mtgClosed");

    await h.worker.runOnce();

    const [item] = await h.queue.list(SOURCE, ADDRESS_A);
    expect(item?.meetingId).toBe("mtgClosed");
    // content_store_failed is INFRASTRUCTURE-state, not item-state — it must NOT burn an attempt
    // (audit fix: a KV outage would otherwise dead-letter otherwise-good user meetings in five
    // retries). The item still retries; the failure is still surfaced as `storeFailures`.
    expect(item?.attempts).toBe(0);
    expect(item?.lastError).toBe("content_store_failed");
    expect(h.worker.stats().fetched).toBe(0);
    expect(h.worker.stats().storeFailures).toBe(1);

    // And it succeeds once the store does.
    h.sink.override = null;
    h.advance(10 * 60_000);
    await h.worker.runOnce();
    expect(await h.queue.depth(SOURCE, ADDRESS_A)).toBe(0);
    expect(h.worker.stats().fetched).toBe(1);
  });

  test("[delta-10] a store that THROWS is the same failure — never a silent success", async () => {
    const h = harness({ addresses: [ADDRESS_A] });
    h.sink.throwOn = "mtgThrow";
    await enqueue(h.queue, ADDRESS_A, "mtgThrow");

    await h.worker.runOnce();

    const [item] = await h.queue.list(SOURCE, ADDRESS_A);
    // Same non-burning posture: a thrown store call is a content-store outage, not an item-state
    // defect — attempts stays 0 while lastError names the failure class for triage.
    expect(item?.attempts).toBe(0);
    expect(item?.lastError).toBe("content_store_failed");
    expect(h.worker.stats().fetched).toBe(0);
  });

  test("[delta-10] a store answering with a NON-Result is a failure: silent success is unrepresentable", async () => {
    for (const bogus of [undefined, null, {}, { ok: "true" }, { ok: 1 }, true]) {
      const h = harness({ addresses: [ADDRESS_A] });
      h.sink.override = { value: bogus };
      await enqueue(h.queue, ADDRESS_A, "mtgBogus");

      await h.worker.runOnce();

      expect(await h.queue.depth(SOURCE, ADDRESS_A)).toBe(1);
      expect(h.worker.stats().fetched).toBe(0);
      expect(h.worker.stats().storeFailures).toBe(1);
    }
  });

  test("[delta-10] a queue write that fails is a failure too — the item is never reported fetched", async () => {
    const h = harness({ addresses: [ADDRESS_A] });
    await enqueue(h.queue, ADDRESS_A, "mtgQueueDown");
    // The SDK reports durable write failure as a resolved Result; the queue turns it into a
    // throw, and the worker must not report a success it could not record.
    h.node.overridePutResult = { ok: false, error: "write refused" };

    const summary = await h.worker.runOnce();

    expect(summary.errors).toBeGreaterThan(0);
    expect(h.worker.stats().fetched).toBe(0);
  });

  test("[delta-10] the worker's own outcome type has no default arm: every path is an explicit disposition", () => {
    // A `settle`/`succeed` that runs on a fallthrough is exactly how a silent success gets built.
    expect(WORKER_SOURCE).not.toMatch(/catch\s*\{\s*\}/);
    expect(WORKER_SOURCE).toContain("ok: true");
    // No optimistic removal: the ONLY `status: "done"` settle is reached from a checked store
    // result (this asserts the count, so a second, unchecked one cannot appear unnoticed).
    const doneSettles = WORKER_SOURCE.split("\n")
      .filter((line) => !/^\s*(\*|\/\/)/.test(line))
      .filter((line) => line.includes('status: "done"'));
    expect(doneSettles).toHaveLength(1);
  });
});

// ── Lifecycle: D4 single instance + the W1 seam ──────────────────────

describe("W3 fetch worker — lifecycle", () => {
  test("start() registers the W1 nudge seam and stop() unregisters it", async () => {
    const h = harness({ addresses: [ADDRESS_A] });
    expect(ingestNudgeStats().noWorker).toBe(0);
    h.worker.start();
    expect(h.worker.isRunning()).toBe(true);
    h.worker.stop();
    expect(h.worker.isRunning()).toBe(false);
  });

  test("D4 single-instance: a second worker refuses to start while one is running", () => {
    const first = harness({ addresses: [ADDRESS_A] });
    const second = harness({ addresses: [ADDRESS_A] });
    first.worker.start();
    try {
      expect(() => second.worker.start()).toThrow(/single instance/i);
      expect(second.worker.isRunning()).toBe(false);
    } finally {
      first.worker.stop();
    }
    // After the first stops, the seat is free again.
    second.worker.start();
    expect(second.worker.isRunning()).toBe(true);
    second.worker.stop();
  });

  test("an unreadable cohort fails closed: the pass claims nothing", async () => {
    const h = harness({ addresses: [ADDRESS_A] });
    await enqueue(h.queue, ADDRESS_A, "mtgX");
    h.modes.failCohort = true;

    const summary = await h.worker.runOnce();

    expect(h.fetcher.calls).toHaveLength(0);
    expect(summary.errors).toBeGreaterThan(0);
    expect(await h.queue.depth(SOURCE, ADDRESS_A)).toBe(1);
  });
});

// ── §6.2 "rotate": the credential the WIRED worker presents ──────────
//
// Under DECISIONS `V-a-branch: b1` the credential is expiring BY DESIGN, so expiry is the routine
// case, not the edge. A worker handed the bare store presents the expired token, takes a provider
// 401, gates the lane for CREDENTIAL_HOLD_MS and retries the SAME dead token forever — ingest
// stops for good at the first expiry. These tests are written against the lookup `index.ts` wires.

describe("W3 fetch worker — credential rotation before use (delta 3)", () => {
  const MASTER = "Zk9pQ2xUb0FzRHZFcldxTnBZeEhtQjNnU2o1dDBjMD0=";
  const REFRESHED_TOKEN = "ff-access-token-AAAA-refreshed-000000";

  interface RotationRig {
    store: CredentialStore;
    lookup: WorkerCredentialLookup;
    refreshes: number;
    clock: () => number;
  }

  async function rotationRig(options: {
    expiresInMs: number;
    refreshFails?: boolean;
  }): Promise<RotationRig> {
    // The credential is written first and rotated a minute later, so `rotatedAt` moving is
    // observable rather than a stamp that happens to be equal.
    let credentialClock = T0;
    const clock = () => credentialClock;
    const rows = new InMemoryCredentialRowStore();
    const store = new CredentialStore(rows, {
      now: clock,
      master: () => MASTER,
    });
    await store.store({
      source: SOURCE,
      address: ADDRESS_A,
      secret: {
        kind: "oauth",
        accessToken: "ff-access-token-AAAA-expired-00000000",
        refreshToken: "ff-refresh-token-AAAAAAAAAAAAAAAAAA",
        expiresAt: new Date(T0 + options.expiresInMs).toISOString(),
      },
    });
    credentialClock = T0 + 60_000;
    const rig: RotationRig = {
      store,
      refreshes: 0,
      clock,
      lookup: createRefreshingCredentialLookup({
        store,
        client: () => ({
          refresh: async () => {
            rig.refreshes += 1;
            if (options.refreshFails === true) {
              throw new Error("oauth request rejected (status 400)");
            }
            return {
              kind: "oauth" as const,
              accessToken: REFRESHED_TOKEN,
              refreshToken: "ff-refresh-token-AAAAAAAAAAAAAAAAAA",
              expiresAt: new Date(T0 + 3_600_000).toISOString(),
            };
          },
        }),
        now: clock,
      }),
    };
    return rig;
  }

  test("[delta-03] an EXPIRED access token is rotated before the fetch, and the pass still reaches `fetched`", async () => {
    const rig = await rotationRig({ expiresInMs: -3_600_000 });
    const before = await rig.store.status(SOURCE, ADDRESS_A);
    const h = harness({ addresses: [ADDRESS_A], credentialLookup: rig.lookup });
    await enqueue(h.queue, ADDRESS_A, "mtg-rot");

    await h.worker.runOnce();

    // The token that went upstream is the refreshed one — the expired one is never presented.
    expect(h.fetcher.calls.map((c) => c.token)).toEqual([REFRESHED_TOKEN]);
    expect(rig.refreshes).toBe(1);
    expect(h.worker.stats().fetched).toBe(1);
    expect(h.worker.stats().credentialUnavailable).toBe(0);
    expect(await h.queue.depth(SOURCE, ADDRESS_A)).toBe(0);
    // Rotation is audited and the new envelope REPLACED the old one.
    const after = await rig.store.status(SOURCE, ADDRESS_A);
    expect(after?.rotatedAt).not.toBe(before?.rotatedAt);
    expect(after?.rotatedAt).toBe(new Date(T0 + 60_000).toISOString());
    expect(
      (await rig.store.getCredential(SOURCE, ADDRESS_A, "fetch-worker")) as {
        accessToken?: string;
      },
    ).toMatchObject({ accessToken: REFRESHED_TOKEN });
  });

  test("[delta-03] a credential comfortably inside its lifetime is used as-is — no refresh per pass", async () => {
    const rig = await rotationRig({ expiresInMs: 3_600_000 });
    const h = harness({ addresses: [ADDRESS_A], credentialLookup: rig.lookup });
    await enqueue(h.queue, ADDRESS_A, "mtg-fresh");

    await h.worker.runOnce();

    expect(rig.refreshes).toBe(0);
    expect(h.fetcher.calls.map((c) => c.token)).toEqual([
      "ff-access-token-AAAA-expired-00000000",
    ]);
    expect(h.worker.stats().fetched).toBe(1);
  });

  test("[delta-09] a provider 401 and an unreadable envelope are DIFFERENT hold reasons in the log", async () => {
    // The two demand opposite operator responses: an unreadable envelope is a custody incident
    // (wrong master, corrupt row — a stripped env secret after a redeploy), a 401 is a grant that
    // expired or was revoked upstream (re-run the connect flow). One shared code makes a real
    // master-strip indistinguishable from a routine token expiry.
    const rejected = harness({ addresses: [ADDRESS_A] });
    rejected.fetcher.behaviour.set("mtg-401", {
      ok: false,
      error: { code: "unauthorized" },
    });
    await enqueue(rejected.queue, ADDRESS_A, "mtg-401");
    const rejectedLogs = captureLogs();
    try {
      await rejected.worker.runOnce();
    } finally {
      rejectedLogs.restore();
    }

    const unreadable = harness({
      addresses: [ADDRESS_A],
      credentialLookup: {
        getCredential: async () => {
          throw new Error("credential envelope is unreadable");
        },
      },
    });
    await enqueue(unreadable.queue, ADDRESS_A, "mtg-envelope");
    const unreadableLogs = captureLogs();
    try {
      await unreadable.worker.runOnce();
    } finally {
      unreadableLogs.restore();
    }

    const rejectedText = rejectedLogs.lines.join("\n");
    const unreadableText = unreadableLogs.lines.join("\n");
    expect(rejectedText).toContain("op=lane result=credential_rejected");
    expect(rejectedText).not.toContain("credential_unreadable");
    expect(unreadableText).toContain("op=lane result=credential_unreadable");
    expect(unreadableText).not.toContain("credential_rejected");
    // Both are still credential-unavailable holds: same physics, different diagnosis.
    expect(rejected.worker.stats().credentialUnavailable).toBe(1);
    expect(unreadable.worker.stats().credentialUnavailable).toBe(1);
  });

  test("[delta-03] a FAILED refresh holds the lane instead of presenting the expired token", async () => {
    const rig = await rotationRig({
      expiresInMs: -3_600_000,
      refreshFails: true,
    });
    const h = harness({ addresses: [ADDRESS_A], credentialLookup: rig.lookup });
    await enqueue(h.queue, ADDRESS_A, "mtg-stuck");

    await h.worker.runOnce();

    // Fail closed: nothing goes upstream, the item is HELD (not failed, not dead-lettered).
    expect(h.fetcher.calls).toHaveLength(0);
    expect(h.worker.stats().fetched).toBe(0);
    expect(h.worker.stats().credentialUnavailable).toBe(1);
    expect(await h.queue.depth(SOURCE, ADDRESS_A)).toBe(1);
  });
});
