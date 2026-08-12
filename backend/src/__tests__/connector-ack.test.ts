import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import express from "express";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import {
  ACK_ITEMS_PER_REQUEST_CAP,
  ConnectorDrainAbortFlags,
  ConnectorWebhookLimiters,
  createConnectorWebhookCompanionRouter,
  type ConnectorControl,
  type DisabledMarker,
  type PurgeLedger,
  type PurgeLedgerRead,
} from "../routes/connector-webhooks.js";
import {
  ConnectorQueue,
  LEDGER_UNAVAILABLE,
  type AcknowledgeInput,
  type AcknowledgeResult,
  type ClearResult,
  type DeadItem,
  type PendingItem,
  type PendingKind,
} from "../services/connector-queue.js";
import { CONNECTOR_COMPANION_PATHS } from "../rate-limits.js";
import {
  _resetWebhookTokenState,
  generateWebhookToken,
  type WebhookConfigRecord,
  type WebhookTokenRecord,
} from "../services/webhook-tokens.js";

/**
 * BE3 — the acknowledgement/settlement companion (`POST /api/connectors/webhooks/ack`) and the
 * `ConnectorQueue` settlement method behind it.
 *
 * Under OPTION C the BROWSER is the writer: it fetches the exact queued id with the user's own
 * Fireflies key, writes SQL + KV into the user's own space, and only THEN tells the backend the
 * item is settled. This route is that "and only then". Everything it must not do follows from
 * the fact that its one input is a browser assertion:
 *
 *  - address and source come from the SESSION and the stored config, never from the body;
 *  - every id and kind is validated BEFORE anything is mutated;
 *  - it removes ONLY the exact `(meetingId, kind)` identities acknowledged;
 *  - acking an id that is already gone SUCCEEDS (the browser stored the meeting and then lost
 *    the response — a retry must converge, not resurrect or 4xx forever);
 *  - the disabled marker and the purge ledger are re-applied here, because an ack is the last
 *    place a revoked or tombstoned identity could be re-classified as legitimately ingested;
 *  - failures are NOT accepted in this version, and no browser-supplied error string reaches a
 *    log line.
 */

const ORIGINAL_ENV = { ...process.env };

const SOURCE = "fireflies";
const ADDRESS = "0x7d033300000000000000000000000000000073f2";
const OTHER_ADDRESS = "0xb1b1b10000000000000000000000000000001111";
const MASTER = "3H8Qk0m2yq1sZ0VjK5xPwq0nA6oJ2bL9dR4tW7uY1cM=";
const LOG_SALT = "aQ2wS3eD4rF5tG6yH7uJ8iK9oL0pZ1xC2vB3nM4kJ5h=";

const T0 = Date.parse("2026-08-04T12:00:00.000Z");

function captureLogs(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  const record = (...args: unknown[]) => {
    lines.push(
      args.map((a) => (typeof a === "string" ? a : String(a))).join(" "),
    );
  };
  console.log = record;
  console.warn = record;
  console.error = record;
  return {
    lines,
    restore: () => {
      console.log = originalLog;
      console.warn = originalWarn;
      console.error = originalError;
    },
  };
}

// ── Fakes ────────────────────────────────────────────────────────────

/**
 * Every collaborator call that costs a node round trip lands here, in order. The
 * ack route's COST is a contract, not an implementation detail: the companion
 * bucket is 600 requests/15 min/IP and exempt from `globalLimiter`, so a route
 * that reads five things twice hands one authenticated session thousands of
 * reads against the single-writer node every tenant shares. `connector-drain.ts`
 * grew `forcedMinIntervalMs` for exactly this, and the suites there assert
 * behaviour but not cost — so this array is what stops the duplicate read from
 * coming back.
 */
type Trips = string[];

class FakeTokens {
  readonly configs = new Map<string, WebhookConfigRecord>();
  constructor(private readonly trips: Trips = []) {}

  async config(address: string): Promise<WebhookConfigRecord | null> {
    this.trips.push("config");
    return this.configs.get(address.toLowerCase()) ?? null;
  }

  async mint(address: string, source: string) {
    return this.issue(address, source);
  }

  async rotate(address: string, source: string) {
    return this.issue(address, source);
  }

  async revoke(address: string): Promise<void> {
    this.configs.delete(address.toLowerCase());
  }

  enable(address: string, source = SOURCE): void {
    void this.issue(address, source);
  }

  private issue(address: string, source: string) {
    const previous = this.configs.get(address.toLowerCase()) ?? null;
    const token = generateWebhookToken();
    const createdAt = new Date(T0).toISOString();
    this.configs.set(address.toLowerCase(), { token, source, createdAt });
    const record: WebhookTokenRecord = {
      address: address.toLowerCase(),
      source,
      createdAt,
    };
    return { token, record, rotatedFrom: previous?.token ?? null };
  }
}

/**
 * A queue fake with REAL identity semantics: settlement removes the exact `(meetingId, kind)`
 * and nothing else, and an unknown identity is reported rather than invented. The `ConnectorQueue`
 * itself is exercised directly further down against a fake node.
 */
