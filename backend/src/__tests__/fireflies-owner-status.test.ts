import { describe, expect, it } from "bun:test";
import { once } from "node:events";
import type { Server } from "node:http";
import express, { type NextFunction, type Request, type Response } from "express";
import { createCsrfMiddleware } from "@tinyboilerplate/server";
import { createApiBodyParser } from "../body-parsing.js";
import { deriveFirefliesImportKeys, FIREFLIES_DELEGATE_KMS_PATH } from "../fireflies-import-identity.js";
import { createFirefliesDelegationRouter } from "../routes/fireflies-delegation.js";
import { FirefliesGrantStore } from "../services/fireflies-grant-store.js";
import { createMemoryGrantKv, HOST, mintGrantPair } from "./helpers/fireflies-grant-fixtures.js";

const NOW = Date.UTC(2026, 10, 22, 17, 30, 0);
const DAY = 86_400_000;

async function fixture(seed: number) {
  const keys = await deriveFirefliesImportKeys(
    { getKey: async (p) => Buffer.alloc(32, p === FIREFLIES_DELEGATE_KMS_PATH ? seed : seed + 1) },
    { host: HOST, env: {} },
  );
  const cidOf = keys.delegate.node.computeDelegationCid.bind(keys.delegate.node);
  const store = new FirefliesGrantStore({ kv: createMemoryGrantKv().kv, kek: keys.grantKek, delegateDid: keys.delegate.did });
  return { keys, store, grant: () => mintGrantPair(keys.delegate.did, cidOf, { now: NOW, ttlMs: 7 * DAY }) };
}

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

async function statusOf(f: Awaited<ReturnType<typeof fixture>>, address: string | undefined, now: number) {
  const app = express();
  app.use(createApiBodyParser());
  app.use(createCsrfMiddleware());
  app.use(
    "/api/connectors/fireflies/delegation",
    createFirefliesDelegationRouter({
      delegate: f.keys.delegate,
      configuredHost: HOST,
      store: f.store,
      now: () => now,
      authMiddleware: (req: Request, res: Response, next: NextFunction) => {
        if (!address) {
          res.status(401).json({ error: "unauthenticated" });
          return;
        }
        req.user = { address };
        next();
      },
    }),
  );
  return withServer(app, async (base) => {
    const res = await fetch(`${base}/api/connectors/fireflies/delegation/status`, { headers: { "x-requested-with": "XMLHttpRequest" } });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  });
}

describe("GET /api/connectors/fireflies/delegation/status", () => {
  it("gives the delegate to sign for, the state and the two ids, and nothing secret", async () => {
    const f = await fixture(0xb1);
    const mine = await f.grant();
    const none = await statusOf(f, mine.address, NOW);
    expect(none.status).toBe(200);
    expect(none.body).toEqual({ state: "none", expiresAt: null, delegateDid: f.keys.delegate.did, grantCids: [] });

    await f.store.store(mine.address, mine, mine.expiresAt);
    const active = await statusOf(f, mine.address, NOW);
    const cid = (grant: string) => (JSON.parse(grant) as { cid: string }).cid;
    expect(active.body).toEqual({
      state: "active",
      expiresAt: mine.expiresAt.toISOString(),
      delegateDid: f.keys.delegate.did,
      grantCids: [cid(mine.secretsGrant), cid(mine.meetingsGrant)],
    });
    expect(JSON.stringify(active.body)).not.toContain("Bearer");

    const lapsed = await statusOf(f, mine.address, NOW + 8 * DAY);
    expect(lapsed.body).toMatchObject({ state: "needs_renewal", grantCids: [], delegateDid: f.keys.delegate.did });
  });

  it("answers 401 without a signed-in owner", async () => {
    const f = await fixture(0xb2);
    expect((await statusOf(f, undefined, NOW)).status).toBe(401);
  });
});
