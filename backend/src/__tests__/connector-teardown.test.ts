import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import express from "express";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import type { TinyCloudNode } from "@tinycloud/node-sdk";

import {
  CONTENT_MASTER_ENV,
  ContentStore,
  InMemoryContentBlobStore,
  PURGE_TOMBSTONED,
  _resetContentMasterCache,
} from "../services/content-store.js";
import {
  CREDENTIAL_MASTER_ENV,
  CredentialStore,
  InMemoryCredentialRowStore,
  _resetCredentialMasterCache,
  type CredentialSecret,
} from "../services/credential-store.js";
import { ConnectorQueue } from "../services/connector-queue.js";
import { ConnectorFetchWorker } from "../services/fetch-worker.js";
import type {
  ContentUpsertInput,
  MeetingFetchRequest,
  MeetingFetchResult,
  MeetingFetcher,
} from "../services/fetch-worker.js";
import { ConnectorTeardownService } from "../services/connector-teardown.js";
import { createConnectorCredentialRouter } from "../routes/connector-credentials.js";
import type { ConnectorOAuthPort } from "../routes/connector-credentials.js";
import type {
  PurgeLedger,
  PurgeLedgerRead,
  DisabledMarker,
} from "../routes/connector-webhooks.js";
import type { IngestMode } from "../services/ingest-mode.js";
import { _resetWebhookTokenState } from "../services/webhook-tokens.js";
import { deriveWebhookSecret, WebhookTokenService } from "../services/webhook-tokens.js";
import { ConnectorDrainAbortFlags, ConnectorWebhookLimiters, createConnectorWebhookCompanionRouter, createConnectorWebhookHandler, respondToConnectorPurgeCheck } from "../routes/connector-webhooks.js";

/**
 * W7 — TEARDOWN + PURGE EXTENSION (backend-ingest plan §8.1 W7; §8.2 delta item 12;
 * §9 anti-pattern 8 — "no teardown: secret/mapping/queue/delegation left behind").
 *
 * Every test here is tagged `[delta-12]`, whose acceptance sentence is the checklist:
 *
 *   Disconnect → credential gone (+ revoke called), content gone, queue gone, tombstones
 *   present; redeliver an old webhook post-purge → tombstoned, nothing re-stored, no re-fetch.
 *
 * The tombstone half is the reason this is not just three deletes in a row. Fireflies is
 * at-least-once and a timestamp-less delivery is replayable indefinitely (findings §2.1), so a
 * teardown that deletes without a watermark is a teardown a replay undoes: the meetings come
 * back into a store the user disconnected from. The shipped purge ledger (§6.2's
 * `purgedThrough` + `recentIds`, applied by `connector-drain`'s `isTombstoned`) is extended to
 * the server content store rather than copied — one rule, two consumers.
 */

const ORIGINAL_ENV = { ...process.env };

const SOURCE = "fireflies";
const ADDRESS_A = "0x7d033300000000000000000000000000000073f2";
const ADDRESS_B = "0xb1b1b10000000000000000000000000000001111";
const CONTENT_MASTER = "R29vZE1hc3RlckZvckNvbnRlbnRFbnZlbG9wZXNBQTA9";
const CREDENTIAL_MASTER = "Zk9pQ2xUb0FzRHZFcldxTnBZeEhtQjNnU2o1dDBjMD0=";
const WEBHOOK_MASTER = "3H8Qk0m2yq1sZ0VjK5xPwq0nA6oJ2bL9dR4tW7uY1cM=";
const LOG_SALT = "aQ2wS3eD4rF5tG6yH7uJ8iK9oL0pZ1xC2vB3nM4kJ5h=";

/** The strings a teardown must never leak into a log line, a response or the substrate. */
const SECRET_A = "ff-access-token-AAAA-1111";
const SECRET_B = "ff-access-token-BBBB-3333";
const TRANSCRIPT_TEXT = "so about the Q3 layoffs — Dana said legal is blocking";

