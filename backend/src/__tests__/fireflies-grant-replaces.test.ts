import { describe, expect, it } from "bun:test";
import { once } from "node:events";
import type { Server } from "node:http";
import express, { type NextFunction, type Request, type Response } from "express";
import { createCsrfMiddleware } from "@tinyboilerplate/server";
import { generatePrivateKey } from "viem/accounts";
import { createApiBodyParser } from "../body-parsing.js";
import { deriveFirefliesImportKeys, FIREFLIES_DELEGATE_KMS_PATH } from "../fireflies-import-identity.js";
import { createFirefliesDelegationRouter } from "../routes/fireflies-delegation.js";
import { FirefliesGrantReplacesMismatchError, FirefliesGrantStore } from "../services/fireflies-grant-store.js";
import { createMemoryGrantKv, HOST, mintGrantPair } from "./helpers/fireflies-grant-fixtures.js";

const NOW = Date.UTC(2026, 10, 22, 17, 30, 0);

const cidOfGrant = (grant: string) => (JSON.parse(grant) as { cid: string }).cid;

async function fixture(seed: number) {
  const keys = await deriveFirefliesImportKeys(
    { getKey: async (p) => Buffer.alloc(32, p === FIREFLIES_DELEGATE_KMS_PATH ? seed : seed + 1) },
    { host: HOST, env: {} },
  );
  const cidOf = keys.delegate.node.computeDelegationCid.bind(keys.delegate.node);
  const memory = createMemoryGrantKv();
  const store = new FirefliesGrantStore({ kv: memory.kv, kek: keys.grantKek, delegateDid: keys.delegate.did });
  const grant = (privateKey?: `0x${string}`) => mintGrantPair(keys.delegate.did, cidOf, { now: NOW, ...(privateKey ? { privateKey } : {}) });
  const ids = (pair: { secretsGrant: string; meetingsGrant: string }) => [cidOfGrant(pair.secretsGrant), cidOfGrant(pair.meetingsGrant)];
  const state = (address: string) => (memory.rows.get(store.keyFor(address)) as { state?: string } | undefined)?.state;
  return { keys, memory, store, grant, ids, state };
}

describe("a grant write names the grants it replaces", () => {
  it("stores when it names nothing and nothing is held, and when it names exactly what is held", async () => {
    const f = await fixture(0xc1);
    const first = await f.grant();
    const second = await f.grant();
    await f.store.store(first.address, first, first.expiresAt, []);
    expect(f.state(first.address)).toBe("active");
    // The same owner's renewal names the two ids it replaces, in either order.
    await f.store.store(first.address, { ...second }, second.expiresAt, [...f.ids(first)].reverse());
    expect(await f.store.grantCids(first.address)).toEqual({
      secrets: cidOfGrant(second.secretsGrant),
      meetings: cidOfGrant(second.meetingsGrant),
    });
  });

  it("refuses and changes nothing when the ids named are not the ids held", async () => {
    const f = await fixture(0xc3);
    const held = await f.grant();
    const incoming = await f.grant();
    await f.store.store(held.address, held, held.expiresAt, []);
    const before = structuredClone(f.memory.rows.get(f.store.keyFor(held.address)));

    // Names nothing, but a pair is held; names a different id; names only one of the two.
    for (const named of [[], ["some-other-id", cidOfGrant(held.meetingsGrant)], [cidOfGrant(held.secretsGrant)]]) {
      await expect(f.store.store(held.address, incoming, incoming.expiresAt, named)).rejects.toBeInstanceOf(
        FirefliesGrantReplacesMismatchError,
      );
    }
    expect(f.memory.rows.get(f.store.keyFor(held.address))).toEqual(before);
  });

  it("refuses a renewal that raced a turn off: after the removal the old ids name nothing held", async () => {
    const f = await fixture(0xc5);
    const held = await f.grant();
    const renewal = await f.grant();
    await f.store.store(held.address, held, held.expiresAt, []);
    await f.store.remove(held.address);

    await expect(f.store.store(held.address, renewal, renewal.expiresAt, f.ids(held))).rejects.toBeInstanceOf(
      FirefliesGrantReplacesMismatchError,
    );
    expect(f.memory.rows.size).toBe(0);
  });
});

