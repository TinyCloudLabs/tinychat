import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import {
  AWAITING_TRANSCRIPT,
  AWAITING_TRANSCRIPT_TIMEOUT,
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  CONTENT_STORE_UNAVAILABLE,
  ConnectorQueue,
  DEAD_CAP,
  DELEGATION_UNUSABLE,
  ENQUEUE_FLUSH_WINDOW_MS,
  LEDGER_UNAVAILABLE,
  MAX_ATTEMPTS,
  NON_BURNING_ERRORS,
  PENDING_CAP,
  QUEUE_TTL_MS,
  SCHEMA_MISSING,
  SPACE_NOT_HOSTED,
  TTL_EXPIRED,
  backoffDelayMs,
  burnsAttempt,
  corruptQueueKey,
  deadLetterKey,
  pendingQueueKey,
} from "../services/connector-queue.js";
import { _resetWebhookTokenState } from "../services/webhook-tokens.js";

const ORIGINAL_ENV = { ...process.env };
const SALT = Buffer.from("queue-salt-queue-salt-queue-1234").toString("base64");

const ADDRESS = "0x7d0333AbCdEf0123456789AbCdEf012345673f21";
const LOWER = ADDRESS.toLowerCase();
const SOURCE = "fireflies";
const PENDING_KEY = `webhooks/pending/${SOURCE}/${LOWER}`;
const DEAD_KEY = `webhooks/dead/${SOURCE}/${LOWER}`;
const CORRUPT_KEY = `webhooks/corrupt/${SOURCE}/${LOWER}`;

const T0 = Date.parse("2026-08-04T12:00:00.000Z");

beforeEach(() => {
  _resetWebhookTokenState();
  process.env.LOG_HASH_SALT = SALT;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  _resetWebhookTokenState();
});

// ── Fake backend-KV node (same shape as webhook-tokens.test.ts) ──────

class FakeNode {
  readonly store = new Map<string, unknown>();
  readonly calls: Array<{ op: string; key: string }> = [];
  maxConcurrent = 0;
  private inFlight = 0;
  /**
   * When set, kv.put returns this Result verbatim and never mutates `store` — the SDK's KV
   * surface reports durable write failures as `{ok:false, error}` and the promise no longer
   * rejects, so the queue must surface that shape as a thrown error rather than accept it.
   */
  overridePutResult: unknown | null = null;
  /** Same, for delete. */
  overrideDeleteResult: unknown | null = null;
  /**
   * Same, for READS. Prior read paths cast `(result as {data?}).data` and read a rejected
   * Result as "no state present", so `enqueue` would treat every prior queue entry as absent
   * and `persist` would durably OVERWRITE the pending array with the newly-arrived delivery
   * only — silently wiping every previously-queued item and answering 202 for the write that
   * did the wiping. Reads must surface the Result too.
   */
  overrideGetResult: unknown | null = null;

  readonly kv = {
    get: async (key: string): Promise<unknown> => {
      await this.enter("get", key);
      try {
        if (this.overrideGetResult !== null) return this.overrideGetResult;
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
        // Round-trip through JSON, as a real KV does — a value written here is not the same
        // object the caller still holds.
        this.store.set(key, JSON.parse(JSON.stringify(value)));
        return { data: true };
      } finally {
        this.exit();
      }
    },
    delete: async (key: string): Promise<unknown> => {
      await this.enter("delete", key);
      try {
        if (this.overrideDeleteResult !== null)
          return this.overrideDeleteResult;
        this.store.delete(key);
        return { data: true };
      } finally {
        this.exit();
      }
    },
  };

  async signIn(): Promise<void> {}

  countCalls(op?: string, key?: string): number {
    return this.calls.filter(
      (call) => (!op || call.op === op) && (!key || call.key === key),
    ).length;
  }

  private async enter(op: string, key: string): Promise<void> {
    this.calls.push({ op, key });
    this.inFlight += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.inFlight);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }

  private exit(): void {
    this.inFlight -= 1;
  }
}

interface Harness {
  node: FakeNode;
  queue: ConnectorQueue;
  clock: { now: number };
}

function createQueue(
  options: ConstructorParameters<typeof ConnectorQueue>[1] = {},
): Harness {
  const node = new FakeNode();
  const clock = { now: T0 };
  const queue = new ConnectorQueue(node as unknown as TinyCloudNode, {
    flushWindowMs: 1,
    now: () => clock.now,
    jitter: () => 0,
    ...options,
  });
  return { node, queue, clock };
}

function captureLogs(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const log = console.log;
  const warn = console.warn;
  console.log = (...args: unknown[]) => {
    lines.push(args.join(" "));
  };
  console.warn = (...args: unknown[]) => {
    lines.push(args.join(" "));
  };
  return {
    lines,
    restore: () => {
      console.log = log;
      console.warn = warn;
    },
  };
}

async function withLogs<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; lines: string[] }> {
  const capture = captureLogs();
  try {
    const result = await fn();
    return { result, lines: capture.lines };
  } finally {
    capture.restore();
  }
}

function stored(node: FakeNode, key: string): unknown[] {
  const value = node.store.get(key);
  return Array.isArray(value) ? value : [];
}

// ── Keys (§5.1 — backend-own prefix, NOT the xyz.tinycloud.tinychat path) ──

describe("queue keys", () => {
  test("are the verbatim §5.1 shapes under the backend's own prefix", () => {
    expect(pendingQueueKey(SOURCE, ADDRESS)).toBe(PENDING_KEY);
    expect(deadLetterKey(SOURCE, ADDRESS)).toBe(DEAD_KEY);
    expect(corruptQueueKey(SOURCE, ADDRESS)).toBe(CORRUPT_KEY);
    // Backend-KV keys are auto-prefixed with ops.tinychat.backend; they must NOT carry the
    // user-space path the writer uses.
    expect(pendingQueueKey(SOURCE, ADDRESS)).not.toContain(
      "xyz.tinycloud.tinychat",
    );
  });

  test("reject traversal in the address and the source rather than building the key", () => {
    expect(() => pendingQueueKey(SOURCE, "../../delegations/0xabc")).toThrow(
      /Invalid webhook config address/,
    );
    expect(() => pendingQueueKey("../fireflies", ADDRESS)).toThrow(
      /Invalid webhook source/,
    );
    expect(() => deadLetterKey(SOURCE, "0xnot-an-address")).toThrow();
  });
});

// ── The constants are normative, not suggestions (§5.3/§5.5) ─────────

describe("queue constants", () => {
  test("match §5.3/§5.5 exactly", () => {
    expect(PENDING_CAP).toBe(200);
    expect(DEAD_CAP).toBe(50);
    expect(QUEUE_TTL_MS).toBe(14 * 24 * 60 * 60 * 1000);
    expect(MAX_ATTEMPTS).toBe(5);
    expect(BACKOFF_BASE_MS).toBe(60_000);
    expect(BACKOFF_CAP_MS).toBe(6 * 60 * 60 * 1000);
    expect(ENQUEUE_FLUSH_WINDOW_MS).toBe(250);
  });
});

// ── Enqueue: no RMW loss (§5.2) ──────────────────────────────────────

