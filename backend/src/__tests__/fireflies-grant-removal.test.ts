import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { once } from "node:events";
import type { Server } from "node:http";
import express, { type NextFunction, type Request, type Response } from "express";
import { createCsrfMiddleware } from "@tinyboilerplate/server";
import { generatePrivateKey } from "viem/accounts";
import { createApiBodyParser } from "../body-parsing.js";
import { deriveFirefliesImportKeys, FIREFLIES_DELEGATE_KMS_PATH } from "../fireflies-import-identity.js";
import { createConnectorWebhookCompanionRouter, ConnectorWebhookLimiters } from "../routes/connector-webhooks.js";
import { createFirefliesDelegationRouter } from "../routes/fireflies-delegation.js";
import { FirefliesGrantStore } from "../services/fireflies-grant-store.js";
import { TenantCoordinator } from "../services/calendar-autojoin-store.js";
import { createMemoryGrantKv, HOST, mintGrantPair } from "./helpers/fireflies-grant-fixtures.js";

const NOW = Date.UTC(2026, 10, 22, 17, 30, 0);
const DAY = 86_400_000;

async function fixture(seed: number) {
  const keys = await deriveFirefliesImportKeys(
    { getKey: async (p) => Buffer.alloc(32, p === FIREFLIES_DELEGATE_KMS_PATH ? seed : seed + 1) },
    { host: HOST, env: {} },
  );
  const cidOf = keys.delegate.node.computeDelegationCid.bind(keys.delegate.node);
  const memory = createMemoryGrantKv();
  const store = new FirefliesGrantStore({ kv: memory.kv, kek: keys.grantKek, delegateDid: keys.delegate.did });
  const grant = (ttlMs = 7 * DAY) => mintGrantPair(keys.delegate.did, cidOf, { now: NOW, ttlMs });
  const verifyOptions = (now = NOW) => ({ configuredHost: HOST, deps: { computeDelegationCid: cidOf }, now });
  return { keys, cidOf, memory, store, grant, verifyOptions };
}

/** Runs each owner's work one at a time, as the server does. */
const run = <T>(coordinator: TenantCoordinator) => (address: string, fn: () => Promise<T>) => coordinator.run(address, fn);