class FakeQueue {
  readonly items = new Map<string, PendingItem[]>();
  readonly deadItems = new Map<string, DeadItem[]>();
  readonly ops: string[] = [];
  constructor(private readonly trips: Trips = []) {}

  private key(source: string, address: string): string {
    return `${source}/${address.toLowerCase()}`;
  }

  seed(
    source: string,
    address: string,
    entries: Array<{
      meetingId: string;
      kind: PendingKind;
      sourceTimestamp?: string;
    }>,
  ): void {
    this.items.set(
      this.key(source, address),
      entries.map((entry, i) => ({
        meetingId: entry.meetingId,
        kind: entry.kind,
        receivedAt: new Date(T0 + i).toISOString(),
        sourceTimestamp:
          entry.sourceTimestamp ?? new Date(T0 + i).toISOString(),
        attempts: 0,
        nextAttemptAt: new Date(T0 + i).toISOString(),
      })),
    );
  }

  identities(source: string, address: string): string[] {
    return (this.items.get(this.key(source, address)) ?? []).map(
      (item) => `${item.kind}:${item.meetingId}`,
    );
  }

  async list(source: string, address: string): Promise<PendingItem[]> {
    this.trips.push("list");
    return this.items.get(this.key(source, address)) ?? [];
  }

  async dead(source: string, address: string): Promise<DeadItem[]> {
    this.trips.push("dead");
    return this.deadItems.get(this.key(source, address)) ?? [];
  }

  /** F010: the real queue reports what it deleted; the fake mirrors that contract. */
  async clear(source: string, address: string): Promise<ClearResult> {
    this.ops.push(`clear:${this.key(source, address)}`);
    const cleared = (this.items.get(this.key(source, address)) ?? []).length;
    this.items.delete(this.key(source, address));
    this.deadItems.delete(this.key(source, address));
    return { cleared, superseded: 0 };
  }

  async acknowledge(
    source: string,
    address: string,
    acks: AcknowledgeInput[],
  ): Promise<AcknowledgeResult[]> {
    this.trips.push("acknowledge");
    this.ops.push(`acknowledge:${this.key(source, address)}:${acks.length}`);
    const key = this.key(source, address);
    let items = this.items.get(key) ?? [];
    const results: AcknowledgeResult[] = [];
    for (const ack of acks) {
      const index = items.findIndex(
        (item) => item.meetingId === ack.meetingId && item.kind === ack.kind,
      );
      if (index === -1) {
        results.push({ ...ack, disposition: "not-queued" });
        continue;
      }
      items = items.filter((_, i) => i !== index);
      results.push({ ...ack, disposition: "removed" });
    }
    this.items.set(key, items);
    return results;
  }
}

class FakeControl implements ConnectorControl {
  readonly markers = new Map<string, DisabledMarker>();
  readonly ledgers = new Map<string, PurgeLedger>();
  readonly corrupt = new Map<string, unknown>();
  unparseableLedger: string | null = null;
  failLedgerReadWith: Error | null = null;
  constructor(private readonly trips: Trips = []) {}

  private key(source: string, address: string): string {
    return `${source}/${address.toLowerCase()}`;
  }

  async readDisabled(address: string): Promise<DisabledMarker | null> {
    this.trips.push("readDisabled");
    return this.markers.get(address.toLowerCase()) ?? null;
  }

  async markDisabled(address: string, source: string | null): Promise<void> {
    this.markers.set(address.toLowerCase(), {
      revokedAt: new Date(T0).toISOString(),
      source,
    });
  }

  async clearDisabled(address: string): Promise<void> {
    this.markers.delete(address.toLowerCase());
  }

  async readLedger(source: string, address: string): Promise<PurgeLedgerRead> {
    this.trips.push("readLedger");
    if (this.failLedgerReadWith !== null) throw this.failLedgerReadWith;
    if (this.unparseableLedger !== null) {
      return { status: "unparseable", raw: this.unparseableLedger };
    }
    const ledger = this.ledgers.get(this.key(source, address));
    return ledger === undefined
      ? { status: "absent" }
      : { status: "ok", ledger };
  }

  async writeLedger(
    source: string,
    address: string,
    ledger: PurgeLedger,
  ): Promise<void> {
    this.ledgers.set(this.key(source, address), ledger);
  }

  async clearLedger(source: string, address: string): Promise<void> {
    this.ledgers.delete(this.key(source, address));
  }

  async quarantineLedger(
    source: string,
    address: string,
    raw: unknown,
  ): Promise<void> {
    this.corrupt.set(this.key(source, address), raw);
  }
}

interface Harness {
  app: express.Express;
  tokens: FakeTokens;
  queue: FakeQueue;
  control: FakeControl;
  /** Every collaborator call that costs a node round trip, in order. */
  trips: Trips;
  /** Mutable so a single app can act as two different signed-in users. */
  session: { address: string | null };
}