describe("enqueue under concurrency", () => {
  test("50 concurrent enqueues produce depth 50 — no lost writes", async () => {
    const { node, queue } = createQueue();

    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        queue.enqueue(SOURCE, ADDRESS, {
          meetingId: `M${i}`,
          kind: "transcript",
        }),
      ),
    );

    expect(results.every((result) => result.status === "queued")).toBe(true);
    expect(await queue.depth(SOURCE, ADDRESS)).toBe(50);
    expect(stored(node, PENDING_KEY)).toHaveLength(50);
    const ids = new Set(
      stored(node, PENDING_KEY).map(
        (item) => (item as { meetingId: string }).meetingId,
      ),
    );
    expect(ids.size).toBe(50);
  });

  test("the burst is coalesced into a handful of writes, not 50 (W0 §6.1)", async () => {
    const { node, queue } = createQueue();

    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        queue.enqueue(SOURCE, ADDRESS, {
          meetingId: `M${i}`,
          kind: "transcript",
        }),
      ),
    );

    // 50 serialized writes would be ~100s of the node's entire shared write budget.
    expect(node.countCalls("put", PENDING_KEY)).toBeLessThanOrEqual(4);
    expect(node.countCalls("put", PENDING_KEY)).toBeGreaterThanOrEqual(1);
  });

  test("the ack waits for the durable write — an enqueue that resolved is in KV", async () => {
    const { node, queue } = createQueue();
    await queue.enqueue(SOURCE, ADDRESS, {
      meetingId: "M1",
      kind: "transcript",
    });
    expect(stored(node, PENDING_KEY)).toHaveLength(1);
  });

  test("storage calls stay sequential even across addresses (§9.3)", async () => {
    const { node, queue } = createQueue();
    const addresses = Array.from({ length: 5 }, (_, i) =>
      `0x${String(i + 1).repeat(40)}`.slice(0, 42),
    );

    await Promise.all(
      addresses.map((address) =>
        queue.enqueue(SOURCE, address, { meetingId: "M1", kind: "transcript" }),
      ),
    );

    expect(node.maxConcurrent).toBe(1);
  });

  test("an invalid meeting id or kind never reaches KV", async () => {
    const { node, queue } = createQueue();
    await expect(
      queue.enqueue(SOURCE, ADDRESS, {
        meetingId: "../../threads/x",
        kind: "transcript",
      }),
    ).rejects.toThrow(/Invalid meeting id/);
    await expect(
      queue.enqueue(SOURCE, ADDRESS, {
        meetingId: "M1",
        kind: "note" as "transcript",
      }),
    ).rejects.toThrow(/Invalid pending item kind/);
    expect(node.countCalls()).toBe(0);
  });
});

// ── Dedup (§5.3) ─────────────────────────────────────────────────────

describe("dedup by (meetingId, kind)", () => {
  test("a duplicate delivery updates receivedAt and never appends", async () => {
    const { node, queue, clock } = createQueue();

    await queue.enqueue(SOURCE, ADDRESS, {
      meetingId: "M1",
      kind: "transcript",
    });
    clock.now = T0 + 5_000;
    const second = await queue.enqueue(SOURCE, ADDRESS, {
      meetingId: "M1",
      kind: "transcript",
    });

    expect(second.status).toBe("deduped");
    expect(second.depth).toBe(1);
    const items = stored(node, PENDING_KEY) as Array<{ receivedAt: string }>;
    expect(items).toHaveLength(1);
    expect(items[0]!.receivedAt).toBe(new Date(T0 + 5_000).toISOString());
  });

  test("the same meeting's transcript and summary are distinct items", async () => {
    const { queue } = createQueue();
    await queue.enqueue(SOURCE, ADDRESS, {
      meetingId: "M1",
      kind: "transcript",
    });
    await queue.enqueue(SOURCE, ADDRESS, { meetingId: "M1", kind: "summary" });
    expect(await queue.depth(SOURCE, ADDRESS)).toBe(2);
  });

  test("duplicates inside one coalesced window collapse too", async () => {
    const { queue } = createQueue();
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        queue.enqueue(SOURCE, ADDRESS, { meetingId: "M1", kind: "transcript" }),
      ),
    );
    expect(await queue.depth(SOURCE, ADDRESS)).toBe(1);
    expect(results.filter((result) => result.status === "queued")).toHaveLength(
      1,
    );
    expect(
      results.filter((result) => result.status === "deduped"),
    ).toHaveLength(9);
  });
});

// ── Cap + drop-oldest (§5.3) ─────────────────────────────────────────

describe("cap and drop-oldest", () => {
  test("caps at 200 items, drops the OLDEST, and logs the count and the ids", async () => {
    const { node, queue } = createQueue();

    const { lines } = await withLogs(async () => {
      await Promise.all(
        Array.from({ length: 205 }, (_, i) =>
          queue.enqueue(SOURCE, ADDRESS, {
            meetingId: `M${i}`,
            kind: "transcript",
            receivedAt: new Date(T0 + i * 1_000).toISOString(),
          }),
        ),
      );
    });

    const items = stored(node, PENDING_KEY) as Array<{ meetingId: string }>;
    expect(items).toHaveLength(200);
    const ids = items.map((item) => item.meetingId);
    // The five oldest are gone; the newest survive.
    expect(ids).not.toContain("M0");
    expect(ids).not.toContain("M4");
    expect(ids).toContain("M5");
    expect(ids).toContain("M204");

    const dropLine = lines.find((line) => line.includes("op=drop-oldest"));
    expect(dropLine).toBeDefined();
    expect(dropLine).toContain("dropped=5");
    expect(dropLine).toContain("depth=200");
    expect(dropLine).toMatch(/mids=([0-9a-f]{16},){4}[0-9a-f]{16}/);
    // No silent caps — and no raw ids or address in a world-readable line (§6.3).
    expect(dropLine).not.toContain("M0");
    expect(dropLine).not.toContain(LOWER);
  });
});

// ── Backoff + error classes (§5.5) ───────────────────────────────────

describe("backoff schedule", () => {
  test("is exactly min(2^attempts x 60s, 6h)", () => {
    expect(backoffDelayMs(1)).toBe(120_000);
    expect(backoffDelayMs(2)).toBe(240_000);
    expect(backoffDelayMs(3)).toBe(480_000);
    expect(backoffDelayMs(4)).toBe(960_000);
    expect(backoffDelayMs(5)).toBe(1_920_000);
    expect(backoffDelayMs(9)).toBe(6 * 60 * 60 * 1000);
    expect(backoffDelayMs(64)).toBe(BACKOFF_CAP_MS);
  });

  test("the stored nextAttemptAt follows that schedule exactly, attempt by attempt", async () => {
    const { queue, clock } = createQueue();
    await queue.enqueue(SOURCE, ADDRESS, {
      meetingId: "M1",
      kind: "transcript",
    });

    for (const attempts of [1, 2, 3, 4]) {
      const result = await queue.fail(
        SOURCE,
        ADDRESS,
        "M1",
        "transcript",
        "write_rejected",
      );
      expect(result.attempts).toBe(attempts);
      expect(result.disposition).toBe("requeued");
      expect(result.nextAttemptAt).toBe(
        new Date(clock.now + backoffDelayMs(attempts)).toISOString(),
      );
      clock.now += backoffDelayMs(attempts);
    }

    const fifth = await queue.fail(
      SOURCE,
      ADDRESS,
      "M1",
      "transcript",
      "write_rejected",
    );
    expect(fifth.disposition).toBe("dead-lettered");
    expect(fifth.attempts).toBe(MAX_ATTEMPTS);
    expect(await queue.depth(SOURCE, ADDRESS)).toBe(0);
    const dead = await queue.dead(SOURCE, ADDRESS);
    expect(dead).toHaveLength(1);
    expect(dead[0]!.lastError).toBe("write_rejected");
    expect(dead[0]!.attempts).toBe(5);
  });

  test("jitter is additive and bounded at 10%", async () => {
    const { queue, clock } = createQueue({ jitter: () => 1 });
    await queue.enqueue(SOURCE, ADDRESS, {
      meetingId: "M1",
      kind: "transcript",
    });
    const result = await queue.fail(
      SOURCE,
      ADDRESS,
      "M1",
      "transcript",
      "write_rejected",
    );
    expect(result.nextAttemptAt).toBe(
      new Date(clock.now + 120_000 * 1.1).toISOString(),
    );
  });

  test("items whose nextAttemptAt is in the future are skipped by due(), not retried hot", async () => {
    const { queue, clock } = createQueue();
    await queue.enqueue(SOURCE, ADDRESS, {
      meetingId: "M1",
      kind: "transcript",
    });
    expect(await queue.due(SOURCE, ADDRESS)).toHaveLength(1);

    await queue.fail(SOURCE, ADDRESS, "M1", "transcript", "write_rejected");
    expect(await queue.due(SOURCE, ADDRESS)).toHaveLength(0);
    expect(await queue.depth(SOURCE, ADDRESS)).toBe(1);

    clock.now += 120_000;
    expect(await queue.due(SOURCE, ADDRESS)).toHaveLength(1);
  });
});

