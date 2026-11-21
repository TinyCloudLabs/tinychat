import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import express from "express";
import {
  ConnectorWebhookLimiters,
  createConnectorWebhookCompanionRouter,
  createConnectorPurgeRouter,
  respondToConnectorPurgeCheck,
  type ConnectorControl,
  type DisabledMarker,
  type PurgeLedger,
  type PurgeLedgerRead,
} from "../routes/connector-webhooks.js";
import { _resetWebhookTokenState } from "../services/webhook-tokens.js";

/**
 * Granola keeps a purge ledger without webhook delivery: `LEDGER_ONLY_SOURCES` opens
 * `POST /purge-check`, `POST /purged` and `DELETE /purged` for it, and nothing else.
 */

const ORIGINAL_ENV = { ...process.env };
const ADDRESS = "0x7d033300000000000000000000000000000073f2";
const MASTER = "3H8Qk0m2yq1sZ0VjK5xPwq0nA6oJ2bL9dR4tW7uY1cM=";
const LOG_SALT = "aQ2wS3eD4rF5tG6yH7uJ8iK9oL0pZ1xC2vB3nM4kJ5h=";

class FakeControl implements ConnectorControl {
  readonly ledgers = new Map<string, PurgeLedger>();
  readonly ops: string[] = [];
  /** Set to prove a ledger-only source never reads Fireflies' webhook state. */
  marker: DisabledMarker | null = { revokedAt: new Date().toISOString(), source: null, connectionRemoved: true };

  private key(source: string, address: string): string {
    return `${source}/${address.toLowerCase()}`;
  }
  async readDisabled(): Promise<DisabledMarker | null> {
    this.ops.push("read-disabled");
    return this.marker;
  }
  async markDisabled(): Promise<void> {}
  async clearDisabled(): Promise<void> {}
  async readLedger(source: string, address: string): Promise<PurgeLedgerRead> {
    const ledger = this.ledgers.get(this.key(source, address));
    return ledger === undefined ? { status: "absent" } : { status: "ok", ledger };
  }
  async writeLedger(source: string, address: string, ledger: PurgeLedger): Promise<void> {
    this.ops.push(`write-ledger:${source}`);
    this.ledgers.set(this.key(source, address), ledger);
  }
  async clearLedger(source: string, address: string): Promise<void> {
    this.ops.push(`clear-ledger:${source}`);
    this.ledgers.delete(this.key(source, address));
  }
  async quarantineLedger(): Promise<void> {}
  async clearQuarantinedLedger(): Promise<void> {}
}

function createApp(webhooksEnabled = true) {
  const control = new FakeControl();
  const ops = control.ops;
  const tokens = { config: async () => null, mint: async () => { throw new Error("unused"); }, rotate: async () => { throw new Error("unused"); }, revoke: async () => {} };
  const queue = {
    list: async () => [],
    dead: async () => [],
    clear: async (source: string) => { ops.push(`queue-clear:${source}`); return { cleared: 0, superseded: 0 }; },
    acknowledge: async () => [],
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { address: ADDRESS };
    next();
  });
  app.post("/api/connectors/webhooks/purge-check", (req, res) => respondToConnectorPurgeCheck(control, req, res));
  app.use("/api/connectors/webhooks", createConnectorPurgeRouter({ control }));
  if (webhooksEnabled) {
  app.use(
    "/api/connectors/webhooks",
    createConnectorWebhookCompanionRouter({
      tokens: tokens as never,
      queue: queue as never,
      control,
      limiters: new ConnectorWebhookLimiters({ ipLimit: 0, tokenSuccessLimit: 0 }),
    }),
  );
  }
  return { app, control };
}

