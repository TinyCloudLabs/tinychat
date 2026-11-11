import { expect, test } from "bun:test";
import express from "express";
import { mountContentContinuityRoute } from "../routes/content-continuity.js";
import { contentMasterFingerprint } from "../services/content-store.js";

test("admin GET returns commitment, DID and read-only result without secret or content", async () => {
  const app = express();
  const key = "admin-key-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const master = "content-master-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  let probes = 0;
  mountContentContinuityRoute(app, { CREDENTIAL_COUNT_ADMIN_KEY: key }, master, "did:key:backend", async () => { probes++; return { ok: true, id: "index-id" }; });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}/api/ops/content-continuity`;
  try {
    expect((await fetch(url)).status).toBe(401);
    expect(probes).toBe(0);
    const response = await fetch(url, { headers: { "x-admin-key": key } });
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body).toEqual({ contentMasterSha256: contentMasterFingerprint(master), backendDid: "did:key:backend", index: { ok: true, id: "index-id" } });
    expect(JSON.stringify(body)).not.toContain(master);
    expect(JSON.stringify(body)).not.toContain(key);
    expect(probes).toBe(1);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
