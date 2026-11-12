import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import express from "express";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import {
  ConnectorQueue,
  PENDING_CAP,
  pendingQueueKey,
  type AcknowledgeInput,
  type AcknowledgeResult,
  type ClearResult,
  type DeadItem,
  type PendingItem,
} from "../services/connector-queue.js";
import {
  BACKEND_INGEST_FLAG,
  COHORT_CAP,
  INGEST_COHORT_KEY,
  IngestModeService,
  backendIngestEnabled,
} from "../services/ingest-mode.js";
import {
  _resetFetchWorkerNudge,
  createIngestOnDelivery,
  ingestNudgeStats,
  registerFetchWorkerNudge,
} from "../services/ingest-nudge.js";
import {
  ConnectorWebhookLimiters,
  createConnectorWebhookCompanionRouter,
  createConnectorWebhookHandler,
  createConnectorWebhookParserErrorHandler,
  type ConnectorControl,
  type DisabledMarker,
  type PurgeLedger,
  type PurgeLedgerRead,
} from "../routes/connector-webhooks.js";
import {
  _resetWebhookTokenState,
  deriveWebhookSecret,
  generateWebhookToken,
  keyedLogHash,
  type WebhookConfigRecord,
  type WebhookTokenRecord,
} from "../services/webhook-tokens.js";

/**
 * W1 — flag + cohort + routing + the burst-ack amendment (plan §8.1 W1, §5.3, §8.2 delta items
 * 1, 7, 8; §9 anti-patterns 1 and 2).
 *
 * The feature under test is DARK by default. Every assertion below is either about the flag-off
 * path (which must stay byte-identical Option C) or about a cohort address that the operator
 * explicitly allow-listed.
 *
 * REVIEW NOTE (§8.2 item 1, the Listen failure this excludes): nothing in `ingest-mode.ts` or
 * `ingest-nudge.ts` holds a "current user", a "latest address" or a "latest secret" at module
 * scope. The cohort cache is a SET of allow-listed addresses (a membership test, not a
 * selection), and every nudge carries the address the signed token resolved to on THAT
 * delivery — asserted behaviourally by the interleaved A/B/A test below, which a
 * last-writer-wins global cannot pass.
 */

const ORIGINAL_ENV = { ...process.env };

const SOURCE = "fireflies";
const ADDRESS_A = "0x7d033300000000000000000000000000000073f2";
const ADDRESS_B = "0xb1b1b10000000000000000000000000000001111";
/** Same address as A, checksum-cased — cohort membership must not be case-sensitive. */
const ADDRESS_A_MIXED = "0x7D033300000000000000000000000000000073F2";
const MASTER = "3H8Qk0m2yq1sZ0VjK5xPwq0nA6oJ2bL9dR4tW7uY1cM=";
const LOG_SALT = "aQ2wS3eD4rF5tG6yH7uJ8iK9oL0pZ1xC2vB3nM4kJ5h=";

beforeEach(() => {
  _resetWebhookTokenState();
  _resetFetchWorkerNudge();
  process.env.WEBHOOK_HMAC_MASTER = MASTER;
  process.env.LOG_HASH_SALT = LOG_SALT;
  delete process.env[BACKEND_INGEST_FLAG];
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  _resetWebhookTokenState();
  _resetFetchWorkerNudge();
});

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

// ── A backend-KV node whose latency is the shared single writer's ────
//
// findings §2.5: the prod node is single-writer SQLite at ~0.5 writes/sec, SHARED across every
// user and app on the host. That number is the whole burst problem, so the fake carries it
// rather than an instant in-memory map.

class SlowFakeNode {
  readonly store = new Map<string, unknown>();
  readonly calls: Array<{ op: string; key: string }> = [];
  /** ~0.5 writes/sec — the measured shared-writer ceiling. */
  putLatencyMs = 2_000;
  getLatencyMs = 200;
  failGetWith: unknown | null = null;

