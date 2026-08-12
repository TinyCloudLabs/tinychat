import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import express from "express";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import {
  ConnectorControlStore,
  ConnectorDrainAbortFlags,
  ConnectorWebhookLimiters,
  createConnectorWebhookCompanionRouter,
  createConnectorWebhookHandler,
  disabledMarkerKey,
  purgeLedgerKey,
  PURGE_RECENT_ID_CAP,
  type ConnectorControl,
  type DisabledMarker,
  type PurgeLedger,
  type PurgeLedgerRead,
} from "../routes/connector-webhooks.js";
import type {
  AcknowledgeInput,
  AcknowledgeResult,
  ClearResult,
  DeadItem,
  PendingItem,
} from "../services/connector-queue.js";
import {
  _resetWebhookTokenState,
  generateWebhookToken,
  type WebhookConfigRecord,
  type WebhookTokenRecord,
} from "../services/webhook-tokens.js";

/**
 * Route tests for the AUTHENTICATED companions (§3.6, §4.4, §4.8, §6.2 — W3b's acceptance row).
 *
 * Same ephemeral-port + real-`fetch` template as `connector-webhooks.test.ts`, with the app
 * assembled in `index.ts`'s ORDER: the public raw mount first, then the global JSON parser,
 * then the companion router — so "a `POST /config` body arrives parsed, not Buffer-ified, and
 * never touches the webhook limiter" is an assertion about the real wiring, not a wish.
 */

const ORIGINAL_ENV = { ...process.env };

const SOURCE = "fireflies";
/**
 * §4.1's registry is parameterized but ships with ONE entry, so every multi-source branch —
 * the `POST /config` source switch and the teardown's all-sources sweep — was unexecutable.
 * This name exists only inside a harness-supplied registry; it is never registered in
 * production (`CONNECTOR_REGISTRY`), and `unknown_source` tests still rely on that.
 */
const SECOND_SOURCE = "granola";
const ADDRESS = "0x7d033300000000000000000000000000000073f2";
const OTHER_ADDRESS = "0xb1b1b10000000000000000000000000000001111";
const MASTER = "3H8Qk0m2yq1sZ0VjK5xPwq0nA6oJ2bL9dR4tW7uY1cM=";
const LOG_SALT = "aQ2wS3eD4rF5tG6yH7uJ8iK9oL0pZ1xC2vB3nM4kJ5h=";

/** Capture console output. Same helper as `connector-webhooks.test.ts` (§6.3/§8.3). */
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

class FakeTokens {
  readonly configs = new Map<string, WebhookConfigRecord>();
  failRevokeWith: Error | null = null;
  /**
   * §2/4 hardening: a durable KV write inside `mint`/`rotate` that returned `{ok:false}`
   * surfaces to the route as a thrown rejection. The route must NOT log a success audit
   * line or answer 200 with a secret — this fake reproduces the shape at the SERVICE
   * boundary so the route contract is provable without live KV.
   */
  failMintWith: Error | null = null;
  failRotateWith: Error | null = null;

  /** One shared array across every fake: §3.6 rule 5 is an ORDER claim, not a set claim. */
  constructor(readonly ops: string[]) {}

  async config(address: string): Promise<WebhookConfigRecord | null> {
    return this.configs.get(address.toLowerCase()) ?? null;
  }

  async mint(address: string, source: string) {
    if (this.failMintWith) throw this.failMintWith;
    return this.issue(address, source, "mint");
  }

  async rotate(address: string, source: string) {
    if (this.failRotateWith) throw this.failRotateWith;
    return this.issue(address, source, "rotate");
  }

  async revoke(address: string): Promise<void> {
    if (this.failRevokeWith) throw this.failRevokeWith;
    this.ops.push("revoke");
    this.configs.delete(address.toLowerCase());
  }

  private issue(address: string, source: string, op: string) {
    this.ops.push(op);
    const previous = this.configs.get(address.toLowerCase()) ?? null;
    const token = generateWebhookToken();
    const createdAt = new Date().toISOString();
    this.configs.set(address.toLowerCase(), { token, source, createdAt });
    const record: WebhookTokenRecord = {
      address: address.toLowerCase(),
      source,
      createdAt,
    };
    return { token, record, rotatedFrom: previous?.token ?? null };
  }
}

class FakeQueue {
  readonly items = new Map<string, PendingItem[]>();
  readonly deadItems = new Map<string, DeadItem[]>();

  constructor(readonly ops: string[]) {}

  private key(source: string, address: string): string {
    return `${source}/${address.toLowerCase()}`;
  }

  seed(source: string, address: string, count: number): void {
    const items: PendingItem[] = Array.from({ length: count }, (_, i) => ({
      meetingId: `01MEETING${String(i).padStart(6, "0")}`,
      kind: "transcript" as const,
      receivedAt: new Date(1_700_000_000_000 + i).toISOString(),
      // The provider stamp, because the tombstone reads THAT and nothing else: a timestamp-less
      // item fails closed against any ledger (see connector-drain.ts's isTombstoned), so seeding
      // without one would make every ledger test drop everything and assert nothing.
      sourceTimestamp: new Date(1_700_000_000_000 + i).toISOString(),
      attempts: 0,
      nextAttemptAt: new Date(1_700_000_000_000 + i).toISOString(),
    }));
    this.items.set(this.key(source, address), items);
  }

  seedDead(source: string, address: string, count: number): void {
    const dead: DeadItem[] = Array.from({ length: count }, (_, i) => ({
      meetingId: `01DEAD${String(i).padStart(8, "0")}`,
      kind: "summary" as const,
      receivedAt: new Date(1_700_000_000_000 + i).toISOString(),
      attempts: 5,
      nextAttemptAt: new Date(1_700_000_000_000 + i).toISOString(),
      lastError: "ttl_expired",
      deadAt: new Date(1_700_000_100_000 + i).toISOString(),
    }));
    this.deadItems.set(this.key(source, address), dead);
  }

  async list(source: string, address: string): Promise<PendingItem[]> {
    return this.items.get(this.key(source, address)) ?? [];
  }

  async dead(source: string, address: string): Promise<DeadItem[]> {
    return this.deadItems.get(this.key(source, address)) ?? [];
  }

  /**
   * F010: the real queue counts what it deleted inside its own lock and returns it, so the
   * teardown never has to `list()` first. The fake mirrors that contract exactly — a fake that
   * still returned `void` would let a route regression back to list-then-clear pass.
   */
  async clear(source: string, address: string): Promise<ClearResult> {
    this.ops.push(`clear:${this.key(source, address)}`);
    const cleared = (this.items.get(this.key(source, address)) ?? []).length;
    this.items.delete(this.key(source, address));
    this.deadItems.delete(this.key(source, address));
    return { cleared, superseded: 0 };
  }

  /**
   * `POST /ack`'s settlement (W-BE3). Present so this harness still satisfies `CompanionQueue`;
   * the acknowledgement contract itself is asserted in `connector-ack.test.ts`.
   */
  async acknowledge(
    source: string,
    address: string,
    acks: AcknowledgeInput[],
  ): Promise<AcknowledgeResult[]> {
    this.ops.push(`acknowledge:${this.key(source, address)}`);
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
  /** A raw value that fails `parsePurgeLedger` — §6.2's fail-closed / quarantine case. */
  unparseableLedger: string | null = null;

  constructor(readonly ops: string[]) {}

  private key(source: string, address: string): string {
    return `${source}/${address.toLowerCase()}`;
  }

  async readDisabled(address: string): Promise<DisabledMarker | null> {
    return this.markers.get(address.toLowerCase()) ?? null;
  }

  async markDisabled(address: string, source: string | null): Promise<void> {
    this.ops.push("mark-disabled");
    this.markers.set(address.toLowerCase(), {
      revokedAt: new Date().toISOString(),
      source,
    });
  }

  async clearDisabled(address: string): Promise<void> {
    this.ops.push("clear-disabled");
    this.markers.delete(address.toLowerCase());
  }

  async readLedger(source: string, address: string): Promise<PurgeLedgerRead> {
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
    this.ops.push(`write-ledger:${this.key(source, address)}`);
    this.ledgers.set(this.key(source, address), ledger);
  }

  async clearLedger(source: string, address: string): Promise<void> {
    this.ops.push(`clear-ledger:${this.key(source, address)}`);
    this.ledgers.delete(this.key(source, address));
  }

  async quarantineLedger(
    source: string,
    address: string,
    raw: unknown,
  ): Promise<void> {
    this.ops.push("quarantine-ledger");
    this.corrupt.set(this.key(source, address), raw);
    this.unparseableLedger = null;
  }
}

/**
 * The app's GENERIC backend delegation store — deliberately NOT handed to the companion router
 * (Option C: the router has no `delegations` collaborator). It stays in the harness as the
 * tripwire: if teardown ever reaches for the chat delegation again, `ops` records it and the
 * address disappears from `stored`.
 */
class FakeDelegations {
  readonly stored = new Set<string>([ADDRESS]);

  constructor(readonly ops: string[]) {}

  async remove(address: string): Promise<void> {
    this.ops.push("delegation-remove");
    this.stored.delete(address.toLowerCase());
  }