describe("error classes", () => {
  test("the non-item-state classes do not burn attempts", () => {
    expect(NON_BURNING_ERRORS).toEqual([
      DELEGATION_UNUSABLE,
      SCHEMA_MISSING,
      SPACE_NOT_HOSTED,
      AWAITING_TRANSCRIPT,
      LEDGER_UNAVAILABLE,
      CONTENT_STORE_UNAVAILABLE,
    ]);
    for (const code of NON_BURNING_ERRORS)
      expect(burnsAttempt(code)).toBe(false);
    expect(burnsAttempt("write_rejected")).toBe(true);
    expect(burnsAttempt("meeting_not_found")).toBe(true);
    expect(burnsAttempt(undefined)).toBe(true);
  });

  test("content_store_failed does not burn attempts — a KV outage must not dead-letter meetings", () => {
    // The security audit flagged that fetch-worker.ts tags CONTENT_STORE_FAILED but the queue's
    // NON_BURNING_ERRORS did not include it — 5 outage-triggered retries would push otherwise-good
    // rows into DLQ. This is a REGRESSION GUARD for the fix.
    expect(NON_BURNING_ERRORS).toContain(CONTENT_STORE_UNAVAILABLE);
    expect(burnsAttempt(CONTENT_STORE_UNAVAILABLE)).toBe(false);
  });

  test("delegation_unusable never burns an attempt — one dead delegation must not dead-letter a queue", async () => {
    const { queue, clock } = createQueue();
    await queue.enqueue(SOURCE, ADDRESS, {
      meetingId: "M1",
      kind: "transcript",
    });

    for (let i = 0; i < MAX_ATTEMPTS + 3; i += 1) {
      const result = await queue.fail(
        SOURCE,
        ADDRESS,
        "M1",
        "transcript",
        DELEGATION_UNUSABLE,
      );
      expect(result.disposition).toBe("requeued");
      expect(result.attempts).toBe(0);
      clock.now += QUEUE_TTL_MS / 100;
    }

    expect(await queue.depth(SOURCE, ADDRESS)).toBe(1);
    expect(await queue.dead(SOURCE, ADDRESS)).toHaveLength(0);
    const [item] = await queue.list(SOURCE, ADDRESS);
    expect(item!.attempts).toBe(0);
    expect(item!.lastError).toBe(DELEGATION_UNUSABLE);
  });

  test("a hold class still backs off — it re-queues on its own counter, not a flat retry", async () => {
    const { queue, clock } = createQueue();
    await queue.enqueue(SOURCE, ADDRESS, {
      meetingId: "M1",
      kind: "transcript",
    });

    const first = await queue.fail(
      SOURCE,
      ADDRESS,
      "M1",
      "transcript",
      LEDGER_UNAVAILABLE,
    );
    expect(first.nextAttemptAt).toBe(
      new Date(clock.now + backoffDelayMs(1)).toISOString(),
    );
    clock.now += backoffDelayMs(1);
    const second = await queue.fail(
      SOURCE,
      ADDRESS,
      "M1",
      "transcript",
      LEDGER_UNAVAILABLE,
    );
    expect(second.attempts).toBe(0);
    expect(second.nextAttemptAt).toBe(
      new Date(clock.now + backoffDelayMs(2)).toISOString(),
    );
  });

  test("a terminal failure dead-letters on the FIRST attempt (§5.4/T5)", async () => {
    const { queue } = createQueue();
    await queue.enqueue(SOURCE, ADDRESS, {
      meetingId: "M1",
      kind: "transcript",
    });

    const result = await queue.fail(
      SOURCE,
      ADDRESS,
      "M1",
      "transcript",
      "meeting_not_found",
      {
        terminal: true,
      },
    );
    expect(result.disposition).toBe("dead-lettered");
    expect(await queue.depth(SOURCE, ADDRESS)).toBe(0);
    expect((await queue.dead(SOURCE, ADDRESS))[0]!.lastError).toBe(
      "meeting_not_found",
    );
  });

  test("a second-write failure during settle preserves pending and dead, emits no success log, and retries without duplication", async () => {
    const { node, queue } = createQueue();
    await queue.enqueue(SOURCE, ADDRESS, {
      meetingId: "M-AT-LEAST-ONCE",
      kind: "transcript",
    });

    const originalPut = node.kv.put.bind(node.kv);
    const writeKeys: string[] = [];
    let armed = true;
    node.kv.put = async (key: string, value: unknown) => {
      if (!armed) return originalPut(key, value);
      writeKeys.push(key);
      if (writeKeys.length === 2) {
        return {
          ok: false,
          error: {
            code: "WRITE_REJECTED",
            message: "PRIVATE_RESULT_PAYLOAD pending removal failed",
            service: "kv",
            meta: { status: 503 },
          },
        };
      }
      return originalPut(key, value);
    };

    const partial = captureLogs();
    try {
      await expect(
        queue.fail(
          SOURCE,
          ADDRESS,
          "M-AT-LEAST-ONCE",
          "transcript",
          "meeting_not_found",
          { terminal: true },
        ),
      ).rejects.toMatchObject({
        name: "KvResultError",
        code: "WRITE_REJECTED",
        status: 503,
      });
    } finally {
      partial.restore();
    }

    expect(writeKeys).toEqual([DEAD_KEY, PENDING_KEY]);
    expect(stored(node, PENDING_KEY).map((item) => item.meetingId)).toEqual([
      "M-AT-LEAST-ONCE",
    ]);
    const partialDead = stored(node, DEAD_KEY);
    expect(partialDead.map((item) => item.meetingId)).toEqual([
      "M-AT-LEAST-ONCE",
    ]);
    expect(partial.lines.some((line) => line.includes("op=dead-letter"))).toBe(
      false,
    );

    armed = false;
    const retried = await withLogs(() =>
      queue.fail(
        SOURCE,
        ADDRESS,
        "M-AT-LEAST-ONCE",
        "transcript",
        "meeting_not_found",
        { terminal: true },
      ),
    );
    expect(retried.result.disposition).toBe("dead-lettered");
    expect(await queue.list(SOURCE, ADDRESS)).toEqual([]);
    const converged = await queue.dead(SOURCE, ADDRESS);
    expect(converged.map((item) => item.meetingId)).toEqual([
      "M-AT-LEAST-ONCE",
    ]);
    expect(converged[0]!.deadAt).toBe(partialDead[0]!.deadAt);
    expect(
      retried.lines.filter((line) => line.includes("op=dead-letter")),
    ).toHaveLength(1);
  });

  test("a settled success removes the item; an unknown key is reported, not invented", async () => {
    const { queue } = createQueue();
    await queue.enqueue(SOURCE, ADDRESS, {
      meetingId: "M1",
      kind: "transcript",
    });

    const results = await queue.settle(SOURCE, ADDRESS, [
      { meetingId: "M1", kind: "transcript", status: "done" },
      { meetingId: "M2", kind: "transcript", status: "done" },
    ]);
    expect(results[0]!.disposition).toBe("removed");
    expect(results[1]!.disposition).toBe("unknown");
    expect(await queue.depth(SOURCE, ADDRESS)).toBe(0);
  });
});

