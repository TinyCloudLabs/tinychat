import { describe, expect, it } from "bun:test";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import { assertKvResult } from "@tinyboilerplate/server";
import {
  BACKEND_DELEGATION_EXPIRY_MS,
  backendDelegationPolicyHash,
  backendDelegationResolvedPermissions,
} from "../manifest.js";
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
    set: (identifier: string, access: unknown) =>
      records.set(identifier, access),
    evict: (identifier: string) => records.delete(identifier),
  };
}

async function rejectedKvAcknowledgement(error: string): Promise<never> {
  const result = await Promise.resolve({ ok: false, error });
  return assertKvResult(result) as never;
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

/** Capture console output for the §6.3 log-hygiene assertions. */
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

function createApp(
  overrides: Partial<Parameters<typeof createDelegationRouter>[0]> = {},
) {
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
    expect(stored.resources).toEqual(
      backendDelegationResolvedPermissions(TEST_DID),
    );
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

  // §3.2a edit 1 — the coverage check above runs in one direction only, so a bundle that grants
  // strictly more than the policy passes it. All three resources below are covered by the app
  // recap, so a real session can actually mint this bundle prompt-free.
  //
  // INGEST-CUTOVER(plan §11) — kept, with the stake raised. This least-privilege ceiling is not
  // an Option-C artifact: backend ingestion holds a Fireflies credential and a server-side copy
  // of the meeting, and the operator signed for exactly that (DECISIONS D1/D2). The bundle below
  // — connector KV + SQL — is the thing they did NOT sign for, and a client can offer it in
  // either mode. Refusing it here is what keeps "the backend never gains standing access to your
  // space" true after the cutover (plan §9 row 3), so this is a regression guard now, not a
  // statement about which ingest shape shipped.
  it("rejects delegations broader than the backend policy without storing or activating", async () => {
    const activations: unknown[] = [];
    const { app, store, cache } = createApp({
      activateDelegation: async (delegation) => {
        activations.push(delegation);
        return { kv: {}, sql: {} } as any;
      },
    });
    const granted = [
      {
        service: "tinycloud.kv",
        space: "applications",
        path: "xyz.tinycloud.tinychat/connectors/",
        actions: [
          "tinycloud.kv/get",
          "tinycloud.kv/put",
          "tinycloud.kv/del",
          "tinycloud.kv/list",
        ],
      },
      {
        service: "tinycloud.sql",
        space: "applications",
        path: "xyz.tinycloud.tinychat/connectors",
        actions: [
          "tinycloud.sql/read",
          "tinycloud.sql/write",
          "tinycloud.sql/schema",
        ],
      },
      {
        service: "tinycloud.kv",
        space: "applications",
        path: "xyz.tinycloud.tinychat/threads/",
        actions: [
          "tinycloud.kv/get",
          "tinycloud.kv/put",
          "tinycloud.kv/del",
          "tinycloud.kv/list",
        ],
      },
    ];
    const serialized = JSON.stringify({
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      ownerAddress: TEST_ADDRESS,
      chainId: 1,
      delegateDID: TEST_DID,
      resources: granted,
    });

    const response = await request(app, "/api/delegations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serialized }),
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("overbroad_delegation");

    // The response names the offending resources: exactly those the resolved policy does not cover.
    const allowed = new Set(
      backendDelegationResolvedPermissions(TEST_DID).map(
        (permission) => `${permission.service}:${permission.path}`,
      ),
    );
    const expectedOffending = granted.filter(
      (resource) => !allowed.has(`${resource.service}:${resource.path}`),
    );
    expect(expectedOffending.length).toBeGreaterThan(0);
    expect(
      body.offending.map(
        (resource: any) => `${resource.service}:${resource.path}`,
      ),
    ).toEqual(
      expectedOffending.map(
        (resource) => `${resource.service}:${resource.path}`,
      ),
    );

    expect(activations).toEqual([]);
    expect(await store.load(TEST_ADDRESS)).toBeNull();
    expect(cache.get(TEST_ADDRESS)).toBeNull();
  });

  // The accept-side ceiling and the activation clamp have to agree about a path the prefix
  // predicate cannot compare: `<policy>/../../` startsWith `<policy>`, so `isCapabilitySubset`
  // reported an EMPTY offending list for a bundle that escapes the policy, and the clamp then
  // emitted the traversal path verbatim into `useDelegation`.
  it("rejects a traversal path carried alongside a legitimate resource", async () => {
    const activations: unknown[] = [];
    const { app, store, cache } = createApp({
      activateDelegation: async (delegation: any) => {
        activations.push(delegation);
        return { kv: {}, sql: {} } as any;
      },
    });
    const policy = backendDelegationResolvedPermissions(TEST_DID);
    const escaping = policy.map((permission) => ({
      ...permission,
      path: `${permission.path}../../../`,
    }));
    const serialized = JSON.stringify({
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      ownerAddress: TEST_ADDRESS,
      chainId: 1,
      delegateDID: TEST_DID,
      resources: [...policy, ...escaping],
    });

    const response = await request(app, "/api/delegations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serialized }),
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("overbroad_delegation");
    expect(body.offending.map((resource: any) => resource.path)).toEqual(
      escaping.map((permission) => permission.path),
    );
    expect(activations).toEqual([]);
    expect(await store.load(TEST_ADDRESS)).toBeNull();
    expect(cache.get(TEST_ADDRESS)).toBeNull();
  });

  // §3.3/§9.2 S2c (interim): the 7-day TTL T2/T4 name as the mitigation has to be a bound this
  // backend applies. The source of `expiry` is an unsigned, rewritable top-level field, and the
  // old fallback was `DEFAULT_DELEGATION_EXPIRY_MS` — one YEAR.
  it("clamps the stored expiry to the backend's 7 days", async () => {
    const { app, store } = createApp();
    const serialized = JSON.stringify({
      expiresAt: new Date(Date.now() + 300 * 86_400_000).toISOString(),
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
    const ceiling = Date.now() + BACKEND_DELEGATION_EXPIRY_MS;
    const stored = await store.load(TEST_ADDRESS);
    expect(Date.parse(stored.expiresAt)).toBeLessThanOrEqual(ceiling + 1_000);
    expect(Date.parse(stored.expiresAt)).toBeGreaterThan(
      Date.now() + 6 * 86_400_000,
    );
    expect(Date.parse((await response.json()).expiresAt)).toBe(
      Date.parse(stored.expiresAt),
    );
  });

  it("never falls back to a year when the bundle carries no expiry", async () => {
    const { app, store } = createApp({ extractExpiry: () => null });
    const serialized = JSON.stringify({
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
    expect(Date.parse(stored.expiresAt)).toBeLessThanOrEqual(
      Date.now() + BACKEND_DELEGATION_EXPIRY_MS + 1_000,
    );
  });

  it("keeps an expiry that is already shorter than the ceiling", async () => {
    const { app, store } = createApp();
    const shorter = new Date(Date.now() + 3_600_000).toISOString();
    const serialized = JSON.stringify({
      expiresAt: shorter,
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
    expect((await store.load(TEST_ADDRESS)).expiresAt).toBe(shorter);
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

  it("returns 503 without mutating the cache when durable status loading fails", async () => {
    const sensitiveFailure =
      "address=0xdeadbeef space=tinycloud:secret delegation=AUTHZ_BYTES " +
      "token=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA payload=PRIVATE meeting=MEETING_SECRET";
    const { app, store, cache } = createApp();
    const cached = { kv: {}, sql: {} };
    cache.set(TEST_ADDRESS, cached);
    let cacheEvictions = 0;
    cache.evict = (identifier: string) => {
      cacheEvictions += 1;
      return cache._records.delete(identifier);
    };
    store.load = () => rejectedKvAcknowledgement(sensitiveFailure);

    const capture = captureLogs();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 500);
    let response: Response | null;
    try {
      response = await request(app, "/api/delegations/status", {
        signal: controller.signal,
      }).catch(() => null);
    } finally {
      clearTimeout(timeout);
      capture.restore();
    }

    expect(response?.status).toBe(503);
    expect(await response?.json()).toEqual({ error: "unavailable" });
    expect(cacheEvictions).toBe(0);
    expect(cache.get(TEST_ADDRESS)).toBe(cached);
    expect(capture.lines).toEqual([
      "[delegations] op=status-load result=error",
    ]);
    expect(capture.lines.join("\n")).not.toContain(sensitiveFailure);
  });

  it("returns 503 and preserves expired state when status cleanup rejects", async () => {
    const sensitiveFailure =
      "address=0xdeadbeef space=tinycloud:secret delegation=AUTHZ_BYTES " +
      "token=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA payload=PRIVATE meeting=MEETING_SECRET";
    const { app, store, cache } = createApp();
    await store.store(TEST_ADDRESS, "serialized", {
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
      actions: [],
      path: "",
      policyHash: backendDelegationPolicyHash(TEST_DID),
      delegateDid: TEST_DID,
      resources: backendDelegationResolvedPermissions(TEST_DID),
    });
    const cached = { kv: {}, sql: {} };
    cache.set(TEST_ADDRESS, cached);
    store.remove = () => rejectedKvAcknowledgement(sensitiveFailure);

    const capture = captureLogs();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 500);
    let response: Response | null;
    try {
      response = await request(app, "/api/delegations/status", {
        signal: controller.signal,
      }).catch(() => null);
    } finally {
      clearTimeout(timeout);
      capture.restore();
    }

    expect(response?.status).toBe(503);
    expect(((await response?.json()) as { error: string }).error).toBe(
      "unavailable",
    );
    expect(await store.load(TEST_ADDRESS)).not.toBeNull();
    expect(cache.get(TEST_ADDRESS)).toBe(cached);
    expect(capture.lines).toEqual([
      "[delegations] op=status-cleanup result=error",
    ]);
    expect(capture.lines.join("\n")).not.toContain(sensitiveFailure);
  });

  it("returns 503 and preserves stale state when status cleanup rejects", async () => {
    const sensitiveFailure =
      "address=0xdeadbeef space=tinycloud:secret delegation=AUTHZ_BYTES " +
      "token=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA payload=PRIVATE meeting=MEETING_SECRET";
    const { app, store, cache } = createApp();
    await store.store(TEST_ADDRESS, "serialized", {
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      actions: [],
      path: "",
      policyHash: "old-policy",
      resources: backendDelegationResolvedPermissions(TEST_DID),
    });
    const cached = { kv: {}, sql: {} };
    cache.set(TEST_ADDRESS, cached);
    store.remove = () => rejectedKvAcknowledgement(sensitiveFailure);

    const capture = captureLogs();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 500);
    let response: Response | null;
    try {
      response = await request(app, "/api/delegations/status", {
        signal: controller.signal,
      }).catch(() => null);
    } finally {
      clearTimeout(timeout);
      capture.restore();
    }

    expect(response?.status).toBe(503);
    expect(((await response?.json()) as { error: string }).error).toBe(
      "unavailable",
    );
    expect(await store.load(TEST_ADDRESS)).not.toBeNull();
    expect(cache.get(TEST_ADDRESS)).toBe(cached);
    expect(capture.lines).toEqual([
      "[delegations] op=status-cleanup result=error",
    ]);
    expect(capture.lines.join("\n")).not.toContain(sensitiveFailure);
  });

  it("returns 503 and preserves cached state when deletion rejects", async () => {
    const sensitiveFailure =
      "address=0xdeadbeef space=tinycloud:secret delegation=AUTHZ_BYTES " +
      "token=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA payload=PRIVATE meeting=MEETING_SECRET";
    const { app, store, cache } = createApp();
    await store.store(TEST_ADDRESS, "serialized", {
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      actions: [],
      path: "",
      policyHash: backendDelegationPolicyHash(TEST_DID),
      delegateDid: TEST_DID,
      resources: backendDelegationResolvedPermissions(TEST_DID),
    });
    const cached = { kv: {}, sql: {} };
    cache.set(TEST_ADDRESS, cached);
    store.remove = () => rejectedKvAcknowledgement(sensitiveFailure);

    const capture = captureLogs();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 500);
    let response: Response | null;
    try {
      response = await request(app, "/api/delegations", {
        method: "DELETE",
        signal: controller.signal,
      }).catch(() => null);
    } finally {
      clearTimeout(timeout);
      capture.restore();
    }

    expect(response?.status).toBe(503);
    const body = (await response?.json()) as {
      error: string;
      status?: string;
    };
    expect(body.error).toBe("unavailable");
    expect(body.status).not.toBe("none");
    expect(await store.load(TEST_ADDRESS)).not.toBeNull();
    expect(cache.get(TEST_ADDRESS)).toBe(cached);
    expect(capture.lines).toEqual(["[delegations] op=delete result=error"]);
    expect(capture.lines.join("\n")).not.toContain(sensitiveFailure);
  });

  // This route knows NOTHING about the Fireflies connector — in EITHER ingest mode.
  //
  // The drafted Option-B shape gave it two connector hooks: `isBackgroundSyncDisabled` (409
  // `background_sync_disabled` / fail-closed 503 while the webhook disabled marker stood) and
  // `onDelegationAccepted` (a fresh-grant drain kick). Both existed to protect a *connector*
  // delegation the server does not hold. What survived was a coupling in the wrong direction: an
  // optional notification toggle able to refuse the delegation that ordinary chat depends on.
  // See connector-delegation-independence.test.ts for the two routers driven end to end against
  // one store.
  //
  // INGEST-CUTOVER(plan §11): for a cohort address the server now DOES hold a Fireflies
  // credential and a server-side copy of the meeting (plan §5, §6) — but still no connector
  // delegation, and still no hook from the connector into this route. The three tests below are
  // therefore regression guards in both modes; each carries its own marker.
  //
  // These tests pass the removed hooks anyway, through a cast — the point is that the route
  // ignores them, not that its config type still accepts them.
  function legacyConnectorHooks(hooks: {
    isBackgroundSyncDisabled?: (address: string) => Promise<boolean>;
    onDelegationAccepted?: (address: string) => void | Promise<void>;
  }): Partial<Parameters<typeof createDelegationRouter>[0]> {
    return hooks as unknown as Partial<
      Parameters<typeof createDelegationRouter>[0]
    >;
  }

  function mintableBundle() {
    return JSON.stringify({
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      ownerAddress: TEST_ADDRESS,
      chainId: 1,
      delegateDID: TEST_DID,
      resources: backendDelegationResolvedPermissions(TEST_DID),
    });
  }

  // INGEST-CUTOVER(plan §11) — still true, and still worth guarding. Backend ingestion adds a
  // per-address cohort check and a fetch worker, but neither is an input to the chat delegation:
  // the delegation router is built with no connector collaborator in either mode
  // (`backend/src/index.ts`), so an unreadable cohort list or a disabled connector cannot refuse
  // the grant every authenticated TinyChat write depends on.
  it("mints without ever consulting a connector background-sync state", async () => {
    let probed = 0;
    const { app, store, cache } = createApp(
      legacyConnectorHooks({
        isBackgroundSyncDisabled: async () => {
          probed += 1;
          return true;
        },
      }),
    );

    const response = await request(app, "/api/delegations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serialized: mintableBundle() }),
    });

    // Never 409 `background_sync_disabled`: a Fireflies toggle is not an authorization input
    // for the delegation every authenticated TinyChat write needs.
    expect(response.status).toBe(200);
    expect(probed).toBe(0);
    expect(await store.load(TEST_ADDRESS)).not.toBeNull();
    expect(cache.get(TEST_ADDRESS)).not.toBeNull();
  });

  // INGEST-CUTOVER(plan §11) — the reasoning is re-stated for the new architecture and the
  // assertion survives. Backend ingestion DOES fail closed on an unreadable cohort list, but it
  // does so inside the connector surfaces (a 503 from the credential/meetings routes), where the
  // blast radius is the connector. Chat is not the connector: there is still no connector read on
  // this path, so there is still nothing here to fail closed on.
  it("does not fail closed on a connector state read — there is no such read", async () => {
    // The Option-B gate answered a retryable 503 when the marker was unreadable. With no
    // connector delegation to protect, that trade is pure loss: an unrelated KV hiccup in the
    // webhook namespace would lock the user out of chat.
    const sensitiveFailure =
      "address=0xdeadbeef space=tinycloud:secret delegation=AUTHZ_BYTES " +
      "token=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA payload=PRIVATE meeting=MEETING_SECRET";
    const { app, store } = createApp(
      legacyConnectorHooks({
        isBackgroundSyncDisabled: () =>
          rejectedKvAcknowledgement(sensitiveFailure),
      }),
    );

    const capture = captureLogs();
    let response: Response;
    try {
      response = await request(app, "/api/delegations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serialized: mintableBundle() }),
      });
    } finally {
      capture.restore();
    }

    expect(response.status).toBe(200);
    expect(await store.load(TEST_ADDRESS)).not.toBeNull();
    expect(capture.lines).toEqual([]);
    expect(capture.lines.join("\n")).not.toContain(sensitiveFailure);
  });

  // INGEST-CUTOVER(plan §11) — REWRITTEN RATIONALE. The old one ("there is no server-side
  // writer") is no longer true: for a cohort address W3's fetch worker fetches the meeting and
  // W4 writes it into the backend's own encrypted store. What is still true — and is what this
  // test now guards — is that nothing wakes that worker from HERE. Its triggers are the signed
  // delivery (`onDelivery`, wired in `backend/src/index.ts`) and its own timer sweep; a
  // delegation accept is neither. Keeping the accept path connector-free is what stops the chat
  // grant from becoming an input to ingestion, in either direction.
  it("does not kick a connector drain when a delegation is accepted", async () => {
    // §5.4 trigger 4 (fresh-grant kick) existed to drain a queue into a server-side writer.
    // Under Option C the browser drains on the user's next usable visit; under backend ingest
    // the fetch worker drains, but only off a delivery or its sweep. An accept must not reach
    // into the connector at all.
    let kicked = 0;
    const { app } = createApp(
      legacyConnectorHooks({
        onDelegationAccepted: () => {
          kicked += 1;
        },
      }),
    );

    const response = await request(app, "/api/delegations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serialized: mintableBundle() }),
    });

    expect(response.status).toBe(200);
    // Give a fire-and-forget hook the tick it would have had.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(kicked).toBe(0);
  });

  // ── S2e (§3.5): the accept route capped NOTHING about the bundle ────

  it("S2e: rejects an oversize `serialized` BEFORE deserializing it", async () => {
    // The string is stored verbatim on the shared single-writer node, so the cap has to bite
    // ahead of JSON.parse. Only the 1 MB global parser and a 240-req/15-min bucket bounded it,
    // and that bucket is exempt from the global limiter. A legitimate bundle is a few kB.
    let deserialized = 0;
    const { app, store } = createApp({
      deserializeDelegationSet: (serialized: string) => {
        deserialized += 1;
        return JSON.parse(serialized);
      },
    });

    const response = await request(app, "/api/delegations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serialized: "x".repeat(65_537) }),
    });

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe(
      "bundle_too_large",
    );
    expect(deserialized).toBe(0);
    expect(await store.load(TEST_ADDRESS)).toBeNull();
  });

  it("S2e: rejects a bundle carrying more than 4 delegations", async () => {
    const one = JSON.parse(mintableBundle()) as unknown;
    const { app, store } = createApp({
      deserializeDelegationSet: () => Array(5).fill(one) as any,
    });

    const response = await request(app, "/api/delegations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serialized: mintableBundle() }),
    });

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe(
      "bundle_too_many_delegations",
    );
    expect(await store.load(TEST_ADDRESS)).toBeNull();
  });

  it("S2e: rejects N duplicate in-policy resources rather than persisting all N", async () => {
    // The clamp DEDUPES for activation, so 400 identical policy-shaped entries collapse to one
    // activation and never reach `assertSupportedMultiResourceShape` — while all 400 were still
    // persisted verbatim by `store()`. Nothing about them is overbroad, so S2d does not close it.
    const policy = backendDelegationResolvedPermissions(TEST_DID);
    const { app, store } = createApp({
      extractResources: () => Array(400).fill(policy[0]) as any,
    });

    const response = await request(app, "/api/delegations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serialized: mintableBundle() }),
    });

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe(
      "bundle_too_many_resources",
    );
    expect(await store.load(TEST_ADDRESS)).toBeNull();
  });

  it("§3.2a: the accept-side ceiling refuses a resource naming ANOTHER user's space", async () => {
    // `isCapabilitySubset` normalizes a space to the segment after its LAST colon, so
    // `tinycloud:0xVICTIM:applications` compares EQUAL to the policy's own space and
    // `delegationExceedsBackendPolicy` returned an EMPTY offending list. Only the activation
    // clamp refused it — after the bundle had already been declared within policy, i.e. after
    // the check that bounds what may be STORED had passed it. The stored bundle is the artifact
    // T4 inherits, so both checks have to agree.
    const policy = backendDelegationResolvedPermissions(TEST_DID);
    let activated = 0;
    const { app, store } = createApp({
      activateDelegation: async () => {
        activated += 1;
        return { kv: {}, sql: {} } as any;
      },
    });

    const serialized = JSON.stringify({
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      ownerAddress: TEST_ADDRESS,
      chainId: 1,
      delegateDID: TEST_DID,
      spaceId: "tinycloud:pkh:eip155:1:0xowner:applications",
      resources: [
        ...policy,
        {
          ...policy[0],
          space:
            "tinycloud:0xdeadbeef00000000000000000000000000001234:applications",
        },
      ],
    });

    const response = await request(app, "/api/delegations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serialized }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: string;
      offending: unknown[];
    };
    expect(body.error).toBe("overbroad_delegation");
    expect(body.offending.length).toBeGreaterThan(0);
    expect(activated).toBe(0);
    expect(await store.load(TEST_ADDRESS)).toBeNull();
  });

  // §3.2a, the top-level `spaceId` half. `foreignSpaceResources` compares the RESOURCE space
  // against this same unsigned field, so setting the two equal to a victim's space is invisible
  // to it; and `resourceSpaceWithinPolicy` returns true on its first line when the resource
  // declares no space at all, so that variant never reaches the identity rule either. All three
  // shapes below were accepted 200 and activated with the VICTIM's spaceId, because
  // `activateResource` falls back to `delegation.spaceId` whenever the clamped resource carries
  // no `tinycloud:` space — which, since the clamp re-emits the policy's bare `applications`,
  // is always.
  it("§3.2a: refuses a bundle whose top-level spaceId is not the authenticated user's", async () => {
    const policy = backendDelegationResolvedPermissions(TEST_DID);
    const VICTIM_SPACE =
      "tinycloud:pkh:eip155:1:0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:applications";

    const variants: Array<{ name: string; resources: unknown[] }> = [
      // (a) resource declares NO space
      {
        name: "no resource space",
        resources: policy.map(({ space: _space, ...rest }) => rest),
      },
      // (b) resource space === top-level spaceId — the equality the attacker arranges
      {
        name: "equal spaces",
        resources: policy.map((entry) => ({ ...entry, space: VICTIM_SPACE })),
      },
      // (c) bare policy space alongside a foreign top-level spaceId
      { name: "bare resource space", resources: policy },
    ];

    for (const variant of variants) {
      let activated = 0;
      const { app, store, cache } = createApp({
        activateDelegation: async () => {
          activated += 1;
          return { kv: {}, sql: {} } as any;
        },
      });
      const serialized = JSON.stringify({
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        ownerAddress: TEST_ADDRESS,
        chainId: 1,
        delegateDID: TEST_DID,
        spaceId: VICTIM_SPACE,
        resources: variant.resources,
      });

      const response = await request(app, "/api/delegations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serialized }),
      });

      expect({ variant: variant.name, status: response.status }).toEqual({
        variant: variant.name,
        status: 400,
      });
      expect(((await response.json()) as { error: string }).error).toBe(
        "foreign_space_delegation",
      );
      expect(activated).toBe(0);
      expect(await store.load(TEST_ADDRESS)).toBeNull();
      expect(cache.get(TEST_ADDRESS)).toBeNull();
    }
  });

  // The bare-name seam. `applications` names no OWNER, which an earlier reading took to mean it
  // could not steer the invocation — but the field is forwarded verbatim as the invocation's
  // `spaceId`, and what the node resolves a bare name against is precisely the thing this rule
  // must not guess. The SDK types the field as the full space URI, so a real bundle always
  // carries the comparable form.
  it("§3.2a: refuses a top-level spaceId that is not a comparable space URI", async () => {
    for (const spaceId of [
      "applications",
      "tinycloud:applications",
      "tinycloud:pkh:eip155:1",
    ]) {
      let activated = 0;
      const { app, store } = createApp({
        activateDelegation: async () => {
          activated += 1;
          return { kv: {}, sql: {} } as any;
        },
      });
      const serialized = JSON.stringify({
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        ownerAddress: TEST_ADDRESS,
        chainId: 1,
        delegateDID: TEST_DID,
        spaceId,
        resources: backendDelegationResolvedPermissions(TEST_DID),
      });

      const response = await request(app, "/api/delegations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serialized }),
      });

      expect({ spaceId, status: response.status }).toEqual({
        spaceId,
        status: 400,
      });
      expect(((await response.json()) as { error: string }).error).toBe(
        "foreign_space_delegation",
      );
      expect(activated).toBe(0);
      expect(await store.load(TEST_ADDRESS)).toBeNull();
    }
  });

  it("§3.2a: still accepts a bundle whose spaceId IS the authenticated user's own", async () => {
    // The non-breaking half: the check is an identity rule on the owner segment, not a ban on
    // carrying a `spaceId`. An ABSENT `spaceId` leaves `activateResource` no attacker-chosen
    // target to fall back to, so it stays allowed.
    for (const spaceId of [
      `tinycloud:pkh:eip155:1:${TEST_ADDRESS}:applications`,
      undefined,
    ]) {
      const { app, store } = createApp();
      const serialized = JSON.stringify({
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        ownerAddress: TEST_ADDRESS,
        chainId: 1,
        delegateDID: TEST_DID,
        ...(spaceId === undefined ? {} : { spaceId }),
        resources: backendDelegationResolvedPermissions(TEST_DID),
      });

      const response = await request(app, "/api/delegations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serialized }),
      });

      expect({ spaceId, status: response.status }).toEqual({
        spaceId,
        status: 200,
      });
      expect(await store.load(TEST_ADDRESS)).not.toBeNull();
    }
  });

  // §6.3 / T13. The deploy runs `phala deploy --public-logs`, so this stream is world-readable
  // and §6.3 rests on it being forensically trustworthy.
  it("§6.3: an attacker-supplied resource path cannot forge a line on the public log stream", async () => {
    const policy = backendDelegationResolvedPermissions(TEST_DID);
    const { app } = createApp();
    const serialized = JSON.stringify({
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      ownerAddress: TEST_ADDRESS,
      chainId: 1,
      delegateDID: TEST_DID,
      resources: [
        ...policy,
        {
          ...policy[0],
          path:
            "xyz.tinycloud.tinychat/evil/\n[connector-webhook] op=disable " +
            "aid=0000000000000000 FORGED-LINE",
        },
      ],
    });

    const capture = captureLogs();
    let response: Response;
    try {
      response = await request(app, "/api/delegations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serialized }),
      });
    } finally {
      capture.restore();
    }

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe(
      "overbroad_delegation",
    );
    const logged = capture.lines.join("\n");
    // The line break is gone, so there is no second line to impersonate anything…
    expect(logged).not.toContain("\n");
    expect(
      capture.lines.some((line) => line.startsWith("[connector-webhook]")),
    ).toBe(false);
    // …and `=` is outside the allowlist, so no `key=value` field can be reconstructed either.
    expect(logged).not.toContain("op=disable");
    expect(logged).not.toContain("aid=0000000000000000");
    // The operator still gets the COUNT and a sanitized, bounded description.
    expect(logged).toContain("count=1");
    expect(logged).toContain("xyz.tinycloud.tinychat/evil/");
  });

  // KV Result failure contract (hardening 1/4). DelegationStore.store now surfaces a durable
  // storage failure as a thrown redacted error rather than silently returning; the accept route
  // must NOT emit its success response ("status":"active") after the store rejects, and it must
  // not warm the delegation cache either — otherwise the browser would report success and the
  // fresh-grant drain would run on a delegation that was never persisted.
  it("returns 503 and leaves the cache cold when durable storage rejects", async () => {
    let cacheSets = 0;
    const sensitiveFailure =
      "address=0xdeadbeef space=tinycloud:secret delegation=AUTHZ_BYTES " +
      "token=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA payload=PRIVATE meeting=MEETING_SECRET";
    const failingStore = {
      store: () => rejectedKvAcknowledgement(sensitiveFailure),
      load: async () => null,
      remove: async () => {},
    };
    const cache = createCache();
    cache.set = ((identifier: string, access: unknown) => {
      cacheSets += 1;
      cache._records.set(identifier, access);
    }) as any;

    const app = express();
    app.use(express.json());
    app.use(
      "/api/delegations",
      createDelegationRouter({
        backendDid: TEST_DID,
        store: failingStore as any,
        cache: cache as any,
        authMiddleware: (req: Request, _res: Response, next: NextFunction) => {
          req.user = { address: TEST_ADDRESS };
          next();
        },
        deserializeDelegationSet: (serialized: string) =>
          JSON.parse(serialized),
        activateDelegation: async () => ({ kv: {}, sql: {} }) as any,
        extractResources: (delegation: any) => delegation.resources,
        extractExpiry: (delegation: any) => new Date(delegation.expiresAt),
      }),
    );

    const serialized = JSON.stringify({
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      ownerAddress: TEST_ADDRESS,
      chainId: 1,
      delegateDID: TEST_DID,
      resources: backendDelegationResolvedPermissions(TEST_DID),
    });

    const capture = captureLogs();
    let response: Response;
    try {
      response = await request(app, "/api/delegations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serialized }),
      });
    } finally {
      capture.restore();
    }

    expect(response.status).toBe(503);
    const body = (await response.json()) as { status?: string; error?: string };
    expect(body.error).toBe("unavailable");
    expect(body.status).not.toBe("active");
    expect(cacheSets).toBe(0);
    expect(cache.get(TEST_ADDRESS)).toBeNull();
    expect(capture.lines).toEqual(["[delegations] op=store result=error"]);
    expect(capture.lines.join("\n")).not.toContain(sensitiveFailure);
    expect(capture.lines.join("\n")).not.toContain(serialized);
  });

  it("§6.3: a malformed bundle does not echo its own bytes into the log stream", async () => {
    // The serialized bundle is capability material (it carries `delegationHeader`), and the raw
    // error object put ~50 verbatim characters of it on a `public_logs=true` stream:
    // `SyntaxError: JSON Parse error: Unexpected identifier "AUTHZ_BEARER_MATERIAL_zzz…"`.
    const { app } = createApp({
      deserializeDelegationSet: (s: string) => JSON.parse(s),
    });
    const secretish = `AUTHZ_BEARER_MATERIAL_${"z".repeat(40)}-not-json`;

    const capture = captureLogs();
    let response: Response;
    try {
      response = await request(app, "/api/delegations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serialized: secretish }),
      });
    } finally {
      capture.restore();
    }

    expect(response.status).toBe(400);
    expect(capture.lines.join("\n")).not.toContain("AUTHZ_BEARER_MATERIAL");
  });
});
