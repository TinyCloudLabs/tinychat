import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import {
  ConnectorQueue,
  PENDING_CAP,
  pendingQueueKey,
} from "../services/connector-queue.js";
import {
  _resetWebhookTokenState,
  keyedLogHash,
} from "../services/webhook-tokens.js";

/**
 * The burst-ack amendment and per-user backpressure of `ConnectorQueue` (delta item 8):
 * one same-address burst is absorbed by a single flush on the shared single writer, and the
 * pending cap drops the oldest item loudly.
 */

const ORIGINAL_ENV = { ...process.env };

const SOURCE = "fireflies";
const ADDRESS_A = "0x7d033300000000000000000000000000000073f2";
const MASTER = "3H8Qk0m2yq1sZ0VjK5xPwq0nA6oJ2bL9dR4tW7uY1cM=";
const LOG_SALT = "aQ2wS3eD4rF5tG6yH7uJ8iK9oL0pZ1xC2vB3nM4kJ5h=";

beforeEach(() => {
  _resetWebhookTokenState();
  process.env.WEBHOOK_HMAC_MASTER = MASTER;
  process.env.LOG_HASH_SALT = LOG_SALT;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  _resetWebhookTokenState();
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