// ── awaiting_transcript: the §5.5-vs-§5.6 contradiction, both halves ──

describe("awaiting_transcript", () => {
  test("never dead-letters by the 5-attempt rule, and IS dead-lettered at the 14-day TTL", async () => {
    const { queue, clock } = createQueue();
    await queue.enqueue(SOURCE, ADDRESS, { meetingId: "M1", kind: "summary" });

    // Half 1: far more than MAX_ATTEMPTS failures, still pending, attempts never burned.
    for (let i = 0; i < MAX_ATTEMPTS + 5; i += 1) {
      const result = await queue.fail(
        SOURCE,
        ADDRESS,
        "M1",
        "summary",
        AWAITING_TRANSCRIPT,
      );
      expect(result.disposition).toBe("requeued");
      expect(result.attempts).toBe(0);
      clock.now += 60 * 60 * 1000;
    }
    expect(await queue.depth(SOURCE, ADDRESS)).toBe(1);
    expect(await queue.dead(SOURCE, ADDRESS)).toHaveLength(0);

    // Half 2: at the TTL it IS dead-lettered, with the class-specific code.
    clock.now = T0 + QUEUE_TTL_MS + 1;
    expect(await queue.depth(SOURCE, ADDRESS)).toBe(0);
    const dead = await queue.dead(SOURCE, ADDRESS);
    expect(dead).toHaveLength(1);
    expect(dead[0]!.meetingId).toBe("M1");
    expect(dead[0]!.kind).toBe("summary");
    expect(dead[0]!.lastError).toBe(AWAITING_TRANSCRIPT_TIMEOUT);
    expect(dead[0]!.attempts).toBe(0);
  });

  test("an ordinary item promoted by the TTL carries ttl_expired, not the summary code", async () => {
    const { queue, clock } = createQueue();
    await queue.enqueue(SOURCE, ADDRESS, {
      meetingId: "M1",
      kind: "transcript",
    });

    clock.now = T0 + QUEUE_TTL_MS + 1;
    const dead = await queue.dead(SOURCE, ADDRESS);
    expect(await queue.depth(SOURCE, ADDRESS)).toBe(0);
    expect(dead[0]!.lastError).toBe(TTL_EXPIRED);
  });

  test("a TTL promotion is a promotion — the item is in the dead-letter, never silently dropped", async () => {
    const { node, queue, clock } = createQueue();
    await queue.enqueue(SOURCE, ADDRESS, {
      meetingId: "M1",
      kind: "transcript",
    });
    clock.now = T0 + QUEUE_TTL_MS + 1;
    await queue.list(SOURCE, ADDRESS);

    expect(stored(node, PENDING_KEY)).toHaveLength(0);
    expect(stored(node, DEAD_KEY)).toHaveLength(1);
  });

  test("a second-write failure during TTL promotion preserves both copies and list retry converges without duplicate dead entries", async () => {
    const { node, queue, clock } = createQueue();
    await queue.enqueue(SOURCE, ADDRESS, {
      meetingId: "M-TTL-AT-LEAST-ONCE",
      kind: "transcript",
    });
    clock.now = T0 + QUEUE_TTL_MS + 1;

    const originalPut = node.kv.put.bind(node.kv);
    const writeKeys: string[] = [];
    let armed = true;
    node.kv.put = async (key: string, value: unknown) => {
      if (!armed) return originalPut(key, value);
      writeKeys.push(key);
      if (writeKeys.length === 2) {
        return {
          ok: false,
          error: {
            code: "WRITE_REJECTED",
            message: "PRIVATE_RESULT_PAYLOAD ttl pending removal failed",
            service: "kv",
            meta: { status: 503 },
          },
        };
      }
      return originalPut(key, value);
    };

    const partial = captureLogs();
    try {
      await expect(queue.list(SOURCE, ADDRESS)).rejects.toMatchObject({
        name: "KvResultError",
        code: "WRITE_REJECTED",
        status: 503,
      });
    } finally {
      partial.restore();
    }

    expect(writeKeys).toEqual([DEAD_KEY, PENDING_KEY]);
    expect(stored(node, PENDING_KEY).map((item) => item.meetingId)).toEqual([
      "M-TTL-AT-LEAST-ONCE",
    ]);
    const partialDead = stored(node, DEAD_KEY);
    expect(partialDead.map((item) => item.meetingId)).toEqual([
      "M-TTL-AT-LEAST-ONCE",
    ]);
    expect(partial.lines.some((line) => line.includes("op=dead-letter"))).toBe(
      false,
    );

    armed = false;
    const retried = await withLogs(() => queue.list(SOURCE, ADDRESS));
    expect(retried.result).toEqual([]);
    const converged = await queue.dead(SOURCE, ADDRESS);
    expect(converged.map((item) => item.meetingId)).toEqual([
      "M-TTL-AT-LEAST-ONCE",
    ]);
    expect(converged[0]!.deadAt).toBe(partialDead[0]!.deadAt);
    expect(
      retried.lines.filter((line) => line.includes("op=dead-letter")),
    ).toHaveLength(1);
  });
});

// ── Dead-letter cap (§5.3) ───────────────────────────────────────────