  readonly kv = {
    get: async (key: string): Promise<unknown> => {
      this.calls.push({ op: "get", key });
      await sleep(this.getLatencyMs);
      if (this.failGetWith !== null) return this.failGetWith;
      if (!this.store.has(key)) return { data: null };
      return { data: { data: this.store.get(key) } };
    },
    put: async (key: string, value: unknown): Promise<unknown> => {
      this.calls.push({ op: "put", key });
      await sleep(this.putLatencyMs);
      this.store.set(key, JSON.parse(JSON.stringify(value)));
      return { data: true };
    },
    delete: async (key: string): Promise<unknown> => {
      this.calls.push({ op: "delete", key });
      await sleep(this.putLatencyMs);
      this.store.delete(key);
      return { data: true };
    },
  };

  async signIn(): Promise<void> {}

  countCalls(op: string, key?: string): number {
    return this.calls.filter(
      (call) => call.op === op && (key === undefined || call.key === key),
    ).length;
  }

  asNode(): TinyCloudNode {
    return this as unknown as TinyCloudNode;
  }
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    (timer as unknown as { unref?: () => void }).unref?.();
  });
}

// ── Public-delivery harness (same template as connector-webhooks.test.ts) ──

class FakeTokenStore {
  readonly records = new Map<string, WebhookTokenRecord>();

  register(token: string, address: string): string {
    this.records.set(token, {
      address: address.toLowerCase(),
      source: SOURCE,
      createdAt: new Date(0).toISOString(),
    });
    return token;
  }

  async lookup(token: unknown): Promise<WebhookTokenRecord | null> {
    return typeof token === "string" ? (this.records.get(token) ?? null) : null;
  }
}

class RecordingQueue {
  readonly enqueued: Array<{ source: string; address: string }> = [];

  async enqueue(source: string, address: string) {
    this.enqueued.push({ source, address });
    return { status: "queued" as const, depth: this.enqueued.length };
  }
}

/** A cohort list living where the operator puts it: the backend's own config KV. */
class CohortNode {
  readonly store = new Map<string, unknown>();
  readonly calls: Array<{ op: string; key: string }> = [];
  failGetWith: unknown | null = null;
  rawOverride: unknown | null = null;

  readonly kv = {
    get: async (key: string): Promise<unknown> => {
      this.calls.push({ op: "get", key });
      if (this.failGetWith !== null) throw this.failGetWith;
      if (this.rawOverride !== null) return { data: { data: this.rawOverride } };
      if (!this.store.has(key)) return { data: null };
      return { data: { data: this.store.get(key) } };
    },
    put: async (key: string, value: unknown): Promise<unknown> => {
      this.calls.push({ op: "put", key });
      this.store.set(key, JSON.parse(JSON.stringify(value)));
      return { data: true };
    },
    delete: async (key: string): Promise<unknown> => {
      this.calls.push({ op: "delete", key });
      this.store.delete(key);
      return { data: true };
    },
  };

  async signIn(): Promise<void> {}

  seedCohort(addresses: string[]): void {
    this.store.set(INGEST_COHORT_KEY, {
      addresses,
      updatedAt: new Date(0).toISOString(),
    });
  }

  asNode(): TinyCloudNode {
    return this as unknown as TinyCloudNode;
  }
}

interface DeliveryHarness {
  app: express.Express;
  tokens: FakeTokenStore;
  queue: RecordingQueue;
  cohortNode: CohortNode;
  modes: IngestModeService;
  nudges: Array<{ source: string; address: string }>;
}

function deliveryHarness(
  options: { nudge?: (input: { source: string; address: string }) => unknown } = {},
): DeliveryHarness {
  const tokens = new FakeTokenStore();
  const queue = new RecordingQueue();
  const cohortNode = new CohortNode();
  const modes = new IngestModeService(cohortNode.asNode());
  const nudges: Array<{ source: string; address: string }> = [];
  registerFetchWorkerNudge({
    nudge: (input) => {
      nudges.push({ source: input.source, address: input.address });
      return options.nudge?.(input);
    },
  });

  const limiters = new ConnectorWebhookLimiters();
  const app = express();
  app.set("trust proxy", 1);
  app.post(
    "/api/connectors/webhooks/:source/:token",
    limiters.ipPreLimiter,
    express.raw({ type: "application/json", limit: "64kb", inflate: false }),
    createConnectorWebhookParserErrorHandler(limiters),
    createConnectorWebhookHandler({
      tokens,
      queue,
      limiters,
      onDelivery: createIngestOnDelivery({ modes }),
    }),
  );
  return { app, tokens, queue, cohortNode, modes, nudges };
}