const T0 = Date.parse("2026-08-10T12:00:00.000Z");
const HOUR_MS = 3_600_000;

beforeEach(() => {
  _resetWebhookTokenState();
  _resetContentMasterCache();
  _resetCredentialMasterCache();
  process.env[CONTENT_MASTER_ENV] = CONTENT_MASTER;
  process.env[CREDENTIAL_MASTER_ENV] = CREDENTIAL_MASTER;
  process.env.WEBHOOK_HMAC_MASTER = WEBHOOK_MASTER;
  process.env.LOG_HASH_SALT = LOG_SALT;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  _resetWebhookTokenState();
  _resetContentMasterCache();
  _resetCredentialMasterCache();
});

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

/** The queue is REAL — a stub would let the teardown assert its own clear. */
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

class FakeOAuth implements ConnectorOAuthPort {
  readonly calls: string[] = [];
  revokeFails = false;

  authorizeUrl(input: { state: string; challenge: string }): string {
    return `https://api.fireflies.ai/authorize?state=${input.state}&code_challenge=${input.challenge}`;
  }

  async exchangeCode(): Promise<CredentialSecret> {
    return { kind: "oauth", accessToken: SECRET_A };
  }

  async revoke(_secret: CredentialSecret): Promise<void> {
    this.calls.push("revoke");
    if (this.revokeFails) throw new Error("upstream revoke 500");
  }
}

class CountingFetcher implements MeetingFetcher {
  readonly calls: string[] = [];

  async fetchMeeting(request: MeetingFetchRequest): Promise<MeetingFetchResult> {
    this.calls.push(request.meetingId);
    return {
      ok: true,
      content: {
        sourceId: request.meetingId,
        title: "Q3 planning sync",
        ts: new Date(T0 - HOUR_MS).toISOString(),
        payload: { transcript: TRANSCRIPT_TEXT },
      },
    };
  }
}

interface Harness {
  exoCleared: Array<{ source: string; address: string }>;
  clock: () => number;
  advance: (ms: number) => void;
  node: FakeNode;
  queue: ConnectorQueue;
  blobs: InMemoryContentBlobStore;
  content: ContentStore;
  rows: InMemoryCredentialRowStore;
  credentials: CredentialStore;
  control: FakeControl;
  oauth: FakeOAuth;
  tokens: WebhookTokenService;
  teardown: ConnectorTeardownService;
}