describe("stored Fireflies import grants do not outlive their purpose", () => {
  it("replaces expired and other-delegate records with a content-free marker and leaves live ones alone", async () => {
    const f = await fixture(0xa1);
    const live = await f.grant();
    const lapsed = await f.grant(1_000);
    await f.store.store(live.address, live, live.expiresAt);
    await f.store.store(lapsed.address, lapsed, lapsed.expiresAt);

    // A record sealed for a delegate the server no longer has (a KMS move) is dead weight too.
    const otherKeys = await deriveFirefliesImportKeys(
      { getKey: async (p) => Buffer.alloc(32, p === FIREFLIES_DELEGATE_KMS_PATH ? 0xb7 : 0xb8) },
      { host: HOST, env: {} },
    );
    const moved = await mintGrantPair(
      otherKeys.delegate.did,
      otherKeys.delegate.node.computeDelegationCid.bind(otherKeys.delegate.node),
      { now: NOW },
    );
    const otherStore = new FirefliesGrantStore({ kv: f.memory.kv, kek: otherKeys.grantKek, delegateDid: otherKeys.delegate.did });
    await otherStore.store(moved.address, moved, moved.expiresAt);

    const coordinator = new TenantCoordinator();
    const result = await f.store.reapLapsed({ now: NOW + 60_000, run: run(coordinator) });
    expect(result).toEqual({ scanned: 3, reaped: 2 });

    const raw = (address: string) => f.memory.rows.get(f.store.keyFor(address)) as Record<string, unknown>;
    expect(raw(live.address).state).toBe("active");
    for (const dead of [lapsed.address, moved.address]) {
      expect(raw(dead).state).toBe("needs_renewal");
      expect(raw(dead).ciphertext).toBeUndefined();
      expect(raw(dead).iv).toBeUndefined();
      expect(raw(dead).tag).toBeUndefined();
    }

    // Second pass finds nothing left to reap.
    expect(await f.store.reapLapsed({ now: NOW + 60_000, run: run(coordinator) })).toEqual({ scanned: 3, reaped: 0 });
  });

  it("keeps a grant the owner stored again between the listing and the replacement", async () => {
    const f = await fixture(0xa3);
    const owner = generatePrivateKey();
    const stale = await mintGrantPair(f.keys.delegate.did, f.cidOf, { now: NOW, ttlMs: 1_000, privateKey: owner });
    const renewed = await mintGrantPair(f.keys.delegate.did, f.cidOf, { now: NOW + 5_000, privateKey: owner });
    await f.store.store(stale.address, stale, stale.expiresAt);

    // The renewal lands after the sweep listed the record and before it takes the owner's lock.
    const sweep = await f.store.reapLapsed({
      now: NOW + 5_000,
      run: async (address, fn) => {
        await f.store.store(address, renewed, renewed.expiresAt);
        return fn();
      },
    });

    expect(sweep).toEqual({ scanned: 1, reaped: 0 });
    expect((f.memory.rows.get(f.store.keyFor(stale.address)) as { state: string }).state).toBe("active");
  });

  it("keeps the two grant ids from acceptance until removal, through a lapse and an unreadable grant", async () => {
    const f = await fixture(0xa7);
    const pair = await f.grant();
    const parsed = (grant: string) => (JSON.parse(grant) as { cid: string }).cid;
    const ids = { secrets: parsed(pair.secretsGrant), meetings: parsed(pair.meetingsGrant) };
    expect(await f.store.grantCids(pair.address)).toBeNull();
    await f.store.store(pair.address, pair, pair.expiresAt);
    expect(await f.store.grantCids(pair.address)).toEqual(ids);

    // The sweep replaces the sealed grant with a marker; the ids stay, so the owner's browser can still revoke them.
    const coordinator = new TenantCoordinator();
    expect(await f.store.reapLapsed({ now: NOW + 8 * DAY, run: run(coordinator) })).toEqual({ scanned: 1, reaped: 1 });
    expect((f.memory.rows.get(f.store.keyFor(pair.address)) as { state: string }).state).toBe("needs_renewal");
    expect(await f.store.grantCids(pair.address)).toEqual(ids);

    // A grant the importer later marks revoked keeps them too.
    await f.store.markState(pair.address, "revoked");
    expect(await f.store.grantCids(pair.address)).toEqual(ids);

    await f.store.remove(pair.address);
    expect(await f.store.grantCids(pair.address)).toBeNull();
  });
});

describe("GET /api/connectors/fireflies/delegation/grants", () => {
  it("lists the two ids for the signed-in owner only, and never any grant material", async () => {
    const f = await fixture(0xa9);
    const mine = await f.grant();
    const theirs = await f.grant();
    await f.store.store(mine.address, mine, mine.expiresAt);
    await f.store.store(theirs.address, theirs, theirs.expiresAt);
    let signedIn: string | undefined = mine.address;

    const app = express();
    app.use(createApiBodyParser());
    app.use(createCsrfMiddleware());
    app.use(
      "/api/connectors/fireflies/delegation",
      createFirefliesDelegationRouter({
        delegate: f.keys.delegate,
        configuredHost: HOST,
        store: f.store,
        now: () => NOW,
        authMiddleware: (req: Request, res: Response, next: NextFunction) => {
          if (!signedIn) {
            res.status(401).json({ error: "unauthenticated" });
            return;
          }
          req.user = { address: signedIn };
          next();
        },
      }),
    );

    await withServer(app, async (base) => {
      const get = () => fetch(`${base}/api/connectors/fireflies/delegation/grants`, { headers: { "x-requested-with": "XMLHttpRequest" } });
      const res = await get();
      expect(res.status).toBe(200);
      const body = (await res.json()) as { grantCids: string[] };
      const cid = (grant: string) => (JSON.parse(grant) as { cid: string }).cid;
      expect(body).toEqual({ grantCids: [cid(mine.secretsGrant), cid(mine.meetingsGrant)] });
      expect(JSON.stringify(body)).not.toContain("Bearer");

      await f.store.remove(mine.address);
      expect(await (await get()).json()).toEqual({ grantCids: [] });

      signedIn = undefined;
      expect((await get()).status).toBe(401);
    });
  });
});