async function withServer<T>(app: express.Express, fn: (base: string) => Promise<T>): Promise<T> {
  const server = await new Promise<import("http").Server>((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });
  const { port } = server.address() as { port: number };
  try {
    return await fn(`http://localhost:${port}/api/connectors/webhooks`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

function send(base: string, path: string, method: string, body: unknown): Promise<Response> {
  return fetch(`${base}${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
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

const BEFORE = "2026-01-01T00:00:00.000Z";
const AFTER = new Date(Date.now() + 60_000).toISOString();

describe("a ledger-only source (granola)", () => {
  test("records a tombstone with no webhook state, ignoring Fireflies' removed-connection marker, and clears no queue", async () => {
    const { app, control } = createApp();
    await withServer(app, async (base) => {
      const res = await send(base, "/purged", "POST", { source: "granola", ids: ["not_abc123"] });
      expect(res.status).toBe(204);
    });
    expect(control.ledgers.has(`granola/${ADDRESS}`)).toBe(true);
    expect(control.ops).toContain("write-ledger:granola");
    expect(control.ops.some((op) => op.startsWith("queue-clear"))).toBe(false);
    expect(control.ops).not.toContain("read-disabled");
  });

  test("purge-check blocks a deleted meeting, lets a newer one through, and keeps the Fireflies ledger separate", async () => {
    const { app } = createApp();
    await withServer(app, async (base) => {
      await send(base, "/purged", "POST", { source: "granola", ids: ["not_abc123"], purgedThrough: "2026-06-01T00:00:00.000Z" });
      const check = async (body: Record<string, unknown>) =>
        (await (await send(base, "/purge-check", "POST", body)).json()) as { blocked: boolean };

      expect(await check({ source: "granola", meetingId: "not_abc123", sourceTimestamp: BEFORE })).toEqual({ blocked: true });
      expect(await check({ source: "granola", meetingId: "not_other1", sourceTimestamp: BEFORE })).toEqual({ blocked: true });
      expect(await check({ source: "granola", meetingId: "not_other2", sourceTimestamp: AFTER })).toEqual({ blocked: false });
      // No ledger for Fireflies, and a call without `source` still means Fireflies.
      expect(await check({ meetingId: "not_abc123", sourceTimestamp: BEFORE })).toEqual({ blocked: false });
      expect(await check({ source: "fireflies", meetingId: "not_abc123", sourceTimestamp: BEFORE })).toEqual({ blocked: false });
    });
  });

  test("DELETE /purged lets deleted meetings back", async () => {
    const { app, control } = createApp();
    await withServer(app, async (base) => {
      await send(base, "/purged", "POST", { source: "granola", ids: ["not_abc123"], purgedThrough: "2026-06-01T00:00:00.000Z" });
      const res = await send(base, "/purged", "DELETE", { source: "granola" });
      expect(res.status).toBe(204);
      const check = await send(base, "/purge-check", "POST", { source: "granola", meetingId: "not_abc123", sourceTimestamp: BEFORE });
      expect(await check.json()).toEqual({ blocked: false });
    });
    expect(control.ledgers.size).toBe(0);
  });
});

describe("sources that are still unknown", () => {
  test("an unregistered source 400s on every ledger route", async () => {
    const { app, control } = createApp();
    await withServer(app, async (base) => {
      for (const [path, method, body] of [
        ["/purged", "POST", { source: "not-registered", ids: [] }],
        ["/purged", "DELETE", { source: "not-registered" }],
        ["/purge-check", "POST", { source: "not-registered", meetingId: "not_abc123" }],
        ["/purge-check", "POST", { source: "../../config", meetingId: "not_abc123" }],
      ] as const) {
        const res = await send(base, path, method, body);
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: "unknown_source" });
      }
    });
    expect(control.ledgers.size).toBe(0);
  });

  test("granola is not a webhook source: /config refuses it", async () => {
    const { app } = createApp();
    await withServer(app, async (base) => {
      const res = await send(base, "/config", "POST", { source: "granola" });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "unknown_source" });
    });
  });
});

test("Granola deletion and explicit restoration work with webhook delivery disabled", async () => {
  const { app, control } = createApp(false);
  await withServer(app, async (base) => {
    expect((await send(base, "/purged", "POST", { source: "granola", ids: ["not_abc123"] })).status).toBe(204);
    const blocked = await send(base, "/purge-check", "POST", { source: "granola", meetingId: "not_abc123", sourceTimestamp: BEFORE });
    expect(await blocked.json()).toEqual({ blocked: true });
    expect((await send(base, "/purged", "DELETE", { source: "granola" })).status).toBe(204);
    const allowed = await send(base, "/purge-check", "POST", { source: "granola", meetingId: "not_abc123", sourceTimestamp: BEFORE });
    expect(await allowed.json()).toEqual({ blocked: false });
    expect(control.ops).not.toContain("read-disabled");
  });
});