async function withServer<T>(
  app: express.Express,
  fn: (base: string) => Promise<T>,
): Promise<T> {
  const server = await new Promise<import("http").Server>((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });
  const { port } = server.address() as { port: number };
  try {
    return await fn(`http://localhost:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

function body(meetingId: string): string {
  return JSON.stringify({
    meetingId,
    eventType: "Transcription completed",
    timestamp: new Date().toISOString(),
  });
}

function sign(raw: string, token: string): string {
  const secret = deriveWebhookSecret(SOURCE, token);
  return `sha256=${createHmac("sha256", secret).update(Buffer.from(raw, "utf8")).digest("hex")}`;
}

async function deliver(
  base: string,
  token: string,
  meetingId: string,
): Promise<Response> {
  const raw = body(meetingId);
  return fetch(`${base}/api/connectors/webhooks/${SOURCE}/${token}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hub-signature": sign(raw, token),
    },
    body: raw,
  });
}

/** The nudge is fire-and-forget AFTER the response; give the microtasks a tick to land. */
async function settle(): Promise<void> {
  await sleep(25);
}

// ═════════════════════════════════════════════════════════════════════
// The flag itself (plan §8.1 W1; DECISIONS `Flag-name`)
// ═════════════════════════════════════════════════════════════════════

describe("backend-ingest flag (dark default)", () => {
  test("the flag name is the one the decision record fixed", () => {
    expect(BACKEND_INGEST_FLAG).toBe("CONNECTOR_BACKEND_INGEST_ENABLED");
  });

  test("absent, empty and any non-`true` value all read as OFF", () => {
    expect(backendIngestEnabled({})).toBe(false);
    expect(backendIngestEnabled({ [BACKEND_INGEST_FLAG]: "" })).toBe(false);
    expect(backendIngestEnabled({ [BACKEND_INGEST_FLAG]: "1" })).toBe(false);
    expect(backendIngestEnabled({ [BACKEND_INGEST_FLAG]: "TRUE" })).toBe(false);
    expect(backendIngestEnabled({ [BACKEND_INGEST_FLAG]: "yes" })).toBe(false);
    expect(backendIngestEnabled({ [BACKEND_INGEST_FLAG]: "true" })).toBe(true);
  });

  test("flag off costs the shared node ZERO reads — Option C is untouched, not re-decided", async () => {
    const node = new CohortNode();
    node.seedCohort([ADDRESS_A]);
    const modes = new IngestModeService(node.asNode());

    expect(await modes.mode(ADDRESS_A)).toBe("browser");
    expect(node.calls).toHaveLength(0);
  });
});