describe("dead-letter cap", () => {
  test("caps at its configured size, drops oldest, and logs the drop", async () => {
    const { queue } = createQueue({ maxDeadItems: 3 });

    const { lines } = await withLogs(async () => {
      for (let i = 0; i < 5; i += 1) {
        await queue.enqueue(SOURCE, ADDRESS, {
          meetingId: `M${i}`,
          kind: "transcript",
        });
        await queue.fail(
          SOURCE,
          ADDRESS,
          `M${i}`,
          "transcript",
          "write_rejected",
          {
            terminal: true,
          },
        );
      }
    });

    const dead = await queue.dead(SOURCE, ADDRESS);
    expect(dead.map((item) => item.meetingId)).toEqual(["M2", "M3", "M4"]);
    expect(lines.some((line) => line.includes("op=dead-drop-oldest"))).toBe(
      true,
    );
  });

  test("a cap eviction is logged after the dead-first write lands even when pending removal fails", async () => {
    const { node, queue } = createQueue({ maxDeadItems: 1 });
    await queue.enqueue(SOURCE, ADDRESS, {
      meetingId: "M-OLD-DEAD",
      kind: "transcript",
    });
    await queue.fail(
      SOURCE,
      ADDRESS,
      "M-OLD-DEAD",
      "transcript",
      "meeting_not_found",
      { terminal: true },
    );
    await queue.enqueue(SOURCE, ADDRESS, {
      meetingId: "M-NEW-DEAD",
      kind: "transcript",
    });

    const originalPut = node.kv.put.bind(node.kv);
    let writes = 0;
    node.kv.put = async (key: string, value: unknown) => {
      writes += 1;
      if (writes === 2) {
        return {
          ok: false,
          error: {
            code: "WRITE_REJECTED",
            message: "pending removal failed",
            service: "kv",
          },
        };
      }
      return originalPut(key, value);
    };

    const partial = captureLogs();
    try {
      await expect(
        queue.fail(
          SOURCE,
          ADDRESS,
          "M-NEW-DEAD",
          "transcript",
          "meeting_not_found",
          { terminal: true },
        ),
      ).rejects.toMatchObject({ code: "WRITE_REJECTED" });
    } finally {
      partial.restore();
    }

    expect(stored(node, DEAD_KEY).map((item) => item.meetingId)).toEqual([
      "M-NEW-DEAD",
    ]);
    expect(
      partial.lines.filter((line) => line.includes("op=dead-drop-oldest")),
    ).toHaveLength(1);
    expect(partial.lines.some((line) => line.includes("op=dead-letter"))).toBe(
      false,
    );
  });
});

// ── Container-level recovery (§5.3) ──────────────────────────────────

describe("container-level recovery", () => {
  test("a corrupt queue value is moved aside, op=queue-reset is logged, and the next enqueue succeeds", async () => {
    const { node, queue } = createQueue();
    node.store.set(PENDING_KEY, "{ this is not json");

    const { result, lines } = await withLogs(() =>
      queue.enqueue(SOURCE, ADDRESS, { meetingId: "M1", kind: "transcript" }),
    );

    // The address is not wedged.
    expect(result.status).toBe("queued");
    expect(await queue.depth(SOURCE, ADDRESS)).toBe(1);

    // The corrupt value is preserved verbatim for triage.
    expect(node.store.get(CORRUPT_KEY)).toBe("{ this is not json");

    const resetLine = lines.find((line) => line.includes("op=queue-reset"));
    expect(resetLine).toBeDefined();
    expect(resetLine).toContain("reason=unparseable");
    expect(resetLine).toContain(`moved_to=webhooks/corrupt/${SOURCE}`);
    // The key's last segment is the raw address, so the line names the prefix only (§6.3).
    expect(resetLine).not.toContain(LOWER);
    expect(resetLine).toMatch(/aid=[0-9a-f]{16}/);
  });

  test("a type-invalid queue value (not an array) resets the same way", async () => {
    const { node, queue } = createQueue();
    node.store.set(PENDING_KEY, { meetingId: "M9", kind: "transcript" });

    const { lines } = await withLogs(() =>
      queue.enqueue(SOURCE, ADDRESS, { meetingId: "M1", kind: "transcript" }),
    );

    expect(await queue.depth(SOURCE, ADDRESS)).toBe(1);
    expect(node.store.get(CORRUPT_KEY)).toEqual({
      meetingId: "M9",
      kind: "transcript",
    });
    expect(
      lines.some(
        (line) =>
          line.includes("op=queue-reset") &&
          line.includes("reason=not-an-array"),
      ),
    ).toBe(true);
  });

  test("individual invalid entries are dropped with their count logged — the valid ones survive", async () => {
    const { node, queue } = createQueue();
    node.store.set(PENDING_KEY, [
      {
        meetingId: "GOOD",
        kind: "transcript",
        receivedAt: new Date(T0).toISOString(),
        attempts: 0,
        nextAttemptAt: new Date(T0).toISOString(),
      },
      {
        meetingId: "../../threads/x",
        kind: "transcript",
        receivedAt: "x",
        attempts: 0,
      },
      {
        meetingId: "BAD2",
        kind: "note",
        receivedAt: new Date(T0).toISOString(),
        attempts: 0,
        nextAttemptAt: new Date(T0).toISOString(),
      },
      null,
    ]);

    const { lines } = await withLogs(() => queue.list(SOURCE, ADDRESS));

    const items = stored(node, PENDING_KEY) as Array<{ meetingId: string }>;
    expect(items.map((item) => item.meetingId)).toEqual(["GOOD"]);
    const dropLine = lines.find((line) => line.includes("op=drop-invalid"));
    expect(dropLine).toBeDefined();
    expect(dropLine).toContain("dropped=3");
    expect(dropLine).not.toContain("../../threads/x");
  });

  test("a corrupt DEAD-letter value does not wedge the pending queue either", async () => {
    const { node, queue } = createQueue();
    node.store.set(DEAD_KEY, "not json");

    await expect(
      queue.enqueue(SOURCE, ADDRESS, { meetingId: "M1", kind: "transcript" }),
    ).resolves.toMatchObject({ status: "queued" });
    expect(await queue.depth(SOURCE, ADDRESS)).toBe(1);
  });
});

// ── Ordering, clear, and no-op writes ────────────────────────────────