function createHarness(): Harness {
  const trips: Trips = [];
  const tokens = new FakeTokens(trips);
  const queue = new FakeQueue(trips);
  const control = new FakeControl(trips);
  const session: { address: string | null } = { address: ADDRESS };
  // ipLimit 0 / tokenSuccessLimit 0 ⇒ the PUBLIC webhook chain trips on its first counted
  // request. The companion must never touch it (§4.4: the companion bucket, not this one and
  // not globalLimiter).
  const limiters = new ConnectorWebhookLimiters({
    ipLimit: 0,
    tokenSuccessLimit: 0,
  });

  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "1mb" }));
  app.use((req, _res, next) => {
    if (session.address !== null) req.user = { address: session.address };
    next();
  });
  app.use(
    "/api/connectors/webhooks",
    createConnectorWebhookCompanionRouter({
      tokens,
      queue,
      control,
      limiters,
      abort: new ConnectorDrainAbortFlags(),
      now: () => T0,
    }),
  );

  return { app, tokens, queue, control, trips, session };
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

function ack(base: string, body: unknown): Promise<Response> {
  return fetch(`${base}/api/connectors/webhooks/ack`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  process.env.WEBHOOK_HMAC_MASTER = MASTER;
  process.env.LOG_HASH_SALT = LOG_SALT;
  delete process.env.WEBHOOK_HMAC_MASTER_PREV;
  _resetWebhookTokenState();
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
  _resetWebhookTokenState();
});

// ── Ownership: session and config, never the body ────────────────────