describe("cohort allowlist (D5: operator-only, backend config KV)", () => {
  function enabled(): void {
    process.env[BACKEND_INGEST_FLAG] = "true";
  }

  test("only allow-listed addresses are in backend-ingest mode", async () => {
    enabled();
    const node = new CohortNode();
    node.seedCohort([ADDRESS_A]);
    const modes = new IngestModeService(node.asNode());

    expect(await modes.mode(ADDRESS_A)).toBe("backend");
    expect(await modes.mode(ADDRESS_B)).toBe("browser");
  });

  test("membership is address-normalized, so a checksum-cased address still matches", async () => {
    enabled();
    const node = new CohortNode();
    node.seedCohort([ADDRESS_A_MIXED]);
    const modes = new IngestModeService(node.asNode());

    expect(await modes.mode(ADDRESS_A)).toBe("backend");
    expect(await modes.mode(ADDRESS_A_MIXED)).toBe("backend");
  });

  test("an absent cohort key means an empty cohort, not an error", async () => {
    enabled();
    const node = new CohortNode();
    const modes = new IngestModeService(node.asNode());

    expect(await modes.mode(ADDRESS_A)).toBe("browser");
  });

  test("the cohort read is cached, so a delivery burst is not a read burst", async () => {
    enabled();
    const node = new CohortNode();
    node.seedCohort([ADDRESS_A]);
    const clock = { now: 1_000 };
    const modes = new IngestModeService(node.asNode(), {
      ttlMs: 60_000,
      now: () => clock.now,
    });

    for (let i = 0; i < 25; i += 1) await modes.mode(ADDRESS_A);
    expect(node.calls.filter((c) => c.op === "get")).toHaveLength(1);

    clock.now += 60_001;
    await modes.mode(ADDRESS_A);
    expect(node.calls.filter((c) => c.op === "get")).toHaveLength(2);
  });

  test("an unreadable cohort FAILS CLOSED — never silently 'not in the cohort'", async () => {
    enabled();
    const node = new CohortNode();
    node.failGetWith = new Error("kv down");
    const modes = new IngestModeService(node.asNode());

    await expect(modes.mode(ADDRESS_A)).rejects.toThrow();
  });

  test("an unparseable cohort value FAILS CLOSED too", async () => {
    enabled();
    const node = new CohortNode();
    node.rawOverride = { addresses: "0xnot-an-array" };
    const modes = new IngestModeService(node.asNode());

    await expect(modes.mode(ADDRESS_A)).rejects.toThrow();
  });

  test("an over-cap cohort is truncated LOUDLY — no silent caps", async () => {
    enabled();
    const node = new CohortNode();
    const many = Array.from(
      { length: COHORT_CAP + 5 },
      (_, i) => `0x${String(i).padStart(40, "0")}`,
    );
    node.seedCohort(many);
    const modes = new IngestModeService(node.asNode());

    const capture = captureLogs();
    try {
      await modes.mode(ADDRESS_A);
    } finally {
      capture.restore();
    }
    expect(
      capture.lines.some(
        (line) => line.includes("op=cohort-cap") && line.includes("dropped=5"),
      ),
    ).toBe(true);
  });

  test("the cohort is never logged raw — addresses appear hashed or not at all", async () => {
    enabled();
    const node = new CohortNode();
    node.seedCohort([ADDRESS_A]);
    const modes = new IngestModeService(node.asNode());

    const capture = captureLogs();
    try {
      await modes.mode(ADDRESS_A);
      await modes.mode(ADDRESS_B);
    } finally {
      capture.restore();
    }
    const joined = capture.lines.join("\n").toLowerCase();
    expect(joined).not.toContain(ADDRESS_A.toLowerCase());
    expect(joined).not.toContain(ADDRESS_B.toLowerCase());
  });
});

// ═════════════════════════════════════════════════════════════════════
// Delta 1 — per-delivery tenant resolution (AP 1)
// ═════════════════════════════════════════════════════════════════════