  evict(_address: string): void {
    this.ops.push("delegation-evict");
  }
}

interface Harness {
  app: express.Express;
  tokens: FakeTokens;
  queue: FakeQueue;
  control: FakeControl;
  delegations: FakeDelegations;
  abort: ConnectorDrainAbortFlags;
  limiters: ConnectorWebhookLimiters;
  drains: Array<{ source: string; address: string }>;
  ops: string[];
}

function createHarness(
  options: {
    address?: string;
    drain?: boolean;
    drainFails?: boolean;
    /** §12a R3: an aborted drain surfaces NOTHING, whatever is still sitting in the queue. */
    drainAborts?: string;
    /**
     * §4.1's registry, parameterized. Today it holds one entry, so the source-switch and
     * all-sources-teardown paths were unreachable from a test; connector two is exactly when
     * an unverified path stops being latent. Passing two names here is what makes those
     * branches executable BEFORE a second connector ships.
     */
    sources?: readonly string[];
    /** The pinned public callback origin (`CONNECTOR_WEBHOOK_PUBLIC_ORIGIN`). */
    publicOrigin?: string;
  } = {},
): Harness {
  const ops: string[] = [];
  const tokens = new FakeTokens(ops);
  const queue = new FakeQueue(ops);
  const control = new FakeControl(ops);
  const delegations = new FakeDelegations(ops);
  const abort = new ConnectorDrainAbortFlags();
  // ipLimit 0 / tokenSuccessLimit 0 ⇒ the webhook chain trips on its first counted request.
  // Nothing the companions serve may ever touch it (§4.3's collision rule).
  const limiters = new ConnectorWebhookLimiters({
    ipLimit: 0,
    tokenSuccessLimit: 0,
  });
  const drains: Array<{ source: string; address: string }> = [];

  const app = express();
  app.set("trust proxy", 1);
  // 1. THE RAW WINDOW — exactly index.ts's shape: app.post on the two-segment path.
  app.post(
    "/api/connectors/webhooks/:source/:token",
    limiters.ipPreLimiter,
    express.raw({ type: "application/json", limit: "64kb", inflate: false }),
    createConnectorWebhookHandler({
      tokens: { lookup: async () => null },
      queue: { enqueue: async () => ({ status: "queued", depth: 1 }) },
      limiters,
    }),
  );
  // 2. The global JSON parser, then the authenticated companions.
  app.use(express.json({ limit: "1mb" }));
  app.use((req, _res, next) => {
    req.user = { address: options.address ?? ADDRESS };
    next();
  });
  app.use(
    "/api/connectors/webhooks",
    createConnectorWebhookCompanionRouter({
      tokens,
      queue,
      control,
      limiters,
      abort,
      ...(options.sources ? { registry: new Set(options.sources) } : {}),
      ...(options.publicOrigin === undefined
        ? {}
        : { publicOrigin: options.publicOrigin }),
      ...(options.drain
        ? {
            // Shaped like `ConnectorDrainWorker`'s `DrainResult`, because the routes now read
            // the drain's OWN verdict rather than re-listing the queue (§4.7 / §12a R3).
            drain: async (input: { source: string; address: string }) => {
              drains.push(input);
              if (options.drainFails) throw new Error("drain exploded");
              if (options.drainAborts !== undefined) {
                return {
                  status: "aborted",
                  reason: options.drainAborts,
                  surfaced: [],
                };
              }
              const due = await queue.list(input.source, input.address);
              return {
                status: "ok",
                surfaced: due.map((item) => item.meetingId),
              };
            },
          }
        : {}),
    }),
  );

  return {
    app,
    tokens,
    queue,
    control,
    delegations,
    abort,
    limiters,
    drains,
    ops,
  };
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

function call(
  base: string,
  path: string,
  method: string,
  body?: unknown,
): Promise<Response> {
  return fetch(`${base}/api/connectors/webhooks${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
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

// ── Mount isolation (§4.3 / §8.3's last bullet) ──────────────────────

describe("companion mount isolation", () => {
  test("POST /config reaches the handler with a PARSED OBJECT, not a Buffer", async () => {
    const h = createHarness();
    await withServer(h.app, async (base) => {
      // An unknown source can only be detected from a parsed body; a Buffer would produce the
      // default source and a 200. And the ipLimit-0 webhook pre-limiter never runs here.
      const bad = await call(base, "/config", "POST", {
        source: "not-registered",
      });
      expect(bad.status).toBe(400);
      expect(await bad.json()).toEqual({ error: "unknown_source" });

      const ok = await call(base, "/config", "POST", { source: SOURCE });
      expect(ok.status).toBe(200);
      const body = (await ok.json()) as {
        enabled: boolean;
        url: string;
        secret: string;
      };
      expect(body.enabled).toBe(true);
      expect(body.url).toContain("/api/connectors/webhooks/fireflies/");
      expect(body.secret.length).toBeGreaterThan(0);
    });
  });

  // ── The minted callback URL (delivery-origin pin) ──────────────────
  //
  // The URL is what the user pastes into their Fireflies dashboard, and a wrong
  // host or an `http://` scheme produces a webhook that silently never delivers
  // — with no server-side signal that anything is wrong. Derived from the
  // client-supplied `Host` header and a forwarded scheme it was pinned to
  // nothing at all, so the callback origin is now pinned in code.

  test("a configured public origin wins over the request's Host and scheme", async () => {
    const h = createHarness({ publicOrigin: "https://api.tinycloud.chat" });
    await withServer(h.app, async (base) => {
      const res = await fetch(`${base}/api/connectors/webhooks/config`, {
        method: "POST",
        headers: { "content-type": "application/json", host: "evil.example" },
        body: JSON.stringify({ source: SOURCE }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { url: string };
      expect(body.url).toStartWith(
        "https://api.tinycloud.chat/api/connectors/webhooks/fireflies/",
      );
      expect(body.url).not.toContain("evil.example");
    });
  });

  test("an unpinned mint still never hands out an http:// callback", async () => {
    // Fireflies requires an HTTPS callback, so an `http` scheme — a plain hop
    // behind the proxy, or a spoofed `X-Forwarded-Proto` — is always the wrong
    // string to paste. The request below is plain HTTP, which is the point.
    const h = createHarness();
    await withServer(h.app, async (base) => {
      const res = await fetch(`${base}/api/connectors/webhooks/config`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          host: "api.tinycloud.chat",
        },
        body: JSON.stringify({ source: SOURCE }),
      });
      const body = (await res.json()) as { url: string };
      expect(body.url).toStartWith(
        "https://api.tinycloud.chat/api/connectors/webhooks/",
      );
    });
  });

  test("a LOOPBACK host keeps the request's scheme — no provider can reach it", async () => {
    // The local e2e loop delivers to the URL it was just handed, on its own
    // plain-HTTP server. Forcing a scheme that server does not speak would break
    // the harness while protecting a callback address Fireflies can never use.
    const h = createHarness();
    await withServer(h.app, async (base) => {
      const res = await call(base, "/config", "POST", { source: SOURCE });
      const body = (await res.json()) as { url: string };
      expect(body.url).toStartWith(`${base}/api/connectors/webhooks/`);
    });
  });

  test("a malformed pinned origin refuses to build the router", () => {
    // Fail closed at boot, exactly as a weak WEBHOOK_HMAC_MASTER does: a typo
    // in the one string that decides where deliveries land must not become a
    // fleet of dead webhooks.
    for (const bad of [
      "http://api.tinycloud.chat",
      "https://api.tinycloud.chat/",
      "https://api.tinycloud.chat/api",
      "api.tinycloud.chat",
      "https://",
    ]) {
      expect(() => createHarness({ publicOrigin: bad })).toThrow();
    }
  });

  test("a tripped webhook limiter does not 429 the companions", async () => {
    // The control for the assertion above: the SAME limiter instance, once tripped, suppresses
    // work on the public path — so the companion's 200 is isolation, not a disabled limiter.
    //
    // The trip is observed on the LOG, not on the status code: both the unlimited and the
    // suppressed scanner request answer the generic 401 on purpose. A 429 on the scanner path
    // diverges from the 401 a REGISTERED token gets and is a one-request-per-candidate
    // live-token oracle (§4.4/T8) — the response must not name the bucket it hit.
    const h = createHarness();
    const capture = captureLogs();
    try {
      await withServer(h.app, async (base) => {
        const deliver = () =>
          fetch(
            `${base}/api/connectors/webhooks/${SOURCE}/${generateWebhookToken()}`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: "{}",
            },
          );
        expect((await deliver()).status).toBe(401); // unknown token: counted on the IP bucket
        expect((await deliver()).status).toBe(401); // bucket now tripped — SAME answer

        const config = await call(base, "/config", "POST", { source: SOURCE });
        expect(config.status).toBe(200);
        const pending = await fetch(`${base}/api/connectors/webhooks/pending`);
        expect(pending.status).toBe(200);
      });
    } finally {
      capture.restore();
    }
    // …and the bucket really did fire, which is what makes the companions' 200 meaningful.
    expect(
      capture.lines.some((line) => line.includes("reason=limited bucket=ip")),
    ).toBe(true);
  });
});

// ── DELETE /config — the single idempotent teardown (§3.6 rules 1 + 5) ─

describe("DELETE /config teardown", () => {
  test("runs the NORMATIVE ORDER and drops the queue last", async () => {
    const h = createHarness();
    h.tokens.configs.set(ADDRESS, {
      token: generateWebhookToken(),
      source: SOURCE,
      createdAt: new Date().toISOString(),
    });
    h.queue.seed(SOURCE, ADDRESS, 3);

    await withServer(h.app, async (base) => {
      const res = await call(base, "/config", "DELETE");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "disabled", queueDropped: 3 });
    });

    // OPTION C: three steps, not five. The disabled marker still goes FIRST — every crash
    // point below it must leave a state the drain classifies as REVOKED — but steps 3 and 4
    // (delegation remove + cache evict) are GONE: the server holds no connector delegation to
    // remove, and the only delegation it does hold is the app's unrelated chat grant.
    expect(h.ops).toEqual([
      "mark-disabled",
      "revoke",
      `clear:${SOURCE}/${ADDRESS}`,
    ]);
    expect(h.control.markers.has(ADDRESS)).toBe(true);
    expect(h.tokens.configs.has(ADDRESS)).toBe(false);
    expect(h.queue.items.size).toBe(0);
  });

  test("leaves the app's unrelated backend delegation ALONE", async () => {
    // The outage this prevents: a user switches off an optional notification connector and
    // loses the delegation every authenticated TinyChat write needs. The teardown must not
    // touch the delegation store or cache at all — not remove, not evict.
    const h = createHarness();
    h.tokens.configs.set(ADDRESS, {
      token: generateWebhookToken(),
      source: SOURCE,
      createdAt: new Date().toISOString(),
    });

    await withServer(h.app, async (base) => {
      expect((await call(base, "/config", "DELETE")).status).toBe(200);
    });

    expect(h.delegations.stored.has(ADDRESS)).toBe(true);
    expect(h.ops).not.toContain("delegation-remove");
    expect(h.ops).not.toContain("delegation-evict");
  });

  test("sets the per-address abort flag so an in-flight drain drops out", async () => {
    const h = createHarness();
    h.tokens.configs.set(ADDRESS, {
      token: generateWebhookToken(),
      source: SOURCE,
      createdAt: new Date().toISOString(),
    });
    expect(h.abort.isAborted(ADDRESS)).toBe(false);
    await withServer(h.app, async (base) => {
      await call(base, "/config", "DELETE");
    });
    expect(h.abort.isAborted(ADDRESS)).toBe(true);
    expect(h.abort.isAborted(OTHER_ADDRESS)).toBe(false);
  });

  test("is idempotent — a second teardown is another 200, never a partial state", async () => {
    const h = createHarness();
    h.tokens.configs.set(ADDRESS, {
      token: generateWebhookToken(),
      source: SOURCE,
      createdAt: new Date().toISOString(),
    });
    await withServer(h.app, async (base) => {
      expect((await call(base, "/config", "DELETE")).status).toBe(200);
      const again = await call(base, "/config", "DELETE");
      expect(again.status).toBe(200);
      expect(await again.json()).toEqual({
        status: "disabled",
        queueDropped: 0,
      });
    });
    expect(h.control.markers.has(ADDRESS)).toBe(true);
  });

  // ── F006/F010: one DELETE, a fully clean state, an exact count ─────
  //
  // The teardown used to clear only `existing.source`. A queue left behind by any other
  // registered source — a switch that crashed between the rotate and the clear, or an older
  // stint on that source — stayed invisible to every companion read (they all follow
  // `config.source`) and sat in KV until the 14-day TTL. A disconnect must mean disconnected,
  // so the teardown sweeps the whole registry.
  test("a single DELETE clears EVERY registered source's queue, not just the configured one (F006)", async () => {
    const h = createHarness({ sources: [SOURCE, SECOND_SOURCE] });
    h.tokens.configs.set(ADDRESS, {
      token: generateWebhookToken(),
      source: SOURCE,
      createdAt: new Date().toISOString(),
    });
    h.queue.seed(SOURCE, ADDRESS, 3);
    h.queue.seed(SECOND_SOURCE, ADDRESS, 2);

    await withServer(h.app, async (base) => {
      const res = await call(base, "/config", "DELETE");
      expect(res.status).toBe(200);
      // F010: the count is the sum of what the clears actually deleted.
      expect(await res.json()).toEqual({ status: "disabled", queueDropped: 5 });
    });

    expect(h.ops).toEqual([
      "mark-disabled",
      "revoke",
      `clear:${SOURCE}/${ADDRESS}`,
      `clear:${SECOND_SOURCE}/${ADDRESS}`,
    ]);
    expect(h.queue.items.size).toBe(0);
  });

  test("queueDropped comes from the clear itself — the teardown never list()s first (F010)", async () => {
    const h = createHarness();
    h.tokens.configs.set(ADDRESS, {
      token: generateWebhookToken(),
      source: SOURCE,
      createdAt: new Date().toISOString(),
    });
    h.queue.seed(SOURCE, ADDRESS, 4);
    const listed: string[] = [];
    const realList = h.queue.list.bind(h.queue);
    h.queue.list = async (source: string, address: string) => {
      listed.push(`${source}/${address}`);
      return realList(source, address);
    };

    await withServer(h.app, async (base) => {
      const res = await call(base, "/config", "DELETE");
      expect(await res.json()).toEqual({ status: "disabled", queueDropped: 4 });
    });

    // A list() here is the TOCTOU the finding names: anything enqueued between it and the
    // clear is dropped without being counted.
    expect(listed).toEqual([]);
  });

  test("a crash mid-teardown leaves a state the drain classifies as REVOKED", async () => {
    // The whole point of the order: the durable marker lands FIRST, so the reverse-order
    // failure ("enabled config, no delegation" — which the silent renewer repairs by
    // re-minting) is unreachable.
    const h = createHarness();
    h.tokens.configs.set(ADDRESS, {
      token: generateWebhookToken(),
      source: SOURCE,
      createdAt: new Date().toISOString(),
    });
    h.tokens.failRevokeWith = new Error("kv down");

    await withServer(h.app, async (base) => {
      const res = await call(base, "/config", "DELETE");
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "teardown_incomplete" });
    });

    expect(h.control.markers.has(ADDRESS)).toBe(true);
    expect(h.abort.isAborted(ADDRESS)).toBe(true);
    expect(h.ops).toEqual(["mark-disabled"]);
  });
});