function harness(): Harness {
  let clock = T0;
  const now = () => clock;

  const node = new FakeNode();
  const queue = new ConnectorQueue(asNode(node), {
    now,
    jitter: () => 0,
    flushWindowMs: 1,
  });
  const control = new FakeControl();
  const blobs = new InMemoryContentBlobStore();
  const content = new ContentStore(blobs, { now, purgeLedger: control });
  const rows = new InMemoryCredentialRowStore();
  const oauth = new FakeOAuth();
  const credentials = new CredentialStore(rows, {
    now,
    upstreamRevoker: (secret) => oauth.revoke(secret),
  });
  const exoCleared: Array<{ source: string; address: string }> = [];
  const tokens = new WebhookTokenService(asNode(node));
  const teardown = new ConnectorTeardownService(
    {
      notifications: { disable: async (source, address) => {
        await control.markDisabled(address, source, true);
        await tokens.revoke(address);
      } },
      credentials,
      content,
      queue,
      control,
      exo: {
        clearSource: async (source, address) => {
          exoCleared.push({ source, address });
        },
      },
    },
    { now },
  );

  return {
    clock: now,
    advance: (ms: number) => {
      clock += ms;
    },
    node,
    queue,
    blobs,
    content,
    rows,
    credentials,
    control,
    oauth,
    tokens,
    teardown,
    exoCleared,
  };
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

async function recordActivePurge(h: Harness, recentIds: string[]) {
  const stamp = new Date(h.clock()).toISOString();
  await h.control.writeLedger(SOURCE, ADDRESS_A, { recentIds, purgedThrough: stamp, updatedAt: stamp });
  await h.content.purge(SOURCE, ADDRESS_A);
}

function upsertInput(
  address: string,
  sourceId: string,
  overrides: Partial<ContentUpsertInput> = {},
): ContentUpsertInput {
  return {
    source: SOURCE,
    address,
    sourceId,
    kind: "transcript",
    title: "Q3 planning sync",
    ts: new Date(T0 - HOUR_MS).toISOString(),
    content: { transcript: TRANSCRIPT_TEXT },
    fetchedAt: new Date(T0).toISOString(),
    receivedAt: new Date(T0).toISOString(),
    ...overrides,
  };
}

async function seedTenant(
  h: Harness,
  address: string,
  secret: CredentialSecret,
  meetingIds: string[],
): Promise<void> {
  await h.credentials.store({ source: SOURCE, address, secret });
  for (const id of meetingIds) {
    // Sequential by requirement — never Promise.all across meetings.
    const stored = await h.content.upsert(upsertInput(address, id));
    expect(stored.ok).toBe(true);
    await h.queue.enqueue(SOURCE, address, {
      meetingId: id,
      kind: "transcript",
      receivedAt: new Date(T0).toISOString(),
      sourceTimestamp: new Date(T0 - HOUR_MS).toISOString(),
    });
  }
}

// ── The DELETE-shaped disconnect ─────────────────────────────────────

describe("W7 teardown — full per-user teardown (delta 12, AP 8)", () => {
  test("[delta-12] disconnect deletes the credential, every content row and the queue — and calls the upstream revoke", async () => {
    const h = harness();
    await seedTenant(h, ADDRESS_A, { kind: "oauth", accessToken: SECRET_A }, [
      "mtgA1",
      "mtgA2",
    ]);

    const result = await h.teardown.run(SOURCE, ADDRESS_A);

    expect(result.deleted).toBe(true);
    expect(result.upstreamRevoked).toBe("ok");
    expect(h.oauth.calls).toEqual(["revoke"]);
    expect(result.contentRemoved).toBe(2);
    expect(result.queueDropped).toBe(2);

    expect(await h.credentials.status(SOURCE, ADDRESS_A)).toBeNull();
    expect(await h.content.list(SOURCE, ADDRESS_A)).toEqual([]);
    expect(await h.queue.list(SOURCE, ADDRESS_A)).toEqual([]);
    // Nothing of the meeting survives in the substrate, sealed or otherwise.
    expect(h.blobs.dump()).not.toContain("mtgA1");
    expect(h.blobs.dump()).not.toContain(TRANSCRIPT_TEXT);
  });

  test("disconnect clears this source's Exo ledger rows for the normalized address", async () => {
    const h = harness();
    await seedTenant(h, ADDRESS_A, { kind: "oauth", accessToken: SECRET_A }, ["mtgA1"]);

    await h.teardown.run(SOURCE, ADDRESS_A);

    expect(h.exoCleared).toEqual([{ source: SOURCE, address: ADDRESS_A.toLowerCase() }]);
    expect(await h.credentials.status(SOURCE, ADDRESS_A)).toBeNull();
  });

  test("with the exo flag off the teardown has no exo step and still completes", async () => {
    const h = harness();
    await seedTenant(h, ADDRESS_A, { kind: "oauth", accessToken: SECRET_A }, ["mtgA1"]);
    const teardown = new ConnectorTeardownService(
      { notifications: { disable: async () => {} }, credentials: h.credentials, content: h.content, queue: h.queue, control: h.control },
      { now: h.clock },
    );

    const result = await teardown.run(SOURCE, ADDRESS_A);

    expect(result.deleted).toBe(true);
    expect(result.contentRemoved).toBe(1);
    expect(h.exoCleared).toEqual([]);
    expect(await h.credentials.status(SOURCE, ADDRESS_A)).toBeNull();
  });

  test("[delta-12] the purge ledger covers content AND credential — a tombstone is present after the teardown", async () => {
    const h = harness();
    await seedTenant(h, ADDRESS_A, { kind: "oauth", accessToken: SECRET_A }, [
      "mtgA1",
    ]);

    await withCallbackServer(h, async base => {
      const active = await enableCallbacks(base);
      const replay = callbackDelivery(active.url, active.secret);
      expect((await replay()).status).toBe(202);
      const result = await h.teardown.run(SOURCE, ADDRESS_A);

      const ledger = h.control.ledgerAtRemoval(SOURCE, ADDRESS_A);
      expect(Date.parse(ledger!.purgedThrough)).toBe(T0);
      expect(ledger!.recentIds).toContain("mtgA1");
      expect(result.tombstonedThrough).toBe(new Date(T0).toISOString());
      expect(h.control.ledgerFor(SOURCE, ADDRESS_A)).toBeNull();
      expect((await replay()).status).toBe(401);
      expect(await h.queue.list(SOURCE, ADDRESS_A)).toEqual([]);
      expect(await h.content.list(SOURCE, ADDRESS_A)).toEqual([]);
    });
  });

  test("[delta-12] the ledger watermark only ever moves forward", async () => {
    const h = harness();
    await h.control.writeLedger(SOURCE, ADDRESS_A, {
      purgedThrough: new Date(T0 + 5 * HOUR_MS).toISOString(),
      recentIds: ["older"],
      updatedAt: new Date(T0).toISOString(),
    });
    await seedTenant(h, ADDRESS_A, { kind: "oauth", accessToken: SECRET_A }, []);

    await h.teardown.run(SOURCE, ADDRESS_A);

    const ledger = h.control.ledgerAtRemoval(SOURCE, ADDRESS_A);
    expect(Date.parse(ledger!.purgedThrough)).toBe(T0 + 5 * HOUR_MS);
    expect(ledger!.recentIds).toContain("older");
    expect(h.control.ledgerFor(SOURCE, ADDRESS_A)).toBeNull();
  });

  test("[delta-12] an unparseable ledger is quarantined, never read as 'nothing was ever purged'", async () => {
    const h = harness();
    await seedTenant(h, ADDRESS_A, { kind: "oauth", accessToken: SECRET_A }, [
      "mtgA1",
    ]);
    // A ledger corrupted between the last purge and this teardown.
    h.control.ledgers.set(`${SOURCE} ${ADDRESS_A}`, { nonsense: true });

    const capture = captureLogs();
    try {
      await h.teardown.run(SOURCE, ADDRESS_A);
    } finally {
      capture.restore();
    }

    expect(h.control.quarantined).toHaveLength(1);
    expect(h.control.ledgerAtRemoval(SOURCE, ADDRESS_A)!.recentIds).toContain("mtgA1");
    expect(h.control.ledgerFor(SOURCE, ADDRESS_A)).toBeNull();
  });

  test("[delta-12] a ledger write that fails aborts the teardown BEFORE anything is deleted", async () => {
    const h = harness();
    await seedTenant(h, ADDRESS_A, { kind: "oauth", accessToken: SECRET_A }, [
      "mtgA1",
    ]);
    h.control.failWrite = true;

    const capture = captureLogs();
    try {
      await expect(h.teardown.run(SOURCE, ADDRESS_A)).rejects.toThrow();
    } finally {
      capture.restore();
    }

    // Deleting content without a durable tombstone is how a replay resurrects it.
    expect(await h.content.list(SOURCE, ADDRESS_A)).toHaveLength(1);
    expect(await h.credentials.status(SOURCE, ADDRESS_A)).not.toBeNull();
    expect(h.oauth.calls).toEqual([]);
  });

  test("[delta-12] a failed upstream revoke is surfaced, not swallowed — and custody still ends", async () => {
    const h = harness();
    await seedTenant(h, ADDRESS_A, { kind: "oauth", accessToken: SECRET_A }, [
      "mtgA1",
    ]);
    h.oauth.revokeFails = true;

    const capture = captureLogs();
    let result;
    try {
      result = await h.teardown.run(SOURCE, ADDRESS_A);
    } finally {
      capture.restore();
    }

    expect(result.upstreamRevoked).toBe("failed");
    expect(result.deleted).toBe(true);
    // The local half completed anyway: a provider outage must not leave us holding a live key.
    expect(await h.credentials.status(SOURCE, ADDRESS_A)).toBeNull();
    expect(await h.content.list(SOURCE, ADDRESS_A)).toEqual([]);
  });

  test("[delta-12] the teardown reaches ONLY the tenant it names", async () => {
    const h = harness();
    await seedTenant(h, ADDRESS_A, { kind: "oauth", accessToken: SECRET_A }, [
      "mtgA1",
    ]);
    await seedTenant(h, ADDRESS_B, { kind: "oauth", accessToken: SECRET_B }, [
      "mtgB1",
    ]);

    await h.teardown.run(SOURCE, ADDRESS_A);

    expect(await h.credentials.status(SOURCE, ADDRESS_B)).not.toBeNull();
    expect(await h.content.list(SOURCE, ADDRESS_B)).toHaveLength(1);
    expect(await h.queue.list(SOURCE, ADDRESS_B)).toHaveLength(1);
    expect(h.control.ledgerFor(SOURCE, ADDRESS_B)).toBeNull();
  });

  test("[delta-12] the teardown is idempotent: a second call is clean and reports nothing left", async () => {
    const h = harness();
    await seedTenant(h, ADDRESS_A, { kind: "oauth", accessToken: SECRET_A }, [
      "mtgA1",
    ]);

    await h.teardown.run(SOURCE, ADDRESS_A);
    const again = await h.teardown.run(SOURCE, ADDRESS_A);

    expect(again.contentRemoved).toBe(0);
    expect(again.queueDropped).toBe(0);
    expect(again.deleted).toBe(true);
    expect(again.upstreamRevoked).toBe("not_applicable");
  });

  test("[delta-12] the teardown log carries no credential, no raw address and no meeting id", async () => {
    const h = harness();
    await seedTenant(h, ADDRESS_A, { kind: "oauth", accessToken: SECRET_A }, [
      "mtgA1",
    ]);

    const capture = captureLogs();
    try {
      await h.teardown.run(SOURCE, ADDRESS_A);
    } finally {
      capture.restore();
    }

    const joined = capture.lines.join("\n");
    expect(joined).toContain("op=teardown");
    expect(joined).not.toContain(SECRET_A);
    expect(joined).not.toContain(ADDRESS_A);
    expect(joined).not.toContain("mtgA1");
    expect(joined).not.toContain(TRANSCRIPT_TEXT);
  });
});

// ── The purge extension: redelivery after purge ──────────────────────

describe("W7 purge extension — redelivery after purge (delta 12, AP 8)", () => {
  test("[delta-12] a redelivery after purge is TOMBSTONED, not re-stored", async () => {
    const h = harness();
    await seedTenant(h, ADDRESS_A, { kind: "oauth", accessToken: SECRET_A }, [
      "mtgA1",
    ]);
    await recordActivePurge(h, ["mtgA1"]);
    h.advance(HOUR_MS);

    // The provider replays the SAME delivery: same id, same (pre-purge) provider timestamp.
    const replay = await h.content.upsert(upsertInput(ADDRESS_A, "mtgA1"));

    expect(replay).toEqual({ ok: false, code: PURGE_TOMBSTONED });
    expect(await h.content.list(SOURCE, ADDRESS_A)).toEqual([]);
    expect(h.blobs.dump()).not.toContain(TRANSCRIPT_TEXT);
  });

  test("[delta-12] a timestamp-less redelivery after purge is tombstoned too", async () => {
    const h = harness();
    await seedTenant(h, ADDRESS_A, { kind: "oauth", accessToken: SECRET_A }, []);
    await recordActivePurge(h, []);
    h.advance(HOUR_MS);

    const legacy = upsertInput(ADDRESS_A, "mtgLegacy");
    delete (legacy as { ts?: string }).ts;
    const replay = await h.content.upsert(legacy);

    // The legacy `{meetingId, eventType}` shape carries no provider stamp; treating it as fresh
    // is what made the watermark inert (connector-drain's isTombstoned note).
    expect(replay).toEqual({ ok: false, code: PURGE_TOMBSTONED });
  });

  test("[delta-12] the watermark is not a kill switch: a meeting recorded AFTER the purge still stores", async () => {
    const h = harness();
    await seedTenant(h, ADDRESS_A, { kind: "oauth", accessToken: SECRET_A }, []);
    await h.teardown.run(SOURCE, ADDRESS_A);
    h.advance(HOUR_MS);

    const fresh = await h.content.upsert(
      upsertInput(ADDRESS_A, "mtgFresh", {
        ts: new Date(T0 + HOUR_MS / 2).toISOString(),
        receivedAt: new Date(T0 + HOUR_MS).toISOString(),
      }),
    );

    expect(fresh).toEqual({ ok: true, stored: "created" });
    expect(await h.content.list(SOURCE, ADDRESS_A)).toHaveLength(1);
  });

  test("[delta-12] the purge tombstone is scoped: another tenant's identical id still stores", async () => {
    const h = harness();
    await seedTenant(h, ADDRESS_A, { kind: "oauth", accessToken: SECRET_A }, [
      "mtgA1",
    ]);
    await h.teardown.run(SOURCE, ADDRESS_A);

    const other = await h.content.upsert(upsertInput(ADDRESS_B, "mtgA1"));

    expect(other).toEqual({ ok: true, stored: "created" });
  });

  test("[delta-12] an unreadable ledger is never read as 'not tombstoned' — the store fails closed", async () => {
    const h = harness();
    h.control.ledgers.set(`${SOURCE} ${ADDRESS_A}`, { nonsense: true });

    const capture = captureLogs();
    let result;
    try {
      result = await h.content.upsert(upsertInput(ADDRESS_A, "mtgA1"));
    } finally {
      capture.restore();
    }

    expect(result.ok).toBe(false);
    expect(await h.content.list(SOURCE, ADDRESS_A).catch(() => "threw")).toEqual(
      [],
    );
    // The guard the worker consults propagates rather than answering "not tombstoned".
    await expect(
      h.content.tombstoned({
        source: SOURCE,
        address: ADDRESS_A,
        meetingId: "mtgA1",
        kind: "transcript",
      }),
    ).rejects.toThrow();
  });

  test("an old signed Fireflies webhook returns 401 after disconnect and reconnect", async () => {
    const h = harness();
    await withCallbackServer(h, async base => {
      const initial = await enableCallbacks(base);
      const oldToken = new URL(initial.url).pathname.split("/").at(-1)!;
      expect(initial.secret).toBe(deriveWebhookSecret(SOURCE, oldToken));
      const replay = callbackDelivery(initial.url, initial.secret);
      expect((await replay()).status).toBe(202);
      await h.teardown.run(SOURCE, ADDRESS_A);
      expect((await replay()).status).toBe(401);
      const fresh = await enableCallbacks(base);
      expect(fresh.url).not.toBe(initial.url);
      expect(fresh.secret).not.toBe(initial.secret);
      expect((await replay()).status).toBe(401);
      expect(await h.queue.list(SOURCE, ADDRESS_A)).toEqual([]);
      expect(await h.content.list(SOURCE, ADDRESS_A)).toEqual([]);
    });
  });

  test("an explicit re-sync after reconnection can import meetings from the earlier connection", async () => {
    const h = harness();
    await seedTenant(h, ADDRESS_A, { kind: "oauth", accessToken: SECRET_A }, ["mtgA1"]);
    await withCallbackServer(h, async base => {
      await enableCallbacks(base);
      await h.teardown.run(SOURCE, ADDRESS_A);
      h.advance(HOUR_MS);
      await h.credentials.store({ source: SOURCE, address: ADDRESS_A, secret: { kind: "oauth", accessToken: SECRET_A } });
      const fresh = await enableCallbacks(base);
      const clear = await fetch(`${base}/api/connectors/webhooks/purged`, {
        method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ source: SOURCE }),
      });
      expect(clear.status).toBe(204);
      expect((await callbackDelivery(fresh.url, fresh.secret)()).status).toBe(202);
      const fetcher = new CountingFetcher();
      const worker = new ConnectorFetchWorker({
        queue: h.queue,
        modes: { cohort: async () => new Set([ADDRESS_A.toLowerCase()]), mode: async () => "backend" },
        credentials: { getCredential: (source, address) => h.credentials.getCredential(source, address, "fetch-worker") },
        fetcher, content: h.content, retention: h.content,
      }, { now: h.clock, sleep: async () => {}, sources: [SOURCE] });
      await worker.runOnce();
      expect(fetcher.calls).toEqual(["mtgA1"]);
      expect((await h.content.list(SOURCE, ADDRESS_A)).map(meta => meta.sourceId)).toEqual(["mtgA1"]);
    });
  });
});