describe("delivery-path routing", () => {
  test("[delta-01] every nudge carries the address THAT delivery's signed token resolved to", async () => {
    process.env[BACKEND_INGEST_FLAG] = "true";
    const h = deliveryHarness();
    h.cohortNode.seedCohort([ADDRESS_A, ADDRESS_B]);
    const tokenA = h.tokens.register(generateWebhookToken(), ADDRESS_A);
    const tokenB = h.tokens.register(generateWebhookToken(), ADDRESS_B);

    await withServer(h.app, async (base) => {
      // Interleaved on purpose: a module-level "current user" / "latest secret" — the Listen
      // failure §9 anti-pattern 1 names — routes the third delivery to B.
      expect((await deliver(base, tokenA, "01MEETINGAAAA000001")).status).toBe(202);
      expect((await deliver(base, tokenB, "01MEETINGBBBB000001")).status).toBe(202);
      expect((await deliver(base, tokenA, "01MEETINGAAAA000002")).status).toBe(202);
      await settle();
    });

    expect(h.nudges.map((n) => n.address)).toEqual([
      ADDRESS_A.toLowerCase(),
      ADDRESS_B.toLowerCase(),
      ADDRESS_A.toLowerCase(),
    ]);
    expect(h.queue.enqueued.map((e) => e.address)).toEqual([
      ADDRESS_A.toLowerCase(),
      ADDRESS_B.toLowerCase(),
      ADDRESS_A.toLowerCase(),
    ]);
  });

  test("[delta-01] a non-cohort address is never nudged — its deliveries stay pure Option C", async () => {
    process.env[BACKEND_INGEST_FLAG] = "true";
    const h = deliveryHarness();
    h.cohortNode.seedCohort([ADDRESS_A]);
    const tokenA = h.tokens.register(generateWebhookToken(), ADDRESS_A);
    const tokenB = h.tokens.register(generateWebhookToken(), ADDRESS_B);

    await withServer(h.app, async (base) => {
      await deliver(base, tokenB, "01MEETINGBBBB000001");
      await deliver(base, tokenA, "01MEETINGAAAA000001");
      await settle();
    });

    expect(h.nudges.map((n) => n.address)).toEqual([ADDRESS_A.toLowerCase()]);
    // Both were still durably enqueued: the queue is shared, only the CONSUMER differs.
    expect(h.queue.enqueued).toHaveLength(2);
  });

  test("with the flag dark nothing is nudged and the cohort key is never read", async () => {
    const h = deliveryHarness();
    h.cohortNode.seedCohort([ADDRESS_A]);
    const tokenA = h.tokens.register(generateWebhookToken(), ADDRESS_A);

    await withServer(h.app, async (base) => {
      expect((await deliver(base, tokenA, "01MEETINGAAAA000001")).status).toBe(202);
      await settle();
    });

    expect(h.nudges).toHaveLength(0);
    expect(h.cohortNode.calls).toHaveLength(0);
  });

  test("an unreadable cohort never turns a delivery into a 5xx — the 202 already shipped", async () => {
    process.env[BACKEND_INGEST_FLAG] = "true";
    const h = deliveryHarness();
    h.cohortNode.failGetWith = new Error("kv down");
    const tokenA = h.tokens.register(generateWebhookToken(), ADDRESS_A);

    const capture = captureLogs();
    try {
      await withServer(h.app, async (base) => {
        expect((await deliver(base, tokenA, "01MEETINGAAAA000001")).status).toBe(
          202,
        );
        await settle();
      });
    } finally {
      capture.restore();
    }
    // Not nudged, and counted: the worker's timer sweep is the backstop, but a silent skip
    // would make an outage invisible.
    expect(h.nudges).toHaveLength(0);
    expect(ingestNudgeStats().errors).toBeGreaterThan(0);
  });

  test("a nudge with no worker registered yet is a counted no-op, never a throw", async () => {
    process.env[BACKEND_INGEST_FLAG] = "true";
    _resetFetchWorkerNudge();
    const cohortNode = new CohortNode();
    cohortNode.seedCohort([ADDRESS_A]);
    const onDelivery = createIngestOnDelivery({
      modes: new IngestModeService(cohortNode.asNode()),
    });

    await onDelivery({ source: SOURCE, address: ADDRESS_A });
    expect(ingestNudgeStats().noWorker).toBe(1);
  });

  test("a throwing worker nudge is swallowed and counted, never surfaced", async () => {
    process.env[BACKEND_INGEST_FLAG] = "true";
    const cohortNode = new CohortNode();
    cohortNode.seedCohort([ADDRESS_A]);
    registerFetchWorkerNudge({
      nudge: () => {
        throw new Error("worker exploded");
      },
    });
    const onDelivery = createIngestOnDelivery({
      modes: new IngestModeService(cohortNode.asNode()),
    });

    await onDelivery({ source: SOURCE, address: ADDRESS_A });
    expect(ingestNudgeStats().errors).toBeGreaterThan(0);
  });
});

// ═════════════════════════════════════════════════════════════════════
// Delta 7 — capture-before-ack (AP 2)
// ═════════════════════════════════════════════════════════════════════

describe("capture-before-ack", () => {
  test("[delta-07] a 30 s fetch nudge does not delay the 202 — the ack waits only on the enqueue", async () => {
    process.env[BACKEND_INGEST_FLAG] = "true";
    let nudgeResolved = false;
    const h = deliveryHarness({
      nudge: () =>
        sleep(30_000).then(() => {
          nudgeResolved = true;
        }),
    });
    h.cohortNode.seedCohort([ADDRESS_A]);
    const tokenA = h.tokens.register(generateWebhookToken(), ADDRESS_A);

    await withServer(h.app, async (base) => {
      const started = Date.now();
      const response = await deliver(base, tokenA, "01MEETINGAAAA000001");
      const elapsed = Date.now() - started;

      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ status: "queued" });
      // Fireflies needs a 2xx inside 10 s; the whole point of the seam is that the fetch is
      // downstream of the response, not inside it.
      expect(elapsed).toBeLessThan(10_000);
      await settle();
      expect(h.nudges).toHaveLength(1);
      expect(nudgeResolved).toBe(false);
    });
  });
});