// ── POST /config — enable (§3.6 rule 6) ──────────────────────────────

describe("POST /config enable", () => {
  test("clears the pending queue, the dead-letter and the abort flag as its FIRST durable act", async () => {
    const h = createHarness();
    h.queue.seed(SOURCE, ADDRESS, 4);
    h.queue.seedDead(SOURCE, ADDRESS, 2);
    h.abort.abort(ADDRESS);
    h.control.markers.set(ADDRESS, {
      revokedAt: new Date().toISOString(),
      source: SOURCE,
    });

    await withServer(h.app, async (base) => {
      const res = await call(base, "/config", "POST", { source: SOURCE });
      expect(res.status).toBe(200);
    });

    // Queue clear precedes the marker clear, which precedes the mint.
    expect(h.ops).toEqual([
      `clear:${SOURCE}/${ADDRESS}`,
      "clear-disabled",
      "mint",
    ]);
    expect(h.queue.items.size).toBe(0);
    expect(h.queue.deadItems.size).toBe(0);
    expect(h.abort.isAborted(ADDRESS)).toBe(false);
  });

  test("does NOT clear the purge ledger — only DELETE /purged does (§4.8)", async () => {
    const h = createHarness();
    const ledger: PurgeLedger = {
      purgedThrough: new Date(1_700_000_000_000).toISOString(),
      recentIds: ["01OLDMEETING"],
      updatedAt: new Date(1_700_000_000_000).toISOString(),
    };
    h.control.ledgers.set(`${SOURCE}/${ADDRESS}`, ledger);
    h.control.markers.set(ADDRESS, {
      revokedAt: new Date().toISOString(),
      source: SOURCE,
    });

    await withServer(h.app, async (base) => {
      expect(
        (await call(base, "/config", "POST", { source: SOURCE })).status,
      ).toBe(200);
    });
    expect(h.control.ledgers.get(`${SOURCE}/${ADDRESS}`)).toEqual(ledger);
  });

  test("an already-enabled POST is a no-op read — it never drops a live queue", async () => {
    const h = createHarness();
    const token = generateWebhookToken();
    h.tokens.configs.set(ADDRESS, {
      token,
      source: SOURCE,
      createdAt: new Date().toISOString(),
    });
    h.queue.seed(SOURCE, ADDRESS, 5);

    await withServer(h.app, async (base) => {
      const res = await call(base, "/config", "POST", { source: SOURCE });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { rotated: boolean; url: string };
      expect(body.rotated).toBe(false);
      expect(body.url).toContain(token);
    });
    expect(h.ops).toEqual([]);
    expect((await h.queue.list(SOURCE, ADDRESS)).length).toBe(5);
  });

  test("rotate:true re-mints without dropping the queue", async () => {
    const h = createHarness();
    const token = generateWebhookToken();
    h.tokens.configs.set(ADDRESS, {
      token,
      source: SOURCE,
      createdAt: new Date().toISOString(),
    });
    h.queue.seed(SOURCE, ADDRESS, 2);

    await withServer(h.app, async (base) => {
      const res = await call(base, "/config", "POST", {
        source: SOURCE,
        rotate: true,
      });
      const body = (await res.json()) as { rotated: boolean; url: string };
      expect(body.rotated).toBe(true);
      expect(body.url).not.toContain(token);
    });
    expect(h.ops).toEqual(["rotate"]);
    expect((await h.queue.list(SOURCE, ADDRESS)).length).toBe(2);
  });

  // ── F008/F006: switching source while enabled ──────────────────────
  //
  // `switchingSource` (a different registered source named while already enabled) is a re-mint,
  // not a read. It was the one POST /config branch with no test at all: nothing pinned that the
  // new source's URL comes back, that the old source's queue is dealt with, or that the enable
  // path's queue-clear is NOT re-run against the new source.
  test("switching source while enabled rotates onto the new source and drops the OLD source's queue (F006/F008)", async () => {
    const h = createHarness({ sources: [SOURCE, SECOND_SOURCE] });
    const token = generateWebhookToken();
    h.tokens.configs.set(ADDRESS, {
      token,
      source: SOURCE,
      createdAt: new Date().toISOString(),
    });
    h.queue.seed(SOURCE, ADDRESS, 3);

    await withServer(h.app, async (base) => {
      const res = await call(base, "/config", "POST", {
        source: SECOND_SOURCE,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        status: string;
        rotated: boolean;
        source: string;
        url: string;
        secret: string;
      };
      expect(body.status).toBe("enabled");
      expect(body.rotated).toBe(true);
      expect(body.source).toBe(SECOND_SOURCE);
      expect(body.url).toContain(`/api/connectors/webhooks/${SECOND_SOURCE}/`);
      expect(body.url).not.toContain(token);
      expect(body.secret.length).toBeGreaterThan(0);
    });

    // The old source's queue goes first, then the re-mint — the same order enable uses. No
    // `clear-disabled` and no clear of the NEW source: this is not an enable transition.
    expect(h.ops).toEqual([`clear:${SOURCE}/${ADDRESS}`, "rotate"]);
    expect(h.queue.items.has(`${SOURCE}/${ADDRESS}`)).toBe(false);
    expect(h.tokens.configs.get(ADDRESS)!.source).toBe(SECOND_SOURCE);
  });

  test("switching back does not resurrect the abandoned queue — each switch leaves one live source (F006)", async () => {
    const h = createHarness({ sources: [SOURCE, SECOND_SOURCE] });
    h.tokens.configs.set(ADDRESS, {
      token: generateWebhookToken(),
      source: SOURCE,
      createdAt: new Date().toISOString(),
    });
    h.queue.seed(SOURCE, ADDRESS, 2);

    await withServer(h.app, async (base) => {
      expect(
        (await call(base, "/config", "POST", { source: SECOND_SOURCE })).status,
      ).toBe(200);
      h.queue.seed(SECOND_SOURCE, ADDRESS, 4);
      expect(
        (await call(base, "/config", "POST", { source: SOURCE })).status,
      ).toBe(200);
    });

    expect(h.queue.items.size).toBe(0);
    expect(h.ops).toEqual([
      `clear:${SOURCE}/${ADDRESS}`,
      "rotate",
      `clear:${SECOND_SOURCE}/${ADDRESS}`,
      "rotate",
    ]);
  });

  test("naming the SAME source while enabled is still the no-op read — no clear, no rotate (F008 control)", async () => {
    const h = createHarness({ sources: [SOURCE, SECOND_SOURCE] });
    h.tokens.configs.set(ADDRESS, {
      token: generateWebhookToken(),
      source: SOURCE,
      createdAt: new Date().toISOString(),
    });
    h.queue.seed(SOURCE, ADDRESS, 3);

    await withServer(h.app, async (base) => {
      expect(
        (await call(base, "/config", "POST", { source: SOURCE })).status,
      ).toBe(200);
    });

    expect(h.ops).toEqual([]);
    expect((await h.queue.list(SOURCE, ADDRESS)).length).toBe(3);
  });

  // ── KV hardening 2/4: a failed durable mint/rotate MUST NOT read as success ──
  //
  // When webhook-tokens rejects because a `kv.put` returned `{ok:false}`, the route
  // must answer 503 and log the ERROR audit line, never the success one — otherwise the
  // UI shows "enabled" with a secret that resolves to no owner and every future delivery
  // is a 401 for the user who just enabled.

  test("mint failure surfaces as 503 with the error audit line, never the success one", async () => {
    const h = createHarness();
    h.tokens.failMintWith = new Error("kv_write_rejected");
    const capture = captureLogs();
    try {
      await withServer(h.app, async (base) => {
        const res = await call(base, "/config", "POST", { source: SOURCE });
        expect(res.status).toBe(503);
        expect(await res.json()).toEqual({ error: "unavailable" });
      });
    } finally {
      capture.restore();
    }
    // Never a success audit for a mint that never persisted.
    expect(
      capture.lines.some((line) =>
        /op=enable\b(?![^\n]*result=error)/.test(line),
      ),
    ).toBe(false);
    expect(capture.lines.some((line) => /rotated=true/.test(line))).toBe(false);
    expect(
      capture.lines.some((line) => /op=enable result=error/.test(line)),
    ).toBe(true);
    // And a redacted-log invariant: the raw address never lands in the operator stream.
    expect(capture.lines.some((line) => line.includes(ADDRESS))).toBe(false);
    expect(
      capture.lines.some((line) => line.includes(ADDRESS.toLowerCase())),
    ).toBe(false);
  });

  test("rotate failure on an already-enabled address is 503 + error audit, config unchanged", async () => {
    const h = createHarness();
    const existing = generateWebhookToken();
    h.tokens.configs.set(ADDRESS, {
      token: existing,
      source: SOURCE,
      createdAt: new Date().toISOString(),
    });
    h.tokens.failRotateWith = new Error("kv_write_rejected");
    const capture = captureLogs();
    try {
      await withServer(h.app, async (base) => {
        const res = await call(base, "/config", "POST", {
          source: SOURCE,
          rotate: true,
        });
        expect(res.status).toBe(503);
        expect(await res.json()).toEqual({ error: "unavailable" });
      });
    } finally {
      capture.restore();
    }
    // The user still has the same token — a failed rotate must not orphan them.
    expect(h.tokens.configs.get(ADDRESS)?.token).toBe(existing);
    expect(capture.lines.some((line) => /rotated=true/.test(line))).toBe(false);
    expect(
      capture.lines.some((line) => /op=enable result=error/.test(line)),
    ).toBe(true);
  });
});

// ── GET /config and GET /pending ─────────────────────────────────────

describe("GET /config and GET /pending", () => {
  test("a standing disabled marker makes the server's answer authoritative (§3.6 rule 4)", async () => {
    const h = createHarness();
    h.tokens.configs.set(ADDRESS, {
      token: generateWebhookToken(),
      source: SOURCE,
      createdAt: new Date().toISOString(),
    });
    h.control.markers.set(ADDRESS, {
      revokedAt: "2026-08-04T10:00:00.000Z",
      source: SOURCE,
    });

    await withServer(h.app, async (base) => {
      const res = await fetch(`${base}/api/connectors/webhooks/config`);
      const body = (await res.json()) as {
        enabled: boolean;
        disabledAt: string;
      };
      expect(body.enabled).toBe(false);
      expect(body.disabledAt).toBe("2026-08-04T10:00:00.000Z");
    });
  });

  test("surfaces the pending ids, the dead-letter and deliveriesRateLimited", async () => {
    const h = createHarness();
    h.tokens.configs.set(ADDRESS, {
      token: generateWebhookToken(),
      source: SOURCE,
      createdAt: new Date().toISOString(),
    });
    h.queue.seed(SOURCE, ADDRESS, 2);
    h.queue.seedDead(SOURCE, ADDRESS, 1);
    // §4.4: a tripped per-token bucket is a card state, never silence. (tokenSuccessLimit 0 in
    // the harness, so one verified delivery trips it.)
    h.limiters.consumeTokenSuccess("t".repeat(43), ADDRESS);

    await withServer(h.app, async (base) => {
      const res = await fetch(`${base}/api/connectors/webhooks/pending`);
      const body = (await res.json()) as {
        enabled: boolean;
        count: number;
        pending: Array<{ meetingId: string }>;
        deadCount: number;
        deliveriesRateLimited: boolean;
      };
      expect(body.enabled).toBe(true);
      expect(body.count).toBe(2);
      expect(body.pending.map((p) => p.meetingId)).toEqual([
        "01MEETING000000",
        "01MEETING000001",
      ]);
      expect(body.deadCount).toBe(1);
      expect(body.deliveriesRateLimited).toBe(true);
    });
  });

  // ── The surfacing gate (§4.7 / §6.2 / §12a R3) ─────────────────────
  //
  // Under ingest shape B the drain writes NOTHING; the id list it hands back is what turns a
  // delivery into a meeting, so SURFACING an id resurrects the meeting just as surely as a write
  // would. `connector-drain.ts` implemented that faithfully for its own bookkeeping — and the
  // routes ignored all of it: `GET /pending` never read the ledger at all, and `POST /drain`
  // returned `queue.list()` regardless of the drain's verdict.

  test("GET /pending drops a TOMBSTONED id — the ledger gates surfacing, not only writing", async () => {
    const h = createHarness();
    h.tokens.configs.set(ADDRESS, {
      token: generateWebhookToken(),
      source: SOURCE,
      createdAt: new Date().toISOString(),
    });
    h.queue.seed(SOURCE, ADDRESS, 3);
    h.control.ledgers.set(`${SOURCE}/${ADDRESS}`, {
      purgedThrough: new Date(0).toISOString(),
      recentIds: ["01MEETING000001"],
      updatedAt: new Date().toISOString(),
    });

    await withServer(h.app, async (base) => {
      const res = await fetch(`${base}/api/connectors/webhooks/pending`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        count: number;
        pending: Array<{ meetingId: string }>;
      };
      expect(body.count).toBe(2);
      expect(body.pending.map((p) => p.meetingId)).toEqual([
        "01MEETING000000",
        "01MEETING000002",
      ]);
    });
  });

  test("GET /pending FAILS CLOSED on an unreadable ledger rather than surfacing everything", async () => {
    // §6.2: the ledger is an AUTHORIZATION input. An unparseable value read as an empty ledger
    // means "nothing was ever purged" — the most dangerous available reading.
    const h = createHarness();
    h.tokens.configs.set(ADDRESS, {
      token: generateWebhookToken(),
      source: SOURCE,
      createdAt: new Date().toISOString(),
    });
    h.queue.seed(SOURCE, ADDRESS, 3);
    h.control.unparseableLedger = "{not json";

    await withServer(h.app, async (base) => {
      const res = await fetch(`${base}/api/connectors/webhooks/pending`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        count: number;
        pending: unknown[];
        surfaceBlocked: string;
      };
      // Never silence: the card can tell "nothing pending" from "we refused to tell you".
      expect(body.count).toBe(0);
      expect(body.pending).toEqual([]);
      expect(body.surfaceBlocked).toBe("ledger_unavailable");
    });
    // A GET does not write: quarantine belongs to the drain and the purge route.
    expect(h.ops).not.toContain("quarantine-ledger");
  });

  test("GET /pending surfaces NOTHING while a disabled marker stands", async () => {
    // A teardown that crashed between step 1 (marker) and step 5 (queue drop) leaves this
    // user's ids queued for an account that revoked; handing them to the client syncs meetings
    // for a revoked connector.
    const h = createHarness();
    h.tokens.configs.set(ADDRESS, {
      token: generateWebhookToken(),
      source: SOURCE,
      createdAt: new Date().toISOString(),
    });
    h.queue.seed(SOURCE, ADDRESS, 2);
    h.control.markers.set(ADDRESS, {
      revokedAt: new Date().toISOString(),
      source: SOURCE,
    });

    await withServer(h.app, async (base) => {
      const body = (await (
        await fetch(`${base}/api/connectors/webhooks/pending`)
      ).json()) as { enabled: boolean; count: number; surfaceBlocked: string };
      expect(body.enabled).toBe(false);
      expect(body.count).toBe(0);
      expect(body.surfaceBlocked).toBe("revoked");
    });
    // …and the queue itself is untouched: this is a surfacing gate, not a teardown.
    expect((await h.queue.list(SOURCE, ADDRESS)).length).toBe(2);
  });

  test("an address that never enabled reads as empty, not as an error", async () => {
    const h = createHarness();
    await withServer(h.app, async (base) => {
      const res = await fetch(`${base}/api/connectors/webhooks/pending`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        enabled: false,
        disabledAt: null,
        source: null,
        deliveriesRateLimited: false,
        count: 0,
        pending: [],
        deadCount: 0,
        dead: [],
      });
    });
  });
});