describe("grant ids survive a grant the server can no longer open", () => {
  it("lists the ids for a sealed grant that fails to decrypt, where the verified read gives up", async () => {
    const f = await fixture(0xa5);
    const pair = await f.grant();
    await f.store.store(pair.address, pair, pair.expiresAt);
    const key = f.store.keyFor(pair.address);
    const row = f.memory.rows.get(key) as Record<string, unknown>;
    f.memory.rows.set(key, { ...row, ciphertext: Buffer.alloc(8, 1).toString("base64") });

    expect((await f.store.status(pair.address, f.verifyOptions())).state).toBe("needs_renewal");
    const parsed = (grant: string) => (JSON.parse(grant) as { cid: string }).cid;
    expect(await f.store.grantCids(pair.address)).toEqual({ secrets: parsed(pair.secretsGrant), meetings: parsed(pair.meetingsGrant) });
  });
});

describe("disconnect and purge remove the stored Fireflies grant", () => {
  const ADDRESS = "0x1111111111111111111111111111111111111111";

  beforeEach(() => {
    process.env.WEBHOOK_HMAC_MASTER = Buffer.alloc(32, 0x41).toString("base64");
    process.env.LOG_HASH_SALT = Buffer.alloc(32, 0x42).toString("base64");
  });
  afterEach(() => {
    delete process.env.WEBHOOK_HMAC_MASTER;
    delete process.env.LOG_HASH_SALT;
  });

  function harness(removeFirefliesGrant: (address: string) => Promise<void>) {
    const ledgerWrites: unknown[] = [];
    const tokens = {
      config: async () => ({ source: "fireflies", createdAt: new Date(NOW).toISOString() }),
      revoke: async () => {},
      mint: async () => {
        throw new Error("unused");
      },
    };
    const control = {
      markDisabled: async () => {},
      readDisabled: async () => null,
      readLedger: async () => ({ status: "absent" as const }),
      writeLedger: async (_source: string, _address: string, ledger: unknown) => {
        ledgerWrites.push(ledger);
      },
      quarantineLedger: async () => {},
      clearLedger: async () => {},
    };
    const queue = {
      clear: async () => ({ cleared: 0 }),
      list: async () => [],
    };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = { address: ADDRESS };
      next();
    });
    app.use(
      "/api/connectors/webhooks",
      createConnectorWebhookCompanionRouter({
        tokens: tokens as never,
        queue: queue as never,
        control: control as never,
        limiters: new ConnectorWebhookLimiters(),
        removeFirefliesGrant,
      }),
    );
    return { app, ledgerWrites };
  }

  const send = (base: string, path: string, method: string, body?: unknown) =>
    fetch(`${base}/api/connectors/webhooks${path}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  it("removes the grant on disconnect and on a Fireflies purge, and answers 503 so the client retries when removal fails", async () => {
    const removed: string[] = [];
    let failing = false;
    const h = harness(async (address) => {
      if (failing) throw new Error("storage down");
      removed.push(address);
    });

    await withServer(h.app, async (base) => {
      expect((await send(base, "/config", "DELETE")).status).toBe(200);
      expect(removed).toEqual([ADDRESS]);

      const purge = await send(base, "/purged", "POST", { source: "fireflies", ids: ["m1"] });
      expect(purge.status).toBe(204);
      expect(removed).toEqual([ADDRESS, ADDRESS]);
      expect(h.ledgerWrites).toHaveLength(1);

      failing = true;
      const failedPurge = await send(base, "/purged", "POST", { source: "fireflies", ids: ["m2"] });
      expect(failedPurge.status).toBe(503);
      // Nothing was tombstoned on the failed attempt; the identical retry does the whole job.
      expect(h.ledgerWrites).toHaveLength(1);
      expect((await send(base, "/config", "DELETE")).status).toBe(503);

      failing = false;
      expect((await send(base, "/purged", "POST", { source: "fireflies", ids: ["m2"] })).status).toBe(204);
      expect(h.ledgerWrites).toHaveLength(2);
    });
  });
});

async function withServer<T>(app: express.Express, runIt: (base: string) => Promise<T>): Promise<T> {
  const server: Server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const { port } = server.address() as { port: number };
    return await runIt(`http://127.0.0.1:${port}`);
  } finally {
    const closed = once(server, "close");
    server.close();
    await closed;
  }
}