// ═════════════════════════════════════════════════════════════════════
// Delta 8 — burst-ack amendment + per-user backpressure
// ═════════════════════════════════════════════════════════════════════

describe("burst-ack amendment (plan §5.3's named exception to reuse-verbatim)", () => {
  test(
    "[delta-08] a same-address 50-delivery burst acks < 10 s each on the shared single writer",
    async () => {
      const node = new SlowFakeNode();
      const queue = new ConnectorQueue(node.asNode(), { jitter: () => 0 });
      const key = pendingQueueKey(SOURCE, ADDRESS_A);

      const started = Date.now();
      const acks: Promise<{ latency: number }>[] = [];
      // A Fireflies backlog flush: 50 deliveries for ONE address, ~40 ms apart. The shipped
      // path tailed at ≈100 s here (findings §2.5) because each 250 ms window opened a fresh
      // batch that then queued behind the previous flush on the same lock.
      for (let i = 0; i < 50; i += 1) {
        const at = Date.now();
        acks.push(
          queue
            .enqueue(SOURCE, ADDRESS_A, {
              meetingId: `01BURST${String(i).padStart(8, "0")}`,
              kind: "transcript",
              receivedAt: new Date(at).toISOString(),
            })
            .then(() => ({ latency: Date.now() - at })),
        );
        await sleep(40);
      }

      const results = await Promise.all(acks);
      const worst = Math.max(...results.map((r) => r.latency));
      const wall = Date.now() - started;

      expect(worst).toBeLessThan(10_000);
      // The amendment's mechanism, not just its outcome: one flush absorbs the burst, so the
      // whole backlog costs ~1-2 read-modify-writes instead of one per 250 ms window.
      expect(node.countCalls("put", key)).toBeLessThanOrEqual(4);
      // Every delivery is durably enqueued before its own ack (capture-before-ack, unchanged).
      const stored = node.store.get(key) as unknown[];
      expect(stored).toHaveLength(50);
      expect(wall).toBeLessThan(30_000);
    },
    60_000,
  );

  test("[delta-08] past the pending cap the oldest is dropped, counted and logged with a hashed id", async () => {
    const node = new SlowFakeNode();
    node.putLatencyMs = 0;
    node.getLatencyMs = 0;
    // Pinned inside the 14-day TTL: this test is about the CAP, and an unpinned clock would
    // dead-letter every seeded item before the cap ever looked at it.
    const queue = new ConnectorQueue(node.asNode(), {
      flushWindowMs: 1,
      jitter: () => 0,
      now: () => 1_700_000_100_000,
    });

    const capture = captureLogs();
    try {
      for (let i = 0; i < PENDING_CAP + 3; i += 1) {
        await queue.enqueue(SOURCE, ADDRESS_A, {
          meetingId: `01CAP${String(i).padStart(10, "0")}`,
          kind: "transcript",
          receivedAt: new Date(1_700_000_000_000 + i).toISOString(),
        });
      }
    } finally {
      capture.restore();
    }

    const stored = node.store.get(pendingQueueKey(SOURCE, ADDRESS_A)) as unknown[];
    expect(stored).toHaveLength(PENDING_CAP);
    const drops = capture.lines.filter((line) => line.includes("op=drop-oldest"));
    expect(drops.length).toBeGreaterThan(0);
    // The dropped id is hashed, never raw (§6.3 / delta 9).
    expect(drops.join("\n")).toContain(keyedLogHash("01CAP0000000000"));
    expect(drops.join("\n")).not.toContain("01CAP0000000000\b");
  });
});

// ═════════════════════════════════════════════════════════════════════
// Cohort routing on the authenticated companions (plan §5.3 "Changed")
// ═════════════════════════════════════════════════════════════════════

class CompanionTokens {
  readonly configs = new Map<string, WebhookConfigRecord>();

  seed(address: string): void {
    this.configs.set(address.toLowerCase(), {
      token: generateWebhookToken(),
      source: SOURCE,
      createdAt: new Date(0).toISOString(),
    });
  }

  async config(address: string): Promise<WebhookConfigRecord | null> {
    return this.configs.get(address.toLowerCase()) ?? null;
  }

  /** Minting is not on any path this file exercises — reaching it is the bug, so it throws. */
  async mint(): Promise<never> {
    throw new Error("mint is not part of the cohort-routing contract");
  }