// ── POST /drain (§5.4 trigger 3) ─────────────────────────────────────

describe("POST /drain", () => {
  test("kicks the drain and returns the pending id list (ingest shape B)", async () => {
    const h = createHarness({ drain: true });
    h.tokens.configs.set(ADDRESS, {
      token: generateWebhookToken(),
      source: SOURCE,
      createdAt: new Date().toISOString(),
    });
    h.queue.seed(SOURCE, ADDRESS, 2);

    await withServer(h.app, async (base) => {
      const res = await call(base, "/drain", "POST");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { count: number };
      expect(body.count).toBe(2);
    });
    expect(h.drains).toEqual([{ source: SOURCE, address: ADDRESS }]);
  });

  test("never drains a disabled address", async () => {
    const h = createHarness({ drain: true });
    h.tokens.configs.set(ADDRESS, {
      token: generateWebhookToken(),
      source: SOURCE,
      createdAt: new Date().toISOString(),
    });
    h.control.markers.set(ADDRESS, {
      revokedAt: new Date().toISOString(),
      source: SOURCE,
    });

    await withServer(h.app, async (base) => {
      expect((await call(base, "/drain", "POST")).status).toBe(200);
    });
    expect(h.drains).toEqual([]);
  });

  test("an ABORTED drain surfaces NOTHING, whatever is still sitting in the queue (§12a R3)", async () => {
    // The drain aborts on `revoked`, `ledger_unavailable` and `delegation_unusable` BEFORE the
    // tombstone loop runs — it dropped nothing and authorized nothing. The route used to answer
    // 200 with the whole pending queue anyway, so a drain that refused to act because it could
    // not read the purge ledger still handed every id, tombstoned ones included, to the client.
    for (const reason of [
      "ledger_unavailable",
      "delegation_unusable",
      "revoked",
    ]) {
      const h = createHarness({ drain: true, drainAborts: reason });
      h.tokens.configs.set(ADDRESS, {
        token: generateWebhookToken(),
        source: SOURCE,
        createdAt: new Date().toISOString(),
      });
      h.queue.seed(SOURCE, ADDRESS, 2);

      await withServer(h.app, async (base) => {
        const res = await call(base, "/drain", "POST");
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          count: number;
          pending: unknown[];
          surfaceBlocked: string;
        };
        expect(body.count).toBe(0);
        expect(body.pending).toEqual([]);
        expect(body.surfaceBlocked).toBe(reason);
      });
      // Not a teardown: the items stay queued for the next drain that can authorize them.
      expect((await h.queue.list(SOURCE, ADDRESS)).length).toBe(2);
    }
  });

  test("a drain hook that reports nothing readable surfaces NOTHING (fail closed)", async () => {
    const h = createHarness({ drain: true, drainAborts: undefined });
    h.tokens.configs.set(ADDRESS, {
      token: generateWebhookToken(),
      source: SOURCE,
      createdAt: new Date().toISOString(),
    });
    h.queue.seed(SOURCE, ADDRESS, 2);

    // Replace the well-behaved hook with one that returns `undefined`, the pre-fix shape.
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = { address: ADDRESS };
      next();
    });
    app.use(
      "/api/connectors/webhooks",
      createConnectorWebhookCompanionRouter({
        tokens: h.tokens as any,
        queue: h.queue as any,
        control: h.control as any,
        limiters: h.limiters,
        abort: h.abort,
        drain: async () => undefined,
      }),
    );

    await withServer(app, async (base) => {
      const body = (await (await call(base, "/drain", "POST")).json()) as {
        count: number;
        surfaceBlocked: string;
      };
      expect(body.count).toBe(0);
      expect(body.surfaceBlocked).toBe("drain_unreported");
    });
  });

  test("answers 503 rather than a 200 that would read as 'nothing pending' when unwired", async () => {
    const h = createHarness();
    h.tokens.configs.set(ADDRESS, {
      token: generateWebhookToken(),
      source: SOURCE,
      createdAt: new Date().toISOString(),
    });
    await withServer(h.app, async (base) => {
      const res = await call(base, "/drain", "POST");
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "drain_unavailable" });
    });
  });
});