describe("POST /ack ownership", () => {
  test("401s an unauthenticated caller and mutates nothing", async () => {
    const h = createHarness();
    h.session.address = null;
    h.tokens.enable(ADDRESS);
    h.queue.seed(SOURCE, ADDRESS, [
      { meetingId: "01MEETINGAAA", kind: "transcript" },
    ]);

    await withServer(h.app, async (base) => {
      const res = await ack(base, {
        items: [{ meetingId: "01MEETINGAAA", kind: "transcript" }],
      });
      expect(res.status).toBe(401);
      expect(h.queue.identities(SOURCE, ADDRESS)).toEqual([
        "transcript:01MEETINGAAA",
      ]);
      expect(h.queue.ops).toEqual([]);
    });
  });

  test("a body `address` is IGNORED — the session owns the queue", async () => {
    const h = createHarness();
    h.tokens.enable(ADDRESS);
    h.tokens.enable(OTHER_ADDRESS);
    h.queue.seed(SOURCE, ADDRESS, [
      { meetingId: "01MEETINGAAA", kind: "transcript" },
    ]);
    h.queue.seed(SOURCE, OTHER_ADDRESS, [
      { meetingId: "01MEETINGAAA", kind: "transcript" },
    ]);

    await withServer(h.app, async (base) => {
      const res = await ack(base, {
        address: OTHER_ADDRESS,
        items: [{ meetingId: "01MEETINGAAA", kind: "transcript" }],
      });
      expect(res.status).toBe(200);
      // The SESSION user's item went; the named victim's queue is untouched.
      expect(h.queue.identities(SOURCE, ADDRESS)).toEqual([]);
      expect(h.queue.identities(SOURCE, OTHER_ADDRESS)).toEqual([
        "transcript:01MEETINGAAA",
      ]);
    });
  });

  test("a body `source` that is not the caller's configured source is rejected", async () => {
    const h = createHarness();
    h.tokens.enable(ADDRESS);
    h.queue.seed(SOURCE, ADDRESS, [
      { meetingId: "01MEETINGAAA", kind: "transcript" },
    ]);

    await withServer(h.app, async (base) => {
      const unregistered = await ack(base, {
        source: "not-registered",
        items: [{ meetingId: "01MEETINGAAA", kind: "transcript" }],
      });
      expect(unregistered.status).toBe(400);
      expect(await unregistered.json()).toEqual({ error: "unknown_source" });
      expect(h.queue.identities(SOURCE, ADDRESS)).toEqual([
        "transcript:01MEETINGAAA",
      ]);
      expect(h.queue.ops).toEqual([]);
    });
  });

  test("no body source at all still settles against the CONFIGURED source", async () => {
    const h = createHarness();
    h.tokens.enable(ADDRESS);
    h.queue.seed(SOURCE, ADDRESS, [
      { meetingId: "01MEETINGAAA", kind: "transcript" },
    ]);

    await withServer(h.app, async (base) => {
      const res = await ack(base, {
        items: [{ meetingId: "01MEETINGAAA", kind: "transcript" }],
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        status: string;
        acknowledged: number;
        source: string | null;
      };
      expect(body.status).toBe("acknowledged");
      expect(body.acknowledged).toBe(1);
      expect(body.source).toBe(SOURCE);
      expect(h.queue.identities(SOURCE, ADDRESS)).toEqual([]);
    });
  });
});

// ── Validation BEFORE mutation ───────────────────────────────────────

describe("POST /ack validation", () => {
  const seeded = [
    { meetingId: "01MEETINGAAA", kind: "transcript" as const },
    { meetingId: "01MEETINGBBB", kind: "summary" as const },
  ];

  async function rejects(
    body: unknown,
    status: number,
    error: string,
  ): Promise<void> {
    const h = createHarness();
    h.tokens.enable(ADDRESS);
    h.queue.seed(SOURCE, ADDRESS, seeded);
    await withServer(h.app, async (base) => {
      const res = await ack(base, body);
      expect(res.status).toBe(status);
      expect(((await res.json()) as { error: string }).error).toBe(error);
      // Nothing validated ⇒ nothing settled: the whole batch is rejected.
      expect(h.queue.identities(SOURCE, ADDRESS)).toEqual([
        "transcript:01MEETINGAAA",
        "summary:01MEETINGBBB",
      ]);
      expect(h.queue.ops).toEqual([]);
    });
  }

  test("a missing / non-array / empty `items` is a 400", async () => {
    await rejects({}, 400, "invalid_body");
    await rejects({ items: "01MEETINGAAA" }, 400, "invalid_body");
    await rejects({ items: [] }, 400, "invalid_body");
  });

  test("more ids than the per-request cap is a 400, never a silent truncation", async () => {
    await rejects(
      {
        items: Array.from(
          { length: ACK_ITEMS_PER_REQUEST_CAP + 1 },
          (_, i) => ({
            meetingId: `01MEETING${String(i).padStart(6, "0")}`,
            kind: "transcript",
          }),
        ),
      },
      400,
      "invalid_body",
    );
  });

  test("ONE bad meeting id rejects the whole batch — traversal, length, type", async () => {
    for (const meetingId of [
      "../../delegations/0xabc",
      "01MEETING/AAA",
      "a".repeat(65),
      "",
      42,
      null,
      { meetingId: "01MEETINGAAA" },
    ]) {
      await rejects(
        {
          items: [
            { meetingId: "01MEETINGAAA", kind: "transcript" },
            { meetingId, kind: "transcript" },
          ],
        },
        400,
        "invalid_meeting_id",
      );
    }
  });

  test("an unknown kind rejects the whole batch", async () => {
    for (const kind of ["Transcript", "notes", "", 1, null, undefined]) {
      await rejects(
        {
          items: [
            { meetingId: "01MEETINGAAA", kind: "transcript" },
            { meetingId: "01MEETINGBBB", kind },
          ],
        },
        400,
        "invalid_kind",
      );
    }
  });

  test("a non-object element rejects the whole batch", async () => {
    await rejects({ items: ["01MEETINGAAA"] }, 400, "invalid_body");
    await rejects({ items: [null] }, 400, "invalid_body");
  });
});

// ── SUCCESS acks only ────────────────────────────────────────────────

describe("POST /ack accepts successes only", () => {
  test("a browser-reported FAILURE is refused and the item stays queued for retry", async () => {
    const h = createHarness();
    h.tokens.enable(ADDRESS);
    h.queue.seed(SOURCE, ADDRESS, [
      { meetingId: "01MEETINGAAA", kind: "transcript" },
    ]);

    const logs = captureLogs();
    try {
      await withServer(h.app, async (base) => {
        const res = await ack(base, {
          items: [
            {
              meetingId: "01MEETINGAAA",
              kind: "transcript",
              status: "failed",
              error: "FIREFLIES-SAID-boom\nforged log line",
            },
          ],
        });
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: "unsupported_ack_status" });
        expect(h.queue.identities(SOURCE, ADDRESS)).toEqual([
          "transcript:01MEETINGAAA",
        ]);
        expect(h.queue.ops).toEqual([]);
      });
    } finally {
      logs.restore();
    }

    // §6.3: a browser-supplied error string is never an operational log field.
    const joined = logs.lines.join("\n");
    expect(joined).not.toContain("FIREFLIES-SAID");
    expect(joined).not.toContain("forged log line");
  });

  test("an explicit `status: \"done\"` is the accepted form", async () => {
    const h = createHarness();
    h.tokens.enable(ADDRESS);
    h.queue.seed(SOURCE, ADDRESS, [
      { meetingId: "01MEETINGAAA", kind: "transcript" },
    ]);

    await withServer(h.app, async (base) => {
      const res = await ack(base, {
        items: [
          { meetingId: "01MEETINGAAA", kind: "transcript", status: "done" },
        ],
      });
      expect(res.status).toBe(200);
      expect(h.queue.identities(SOURCE, ADDRESS)).toEqual([]);
    });
  });
});

// ── Targeted removal, idempotency, partial batches ───────────────────