  async rotate(): Promise<never> {
    throw new Error("rotate is not part of the cohort-routing contract");
  }

  async revoke(): Promise<void> {}
}

class CompanionQueueFake {
  readonly items = new Map<string, PendingItem[]>();
  readonly ops: string[] = [];

  seed(source: string, address: string, count: number): void {
    this.items.set(
      `${source}/${address.toLowerCase()}`,
      Array.from({ length: count }, (_, i) => ({
        meetingId: `01MEETING${String(i).padStart(6, "0")}`,
        kind: "transcript" as const,
        receivedAt: new Date(1_700_000_000_000 + i).toISOString(),
        sourceTimestamp: new Date(1_700_000_000_000 + i).toISOString(),
        attempts: 0,
        nextAttemptAt: new Date(1_700_000_000_000 + i).toISOString(),
      })),
    );
  }

  async list(source: string, address: string): Promise<PendingItem[]> {
    this.ops.push("list");
    return this.items.get(`${source}/${address.toLowerCase()}`) ?? [];
  }

  async dead(): Promise<DeadItem[]> {
    this.ops.push("dead");
    return [];
  }

  async clear(): Promise<ClearResult> {
    this.ops.push("clear");
    return { cleared: 0, superseded: 0 };
  }

  async acknowledge(
    _source: string,
    _address: string,
    acks: AcknowledgeInput[],
  ): Promise<AcknowledgeResult[]> {
    this.ops.push("acknowledge");
    return acks.map((ack) => ({ ...ack, disposition: "removed" as const }));
  }
}

class CompanionControl implements ConnectorControl {
  async readDisabled(): Promise<DisabledMarker | null> {
    return null;
  }
  async markDisabled(): Promise<void> {}
  async clearDisabled(): Promise<void> {}
  async readLedger(): Promise<PurgeLedgerRead> {
    return { status: "absent" };
  }
  async writeLedger(_s: string, _a: string, _l: PurgeLedger): Promise<void> {}
  async clearLedger(): Promise<void> {}
  async quarantineLedger(): Promise<void> {}
}

interface CompanionHarness {
  app: express.Express;
  queue: CompanionQueueFake;
  cohortNode: CohortNode;
  drains: Array<{ source: string; address: string }>;
}

function companionHarness(
  options: { address?: string; modes?: boolean } = {},
): CompanionHarness {
  const address = options.address ?? ADDRESS_A;
  const tokens = new CompanionTokens();
  tokens.seed(address);
  const queue = new CompanionQueueFake();
  queue.seed(SOURCE, address, 3);
  const cohortNode = new CohortNode();
  const drains: Array<{ source: string; address: string }> = [];

  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "1mb" }));
  app.use((req, _res, next) => {
    req.user = { address };
    next();
  });
  app.use(
    "/api/connectors/webhooks",
    createConnectorWebhookCompanionRouter({
      tokens: tokens as never,
      queue,
      control: new CompanionControl(),
      limiters: new ConnectorWebhookLimiters(),
      ...(options.modes === false
        ? {}
        : { modes: new IngestModeService(cohortNode.asNode()) }),
      drain: async (input) => {
        drains.push(input);
        const due = await queue.list(input.source, input.address);
        return { status: "ok", surfaced: due.map((item) => item.meetingId) };
      },
    }),
  );
  return { app, queue, cohortNode, drains };
}