describe("a removal is not undone by work that read the record before it", () => {
  it("does not write a marker for a record that was removed after the caller read it", async () => {
    const f = await fixture(0xc7);
    const pair = await f.grant();
    await f.store.store(pair.address, pair, pair.expiresAt);
    const seen = (f.memory.rows.get(f.store.keyFor(pair.address)) as { updatedAt: string }).updatedAt;

    await f.store.remove(pair.address);
    await f.store.markState(pair.address, "needs_renewal", null, seen);

    expect(f.memory.rows.size).toBe(0);
  });

  it("does not overwrite a newer grant with a marker for the older one", async () => {
    const f = await fixture(0xc9);
    const older = await f.grant();
    const newer = await f.grant();
    await f.store.store(older.address, older, older.expiresAt);
    const seen = (f.memory.rows.get(f.store.keyFor(older.address)) as { updatedAt: string }).updatedAt;
    await new Promise((resolve) => setTimeout(resolve, 5));
    await f.store.store(older.address, newer, newer.expiresAt);

    await f.store.markState(older.address, "needs_renewal", null, seen);

    expect(f.state(older.address)).toBe("active");
  });

  it("runs a removal and a marker queued together one after the other, leaving nothing behind", async () => {
    const f = await fixture(0xcb);
    const pair = await f.grant();
    await f.store.store(pair.address, pair, pair.expiresAt);

    await Promise.all([f.store.remove(pair.address), f.store.markState(pair.address, "revoked")]);
    expect(f.memory.rows.size).toBe(0);
  });
});

describe("POST /api/connectors/fireflies/delegation names the grants it replaces", () => {
  async function withApp(
    f: Awaited<ReturnType<typeof fixture>>,
    address: string,
    run: (post: (body: Record<string, unknown>) => Promise<globalThis.Response>, remove: () => Promise<globalThis.Response>) => Promise<void>,
  ) {
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
        activate: async () => {},
        authMiddleware: (req: Request, _res: Response, next: NextFunction) => {
          req.user = { address };
          next();
        },
      }),
    );
    const server: Server = app.listen(0);
    await once(server, "listening");
    const { port } = server.address() as { port: number };
    const url = `http://127.0.0.1:${port}/api/connectors/fireflies/delegation`;
    const headers = { "x-requested-with": "XMLHttpRequest", "content-type": "application/json" };
    try {
      await run(
        (body) => fetch(url, { method: "POST", headers, body: JSON.stringify(body) }),
        () => fetch(url, { method: "DELETE", headers }),
      );
    } finally {
      server.close();
    }
  }

  const bodyOf = (pair: Awaited<ReturnType<typeof mintGrantPair>>, replaces?: string[]) => ({
    secretsGrant: pair.secretsGrant,
    meetingsGrant: pair.meetingsGrant,
    siwe: pair.siwe,
    signature: pair.signature,
    ...(replaces === undefined ? {} : { replaces }),
  });

  it("refuses a body that does not say what it replaces, and a malformed list", async () => {
    const f = await fixture(0xd1);
    const pair = await f.grant();
    await withApp(f, pair.address, async (post) => {
      expect((await post(bodyOf(pair))).status).toBe(400);
      expect((await post({ ...bodyOf(pair), replaces: "abc" })).status).toBe(400);
      expect((await post({ ...bodyOf(pair), replaces: ["a", "b", "c"] })).status).toBe(400);
      expect((await post({ ...bodyOf(pair), replaces: [1] })).status).toBe(400);
    });
    expect(f.memory.rows.size).toBe(0);
  });

  it("answers 409 and stores nothing when a renewal names a pair a turn off already removed", async () => {
    const f = await fixture(0xd3);
    const owner = generatePrivateKey();
    const first = await f.grant(owner);
    const renewal = await f.grant(owner);
    await withApp(f, first.address, async (post, remove) => {
      expect((await post(bodyOf(first, []))).status).toBe(200);
      expect((await remove()).status).toBe(200);

      const raced = await post(bodyOf(renewal, f.ids(first)));
      expect(raced.status).toBe(409);
      expect(await raced.json()).toEqual({ error: "replaces_mismatch" });
      expect(f.memory.rows.size).toBe(0);

      // Naming what is held now is the renewal that is allowed.
      expect((await post(bodyOf(renewal, []))).status).toBe(200);
      expect((await post(bodyOf(first, f.ids(renewal)))).status).toBe(200);
    });
  });
});