// ── The route: one idempotent DELETE ─────────────────────────────────

describe("W7 teardown route — the disconnect the client calls (delta 12)", () => {
  async function withServer<T>(
    app: express.Express,
    fn: (base: string) => Promise<T>,
  ): Promise<T> {
    const server = await new Promise<import("http").Server>((resolve_) => {
      const instance = app.listen(0, () => resolve_(instance));
    });
    const { port } = server.address() as { port: number };
    try {
      return await fn(`http://localhost:${port}`);
    } finally {
      await new Promise<void>((resolve_, reject) =>
        server.close((error) => (error ? reject(error) : resolve_())),
      );
    }
  }

  function routeApp(h: Harness): express.Express {
    const app = express();
    app.use(express.json({ limit: "1mb" }));
    app.use((req, _res, next) => {
      req.user = { address: ADDRESS_A };
      next();
    });
    app.use(
      "/api/connectors/credentials",
      createConnectorCredentialRouter({
        credentials: h.credentials,
        oauth: h.oauth,
        teardown: h.teardown,
        modes: {
          mode: async (address: string): Promise<IngestMode> =>
            address.toLowerCase() === ADDRESS_A.toLowerCase()
              ? "backend"
              : "browser",
        },
      }),
    );
    return app;
  }

  test("[delta-12] DELETE /credentials/:source runs the FULL teardown, not just the credential row", async () => {
    const h = harness();
    await seedTenant(h, ADDRESS_A, { kind: "oauth", accessToken: SECRET_A }, [
      "mtgA1",
      "mtgA2",
    ]);

    const capture = captureLogs();
    let body: Record<string, unknown>;
    let status: number;
    try {
      ({ body, status } = await withServer(routeApp(h), async (base) => {
        const response = await fetch(
          `${base}/api/connectors/credentials/${SOURCE}`,
          { method: "DELETE" },
        );
        return {
          status: response.status,
          body: (await response.json()) as Record<string, unknown>,
        };
      }));
    } finally {
      capture.restore();
    }

    expect(status).toBe(200);
    expect(body.deleted).toBe(true);
    expect(body.upstreamRevoked).toBe(true);
    expect(body.contentRemoved).toBe(2);
    expect(body.queueDropped).toBe(2);
    expect(await h.credentials.status(SOURCE, ADDRESS_A)).toBeNull();
    expect(await h.content.list(SOURCE, ADDRESS_A)).toEqual([]);
    expect(h.control.ledgerFor(SOURCE, ADDRESS_A)).toBeNull();
    // The response is a disposition, never a credential or a meeting id.
    expect(JSON.stringify(body)).not.toContain(SECRET_A);
    expect(JSON.stringify(body)).not.toContain("mtgA1");
  });

  test("[delta-12] a failed upstream revoke answers 502 and still reports the local teardown", async () => {
    const h = harness();
    await seedTenant(h, ADDRESS_A, { kind: "oauth", accessToken: SECRET_A }, [
      "mtgA1",
    ]);
    h.oauth.revokeFails = true;

    const capture = captureLogs();
    let body: Record<string, unknown>;
    let status: number;
    try {
      ({ body, status } = await withServer(routeApp(h), async (base) => {
        const response = await fetch(
          `${base}/api/connectors/credentials/${SOURCE}`,
          { method: "DELETE" },
        );
        return {
          status: response.status,
          body: (await response.json()) as Record<string, unknown>,
        };
      }));
    } finally {
      capture.restore();
    }

    expect(status).toBe(502);
    expect(body.error).toBe("upstream_revoke_failed");
    expect(body.deleted).toBe(true);
    expect(body.upstreamRevoked).toBe(false);
    expect(body.contentRemoved).toBe(1);
    expect(await h.content.list(SOURCE, ADDRESS_A)).toEqual([]);
  });
});