describe("cohort companions: the worker is the sole queue consumer", () => {
  test("POST /drain for a cohort address surfaces nothing and never runs a drain pass", async () => {
    process.env[BACKEND_INGEST_FLAG] = "true";
    const h = companionHarness();
    h.cohortNode.seedCohort([ADDRESS_A]);

    await withServer(h.app, async (base) => {
      const response = await fetch(`${base}/api/connectors/webhooks/drain`, {
        method: "POST",
      });
      expect(response.status).toBe(200);
      const payload = (await response.json()) as Record<string, unknown>;
      expect(payload.count).toBe(0);
      expect(payload.pending).toEqual([]);
      expect(payload.enabled).toBe(true);
      // Never silence: the card learns WHY it was handed nothing.
      expect(payload.surfaceBlocked).toBe("backend_ingest");
    });

    expect(h.drains).toHaveLength(0);
  });

  test("POST /ack for a cohort address is an idempotent no-op — the queue is never touched", async () => {
    process.env[BACKEND_INGEST_FLAG] = "true";
    const h = companionHarness();
    h.cohortNode.seedCohort([ADDRESS_A]);

    await withServer(h.app, async (base) => {
      const response = await fetch(`${base}/api/connectors/webhooks/ack`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          items: [{ meetingId: "01MEETING000000", kind: "transcript" }],
        }),
      });
      expect(response.status).toBe(200);
      const payload = (await response.json()) as Record<string, unknown>;
      expect(payload.status).toBe("acknowledged");
      expect(payload.acknowledged).toBe(0);
      expect(payload.count).toBe(0);
    });

    expect(h.queue.ops).not.toContain("acknowledge");
  });

  test("GET /pending for a cohort address surfaces nothing either", async () => {
    process.env[BACKEND_INGEST_FLAG] = "true";
    const h = companionHarness();
    h.cohortNode.seedCohort([ADDRESS_A]);

    await withServer(h.app, async (base) => {
      const response = await fetch(`${base}/api/connectors/webhooks/pending`);
      const payload = (await response.json()) as Record<string, unknown>;
      expect(payload.count).toBe(0);
      expect(payload.surfaceBlocked).toBe("backend_ingest");
    });
  });

  test("a NON-cohort address on the same server still drains and acks exactly as Option C", async () => {
    process.env[BACKEND_INGEST_FLAG] = "true";
    const h = companionHarness({ address: ADDRESS_B });
    h.cohortNode.seedCohort([ADDRESS_A]);

    await withServer(h.app, async (base) => {
      const drain = await fetch(`${base}/api/connectors/webhooks/drain`, {
        method: "POST",
      });
      const payload = (await drain.json()) as Record<string, unknown>;
      expect(payload.count).toBe(3);
      expect(payload.surfaceBlocked).toBeUndefined();

      const ack = await fetch(`${base}/api/connectors/webhooks/ack`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          items: [{ meetingId: "01MEETING000000", kind: "transcript" }],
        }),
      });
      expect(((await ack.json()) as Record<string, unknown>).acknowledged).toBe(1);
    });

    expect(h.drains).toHaveLength(1);
    expect(h.queue.ops).toContain("acknowledge");
  });

  test("with the flag dark the companions never read the cohort key at all", async () => {
    const h = companionHarness();
    h.cohortNode.seedCohort([ADDRESS_A]);

    await withServer(h.app, async (base) => {
      const response = await fetch(`${base}/api/connectors/webhooks/drain`, {
        method: "POST",
      });
      expect(((await response.json()) as Record<string, unknown>).count).toBe(3);
    });

    expect(h.cohortNode.calls).toHaveLength(0);
    expect(h.drains).toHaveLength(1);
  });

  test("an unreadable cohort blocks the drain rather than guessing 'browser' — no double-drain race", async () => {
    process.env[BACKEND_INGEST_FLAG] = "true";
    const h = companionHarness();
    h.cohortNode.failGetWith = new Error("kv down");

    const capture = captureLogs();
    try {
      await withServer(h.app, async (base) => {
        const response = await fetch(`${base}/api/connectors/webhooks/drain`, {
          method: "POST",
        });
        expect(response.status).toBe(503);
      });
    } finally {
      capture.restore();
    }
    expect(h.drains).toHaveLength(0);
  });
});

// ═════════════════════════════════════════════════════════════════════
// The wiring itself
// ═════════════════════════════════════════════════════════════════════

describe("index.ts wiring", () => {
  const source = readFileSync(join(import.meta.dir, "..", "index.ts"), "utf8");

  test("the onDelivery seam is wired to the ingest nudge, not to a drain kick", () => {
    expect(source).toContain("onDelivery: createIngestOnDelivery(");
    // Trigger 1 stays retired: the seam nudges the fetch worker, it never runs a drain pass.
    expect(source).not.toMatch(/onDelivery[\s\S]{0,200}drain\.kick/);
  });

  test("the companions receive the same ingest-mode service the delivery path uses", () => {
    expect(source).toContain("new IngestModeService(node)");
    expect(source).toMatch(/modes:\s*connectorWebhooks\.modes/);
  });
});
