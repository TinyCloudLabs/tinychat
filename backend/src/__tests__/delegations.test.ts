import { describe, expect, it } from "bun:test";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import { backendDelegationPolicyHash, backendDelegationResolvedPermissions } from "../manifest.js";
import { createDelegationRouter } from "../routes/delegations.js";

const TEST_ADDRESS = "0xtest";
const TEST_DID = "did:key:z6MkBackend";

function createStore() {
  const records = new Map<string, any>();
  return {
    _records: records,
    store: async (identifier: string, serialized: string, metadata: any) => {
      records.set(identifier, { serialized, ...metadata });
    },
    load: async (identifier: string) => records.get(identifier) ?? null,
    remove: async (identifier: string) => {
      records.delete(identifier);
    },
  };
}

function createCache() {
  const records = new Map<string, unknown>();
  return {
    _records: records,
    get: (identifier: string) => records.get(identifier) ?? null,
    set: (identifier: string, access: unknown) => records.set(identifier, access),
    evict: (identifier: string) => records.delete(identifier),
  };
}

async function request(app: express.Express, path: string, init?: RequestInit) {
  const server = await new Promise<import("http").Server>((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });
  const { port } = server.address() as { port: number };
  try {
    return await fetch(`http://localhost:${port}${path}`, init);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

function createApp(overrides: Partial<Parameters<typeof createDelegationRouter>[0]> = {}) {
  const app = express();
  app.use(express.json());
  const store = createStore();
  const cache = createCache();
  app.use(
    "/api/delegations",
    createDelegationRouter({
      backendDid: TEST_DID,
      store: store as any,
      cache: cache as any,
      authMiddleware: (req: Request, _res: Response, next: NextFunction) => {
        req.user = { address: TEST_ADDRESS };
        next();
      },
      deserializeDelegationSet: (serialized: string) => JSON.parse(serialized),
      activateDelegation: async () => ({ kv: {}, sql: {} }) as any,
      extractResources: (delegation: any) => delegation.resources,
      extractExpiry: (delegation: any) => new Date(delegation.expiresAt),
      ...overrides,
    }),
  );
  return { app, store, cache };
}

describe("delegation routes", () => {
  it("stores accepted delegations with the current policy hash", async () => {
    const { app, store } = createApp();
    const serialized = JSON.stringify({
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      ownerAddress: TEST_ADDRESS,
      chainId: 1,
      delegateDID: TEST_DID,
      resources: backendDelegationResolvedPermissions(TEST_DID),
    });

    const response = await request(app, "/api/delegations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serialized }),
    });

    expect(response.status).toBe(200);
    const stored = await store.load(TEST_ADDRESS);
    expect(stored.policyHash).toBe(backendDelegationPolicyHash(TEST_DID));
    expect(stored.delegateDid).toBe(TEST_DID);
    expect(stored.resources).toEqual(backendDelegationResolvedPermissions(TEST_DID));
  });

  it("rejects requests without a serialized delegation body", async () => {
    const { app, store, cache } = createApp();

    const response = await request(app, "/api/delegations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("invalid_body");
    expect(await store.load(TEST_ADDRESS)).toBeNull();
    expect(cache.get(TEST_ADDRESS)).toBeNull();
  });

  it("rejects delegations without extractable owner and delegatee metadata", async () => {
    const { app, store, cache } = createApp();
    const serialized = JSON.stringify({
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      resources: backendDelegationResolvedPermissions(TEST_DID),
    });

    const response = await request(app, "/api/delegations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serialized }),
    });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("invalid_delegation_identity");
    expect(await store.load(TEST_ADDRESS)).toBeNull();
    expect(cache.get(TEST_ADDRESS)).toBeNull();
  });

  it("rejects delegations owned by a different authenticated wallet", async () => {
    const { app, store, cache } = createApp();
    const serialized = JSON.stringify({
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      ownerAddress: "0xother",
      chainId: 1,
      delegateDID: TEST_DID,
      resources: backendDelegationResolvedPermissions(TEST_DID),
    });

    const response = await request(app, "/api/delegations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serialized }),
    });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("wrong_delegator");
    expect(await store.load(TEST_ADDRESS)).toBeNull();
    expect(cache.get(TEST_ADDRESS)).toBeNull();
  });

  it("rejects delegations targeting a different backend delegatee", async () => {
    const { app, store, cache } = createApp();
    const serialized = JSON.stringify({
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      ownerAddress: TEST_ADDRESS,
      chainId: 1,
      delegateDID: "did:key:z6MkOtherBackend",
      resources: backendDelegationResolvedPermissions(TEST_DID),
    });

    const response = await request(app, "/api/delegations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serialized }),
    });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("wrong_delegatee");
    expect(await store.load(TEST_ADDRESS)).toBeNull();
    expect(cache.get(TEST_ADDRESS)).toBeNull();
  });

  it("rejects delegations that do not cover the backend policy", async () => {
    const { app } = createApp();
    const serialized = JSON.stringify({
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      ownerAddress: TEST_ADDRESS,
      chainId: 1,
      delegateDID: TEST_DID,
      resources: [
        {
          ...backendDelegationResolvedPermissions(TEST_DID)[0],
          path: "xyz.tinycloud.tinychat/other/",
        },
      ],
    });

    const response = await request(app, "/api/delegations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serialized }),
    });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("insufficient_delegation");
  });

  it("evicts stale delegations during status checks", async () => {
    const { app, store, cache } = createApp();
    await store.store(TEST_ADDRESS, "serialized", {
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      actions: [],
      path: "",
      policyHash: "old-policy",
      resources: backendDelegationResolvedPermissions(TEST_DID),
    });
    cache.set(TEST_ADDRESS, { kv: {}, sql: {} });

    const response = await request(app, "/api/delegations/status");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "stale", expiresAt: null });
    expect(await store.load(TEST_ADDRESS)).toBeNull();
    expect(cache.get(TEST_ADDRESS)).toBeNull();
  });

  it("evicts stored delegations bound to a different backend delegatee", async () => {
    const { app, store, cache } = createApp();
    await store.store(TEST_ADDRESS, "serialized", {
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      actions: [],
      path: "",
      policyHash: backendDelegationPolicyHash(TEST_DID),
      delegateDid: "did:key:z6MkPreviousBackend",
      resources: backendDelegationResolvedPermissions(TEST_DID),
    });
    cache.set(TEST_ADDRESS, { kv: {}, sql: {} });

    const response = await request(app, "/api/delegations/status");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "stale", expiresAt: null });
    expect(await store.load(TEST_ADDRESS)).toBeNull();
    expect(cache.get(TEST_ADDRESS)).toBeNull();
  });
});