describe("ordering and lifecycle", () => {
  test("items come back oldest-receivedAt first (§5.6)", async () => {
    const { queue } = createQueue();
    await queue.enqueue(SOURCE, ADDRESS, {
      meetingId: "NEW",
      kind: "transcript",
      receivedAt: new Date(T0 + 10_000).toISOString(),
    });
    await queue.enqueue(SOURCE, ADDRESS, {
      meetingId: "OLD",
      kind: "transcript",
      receivedAt: new Date(T0).toISOString(),
    });

    expect(
      (await queue.list(SOURCE, ADDRESS)).map((item) => item.meetingId),
    ).toEqual(["OLD", "NEW"]);
  });

  test("clear drops both the pending queue and the dead-letter, idempotently (§3.6 rule 6)", async () => {
    const { node, queue } = createQueue();
    await queue.enqueue(SOURCE, ADDRESS, {
      meetingId: "M1",
      kind: "transcript",
    });
    await queue.enqueue(SOURCE, ADDRESS, {
      meetingId: "M2",
      kind: "transcript",
    });
    await queue.fail(SOURCE, ADDRESS, "M2", "transcript", "write_rejected", {
      terminal: true,
    });

    await queue.clear(SOURCE, ADDRESS);
    expect(node.store.has(PENDING_KEY)).toBe(false);
    expect(node.store.has(DEAD_KEY)).toBe(false);

    await queue.clear(SOURCE, ADDRESS);
    expect(await queue.depth(SOURCE, ADDRESS)).toBe(0);
    expect(await queue.dead(SOURCE, ADDRESS)).toHaveLength(0);
  });

  // ── F005: the clear/coalescing-batch race ──────────────────────────
  //
  // `enqueue` accepts into a 250 ms in-memory batch whose flush happens LATER, inside the
  // mutex. `clear` takes the same mutex — but an already-accepted batch is not in the mutex
  // yet, so a clear that ran first used to be undone by the flush that fired after it: the
  // re-enable that promised a clean slate came back with items in it. The batch must be
  // SUPERSEDED at the instant clear is called, not merely raced with.
  test("clear supersedes an accepted-but-unflushed batch — the flush cannot resurrect it (F005)", async () => {
    const { node, queue } = createQueue({ flushWindowMs: 50 });
    const accepted = queue.enqueue(SOURCE, ADDRESS, {
      meetingId: "M-INFLIGHT",
      kind: "transcript",
    });

    // Runs to completion well inside the 50 ms window, exactly as a re-enable would.
    const cleared = await queue.clear(SOURCE, ADDRESS);
    expect(cleared).toEqual({ cleared: 0, superseded: 1 });

    // The caller still gets an answer — a `dropped`, which the ingest route already treats as
    // a 202 byte-identical to a queued one (never an oracle for the victim's queue state).
    expect(await accepted).toEqual({ status: "dropped", depth: 0 });
    expect(node.store.has(PENDING_KEY)).toBe(false);
    expect(await queue.depth(SOURCE, ADDRESS)).toBe(0);
  });

  test("a delivery accepted AFTER the clear is queued normally — supersession is not sticky (F005)", async () => {
    const { queue } = createQueue({ flushWindowMs: 20 });
    await queue.clear(SOURCE, ADDRESS);
    const result = await queue.enqueue(SOURCE, ADDRESS, {
      meetingId: "M-AFTER",
      kind: "transcript",
    });

    expect(result.status).toBe("queued");
    expect(
      (await queue.list(SOURCE, ADDRESS)).map((item) => item.meetingId),
    ).toEqual(["M-AFTER"]);
  });

  // ── F010: queueDropped must be exact, not list-then-clear ──────────
  //
  // The teardown used to `list()` then `clear()`: anything enqueued between the two was
  // dropped but not counted, so `queueDropped` was a lower bound reported as a total. The
  // count now comes from the clear itself, inside the one lock that makes it atomic.
  test("clear returns the exact number of pending items it deleted (F010)", async () => {
    const { queue } = createQueue();
    for (const meetingId of ["M1", "M2", "M3"]) {
      await queue.enqueue(SOURCE, ADDRESS, { meetingId, kind: "transcript" });
    }

    expect(await queue.clear(SOURCE, ADDRESS)).toEqual({
      cleared: 3,
      superseded: 0,
    });
    // Idempotent: the second clear deleted nothing and says so.
    expect(await queue.clear(SOURCE, ADDRESS)).toEqual({
      cleared: 0,
      superseded: 0,
    });
  });

  test("the clear count is per-(source,address) and never counts another address's items (F010)", async () => {
    const { queue } = createQueue();
    const other = "0x2222222222222222222222222222222222222222";
    await queue.enqueue(SOURCE, ADDRESS, { meetingId: "M1", kind: "transcript" });
    await queue.enqueue(SOURCE, other, { meetingId: "M2", kind: "transcript" });
    await queue.enqueue(SOURCE, other, { meetingId: "M3", kind: "transcript" });

    expect((await queue.clear(SOURCE, ADDRESS)).cleared).toBe(1);
    expect((await queue.clear(SOURCE, other)).cleared).toBe(2);
  });

  test("the clear audit line carries the counts and no raw identifier (F010/§6.3)", async () => {
    const { queue } = createQueue();
    await queue.enqueue(SOURCE, ADDRESS, {
      meetingId: "MEETING-RAW-ID",
      kind: "transcript",
    });

    const { lines } = await withLogs(() => queue.clear(SOURCE, ADDRESS));
    const clearLine = lines.find((line) => line.includes("op=clear"));
    expect(clearLine).toBeDefined();
    expect(clearLine).toContain("cleared=1");
    expect(clearLine).toContain("superseded=0");
    expect(clearLine).not.toContain("MEETING-RAW-ID");
    expect(clearLine).not.toContain(LOWER);
  });

  test("the ack line's id list is capped so a caller cannot choose its width", async () => {
    // `POST /ack` accepts 200 identities per request and the deploy publishes
    // this stream with `--public-logs`, so an unbounded `mids=` let one
    // authenticated call pick the size of a public log record. No raw id leaks
    // either way (every entry is keyed-hashed) — this is record shape, and the
    // omission is COUNTED, never silent.
    const { queue } = createQueue();
    const ids = Array.from({ length: 25 }, (_, i) => `M${i}`);
    for (const meetingId of ids) {
      await queue.enqueue(SOURCE, ADDRESS, { meetingId, kind: "transcript" });
    }

    const { lines } = await withLogs(() =>
      queue.acknowledge(
        SOURCE,
        ADDRESS,
        ids.map((meetingId) => ({ meetingId, kind: "transcript" as const })),
      ),
    );
    const ackLine = lines.find((line) => line.includes("op=ack"));
    expect(ackLine).toBeDefined();
    expect(ackLine).toContain("removed=25");
    expect(ackLine).toContain("mids_omitted=5");
    const mids = /mids=([0-9a-f,]+)/.exec(ackLine ?? "")?.[1] ?? "";
    expect(mids.split(",")).toHaveLength(20);
  });

  test("a read that changes nothing writes nothing (W0 §6.2)", async () => {
    const { node, queue } = createQueue();
    await queue.enqueue(SOURCE, ADDRESS, {
      meetingId: "M1",
      kind: "transcript",
    });
    const writesAfterEnqueue = node.countCalls("put");

    await queue.list(SOURCE, ADDRESS);
    await queue.list(SOURCE, ADDRESS);
    await queue.due(SOURCE, ADDRESS);

    expect(node.countCalls("put")).toBe(writesAfterEnqueue);
  });

  test("queues for different addresses do not bleed into each other", async () => {
    const { queue } = createQueue();
    const other = "0x1111111111111111111111111111111111111111";
    await queue.enqueue(SOURCE, ADDRESS, {
      meetingId: "M1",
      kind: "transcript",
    });
    await queue.enqueue(SOURCE, other, { meetingId: "M2", kind: "transcript" });

    expect(
      (await queue.list(SOURCE, ADDRESS)).map((item) => item.meetingId),
    ).toEqual(["M1"]);
    expect(
      (await queue.list(SOURCE, other)).map((item) => item.meetingId),
    ).toEqual(["M2"]);
  });
});

// ── Durable KV Result{ok:false} — writes must fail loudly (§9.3) ─────
//
// The node SDK's KV surface resolves to a Result: `{ok:true,data}` on success and
// `{ok:false,error}` on a DURABLE failure — the promise no longer rejects on kv-side errors.
// Silently accepting `{ok:false}` reports "queued" while the write never landed, and the route's
// 202 rides on the queue's `resolve` (§4.6). The write path must therefore surface `{ok:false}`
// as a thrown error, so the public handler falls into its existing enqueue-error arm (503) and
// no `result=queued` is ever logged or drain kicked for a persist that never happened.

