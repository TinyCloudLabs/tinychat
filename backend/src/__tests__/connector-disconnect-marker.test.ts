import { afterEach, beforeEach, expect, test } from "bun:test";
import express from "express";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import type { TinyCloudNode } from "@tinycloud/node-sdk";

import { ConnectorQueue } from "../services/connector-queue.js";
import type {
  PurgeLedger,
  PurgeLedgerRead,
  DisabledMarker,
} from "../routes/connector-webhooks.js";
import { _resetWebhookTokenState } from "../services/webhook-tokens.js";
import { deriveWebhookSecret, WebhookTokenService } from "../services/webhook-tokens.js";
import { ConnectorDrainAbortFlags, ConnectorWebhookLimiters, createConnectorWebhookCompanionRouter, createConnectorWebhookHandler, respondToConnectorPurgeCheck } from "../routes/connector-webhooks.js";

/**
 * The delivery handler answers 401 while a disabled marker stands, even for a callback token that
 * is still live. Moved from the removed teardown suite (TC-1964 test ruling, item 12).
 */

const ORIGINAL_ENV = { ...process.env };

const SOURCE = "fireflies";
const ADDRESS_A = "0x7d033300000000000000000000000000000073f2";
const WEBHOOK_MASTER = "3H8Qk0m2yq1sZ0VjK5xPwq0nA6oJ2bL9dR4tW7uY1cM=";
const LOG_SALT = "aQ2wS3eD4rF5tG6yH7uJ8iK9oL0pZ1xC2vB3nM4kJ5h=";

const T0 = Date.parse("2026-08-10T12:00:00.000Z");
const HOUR_MS = 3_600_000;

beforeEach(() => {
  _resetWebhookTokenState();
  process.env.WEBHOOK_HMAC_MASTER = WEBHOOK_MASTER;
  process.env.LOG_HASH_SALT = LOG_SALT;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  _resetWebhookTokenState();
});

/** The queue is REAL — a stub would let the test assert its own clear. */
class FakeNode {
  readonly store = new Map<string, unknown>();

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
  };

  async signIn(): Promise<void> {}
}

function asNode(node: FakeNode): TinyCloudNode {
  return node as unknown as TinyCloudNode;
}

/** The §6.2 ledger store, as the companions own it. Raw on purpose: a corrupt value is a case. */
class FakeControl {
  readonly ledgers = new Map<string, unknown>();
  readonly ledgersAtRemoval = new Map<string, PurgeLedger>();
  readonly disabled = new Map<string, DisabledMarker>();
  async readDisabled(address: string) { return this.disabled.get(address) ?? null; }
  async markDisabled(address: string, source: string | null, connectionRemoved?: true) {
    this.disabled.set(address, { source, revokedAt: new Date().toISOString(), connectionRemoved });
  }
  async clearDisabled(address: string) { this.disabled.delete(address); }
  async clearLedger(source: string, address: string) {
    const ledger = this.ledgerFor(source, address);
    if (ledger) this.ledgersAtRemoval.set(this.key(source, address), ledger);
    this.ledgers.delete(this.key(source, address));
  }
  ledgerAtRemoval(source: string, address: string) { return this.ledgersAtRemoval.get(this.key(source, address)); }
  readonly quarantined: Array<{ key: string; raw: unknown }> = [];
  failWrite = false;

  async readLedger(source: string, address: string): Promise<PurgeLedgerRead> {
    const raw = this.ledgers.get(this.key(source, address));
    if (raw === undefined || raw === null) return { status: "absent" };
    const value = raw as Record<string, unknown>;
    if (
      typeof value.purgedThrough !== "string" ||
      !Array.isArray(value.recentIds) ||
      !Number.isFinite(Date.parse(value.purgedThrough))
    ) {
      return { status: "unparseable", raw };
    }
    return { status: "ok", ledger: raw as unknown as PurgeLedger };
  }

  async writeLedger(
    source: string,
    address: string,
    ledger: PurgeLedger,
  ): Promise<void> {
    if (this.failWrite) throw new Error("ledger write failed");
    this.ledgers.set(this.key(source, address), JSON.parse(JSON.stringify(ledger)));
  }

  async quarantineLedger(
    source: string,
    address: string,
    raw: unknown,
  ): Promise<void> {
    this.quarantined.push({ key: this.key(source, address), raw });
  }