test("an active Fireflies purge blocks webhook import until the owner allows the meeting back", async () => {
  const h = harness();
  await seedTenant(h, ADDRESS_A, { kind: "oauth", accessToken: SECRET_A }, []);
  await withCallbackServer(h, async base => {
    const active = await enableCallbacks(base);
    const headers = { "content-type": "application/json" };
    const prefix = `${base}/api/connectors/webhooks`;
    const purge = await fetch(`${prefix}/purged`, {
      method: "POST", headers, body: JSON.stringify({ source: SOURCE, ids: ["mtgA1"] }),
    });
    expect(purge.status).toBe(204);
    const check = () => fetch(`${prefix}/purge-check`, {
      method: "POST", headers, body: JSON.stringify({ meetingId: "mtgA1", sourceTimestamp: new Date(T0 - HOUR_MS).toISOString() }),
    }).then(response => response.json());
    expect(await check()).toEqual({ blocked: true });
    const send = callbackDelivery(active.url, active.secret);
    const fetcher = new CountingFetcher();
    const worker = new ConnectorFetchWorker({
      queue: h.queue,
      modes: { cohort: async () => new Set([ADDRESS_A.toLowerCase()]), mode: async () => "backend" },
      credentials: { getCredential: (source, address) => h.credentials.getCredential(source, address, "fetch-worker") },
      fetcher, content: h.content, retention: h.content,
    }, { now: h.clock, sleep: async () => {}, sources: [SOURCE] });
    expect((await send()).status).toBe(202);
    await worker.runOnce();
    expect(fetcher.calls).toEqual([]);
    expect(await h.content.get(SOURCE, ADDRESS_A, "mtgA1")).toBeNull();
    expect((await fetch(`${prefix}/purged`, {
      method: "DELETE", headers, body: JSON.stringify({ source: SOURCE }),
    })).status).toBe(204);
    expect(await check()).toEqual({ blocked: false });
    expect((await send()).status).toBe(202);
    await worker.runOnce();
    expect(fetcher.calls).toEqual(["mtgA1"]);
    expect(await h.content.get(SOURCE, ADDRESS_A, "mtgA1")).not.toBeNull();
  });
});

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
    expect(await h.content.list(SOURCE, ADDRESS_A)).toEqual([]);
  });
});

test("a newly minted callback returns 401 when reconnect cannot clear the disconnect marker", async () => {
  const h = harness();
  await withCallbackServer(h, async base => {
    const before = await enableCallbacks(base);
    await h.teardown.run(SOURCE, ADDRESS_A);
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
    expect(await h.content.list(SOURCE, ADDRESS_A)).toEqual([]);
  });
});