describe("durable kv Result{ok:false} surfacing", () => {
  const OK_FALSE = {
    ok: false,
    error: { code: "WRITE_REJECTED", message: "quota exhausted" },
  };

  test("enqueue rejects when kv.put returns Result{ok:false} — nothing lands, no silent queued", async () => {
    const { node, queue } = createQueue();
    node.overridePutResult = OK_FALSE;

    await expect(
      queue.enqueue(SOURCE, ADDRESS, { meetingId: "M1", kind: "transcript" }),
    ).rejects.toThrow(/kv operation failed/i);

    expect(node.store.has(PENDING_KEY)).toBe(false);
  });

  test("clear rejects when kv.delete returns Result{ok:false} — the address is not falsely cleared", async () => {
    const { node, queue } = createQueue();
    await queue.enqueue(SOURCE, ADDRESS, {
      meetingId: "M1",
      kind: "transcript",
    });
    node.overrideDeleteResult = OK_FALSE;

    await expect(queue.clear(SOURCE, ADDRESS)).rejects.toThrow(
      /kv operation failed/i,
    );
  });

  // ── §9.3 read-side hardening: readRaw must not read {ok:false} as "not present" ──
  //
  // Without the assertion on the read, `readState` sees `{present:false}`, the enqueue path
  // computes `items = [newItem]` and persist() writes that ONE-item array over whatever was
  // already stored — silently wiping the queue and shipping a 202 for the wipe. Reads must
  // reject the Result too.
  test("enqueue rejects when kv.get returns Result{ok:false} — the pending array is NOT overwritten", async () => {
    const { node, queue } = createQueue();
    // Seed prior state — three items already durably queued.
    await queue.enqueue(SOURCE, ADDRESS, {
      meetingId: "MPRIOR1",
      kind: "transcript",
    });
    await queue.enqueue(SOURCE, ADDRESS, {
      meetingId: "MPRIOR2",
      kind: "transcript",
    });
    await queue.enqueue(SOURCE, ADDRESS, {
      meetingId: "MPRIOR3",
      kind: "transcript",
    });
    const before = stored(node, PENDING_KEY);
    expect(before).toHaveLength(3);

    node.overrideGetResult = OK_FALSE;

    // A fresh enqueue while the read is failing must NOT successfully persist a new value: the
    // read fails, the enqueue rejects, and the stored array is left untouched by that write.
    await expect(
      queue.enqueue(SOURCE, ADDRESS, {
        meetingId: "MNEW",
        kind: "transcript",
      }),
    ).rejects.toThrow(/kv operation failed/i);

    // Restore the get path — the underlying pending array must still be the seeded three items,
    // never a one-item wipe.
    node.overrideGetResult = null;
    const after = stored(node, PENDING_KEY);
    expect(after).toEqual(before);
  });

  test("structured missing-key reads produce an absent queue without a repair write", async () => {
    const { node, queue } = createQueue();
    const requested: string[] = [];
    node.kv.get = async (key: string) => {
      requested.push(key);
      return {
        ok: false,
        error: {
          code: "KV_NOT_FOUND",
          message: `Key not found: ${key}`,
          service: "kv",
        },
      };
    };

    await expect(queue.list(SOURCE, ADDRESS)).resolves.toEqual([]);
    expect(requested).toEqual([PENDING_KEY, DEAD_KEY]);
    expect(node.store.size).toBe(0);
    expect(node.countCalls("put")).toBe(0);
  });

  test("structured missing-key deletes keep clear idempotent", async () => {
    const { node, queue } = createQueue();
    const deleted: string[] = [];
    node.kv.delete = async (key: string) => {
      deleted.push(key);
      return {
        ok: false,
        error: {
          code: "KV_NOT_FOUND",
          message: `Key not found: ${key}`,
          service: "kv",
        },
      };
    };

    await expect(queue.clear(SOURCE, ADDRESS)).resolves.toEqual({
      cleared: 0,
      superseded: 0,
    });
    expect(deleted).toEqual([PENDING_KEY, DEAD_KEY]);
    expect(node.store.size).toBe(0);
  });

  test("Space-not-found reads fail closed without overwriting durable queue state", async () => {
    const { node, queue } = createQueue();
    node.store.set(PENDING_KEY, [
      {
        meetingId: "M-PRESERVED",
        kind: "transcript",
        receivedAt: new Date(T0).toISOString(),
        attempts: 0,
        nextAttemptAt: new Date(T0).toISOString(),
      },
    ]);
    const before = new Map(node.store);
    node.overrideGetResult = {
      ok: false,
      error: {
        code: "KV_NOT_FOUND",
        message: "KV 404 - Space not found",
        service: "kv",
        meta: { status: 404 },
      },
    };

    await expect(queue.list(SOURCE, ADDRESS)).rejects.toMatchObject({
      code: "KV_NOT_FOUND",
    });
    expect(node.store).toEqual(before);
    expect(node.countCalls("put")).toBe(0);
  });

  test("Space-not-found deletes fail closed without clearing durable queue state", async () => {
    const { node, queue } = createQueue();
    node.store.set(PENDING_KEY, [{ meetingId: "M-PRESERVED" }]);
    node.store.set(DEAD_KEY, [{ meetingId: "M-DEAD-PRESERVED" }]);
    const before = new Map(node.store);
    node.overrideDeleteResult = {
      ok: false,
      error: {
        code: "KV_NOT_FOUND",
        message: "KV 404 - Space not found",
        service: "kv",
        meta: { status: 404 },
      },
    };

    await expect(queue.clear(SOURCE, ADDRESS)).rejects.toMatchObject({
      code: "KV_NOT_FOUND",
    });
    expect(node.store).toEqual(before);
    expect(node.countCalls("delete")).toBe(1);
  });
});

// ── Session-class Result{ok:false} rides the single-refresh retry ────
//
// `withSessionRefresh` re-signs-in and retries ONCE on a session-class thrown error. Because
// `assertKvResult` runs INSIDE that callback (see writeJson/readRaw/deleteKey), a Result
// carrying `error:"session expired"` throws a session-matching Error and takes the same retry
// path a thrown session error would. Structurally identical to
// packages/server/src/__tests__/delegation-store.test.ts:289-305 — parity here is what makes
// the queue's session-refresh contract observable, not merely present in the source.

