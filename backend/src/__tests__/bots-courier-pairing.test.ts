import { describe, expect, it } from "bun:test";
import express from "express";
import { createCsrfMiddleware, issueSessionToken } from "@tinyboilerplate/server";
import { createAuthMiddleware } from "../middleware/auth.js";
import type { BotsConfig } from "../routes/bots.js";
import type { CourierRouterDeps } from "../routes/bots-courier.js";
import { mountCourierPairing } from "../routes/bots-courier-pairing.js";

const key = `0x${"03".repeat(32)}`;
const enabled = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const other = "0x2222222222222222222222222222222222222222";
const peer = { handle: "peer-1", peerDid: "did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwu7GUbyEkbRZKjyQXS", status: "paired", pairedAt: 1_790_000_000_000, delegationExpiresAt: 1_790_600_000_000 };
const pending = { acceptArtifact: "accept-code", pending: true, handle: peer.handle, pendingExpiresAt: 1_790_600_000_000 };
type Call = { owner: string; method: string; path: string; body?: unknown };
type Upstream = (call: Call) => Response | Promise<Response>;

async function setup(upstream: Upstream, courierEnabled = true) {
  const calls: Call[] = [];
  const config: BotsConfig = { serviceUrl: "http://bots.test", serviceSecret: "test-only", postTimeoutMs: 120_000, accountAllowed: address => address.toLowerCase() === enabled };
  const auth = createAuthMiddleware(key);
  const deps: CourierRouterDeps = { config, auth, callBots: async (owner, method, path, body) => {
    const call = { owner, method, path, ...(body !== undefined ? { body } : {}) };
    calls.push(call);
    return upstream(call);
  } };
  const router = express.Router();
  router.use(auth);
  // The containing C1 router owns the dark-launch/account gates.
  router.use((req, res, next) => {
    if (!courierEnabled || !req.user || !config.accountAllowed(req.user.address)) { res.status(404).json({ error: "not_found" }); return; }
    next();
  });
  mountCourierPairing(router, deps);
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(createCsrfMiddleware());
  app.use("/api/bots/main/courier", router);
  const server = app.listen(0, "127.0.0.1");
  const listening = Promise.withResolvers<void>();
  server.once("listening", listening.resolve);
  await listening.promise;
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
  const url = `http://127.0.0.1:${address.port}/api/bots/main/courier/peers`;
  const headersFor = async (address = enabled) => ({ "content-type": "application/json", "X-Requested-With": "XMLHttpRequest", authorization: `Bearer ${(await issueSessionToken(address, key)).token}` });
  const request = async (method: string, body?: unknown, suffix = "", address = enabled) => fetch(url + suffix, { method, headers: await headersFor(address), ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { calls, url, headersFor, request, close: () => {
    const closed = Promise.withResolvers<void>();
    server.close(() => closed.resolve());
    return closed.promise;
  } };
}

describe("Courier pairing browser boundary", () => {
  it("uses only the authenticated owner for POST and rebuilds the response", async () => {
    const run = await setup(() => Response.json({ peer: { ...peer, privateKey: "must-not-leak" }, grant: "must-not-leak" }));
    try {
      const response = await fetch(run.url, { method: "POST", headers: { ...(await run.headersFor()), "x-tinycloud-owner": other }, body: JSON.stringify({ artifact: "pair-code" }) });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ peer });
      expect(run.calls).toEqual([{ owner: enabled, method: "POST", path: "/courier/peers", body: { artifact: "pair-code" } }]);
    } finally { await run.close(); }
  });

  it("returns only public pending fields for a pair-start artifact", async () => {
    const run = await setup(() => Response.json({ ...pending, grant: "must-not-leak" }));
    try {
      const response = await run.request("POST", { artifact: "start-code" });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(pending);
    } finally { await run.close(); }
  });

  it("lists only public peer fields", async () => {
    const run = await setup(() => Response.json({ peers: [{ ...peer, delegation: "must-not-leak" }], secrets: "must-not-leak" }));
    try {
      const response = await run.request("GET");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ peers: [peer] });
      expect(run.calls).toEqual([{ owner: enabled, method: "GET", path: "/courier/peers" }]);
    } finally { await run.close(); }
  });

  it("deletes the canonical handle for the authenticated owner with no response body", async () => {
    const run = await setup(() => new Response(null, { status: 204 }));
    try {
      const response = await run.request("DELETE", undefined, `/${peer.handle}`);
      expect(response.status).toBe(204);
      expect(await response.text()).toBe("");
      expect(run.calls).toEqual([{ owner: enabled, method: "DELETE", path: `/courier/peers/${peer.handle}` }]);
    } finally { await run.close(); }
  });

  it("cannot reach the service without a session or an admitted account", async () => {
    const run = await setup(() => Response.json({ peers: [] }));
    try {
      for (const [method, suffix, body] of [["GET", "", undefined], ["POST", "", { artifact: "pair-code" }], ["DELETE", `/${peer.handle}`, undefined]] as const) {
        expect((await fetch(run.url + suffix, { method, headers: { "X-Requested-With": "XMLHttpRequest", "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) })).status).toBe(401);
        expect((await run.request(method, body, suffix, other)).status).toBe(404);
      }
      expect(run.calls).toHaveLength(0);
    } finally { await run.close(); }
  });

  it("retains the containing router's feature flag gate", async () => {
    const run = await setup(() => Response.json({ peers: [] }), false);
    try {
      expect((await run.request("GET")).status).toBe(404);
      expect((await run.request("POST", { artifact: "pair-code" })).status).toBe(404);
      expect((await run.request("DELETE", undefined, `/${peer.handle}`)).status).toBe(404);
      expect(run.calls).toHaveLength(0);
    } finally { await run.close(); }
  });

  it("rejects extra fields, owner selection and malformed or oversized artifacts before proxying", async () => {
    const run = await setup(() => Response.json({ peer }));
    try {
      for (const body of [null, [], {}, { artifact: 1 }, { artifact: "" }, { artifact: "   " }, { artifact: "x".repeat(65_537) }, { artifact: "pair-code", owner: other }, { artifact: "pair-code", extra: true }]) {
        expect((await run.request("POST", body)).status).toBe(400);
      }
      expect(run.calls).toHaveLength(0);
    } finally { await run.close(); }
  });

  it("accepts artifacts at the 64 KiB character bound without rewriting them", async () => {
    const artifact = "x".repeat(65_536);
    const run = await setup(() => Response.json({ ...pending, acceptArtifact: artifact }));
    try {
      const response = await run.request("POST", { artifact });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ...pending, acceptArtifact: artifact });
      expect(run.calls[0]?.body).toEqual({ artifact });
    } finally { await run.close(); }
  });

  it("rejects noncanonical handles and DELETE owner bodies", async () => {
    const run = await setup(() => new Response(null, { status: 204 }));
    try {
      for (const handle of ["_bad", "bad handle", ".dot", "bad/handle", "a".repeat(65)]) {
        expect((await run.request("DELETE", undefined, `/${encodeURIComponent(handle)}`)).status).toBe(400);
      }
      expect((await run.request("DELETE", { owner: other }, `/${peer.handle}`)).status).toBe(400);
      expect(run.calls).toHaveLength(0);
    } finally { await run.close(); }
  });

  it("fails closed on malformed peer lists", async () => {
    for (const payload of [null, [], {}, { peers: null }, { peers: [null] }, { peers: [{ ...peer, status: "pending" }] }, { peers: [{ ...peer, pairedAt: -1 }] }, { peers: [{ ...peer, delegationExpiresAt: "tomorrow" }] }, { peers: [{ ...peer, peerDid: "not-a-did" }] }, { peers: [{ ...peer, handle: "../escape" }] }]) {
      const run = await setup(() => Response.json(payload));
      try {
        const response = await run.request("GET");
        expect(response.status).toBe(502);
        expect(await response.json()).toEqual({ error: "courier_unavailable" });
      } finally { await run.close(); }
    }
  });

  it("fails closed on malformed accept responses", async () => {
    for (const payload of [null, {}, { acceptArtifact: "accept-code" }, { ...pending, acceptArtifact: "" }, { ...pending, acceptArtifact: 1 }, { ...pending, acceptArtifact: "x".repeat(65_537) }, { ...pending, pendingExpiresAt: -1 }, { ...pending, handle: "../escape" }, { ...pending, peer }, { peer: { ...peer, status: "pending" } }, { peer: { ...peer, pairedAt: 1.5 } }]) {
      const run = await setup(() => Response.json(payload));
      try {
        const response = await run.request("POST", { artifact: "pair-code" });
        expect(response.status).toBe(502);
        expect(await response.json()).toEqual({ error: "courier_unavailable" });
      } finally { await run.close(); }
    }
  });

  it("maps pairing validation, duplicate and expired failures to fixed codes", async () => {
    for (const [status, error] of [[400, "invalid"], [409, "duplicate"], [410, "pending_expired"]] as const) {
      const run = await setup(() => Response.json({ error: "private grant must-not-leak" }, { status }));
      try {
        const response = await run.request("POST", { artifact: "pair-code" });
        expect(response.status).toBe(status);
        expect(await response.json()).toEqual({ error });
      } finally { await run.close(); }
    }
  });

  it("does not expose upstream error text or exceptions on any operation", async () => {
    for (const upstream of [() => { throw new Error("private grant must-not-leak"); }, () => Response.json({ error: "must-not-leak" }, { status: 500 }), () => new Response("must-not-leak", { status: 200 })]) {
      const run = await setup(upstream);
      try {
        for (const response of [await run.request("GET"), await run.request("POST", { artifact: "pair-code" }), await run.request("DELETE", undefined, `/${peer.handle}`)]) {
          expect(response.status).toBe(502);
          expect(await response.json()).toEqual({ error: "courier_unavailable" });
        }
      } finally { await run.close(); }
    }
  });
});
