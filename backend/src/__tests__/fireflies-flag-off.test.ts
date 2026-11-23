import { describe, expect, it } from "bun:test";
import { once } from "node:events";
import express from "express";
import { deriveFirefliesImportKeys, FIREFLIES_DELEGATE_KMS_PATH } from "../fireflies-import-identity.js";
import { firefliesImportRouteUnavailable } from "../routes/route-unavailable.js";
import { FirefliesGrantStore, removeAllFirefliesGrants } from "../services/fireflies-grant-store.js";
import { createMemoryGrantKv, HOST, mintGrantPair } from "./helpers/fireflies-grant-fixtures.js";

const NOW = Date.UTC(2026, 10, 22, 17, 30, 0);

describe("with the server import off", () => {
  it("removes every stored record, sealed or marker, and nothing else, without a key", async () => {
    const keys = await deriveFirefliesImportKeys(
      { getKey: async (p) => Buffer.alloc(32, p === FIREFLIES_DELEGATE_KMS_PATH ? 0xc1 : 0xc2) },
      { host: HOST, env: {} },
    );
    const cidOf = keys.delegate.node.computeDelegationCid.bind(keys.delegate.node);
    const memory = createMemoryGrantKv();
    const store = new FirefliesGrantStore({ kv: memory.kv, kek: keys.grantKek, delegateDid: keys.delegate.did });

    const live = await mintGrantPair(keys.delegate.did, cidOf, { now: NOW });
    const lapsed = await mintGrantPair(keys.delegate.did, cidOf, { now: NOW, ttlMs: 1_000 });
    await store.store(live.address, live, live.expiresAt);
    await store.store(lapsed.address, lapsed, lapsed.expiresAt);
    await store.markState(lapsed.address, "needs_renewal", lapsed.expiresAt);
    memory.rows.set("delegations/other-feature/0xabc", { kept: true });
    expect([...memory.rows.keys()].filter((key) => key.startsWith("delegations/fireflies-import/"))).toHaveLength(2);

    expect(await removeAllFirefliesGrants(memory.kv)).toBe(2);

    expect([...memory.rows.keys()]).toEqual(["delegations/other-feature/0xabc"]);
    expect(await removeAllFirefliesGrants(memory.kv)).toBe(0);
  });

  it("refuses to run on a store that cannot list, rather than report nothing to remove", async () => {
    const { kv } = createMemoryGrantKv();
    await expect(removeAllFirefliesGrants({ get: kv.get, put: kv.put, delete: kv.delete })).rejects.toThrow("fireflies_grant_listing_unavailable");
  });

  it("answers 404 with the backend's own marker, so a client can tell it from a proxy's 404", async () => {
    const app = express();
    app.use("/api/connectors/fireflies/delegation", (_req, res) => firefliesImportRouteUnavailable(res));
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const { port } = server.address() as { port: number };
      for (const path of ["", "/status", "/grants"]) {
        const res = await fetch(`http://127.0.0.1:${port}/api/connectors/fireflies/delegation${path}`);
        expect(res.status).toBe(404);
        expect(res.headers.get("x-route-unavailable")).toBe("fireflies-import");
        expect(await res.json()).toEqual({ error: "not_found" });
      }
    } finally {
      const closed = once(server, "close");
      server.close();
      await closed;
    }
  });
});