  ledgerFor(source: string, address: string): PurgeLedger | null {
    const raw = this.ledgers.get(this.key(source, address));
    return raw === undefined ? null : (raw as PurgeLedger);
  }

  private key(source: string, address: string): string {
    return `${source} ${address.toLowerCase()}`;
  }
}

interface Harness {
  clock: () => number;
  node: FakeNode;
  queue: ConnectorQueue;
  control: FakeControl;
  tokens: WebhookTokenService;
}

function harness(): Harness {
  const now = () => T0;
  const node = new FakeNode();
  const queue = new ConnectorQueue(asNode(node), {
    now,
    jitter: () => 0,
    flushWindowMs: 1,
  });
  const control = new FakeControl();
  const tokens = new WebhookTokenService(asNode(node));
  return { clock: now, node, queue, control, tokens };
}

async function withCallbackServer<T>(h: Harness, action: (base: string) => Promise<T>): Promise<T> {
  const app = express();
  const limiters = new ConnectorWebhookLimiters();
  app.post("/api/connectors/webhooks/:source/:token", express.raw({ type: "application/json" }),
    createConnectorWebhookHandler({ tokens: h.tokens, queue: h.queue, control: h.control, now: h.clock, limiters }));
  app.use(express.json(), (req, _res, next) => { req.user = { address: ADDRESS_A }; next(); });
  app.post("/api/connectors/webhooks/purge-check", (req, res) => respondToConnectorPurgeCheck(h.control, req, res));
  app.use("/api/connectors/webhooks", createConnectorWebhookCompanionRouter({
    tokens: h.tokens, queue: h.queue, control: h.control, now: h.clock, limiters, abort: new ConnectorDrainAbortFlags(),
  }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    return await action(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

function callbackDelivery(url: string, secret: string) {
  const body = JSON.stringify({ eventType: "meeting.transcribed", meetingId: "mtgA1", timestamp: new Date(T0 - HOUR_MS).toISOString() });
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  return () => fetch(url, {
    method: "POST", headers: { "content-type": "application/json", "x-hub-signature": signature }, body,
  });
}

async function enableCallbacks(base: string): Promise<{ url: string; secret: string }> {
  const response = await fetch(`${base}/api/connectors/webhooks/config`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source: SOURCE }),
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<{ url: string; secret: string }>;
}

test("a signed callback returns 401 while the disconnect marker stands", async () => {
  const h = harness();
  await withCallbackServer(h, async base => {
    const active = await enableCallbacks(base);
    const send = callbackDelivery(active.url, active.secret);
    expect((await send()).status).toBe(202);
    await h.queue.clear(SOURCE, ADDRESS_A);
    await h.control.markDisabled(ADDRESS_A, SOURCE, true);
    // The token is still live while teardown or replacement works through its durable steps.
    const token = new URL(active.url).pathname.split("/").at(-1)!;
    expect(await h.tokens.lookup(token)).not.toBeNull();
    expect((await send()).status).toBe(401);
    expect(await h.queue.list(SOURCE, ADDRESS_A)).toEqual([]);
  });
});

test("a newly minted callback returns 401 when reconnect cannot clear the disconnect marker", async () => {
  const h = harness();
  await withCallbackServer(h, async base => {
    const before = await enableCallbacks(base);
    await h.control.markDisabled(ADDRESS_A, null, true);
    await h.tokens.revoke(ADDRESS_A);
    expect(await h.tokens.config(ADDRESS_A)).toBeNull();

    h.control.clearDisabled = async () => { throw new Error("marker clear failed"); };
    const enable = await fetch(`${base}/api/connectors/webhooks/config`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source: SOURCE }),
    });
    expect(enable.status).toBe(503);
    expect(await h.control.readDisabled(ADDRESS_A)).toMatchObject({ connectionRemoved: true });

    const replacement = await h.tokens.config(ADDRESS_A);
    expect(replacement).not.toBeNull();
    const token = replacement!.token;
    expect(token).not.toBe(new URL(before.url).pathname.split("/").at(-1));
    expect(await h.tokens.lookup(token)).not.toBeNull();

    const url = `${base}/api/connectors/webhooks/${SOURCE}/${token}`;
    expect((await callbackDelivery(url, deriveWebhookSecret(SOURCE, token))()).status).toBe(401);
    expect(await h.queue.list(SOURCE, ADDRESS_A)).toEqual([]);
  });
});