describe("POST /ack settlement", () => {
  test("removes ONLY the acknowledged (meetingId, kind) identity", async () => {
    const h = createHarness();
    h.tokens.enable(ADDRESS);
    h.queue.seed(SOURCE, ADDRESS, [
      { meetingId: "01MEETINGAAA", kind: "transcript" },
      // Same id, different kind: a summary event is a DISTINCT queue identity.
      { meetingId: "01MEETINGAAA", kind: "summary" },
      { meetingId: "01MEETINGBBB", kind: "transcript" },
    ]);

    await withServer(h.app, async (base) => {
      const res = await ack(base, {
        items: [{ meetingId: "01MEETINGAAA", kind: "transcript" }],
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        acknowledged: number;
        alreadySettled: number;
        count: number;
      };
      expect(body.acknowledged).toBe(1);
      expect(body.alreadySettled).toBe(0);
      expect(h.queue.identities(SOURCE, ADDRESS)).toEqual([
        "summary:01MEETINGAAA",
        "transcript:01MEETINGBBB",
      ]);
      // The card gets the caller's own remaining queue back.
      expect(body.count).toBe(2);
    });
  });

  test("a partial batch settles the successes and leaves the rest queued", async () => {
    const h = createHarness();
    h.tokens.enable(ADDRESS);
    h.queue.seed(SOURCE, ADDRESS, [
      { meetingId: "01MEETINGAAA", kind: "transcript" },
      { meetingId: "01MEETINGBBB", kind: "transcript" },
      { meetingId: "01MEETINGCCC", kind: "transcript" },
    ]);

    await withServer(h.app, async (base) => {
      const res = await ack(base, {
        items: [
          { meetingId: "01MEETINGAAA", kind: "transcript" },
          { meetingId: "01MEETINGCCC", kind: "transcript" },
        ],
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { acknowledged: number }).acknowledged).toBe(
        2,
      );
      expect(h.queue.identities(SOURCE, ADDRESS)).toEqual([
        "transcript:01MEETINGBBB",
      ]);
    });
  });

  test("re-acking an already-removed id SUCCEEDS — the lost-response retry converges", async () => {
    const h = createHarness();
    h.tokens.enable(ADDRESS);
    h.queue.seed(SOURCE, ADDRESS, [
      { meetingId: "01MEETINGAAA", kind: "transcript" },
    ]);

    await withServer(h.app, async (base) => {
      const first = await ack(base, {
        items: [{ meetingId: "01MEETINGAAA", kind: "transcript" }],
      });
      expect(first.status).toBe(200);

      // The browser stored the meeting but never saw the response, so it asks again.
      const second = await ack(base, {
        items: [{ meetingId: "01MEETINGAAA", kind: "transcript" }],
      });
      expect(second.status).toBe(200);
      const body = (await second.json()) as {
        status: string;
        acknowledged: number;
        alreadySettled: number;
        count: number;
      };
      expect(body.status).toBe("acknowledged");
      expect(body.acknowledged).toBe(0);
      expect(body.alreadySettled).toBe(1);
      expect(body.count).toBe(0);
    });
  });

  test("acking an id that was never queued is not an error and creates nothing", async () => {
    const h = createHarness();
    h.tokens.enable(ADDRESS);
    h.queue.seed(SOURCE, ADDRESS, []);

    await withServer(h.app, async (base) => {
      const res = await ack(base, {
        items: [{ meetingId: "01NEVERQUEUED", kind: "summary" }],
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        acknowledged: number;
        alreadySettled: number;
      };
      expect(body.acknowledged).toBe(0);
      expect(body.alreadySettled).toBe(1);
      expect(h.queue.identities(SOURCE, ADDRESS)).toEqual([]);
    });
  });
});

// ── Fail-closed: revoked, tombstoned, unreadable ledger ──────────────

describe("POST /ack re-applies the disabled marker and the purge ledger", () => {
  test("a standing disabled marker settles NOTHING and reports `revoked`", async () => {
    const h = createHarness();
    h.tokens.enable(ADDRESS);
    h.queue.seed(SOURCE, ADDRESS, [
      { meetingId: "01MEETINGAAA", kind: "transcript" },
    ]);
    await h.control.markDisabled(ADDRESS, SOURCE);

    await withServer(h.app, async (base) => {
      const res = await ack(base, {
        items: [{ meetingId: "01MEETINGAAA", kind: "transcript" }],
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        acknowledged: number;
        surfaceBlocked?: string;
        enabled: boolean;
        count: number;
      };
      expect(body.acknowledged).toBe(0);
      expect(body.surfaceBlocked).toBe("revoked");
      expect(body.enabled).toBe(false);
      expect(body.count).toBe(0);
      expect(h.queue.ops).toEqual([]);
      expect(h.queue.identities(SOURCE, ADDRESS)).toEqual([
        "transcript:01MEETINGAAA",
      ]);
    });
  });

  test("no config at all is an idempotent no-op, not a 4xx and not new backend state", async () => {
    const h = createHarness();

    await withServer(h.app, async (base) => {
      const res = await ack(base, {
        items: [{ meetingId: "01MEETINGAAA", kind: "transcript" }],
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        acknowledged: number;
        alreadySettled: number;
        enabled: boolean;
      };
      expect(body.acknowledged).toBe(0);
      expect(body.alreadySettled).toBe(1);
      expect(body.enabled).toBe(false);
      expect(h.queue.ops).toEqual([]);
    });
  });

  test("an UNPARSEABLE purge ledger settles nothing and reports ledger_unavailable", async () => {
    const h = createHarness();
    h.tokens.enable(ADDRESS);
    h.queue.seed(SOURCE, ADDRESS, [
      { meetingId: "01MEETINGAAA", kind: "transcript" },
    ]);
    h.control.unparseableLedger = "}{ not a ledger";

    await withServer(h.app, async (base) => {
      const res = await ack(base, {
        items: [{ meetingId: "01MEETINGAAA", kind: "transcript" }],
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        acknowledged: number;
        surfaceBlocked?: string;
      };
      expect(body.acknowledged).toBe(0);
      expect(body.surfaceBlocked).toBe(LEDGER_UNAVAILABLE);
      expect(h.queue.ops).toEqual([]);
      expect(h.queue.identities(SOURCE, ADDRESS)).toEqual([
        "transcript:01MEETINGAAA",
      ]);
    });
  });

  test("a THROWING purge ledger read settles nothing either", async () => {
    const h = createHarness();
    h.tokens.enable(ADDRESS);
    h.queue.seed(SOURCE, ADDRESS, [
      { meetingId: "01MEETINGAAA", kind: "transcript" },
    ]);
    h.control.failLedgerReadWith = new Error("kv down");

    const logs = captureLogs();
    try {
      await withServer(h.app, async (base) => {
        const res = await ack(base, {
          items: [{ meetingId: "01MEETINGAAA", kind: "transcript" }],
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          acknowledged: number;
          surfaceBlocked?: string;
        };
        expect(body.acknowledged).toBe(0);
        expect(body.surfaceBlocked).toBe(LEDGER_UNAVAILABLE);
        expect(h.queue.ops).toEqual([]);
      });
    } finally {
      logs.restore();
    }
  });

  test("a TOMBSTONED id is not settled and is not counted as ingested", async () => {
    const h = createHarness();
    h.tokens.enable(ADDRESS);
    h.queue.seed(SOURCE, ADDRESS, [
      { meetingId: "01PURGEDAAA", kind: "transcript" },
      { meetingId: "01MEETINGBBB", kind: "transcript" },
    ]);
    h.control.ledgers.set(`${SOURCE}/${ADDRESS.toLowerCase()}`, {
      purgedThrough: new Date(T0 - 1).toISOString(),
      recentIds: ["01PURGEDAAA"],
      updatedAt: new Date(T0).toISOString(),
    });

    await withServer(h.app, async (base) => {
      const res = await ack(base, {
        items: [
          { meetingId: "01PURGEDAAA", kind: "transcript" },
          { meetingId: "01MEETINGBBB", kind: "transcript" },
        ],
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        acknowledged: number;
        tombstoned: number;
      };
      // The purged id is NOT settled: an ack must not re-classify tombstoned work as ingested.
      expect(body.acknowledged).toBe(1);
      expect(body.tombstoned).toBe(1);
      expect(h.queue.identities(SOURCE, ADDRESS)).toEqual([
        "transcript:01PURGEDAAA",
      ]);
    });
  });
});

// ── Cost against the shared single-writer node ───────────────────────
//
// The companion bucket is 600 requests / 15 min / IP and is exempt from
// `globalLimiter`, so the per-call round-trip count IS the amplification factor
// one authenticated session can aim at storage every other tenant shares. The
// route used to read config, marker, ledger and the pending list, and then let
// `pendingPayload` read all four AGAIN to build the response — ten round trips
// for a 200-id batch that wrote nothing. `connector-drain.ts` grew
// `forcedMinIntervalMs` for the same class of problem; a mutation endpoint whose
// legitimate client sends batches back to back cannot take a replay floor, so
// the fix is to stop paying twice for the same reads.

describe("POST /ack cost", () => {
  test("reads each input ONCE — no duplicate state read to build the response", async () => {
    const h = createHarness();
    h.tokens.enable(ADDRESS);
    h.queue.seed(SOURCE, ADDRESS, [
      { meetingId: "01MEETINGAAA", kind: "transcript" },
    ]);

    await withServer(h.app, async (base) => {
      const res = await ack(base, {
        items: [{ meetingId: "01MEETINGAAA", kind: "transcript" }],
      });
      expect(res.status).toBe(200);
      expect(h.trips).toEqual([
        "config",
        "readDisabled",
        "readLedger",
        "list",
        "acknowledge",
        "dead",
      ]);
    });
  });

  test("a batch with nothing to settle costs no write path at all", async () => {
    // The lost-response retry, and the shape an abusive caller sends: 200 ids,
    // none of them queued. It must not reach the queue's write lock.
    const h = createHarness();
    h.tokens.enable(ADDRESS);

    await withServer(h.app, async (base) => {
      const items = Array.from({ length: ACK_ITEMS_PER_REQUEST_CAP }, (_, i) => ({
        meetingId: `01NOTQUEUED${String(i).padStart(4, "0")}`,
        kind: "transcript" as const,
      }));
      const res = await ack(base, { items });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        acknowledged: number;
        alreadySettled: number;
      };
      expect(body.acknowledged).toBe(0);
      expect(body.alreadySettled).toBe(ACK_ITEMS_PER_REQUEST_CAP);
      expect(h.trips).toEqual([
        "config",
        "readDisabled",
        "readLedger",
        "list",
        "dead",
      ]);
      expect(h.queue.ops).toEqual([]);
    });
  });

  test("only identities the LEDGER-TESTED snapshot held are settled", async () => {
    // The tombstone verdict is built from `queue.list()`, which is read outside
    // the settlement lock. An identity absent from that snapshot has never been
    // tested against the purge ledger, so it is reported as already settled
    // rather than removed sight-unseen — fail closed, and the next pass (or the
    // TTL) deals with whatever landed in the window.
    const h = createHarness();
    h.tokens.enable(ADDRESS);
    h.queue.seed(SOURCE, ADDRESS, [
      { meetingId: "01MEETINGAAA", kind: "transcript" },
    ]);

    await withServer(h.app, async (base) => {
      const res = await ack(base, {
        items: [
          { meetingId: "01MEETINGAAA", kind: "transcript" },
          { meetingId: "01LATEARRIVL", kind: "transcript" },
        ],
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        acknowledged: number;
        alreadySettled: number;
      };
      expect(body.acknowledged).toBe(1);
      expect(body.alreadySettled).toBe(1);
      // Exactly one identity reached the lock.
      expect(h.queue.ops).toEqual([
        `acknowledge:${SOURCE}/${ADDRESS.toLowerCase()}:1`,
      ]);
    });
  });
});

// ── Two-user isolation ───────────────────────────────────────────────

describe("POST /ack two-user isolation", () => {
  test("user A cannot settle, read or affect user B's queue", async () => {
    const h = createHarness();
    h.tokens.enable(ADDRESS);
    h.tokens.enable(OTHER_ADDRESS);
    h.queue.seed(SOURCE, ADDRESS, [
      { meetingId: "01AAAAAAAAAA", kind: "transcript" },
    ]);
    h.queue.seed(SOURCE, OTHER_ADDRESS, [
      { meetingId: "01BBBBBBBBBB", kind: "transcript" },
      { meetingId: "01BBBBBBBBBC", kind: "summary" },
    ]);

    await withServer(h.app, async (base) => {
      // A acknowledges B's id, by exact identity.
      const res = await ack(base, {
        items: [{ meetingId: "01BBBBBBBBBB", kind: "transcript" }],
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        acknowledged: number;
        alreadySettled: number;
        count: number;
        pending: Array<{ meetingId: string }>;
      };
      expect(body.acknowledged).toBe(0);
      expect(body.alreadySettled).toBe(1);
      // B's queue is intact...
      expect(h.queue.identities(SOURCE, OTHER_ADDRESS)).toEqual([
        "transcript:01BBBBBBBBBB",
        "summary:01BBBBBBBBBC",
      ]);
      // ...and nothing of B's leaks into A's response.
      expect(body.count).toBe(1);
      expect(body.pending.map((item) => item.meetingId)).toEqual([
        "01AAAAAAAAAA",
      ]);

      // Now B settles their own item and A's stays put.
      h.session.address = OTHER_ADDRESS;
      const asB = await ack(base, {
        items: [{ meetingId: "01BBBBBBBBBB", kind: "transcript" }],
      });
      expect(asB.status).toBe(200);
      expect(((await asB.json()) as { acknowledged: number }).acknowledged).toBe(
        1,
      );
      expect(h.queue.identities(SOURCE, ADDRESS)).toEqual([
        "transcript:01AAAAAAAAAA",
      ]);
    });
  });
});

// ── Rate limiting: the companion bucket, never globalLimiter ─────────

describe("POST /ack rate-limit bucket", () => {
  test("the ack path is covered by the connector companion mount", () => {
    const path = "/api/connectors/webhooks/ack";
    expect(
      CONNECTOR_COMPANION_PATHS.some(
        (mount) => path === mount || path.startsWith(`${mount}/`),
      ),
    ).toBe(true);
  });

  test("it is ONE path segment deep, so the raw public mount cannot claim it", () => {
    // `POST /:source/:token` is two segments; a two-segment companion would be Buffer-ified
    // by `express.raw` and keyed into a token bucket that has no token (§4.3).
    expect("ack".includes("/")).toBe(false);
  });
});

// ── ConnectorQueue.acknowledge — the settlement method itself ────────

class FakeNode {
  readonly store = new Map<string, unknown>();
  readonly calls: Array<{ op: string; key: string }> = [];

  readonly kv = {
    get: async (key: string): Promise<unknown> => {
      this.calls.push({ op: "get", key });
      if (!this.store.has(key)) return { data: null };
      return { data: { data: this.store.get(key) } };
    },
    put: async (key: string, value: unknown): Promise<unknown> => {
      this.calls.push({ op: "put", key });
      this.store.set(key, JSON.parse(JSON.stringify(value)));
      return { ok: true };
    },
    delete: async (key: string): Promise<unknown> => {
      this.calls.push({ op: "delete", key });
      this.store.delete(key);
      return { ok: true };
    },
  };
}

function makeQueue(node: FakeNode, now = () => T0): ConnectorQueue {
  return new ConnectorQueue(node as unknown as TinyCloudNode, {
    now,
    jitter: () => 0,
    flushWindowMs: 0,
  });
}

const PENDING_KEY = `webhooks/pending/${SOURCE}/${ADDRESS.toLowerCase()}`;
const DEAD_KEY = `webhooks/dead/${SOURCE}/${ADDRESS.toLowerCase()}`;

describe("ConnectorQueue.acknowledge", () => {
  test("removes exactly the acknowledged identities and reports each disposition", async () => {
    const node = new FakeNode();
    const queue = makeQueue(node);
    await queue.enqueue(SOURCE, ADDRESS, {
      meetingId: "01MEETINGAAA",
      kind: "transcript",
    });
    await queue.enqueue(SOURCE, ADDRESS, {
      meetingId: "01MEETINGAAA",
      kind: "summary",
    });
    await queue.enqueue(SOURCE, ADDRESS, {
      meetingId: "01MEETINGBBB",
      kind: "transcript",
    });

    const results = await queue.acknowledge(SOURCE, ADDRESS, [
      { meetingId: "01MEETINGAAA", kind: "transcript" },
      { meetingId: "01NOTQUEUEDX", kind: "summary" },
    ]);
    expect(results).toEqual([
      {
        meetingId: "01MEETINGAAA",
        kind: "transcript",
        disposition: "removed",
      },
      {
        meetingId: "01NOTQUEUEDX",
        kind: "summary",
        disposition: "not-queued",
      },
    ]);

    const remaining = await queue.list(SOURCE, ADDRESS);
    expect(remaining.map((item) => `${item.kind}:${item.meetingId}`)).toEqual([
      "summary:01MEETINGAAA",
      "transcript:01MEETINGBBB",
    ]);
  });

  test("is idempotent: acknowledging twice is not an error and writes nothing the second time", async () => {
    const node = new FakeNode();
    const queue = makeQueue(node);
    await queue.enqueue(SOURCE, ADDRESS, {
      meetingId: "01MEETINGAAA",
      kind: "transcript",
    });

    await queue.acknowledge(SOURCE, ADDRESS, [
      { meetingId: "01MEETINGAAA", kind: "transcript" },
    ]);
    const writesAfterFirst = node.calls.filter(
      (call) => call.op === "put" && call.key === PENDING_KEY,
    ).length;

    const second = await queue.acknowledge(SOURCE, ADDRESS, [
      { meetingId: "01MEETINGAAA", kind: "transcript" },
    ]);
    expect(second[0]!.disposition).toBe("not-queued");
    // W0 §6.2: a pass that mutates nothing must cost zero node writes.
    expect(
      node.calls.filter(
        (call) => call.op === "put" && call.key === PENDING_KEY,
      ).length,
    ).toBe(writesAfterFirst);
  });

  test("rejects an invalid meeting id or kind BEFORE touching the queue", async () => {
    const node = new FakeNode();
    const queue = makeQueue(node);
    await queue.enqueue(SOURCE, ADDRESS, {
      meetingId: "01MEETINGAAA",
      kind: "transcript",
    });
    const before = node.calls.length;

    await expect(
      queue.acknowledge(SOURCE, ADDRESS, [
        { meetingId: "01MEETINGAAA", kind: "transcript" },
        { meetingId: "../../delegations/0xabc", kind: "transcript" },
      ]),
    ).rejects.toThrow();
    await expect(
      queue.acknowledge(SOURCE, ADDRESS, [
        {
          meetingId: "01MEETINGAAA",
          kind: "notes" as unknown as PendingKind,
        },
      ]),
    ).rejects.toThrow();

    expect(node.calls.length).toBe(before);
    expect((await queue.list(SOURCE, ADDRESS)).length).toBe(1);
  });

  test("never touches the dead-letter", async () => {
    const node = new FakeNode();
    const queue = makeQueue(node);
    node.store.set(DEAD_KEY, [
      {
        meetingId: "01DEADAAAAAA",
        kind: "transcript",
        receivedAt: new Date(T0 - 1000).toISOString(),
        attempts: 5,
        nextAttemptAt: new Date(T0 - 1000).toISOString(),
        lastError: "ttl_expired",
        deadAt: new Date(T0 - 1000).toISOString(),
      },
    ]);
    await queue.enqueue(SOURCE, ADDRESS, {
      meetingId: "01MEETINGAAA",
      kind: "transcript",
    });

    await queue.acknowledge(SOURCE, ADDRESS, [
      { meetingId: "01DEADAAAAAA", kind: "transcript" },
      { meetingId: "01MEETINGAAA", kind: "transcript" },
    ]);

    expect((await queue.dead(SOURCE, ADDRESS)).map((d) => d.meetingId)).toEqual([
      "01DEADAAAAAA",
    ]);
    expect(await queue.list(SOURCE, ADDRESS)).toEqual([]);
  });

  test("one user's acknowledgement cannot reach another user's key", async () => {
    const node = new FakeNode();
    const queue = makeQueue(node);
    await queue.enqueue(SOURCE, ADDRESS, {
      meetingId: "01SHAREDIDXX",
      kind: "transcript",
    });
    await queue.enqueue(SOURCE, OTHER_ADDRESS, {
      meetingId: "01SHAREDIDXX",
      kind: "transcript",
    });

    await queue.acknowledge(SOURCE, ADDRESS, [
      { meetingId: "01SHAREDIDXX", kind: "transcript" },
    ]);

    expect(await queue.list(SOURCE, ADDRESS)).toEqual([]);
    expect(
      (await queue.list(SOURCE, OTHER_ADDRESS)).map((i) => i.meetingId),
    ).toEqual(["01SHAREDIDXX"]);
  });
});