describe("session-class Result{ok:false} takes the single sign-in + retry path", () => {
  test("kv.put returning {ok:false,error:'session expired'} fires exactly one signIn() + one put retry", async () => {
    let putCalls = 0;
    let signInCalls = 0;
    const store = new Map<string, unknown>();
    const node = {
      kv: {
        async get(key: string): Promise<unknown> {
          if (!store.has(key)) return { data: null };
          return { data: { data: store.get(key) } };
        },
        async put(key: string, value: unknown): Promise<unknown> {
          putCalls += 1;
          if (putCalls === 1) {
            return { ok: false, error: "session expired" };
          }
          store.set(key, JSON.parse(JSON.stringify(value)));
          return { ok: true, data: true };
        },
        async delete(key: string): Promise<unknown> {
          store.delete(key);
          return { ok: true, data: true };
        },
      },
      async signIn(): Promise<void> {
        signInCalls += 1;
      },
    } as unknown as TinyCloudNode;
    const clock = { now: T0 };
    const queue = new ConnectorQueue(node, {
      flushWindowMs: 1,
      now: () => clock.now,
      jitter: () => 0,
    });

    // Success on the retry, and the retried write actually landed.
    await queue.enqueue(SOURCE, ADDRESS, {
      meetingId: "MSESSION-PUT",
      kind: "transcript",
    });
    expect(signInCalls).toBe(1);
    // First put throws inside the refresh; the second put is the retry that actually persists.
    expect(putCalls).toBe(2);
    const persisted = store.get(PENDING_KEY);
    expect(Array.isArray(persisted)).toBe(true);
    expect((persisted as PendingItem[]).map((i) => i.meetingId)).toEqual([
      "MSESSION-PUT",
    ]);
  });

  test("kv.get returning {ok:false,error:'session expired'} fires exactly one signIn() + one get retry (no queue wipe)", async () => {
    // Seed durable state via a non-refresh path, then flip get to session-expire on the very
    // next read. The retry must resurface the seeded items — a bare `null` return would fall
    // into readState as `present:false` and let the next enqueue overwrite the pending array.
    let signInCalls = 0;
    const store = new Map<string, unknown>();
    store.set(PENDING_KEY, [
      {
        meetingId: "MSEED-1",
        kind: "transcript" as const,
        receivedAt: new Date(T0 - 3_000).toISOString(),
        sourceTimestamp: new Date(T0 - 3_000).toISOString(),
        attempts: 0,
        nextAttemptAt: new Date(T0 - 3_000).toISOString(),
      },
    ]);
    let getCalls = 0;
    let flipped = false;
    const node = {
      kv: {
        async get(key: string): Promise<unknown> {
          getCalls += 1;
          if (!flipped && key === PENDING_KEY) {
            flipped = true;
            return { ok: false, error: "session expired" };
          }
          if (!store.has(key)) return { data: null };
          return { data: { data: store.get(key) } };
        },
        async put(key: string, value: unknown): Promise<unknown> {
          store.set(key, JSON.parse(JSON.stringify(value)));
          return { ok: true, data: true };
        },
        async delete(key: string): Promise<unknown> {
          store.delete(key);
          return { ok: true, data: true };
        },
      },
      async signIn(): Promise<void> {
        signInCalls += 1;
      },
    } as unknown as TinyCloudNode;
    const clock = { now: T0 };
    const queue = new ConnectorQueue(node, {
      flushWindowMs: 1,
      now: () => clock.now,
      jitter: () => 0,
    });

    await queue.enqueue(SOURCE, ADDRESS, {
      meetingId: "MSESSION-GET",
      kind: "transcript",
    });
    expect(signInCalls).toBe(1);
    // First pending-get throws; the retry re-reads the pending array; dead-get runs once.
    expect(getCalls).toBeGreaterThanOrEqual(3);
    // The seeded row survives: retry read the real value, so persist appends rather than
    // overwriting with a one-item array.
    const persisted = store.get(PENDING_KEY) as PendingItem[];
    expect(persisted.map((i) => i.meetingId)).toEqual([
      "MSEED-1",
      "MSESSION-GET",
    ]);
  });

  test("kv.delete returning {ok:false,error:'session expired'} fires exactly one signIn() + one delete retry", async () => {
    let signInCalls = 0;
    let deleteCalls = 0;
    const store = new Map<string, unknown>();
    const node = {
      kv: {
        async get(_key: string): Promise<unknown> {
          return { data: null };
        },
        async put(key: string, value: unknown): Promise<unknown> {
          store.set(key, JSON.parse(JSON.stringify(value)));
          return { ok: true, data: true };
        },
        async delete(key: string): Promise<unknown> {
          deleteCalls += 1;
          // The FIRST delete (pending key) session-expires; the retry (call #2) succeeds; the
          // dead-key delete (call #3) succeeds normally — assertion counts the whole shape.
          if (deleteCalls === 1) {
            return { ok: false, error: "session expired" };
          }
          store.delete(key);
          return { ok: true, data: true };
        },
      },
      async signIn(): Promise<void> {
        signInCalls += 1;
      },
    } as unknown as TinyCloudNode;
    const clock = { now: T0 };
    const queue = new ConnectorQueue(node, {
      flushWindowMs: 1,
      now: () => clock.now,
      jitter: () => 0,
    });

    // A prior enqueue so `clear` has something to remove — it exercises the delete lane.
    await queue.enqueue(SOURCE, ADDRESS, {
      meetingId: "M-CLEAR-SEED",
      kind: "transcript",
    });
    deleteCalls = 0;

    await queue.clear(SOURCE, ADDRESS);
    expect(signInCalls).toBe(1);
    // Pending-delete throws + retries (2 calls) + dead-delete succeeds (1 call).
    expect(deleteCalls).toBe(3);
  });
});

// ── Maintenance sweep: the only background work Option C keeps ───────
//
// Under Option C nothing on the server writes meeting content, so the background timer is a
// TTL / dead-letter sweep and nothing else. It must return COUNTS, never ids: a maintenance
// pass performs no purge-ledger read, so an id it handed to a caller would be an ungated
// surface. The retention promise is what earns the tick — an abandoned connector's queue is
// otherwise swept only if a delivery or a user visit happens to touch it.

describe("maintenance sweep", () => {
  test("applies the TTL promotion and reports counts, never ids", async () => {
    const { node, queue, clock } = createQueue();
    await queue.enqueue(SOURCE, ADDRESS, {
      meetingId: "M1",
      kind: "transcript",
    });
    await queue.enqueue(SOURCE, ADDRESS, {
      meetingId: "M2",
      kind: "transcript",
    });

    clock.now = T0 + QUEUE_TTL_MS + 1;
    const result = await queue.sweep(SOURCE, ADDRESS);

    expect(result).toEqual({ pending: 0, dead: 2 });
    expect(JSON.stringify(result)).not.toContain("M1");
    // The promotion is durable, not a view: a later read sees the swept state.
    expect(stored(node, PENDING_KEY)).toEqual([]);
  });

  test("is a no-op that surfaces nothing when nothing has expired", async () => {
    const { queue } = createQueue();
    await queue.enqueue(SOURCE, ADDRESS, {
      meetingId: "M1",
      kind: "transcript",
    });

    expect(await queue.sweep(SOURCE, ADDRESS)).toEqual({
      pending: 1,
      dead: 0,
    });
    expect(await queue.depth(SOURCE, ADDRESS)).toBe(1);
  });

  test("rejects a traversal address rather than building the key", async () => {
    const { queue } = createQueue();
    await expect(queue.sweep(SOURCE, "../../delegations/0xabc")).rejects.toThrow(
      /Invalid webhook config address/,
    );
  });
});

// ── Log hygiene (§6.3) ───────────────────────────────────────────────

describe("log hygiene", () => {
  test("no queue line carries a raw address, a raw meeting id, or a spaceId", async () => {
    const { queue, clock } = createQueue();

    const { lines } = await withLogs(async () => {
      await queue.enqueue(SOURCE, ADDRESS, {
        meetingId: "MEETING-RAW-ID",
        kind: "transcript",
      });
      await queue.fail(
        SOURCE,
        ADDRESS,
        "MEETING-RAW-ID",
        "transcript",
        "write_rejected",
        {
          terminal: true,
        },
      );
      clock.now += 1_000;
      await queue.list(SOURCE, ADDRESS);
    });

    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toContain("MEETING-RAW-ID");
      expect(line).not.toContain(LOWER);
      expect(line).not.toContain(ADDRESS.slice(2, 8));
      expect(line).not.toContain("spaceId");
      expect(line).toContain("[connector-queue]");
    }
    expect(
      lines.some(
        (line) => line.includes("op=enqueue") && /aid=[0-9a-f]{16}/.test(line),
      ),
    ).toBe(true);
  });

  test("an unset LOG_HASH_SALT drops the field rather than emitting an unsalted id", async () => {
    delete process.env.LOG_HASH_SALT;
    const { queue } = createQueue();

    const { lines } = await withLogs(() =>
      queue.enqueue(SOURCE, ADDRESS, {
        meetingId: "MEETING-RAW-ID",
        kind: "transcript",
      }),
    );

    expect(lines.some((line) => line.includes("mid=unavailable"))).toBe(true);
    for (const line of lines) expect(line).not.toContain("MEETING-RAW-ID");
  });
});