// ── POST /purged — the tombstone ledger (§4.8, §6.2) ─────────────────

describe("POST /purged", () => {
  function enable(h: Harness): void {
    h.tokens.configs.set(ADDRESS, {
      token: generateWebhookToken(),
      source: SOURCE,
      createdAt: new Date().toISOString(),
    });
  }

  test("rejects an unknown source", async () => {
    const h = createHarness();
    enable(h);
    await withServer(h.app, async (base) => {
      const res = await call(base, "/purged", "POST", {
        source: "granola",
        ids: [],
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "unknown_source" });
    });
    expect(h.control.ledgers.size).toBe(0);
  });

  test("rejects a 60 kb id and a traversal id, writing NOTHING", async () => {
    const h = createHarness();
    enable(h);
    await withServer(h.app, async (base) => {
      for (const bad of ["a".repeat(60 * 1024), "../../threads/x", 42, null]) {
        const res = await call(base, "/purged", "POST", {
          source: SOURCE,
          ids: ["01GOODMEETING", bad],
        });
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: "invalid_meeting_id" });
      }
    });
    expect(h.control.ledgers.size).toBe(0);
  });

  test("a 10k-element array stores at most 200 ids, logs the overflow, and still tombstones ALL of them", async () => {
    const h = createHarness();
    enable(h);
    const ids = Array.from(
      { length: 10_000 },
      (_, i) => `01BULK${String(i).padStart(10, "0")}`,
    );

    await withServer(h.app, async (base) => {
      const res = await call(base, "/purged", "POST", { source: SOURCE, ids });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        status: "accepted",
        stored: 200,
        dropped: 9_800,
      });
    });

    const ledger = h.control.ledgers.get(`${SOURCE}/${ADDRESS}`)!;
    expect(ledger.recentIds.length).toBe(PURGE_RECENT_ID_CAP);
    // The cap bounds FORENSICS, not protection: the watermark covers every one of the 10k.
    expect(Date.parse(ledger.purgedThrough)).toBeGreaterThan(
      Date.now() - 60_000,
    );
  });

  test("a 500-id purge leaves nothing resurrectable — the watermark, not the list, protects", async () => {
    const h = createHarness();
    enable(h);
    const ids = Array.from(
      { length: 500 },
      (_, i) => `01FIVEHUNDRED${String(i).padStart(4, "0")}`,
    );
    const receivedAt = new Date(Date.now() - 60_000).toISOString();

    await withServer(h.app, async (base) => {
      const res = await call(base, "/purged", "POST", { source: SOURCE, ids });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        status: "accepted",
        stored: 200,
        dropped: 300,
      });
    });

    const ledger = h.control.ledgers.get(`${SOURCE}/${ADDRESS}`)!;
    // The 300th-oldest id is NOT in recentIds …
    expect(ledger.recentIds).not.toContain("01FIVEHUNDRED0299");
    // … and is still tombstoned, because its receivedAt precedes purgedThrough (§6.2 step -1).
    expect(Date.parse(receivedAt)).toBeLessThan(
      Date.parse(ledger.purgedThrough),
    );
  });

  test("is idempotent — re-posting the same ids never grows recentIds past the cap", async () => {
    const h = createHarness();
    enable(h);
    const ids = Array.from(
      { length: 150 },
      (_, i) => `01REPEAT${String(i).padStart(6, "0")}`,
    );
    await withServer(h.app, async (base) => {
      expect(
        (await call(base, "/purged", "POST", { source: SOURCE, ids })).status,
      ).toBe(204);
      expect(
        (await call(base, "/purged", "POST", { source: SOURCE, ids })).status,
      ).toBe(204);
      expect(
        (await call(base, "/purged", "POST", { source: SOURCE, ids })).status,
      ).toBe(204);
    });
    const ledger = h.control.ledgers.get(`${SOURCE}/${ADDRESS}`)!;
    expect(ledger.recentIds.length).toBe(150);
    expect(new Set(ledger.recentIds).size).toBe(150);
  });

  test("purgedThrough advances monotonically and never moves backwards", async () => {
    const h = createHarness();
    enable(h);
    const newer = new Date(Date.now() - 1_000).toISOString();
    const older = new Date(Date.now() - 10 * 60_000).toISOString();

    await withServer(h.app, async (base) => {
      await call(base, "/purged", "POST", {
        source: SOURCE,
        ids: ["01AAA"],
        purgedThrough: newer,
      });
      await call(base, "/purged", "POST", {
        source: SOURCE,
        ids: ["01BBB"],
        purgedThrough: older,
      });
    });
    expect(h.control.ledgers.get(`${SOURCE}/${ADDRESS}`)!.purgedThrough).toBe(
      newer,
    );
  });

  test("rejects an unparseable or far-future purgedThrough", async () => {
    const h = createHarness();
    enable(h);
    await withServer(h.app, async (base) => {
      for (const value of [
        "not-a-date",
        new Date(Date.now() + 400 * 86_400_000).toISOString(),
      ]) {
        const res = await call(base, "/purged", "POST", {
          source: SOURCE,
          ids: ["01AAA"],
          purgedThrough: value,
        });
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: "invalid_purged_through" });
      }
    });
    expect(h.control.ledgers.size).toBe(0);
  });

  test("the address comes from the SESSION, never the body", async () => {
    const h = createHarness();
    enable(h);
    await withServer(h.app, async (base) => {
      const res = await call(base, "/purged", "POST", {
        source: SOURCE,
        ids: ["01AAA"],
        address: OTHER_ADDRESS,
      });
      expect(res.status).toBe(204);
    });
    expect([...h.control.ledgers.keys()]).toEqual([`${SOURCE}/${ADDRESS}`]);
  });

  test("drops the pending queue for that source (§6.2)", async () => {
    const h = createHarness();
    enable(h);
    h.queue.seed(SOURCE, ADDRESS, 3);
    await withServer(h.app, async (base) => {
      expect(
        (
          await call(base, "/purged", "POST", {
            source: SOURCE,
            ids: ["01AAA"],
          })
        ).status,
      ).toBe(204);
    });
    expect(h.queue.items.size).toBe(0);
  });

  test("an address that never enabled background sync is a 204 no-op", async () => {
    const h = createHarness();
    await withServer(h.app, async (base) => {
      const res = await call(base, "/purged", "POST", {
        source: SOURCE,
        ids: ["01AAA"],
      });
      expect(res.status).toBe(204);
    });
    expect(h.control.ledgers.size).toBe(0);
  });

  // ── F007: fully revoked (config gone, marker standing) ─────────────
  //
  // The early-return no-op covers "never enabled" (config === null AND marker === null) and
  // deliberately stops there. A REVOKED address — the teardown deleted the config and left the
  // durable marker — still writes its tombstone, because this is the second half of
  // disconnect-with-delete: the browser tears the connector down FIRST (so nothing new can
  // arrive mid-delete) and only then reports the ids it purged. Refusing the write here is
  // fail-OPEN: `POST /config` re-enable does not clear the ledger (only `DELETE /purged`
  // does), so a dropped tombstone is a meeting that comes back on reconnect. The KV-growth
  // worry the guard exists for does not apply — a marker only exists for an address that
  // enabled at least once.
  test("a REVOKED address (config gone, marker standing) still records its purge (F007)", async () => {
    const h = createHarness();
    h.control.markers.set(ADDRESS, {
      revokedAt: new Date(1_700_000_000_000).toISOString(),
      source: SOURCE,
    });
    h.queue.seed(SOURCE, ADDRESS, 2);

    await withServer(h.app, async (base) => {
      const res = await call(base, "/purged", "POST", {
        source: SOURCE,
        ids: ["01AFTERREVOKE"],
      });
      expect(res.status).toBe(204);
    });

    const ledger = h.control.ledgers.get(`${SOURCE}/${ADDRESS}`);
    expect(ledger).toBeDefined();
    expect(ledger!.recentIds).toEqual(["01AFTERREVOKE"]);
    expect(h.ops).toContain(`write-ledger:${SOURCE}/${ADDRESS}`);
    // …and the same call still drops that source's queue (§6.2), revoked or not.
    expect(h.queue.items.size).toBe(0);
  });

  test("the tombstone written after revocation survives a later re-enable (F007)", async () => {
    // Why the arm above must not become a no-op: enable clears the QUEUE, never the ledger.
    const h = createHarness();
    h.control.markers.set(ADDRESS, {
      revokedAt: new Date(1_700_000_000_000).toISOString(),
      source: SOURCE,
    });

    await withServer(h.app, async (base) => {
      expect(
        (
          await call(base, "/purged", "POST", {
            source: SOURCE,
            ids: ["01PURGEDBEFOREREENABLE"],
          })
        ).status,
      ).toBe(204);
      expect(
        (await call(base, "/config", "POST", { source: SOURCE })).status,
      ).toBe(200);
    });

    expect(
      h.control.ledgers.get(`${SOURCE}/${ADDRESS}`)!.recentIds,
    ).toEqual(["01PURGEDBEFOREREENABLE"]);
  });

  test("an unparseable ledger is QUARANTINED, never read as an empty one", async () => {
    const h = createHarness();
    enable(h);
    h.control.unparseableLedger = "{not json";
    await withServer(h.app, async (base) => {
      expect(
        (
          await call(base, "/purged", "POST", {
            source: SOURCE,
            ids: ["01AAA"],
          })
        ).status,
      ).toBe(204);
    });
    expect(h.control.corrupt.get(`${SOURCE}/${ADDRESS}`)).toBe("{not json");
    expect(h.control.ops).toContain("quarantine-ledger");
    expect(h.control.ledgers.get(`${SOURCE}/${ADDRESS}`)!.recentIds).toEqual([
      "01AAA",
    ]);
  });

  test("a non-array ids field is a 400, not a silently-empty purge", async () => {
    const h = createHarness();
    enable(h);
    await withServer(h.app, async (base) => {
      const res = await call(base, "/purged", "POST", {
        source: SOURCE,
        ids: "01AAA",
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe(
        "invalid_body",
      );
    });
  });
});

// ── DELETE /purged — the ONLY clear path (§4.8, §6.2) ────────────────

describe("DELETE /purged", () => {
  test("resets purgedThrough AND recentIds", async () => {
    const h = createHarness();
    h.control.ledgers.set(`${SOURCE}/${ADDRESS}`, {
      purgedThrough: new Date().toISOString(),
      recentIds: ["01AAA", "01BBB"],
      updatedAt: new Date().toISOString(),
    });
    await withServer(h.app, async (base) => {
      const res = await call(base, "/purged", "DELETE", { source: SOURCE });
      expect(res.status).toBe(204);
    });
    expect(h.control.ledgers.size).toBe(0);
    expect(h.control.ops).toContain(`clear-ledger:${SOURCE}/${ADDRESS}`);
  });

  test("rejects an unknown source without touching the ledger", async () => {
    const h = createHarness();
    h.control.ledgers.set(`${SOURCE}/${ADDRESS}`, {
      purgedThrough: new Date().toISOString(),
      recentIds: [],
      updatedAt: new Date().toISOString(),
    });
    await withServer(h.app, async (base) => {
      const res = await call(base, "/purged", "DELETE", {
        source: "../../config",
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "unknown_source" });
    });
    expect(h.control.ledgers.size).toBe(1);
  });
});

// ── KV hardening 4/4: ConnectorControlStore surfaces {ok:false} loudly ──
//
// §9.3 durable-Result contract: the SDK's `kv.put`/`kv.delete` resolve to `{ok:false,error}`
// on durable failure — the promise no longer rejects. Silently accepting that ships a 200 for
// a marker or ledger write that never landed, and the drain trusts those markers as ground
// truth. Every companion write must therefore `assertKvResult` inside its `withSessionRefresh`
// callback, exactly as `connector-queue.ts`'s `writeJson`/`deleteKey` already do — see
// packages/server/src/delegation-store.ts for the same shape on the delegation lane.

describe("ConnectorControlStore surfaces {ok:false} loudly (§9.3 durable-Result contract)", () => {
  /**
   * A fake `TinyCloudNode` whose `kv.put` and `kv.delete` RESOLVE `{ok:false,error}` — the exact
   * shape the SDK now hands back for a durable KV failure. `kv.get` returns null so read paths
   * on the store survive; only the write and delete legs are exercised here.
   */
  function makeFailingNode(rejection: string): TinyCloudNode {
    const failure = { ok: false as const, error: rejection };
    return {
      kv: {
        async put(_key: string, _value: unknown) {
          return failure;
        },
        async delete(_key: string) {
          return failure;
        },
        async get(_key: string) {
          return null;
        },
      },
      async signIn() {},
    } as unknown as TinyCloudNode;
  }

  /**
   * A fake node whose kv.GET resolves `{ok:false,error}` — the read-side dual of `makeFailingNode`.
   * The prior helper returned bare `null` on get, which hid the read-side regression: without
   * `assertKvResult` on the read, `readDisabled` and `readLedger` cast a rejected Result to
   * `undefined` and answered `null` / `{status:'absent'}`. `null` is the exact answer the drain
   * and the pending route treat as "not revoked" and "nothing purged" — the two open-fail
   * scenarios §3.6 rule 5 and §6.2 forbid.
   */
  function makeFailingReadNode(rejection: string): TinyCloudNode {
    const failure = { ok: false as const, error: rejection };
    return {
      kv: {
        async put(_key: string, _value: unknown) {
          return { ok: true, data: true };
        },
        async delete(_key: string) {
          return { ok: true, data: true };
        },
        async get(_key: string) {
          return failure;
        },
      },
      async signIn() {},
    } as unknown as TinyCloudNode;
  }

  test("markDisabled throws when kv.put resolves ok:false", async () => {
    const store = new ConnectorControlStore(
      makeFailingNode("marker_write_rejected"),
    );
    await expect(store.markDisabled(ADDRESS, SOURCE)).rejects.toThrow(
      "KV operation failed",
    );
  });

  test("clearDisabled throws when kv.delete resolves ok:false", async () => {
    const store = new ConnectorControlStore(makeFailingNode("delete_rejected"));
    await expect(store.clearDisabled(ADDRESS)).rejects.toThrow(
      "KV operation failed",
    );
  });

  test("writeLedger throws when kv.put resolves ok:false", async () => {
    const store = new ConnectorControlStore(
      makeFailingNode("ledger_write_rejected"),
    );
    await expect(
      store.writeLedger(SOURCE, ADDRESS, {
        purgedThrough: new Date().toISOString(),
        recentIds: [],
        updatedAt: new Date().toISOString(),
      }),
    ).rejects.toThrow("KV operation failed");
  });

  test("clearLedger throws when kv.delete resolves ok:false", async () => {
    const store = new ConnectorControlStore(
      makeFailingNode("clear_ledger_rejected"),
    );
    await expect(store.clearLedger(SOURCE, ADDRESS)).rejects.toThrow(
      "KV operation failed",
    );
  });

  test("quarantineLedger throws when kv.put resolves ok:false", async () => {
    const store = new ConnectorControlStore(
      makeFailingNode("quarantine_rejected"),
    );
    await expect(
      store.quarantineLedger(SOURCE, ADDRESS, "{not json"),
    ).rejects.toThrow("KV operation failed");
  });

  // Route-facing: the store's throw must reach the router, which then answers 503 and logs the
  // ERROR audit line — never the success one. The teardown's FIRST durable act is markDisabled,
  // so a silent 200 would classify the address as revoked with no durable evidence.
  test("DELETE /config with the real store: silent ok:false → 503, never op=disable success", async () => {
    const h = createHarness();
    h.tokens.configs.set(ADDRESS, {
      token: generateWebhookToken(),
      source: SOURCE,
      createdAt: new Date().toISOString(),
    });
    const failingStore = new ConnectorControlStore(
      makeFailingNode("marker_write_rejected"),
    );

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = { address: ADDRESS };
      next();
    });
    app.use(
      "/api/connectors/webhooks",
      createConnectorWebhookCompanionRouter({
        tokens:
          h.tokens as unknown as import("../routes/connector-webhooks.js").WebhookConfigService,
        queue:
          h.queue as unknown as import("../routes/connector-webhooks.js").CompanionQueue,
        control: failingStore,
        limiters: h.limiters,
        abort: h.abort,
      }),
    );

    const capture = captureLogs();
    try {
      await withServer(app, async (base) => {
        const res = await call(base, "/config", "DELETE");
        expect(res.status).toBe(503);
        expect(await res.json()).toEqual({ error: "teardown_incomplete" });
      });
    } finally {
      capture.restore();
    }
    // The success audit line must NOT appear — otherwise operator triage will read a
    // never-landed marker as a completed teardown.
    expect(capture.lines.some((line) => /op=disable aid=/.test(line))).toBe(
      false,
    );
    expect(
      capture.lines.some((line) => /op=disable result=error/.test(line)),
    ).toBe(true);
    // The remaining steps (config revoke, queue clear) must not have run — the teardown must
    // abort at the first failed durable act, not silently skip past a missing marker. The chat
    // delegation is never in this list at all under Option C, failed marker or not.
    expect(h.ops).not.toContain("revoke");
    expect(h.ops).not.toContain(`clear:${SOURCE}/${ADDRESS}`);
    expect(h.ops).not.toContain("delegation-remove");
    expect(h.ops).not.toContain("delegation-evict");
  });

  test("POST /purged with the real store: silent ok:false → 503, never op=purge success", async () => {
    const h = createHarness();
    h.tokens.configs.set(ADDRESS, {
      token: generateWebhookToken(),
      source: SOURCE,
      createdAt: new Date().toISOString(),
    });
    const failingStore = new ConnectorControlStore(
      makeFailingNode("ledger_write_rejected"),
    );

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = { address: ADDRESS };
      next();
    });
    app.use(
      "/api/connectors/webhooks",
      createConnectorWebhookCompanionRouter({
        tokens:
          h.tokens as unknown as import("../routes/connector-webhooks.js").WebhookConfigService,
        queue:
          h.queue as unknown as import("../routes/connector-webhooks.js").CompanionQueue,
        control: failingStore,
        limiters: h.limiters,
        abort: h.abort,
      }),
    );

    const capture = captureLogs();
    try {
      await withServer(app, async (base) => {
        const res = await call(base, "/purged", "POST", {
          source: SOURCE,
          ids: ["01AAA"],
        });
        expect(res.status).toBe(503);
        expect(await res.json()).toEqual({ error: "unavailable" });
      });
    } finally {
      capture.restore();
    }
    // The success audit line for a purge that never landed is what §6.2 forbids: the drain
    // trusts the ledger as an AUTHORIZATION input, and a false success line makes ops read a
    // never-written watermark as protected. Only the error line may appear.
    expect(capture.lines.some((line) => /op=purge source=/.test(line))).toBe(
      false,
    );
    expect(
      capture.lines.some((line) => /op=purge result=error/.test(line)),
    ).toBe(true);
    // Nor may the queue clear have run — that step belongs to §6.2's atomic purge and must not
    // happen while the ledger write is unresolved.
    expect(h.ops).not.toContain(`clear:${SOURCE}/${ADDRESS}`);
  });

  // ── Read-side dual: kv.get returning {ok:false} must not answer null/absent ──
  //
  // The write-side tests above pin `put`/`delete` — but §3.6 rule 5 and §6.2 hinge on the READ:
  // `readDisabled` gates the drain's revoke check (a `null` from a rejected read == "not
  // revoked"); `readLedger` gates the purge tombstone (a `{status:'absent'}` from a rejected
  // read == "nothing was ever purged"). Both are fail-OPEN readings the comments explicitly
  // forbid. The read helper must apply `assertKvResult` inside `withSessionRefresh` too.
  test("readDisabled REJECTS when kv.get resolves ok:false — never silently 'not revoked'", async () => {
    const store = new ConnectorControlStore(
      makeFailingReadNode("marker_read_rejected"),
    );
    await expect(store.readDisabled(ADDRESS)).rejects.toThrow(
      "KV operation failed",
    );
  });

  test("readLedger REJECTS when kv.get resolves ok:false — never silently absent", async () => {
    const store = new ConnectorControlStore(
      makeFailingReadNode("ledger_read_rejected"),
    );
    await expect(store.readLedger(SOURCE, ADDRESS)).rejects.toThrow(
      "KV operation failed",
    );
  });

  test("structured missing-key reads return the control store's optional absent states", async () => {
    const requested: string[] = [];
    const node = {
      kv: {
        async get(key: string): Promise<unknown> {
          requested.push(key);
          return {
            ok: false,
            error: {
              code: "KV_NOT_FOUND",
              message: `Key not found: ${key}`,
              service: "kv",
            },
          };
        },
        async put(): Promise<unknown> {
          return { ok: true, data: true };
        },
        async delete(): Promise<unknown> {
          return { ok: true, data: true };
        },
      },
      async signIn(): Promise<void> {},
    } as unknown as TinyCloudNode;
    const store = new ConnectorControlStore(node);

    await expect(store.readDisabled(ADDRESS)).resolves.toBeNull();
    await expect(store.readLedger(SOURCE, ADDRESS)).resolves.toEqual({
      status: "absent",
    });
    expect(requested).toEqual([
      disabledMarkerKey(ADDRESS),
      purgeLedgerKey(SOURCE, ADDRESS),
    ]);
  });

  test("structured missing-key deletes keep control teardown idempotent", async () => {
    const deleted: string[] = [];
    const node = {
      kv: {
        async get(): Promise<unknown> {
          return { data: null };
        },
        async put(): Promise<unknown> {
          return { ok: true, data: true };
        },
        async delete(key: string): Promise<unknown> {
          deleted.push(key);
          return {
            ok: false,
            error: {
              code: "KV_NOT_FOUND",
              message: `Key not found: ${key}`,
              service: "kv",
            },
          };
        },
      },
      async signIn(): Promise<void> {},
    } as unknown as TinyCloudNode;
    const store = new ConnectorControlStore(node);

    await expect(store.clearDisabled(ADDRESS)).resolves.toBeUndefined();
    await expect(store.clearLedger(SOURCE, ADDRESS)).resolves.toBeUndefined();
    expect(deleted).toEqual([
      disabledMarkerKey(ADDRESS),
      purgeLedgerKey(SOURCE, ADDRESS),
    ]);
  });

  test("Space-not-found control reads and deletes fail closed without mutating durable state", async () => {
    const disabledKey = disabledMarkerKey(ADDRESS);
    const ledgerKey = purgeLedgerKey(SOURCE, ADDRESS);
    const durable = new Map<string, unknown>([
      [disabledKey, { revokedAt: new Date().toISOString(), source: SOURCE }],
      [
        ledgerKey,
        {
          purgedThrough: new Date().toISOString(),
          recentIds: ["01PRESERVED"],
          updatedAt: new Date().toISOString(),
        },
      ],
    ]);
    const failure = {
      ok: false,
      error: {
        code: "KV_NOT_FOUND",
        message: "KV 404 - Space not found",
        service: "kv",
        meta: { status: 404 },
      },
    };
    const requested: string[] = [];
    const deleted: string[] = [];
    const node = {
      kv: {
        async get(key: string): Promise<unknown> {
          requested.push(key);
          return failure;
        },
        async put(): Promise<unknown> {
          return { ok: true, data: true };
        },
        async delete(key: string): Promise<unknown> {
          deleted.push(key);
          return failure;
        },
      },
      async signIn(): Promise<void> {},
    } as unknown as TinyCloudNode;
    const store = new ConnectorControlStore(node);
    const before = new Map(durable);

    await expect(store.readDisabled(ADDRESS)).rejects.toMatchObject({
      code: "KV_NOT_FOUND",
    });
    await expect(store.readLedger(SOURCE, ADDRESS)).rejects.toMatchObject({
      code: "KV_NOT_FOUND",
    });
    await expect(store.clearDisabled(ADDRESS)).rejects.toMatchObject({
      code: "KV_NOT_FOUND",
    });
    await expect(store.clearLedger(SOURCE, ADDRESS)).rejects.toMatchObject({
      code: "KV_NOT_FOUND",
    });
    expect(requested).toEqual([disabledKey, ledgerKey]);
    expect(deleted).toEqual([disabledKey, ledgerKey]);
    expect(durable).toEqual(before);
  });

  // ── Session-class Result{ok:false} rides the single-refresh retry ──
  //
  // `assertKvResult` runs INSIDE the `withSessionRefresh` callback in `readJson`, `writeJson`,
  // and `deleteKey` (see `connector-webhooks.ts:1195-1240`). A Result carrying `error:"session
  // expired"` therefore throws a session-matching Error and takes the exact same single retry
  // path a thrown session error would — parity with
  // packages/server/src/__tests__/delegation-store.test.ts:289-305 for the DelegationStore.
  test("markDisabled: kv.put returning session-expired Result fires one signIn() + one put retry", async () => {
    let putCalls = 0;
    let signInCalls = 0;
    const node = {
      kv: {
        async get(_key: string): Promise<unknown> {
          return null;
        },
        async put(_key: string, _value: unknown): Promise<unknown> {
          putCalls += 1;
          if (putCalls === 1) {
            return { ok: false, error: "session expired" };
          }
          return { ok: true, data: true };
        },
        async delete(_key: string): Promise<unknown> {
          return { ok: true, data: true };
        },
      },
      async signIn(): Promise<void> {
        signInCalls += 1;
      },
    } as unknown as TinyCloudNode;
    const store = new ConnectorControlStore(node);

    await store.markDisabled(ADDRESS, SOURCE);
    expect(signInCalls).toBe(1);
    expect(putCalls).toBe(2);
  });

  test("readDisabled: kv.get returning session-expired Result fires one signIn() + one get retry", async () => {
    let getCalls = 0;
    let signInCalls = 0;
    const node = {
      kv: {
        async get(_key: string): Promise<unknown> {
          getCalls += 1;
          if (getCalls === 1) {
            return { ok: false, error: "session expired" };
          }
          return null;
        },
        async put(_key: string, _value: unknown): Promise<unknown> {
          return { ok: true, data: true };
        },
        async delete(_key: string): Promise<unknown> {
          return { ok: true, data: true };
        },
      },
      async signIn(): Promise<void> {
        signInCalls += 1;
      },
    } as unknown as TinyCloudNode;
    const store = new ConnectorControlStore(node);

    // A `null` retry return is treated as "no marker present" — the retry path must reach here.
    await expect(store.readDisabled(ADDRESS)).resolves.toBeNull();
    expect(signInCalls).toBe(1);
    expect(getCalls).toBe(2);
  });

  test("clearDisabled: kv.delete returning session-expired Result fires one signIn() + one delete retry", async () => {
    let deleteCalls = 0;
    let signInCalls = 0;
    const node = {
      kv: {
        async get(_key: string): Promise<unknown> {
          return null;
        },
        async put(_key: string, _value: unknown): Promise<unknown> {
          return { ok: true, data: true };
        },
        async delete(_key: string): Promise<unknown> {
          deleteCalls += 1;
          if (deleteCalls === 1) {
            return { ok: false, error: "session expired" };
          }
          return { ok: true, data: true };
        },
      },
      async signIn(): Promise<void> {
        signInCalls += 1;
      },
    } as unknown as TinyCloudNode;
    const store = new ConnectorControlStore(node);

    await store.clearDisabled(ADDRESS);
    expect(signInCalls).toBe(1);
    expect(deleteCalls).toBe(2);
  });

  // ── Route-facing DELETE /purged over a failing ConnectorControlStore ──
  //
  // The store-level test above proves `clearLedger` REJECTS on ok:false; this pins the ROUTE
  // wiring for that same failure — DELETE /purged must answer 503 and log only the ERROR audit
  // line, never the success `op=ledger-clear source=…` line the drain reads as authorization.
  // Parity with the DELETE /config + POST /purged integrations above (§4.8 companion contract).
  test("DELETE /purged with the real store: silent ok:false → 503, never op=ledger-clear success", async () => {
    const h = createHarness();
    h.tokens.configs.set(ADDRESS, {
      token: generateWebhookToken(),
      source: SOURCE,
      createdAt: new Date().toISOString(),
    });
    const failingStore = new ConnectorControlStore(
      makeFailingNode("clear_ledger_rejected"),
    );

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = { address: ADDRESS };
      next();
    });
    app.use(
      "/api/connectors/webhooks",
      createConnectorWebhookCompanionRouter({
        tokens:
          h.tokens as unknown as import("../routes/connector-webhooks.js").WebhookConfigService,
        queue:
          h.queue as unknown as import("../routes/connector-webhooks.js").CompanionQueue,
        control: failingStore,
        limiters: h.limiters,
        abort: h.abort,
      }),
    );

    const capture = captureLogs();
    try {
      await withServer(app, async (base) => {
        const res = await call(base, "/purged", "DELETE", { source: SOURCE });
        expect(res.status).toBe(503);
        expect(await res.json()).toEqual({ error: "unavailable" });
      });
    } finally {
      capture.restore();
    }
    // The success audit line for a ledger clear that never landed would tell the drain the
    // watermark is safe to advance past. Only the error line may appear.
    expect(
      capture.lines.some((line) =>
        /op=ledger-clear source=\S+ aid=/.test(line),
      ),
    ).toBe(false);
    expect(
      capture.lines.some((line) => /op=ledger-clear result=error/.test(line)),
    ).toBe(true);
  });
});
