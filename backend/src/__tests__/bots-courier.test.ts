import { describe, expect, it } from "bun:test";
import express from "express";
import { createCsrfMiddleware, issueSessionToken } from "@tinyboilerplate/server";
import { NonceGuard, verifyCall } from "../../../bots/src/signed-call";
import { createAuthMiddleware } from "../middleware/auth.js";
import { botsFromEnv, type BotsConfig } from "../routes/bots.js";
import { createBotsCourierRouter } from "../routes/bots-courier.js";

const key = `0x${"03".repeat(32)}`;
const allowed = "0xAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa";
const other = "0x2222222222222222222222222222222222222222";
const owner = `did:pkh:eip155:1:${allowed.toLowerCase()}`;
const secret = "c".repeat(64);
const expiresAt = Date.now() + 86_400_000;
const publicJwk = { kty: "OKP", crv: "Ed25519", x: "public-coordinate" };
const grantRequest = {
  permissions: [
    { service: "tinycloud.kv", space: "agents", path: "xyz.tinycloud.courier/to/", actions: ["tinycloud.kv/get", "tinycloud.kv/put"] },
    { service: "tinycloud.hooks", space: "agents", path: "kv/xyz.tinycloud.courier/", actions: ["tinycloud.hooks/subscribe"] },
  ],
  host: "https://node.tinycloud.xyz",
  expiry: "30d",
};
type Upstream = (method: string, path: string, body: unknown, signal: AbortSignal | null | undefined) => Response | Promise<Response>;

async function setup(upstream: Upstream, options: { enabled?: boolean; config?: BotsConfig | null } = { enabled: true }) {
  const calls: { method: string; path: string; body: unknown; owner: string }[] = [];
  const nonces = new NonceGuard();
  const fetchImpl = (async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const rawBody = typeof init?.body === "string" ? init.body : undefined;
    const headers = new Headers(init?.headers);
    const claims = verifyCall(headers.get("authorization"), { method, path: url.pathname + url.search, body: rawBody }, {
      secret, direction: "to-service", environment: "private", nonces,
    });
    expect(claims).not.toBeNull();
    expect(headers.get("x-tinycloud-owner")).toBeNull();
    expect([...headers.values()].join(" ")).not.toContain(secret);
    const body: unknown = rawBody === undefined ? undefined : JSON.parse(rawBody);
    calls.push({ method, path: url.pathname, body, owner: claims!.owner });
    expect(init?.signal).toBeDefined();
    return upstream(method, url.pathname, body, init?.signal);
  }) as typeof fetch;
  const defaults = botsFromEnv({ BOTS_ENABLED: "true", BOTS_TEST_ACCOUNTS: allowed, BOTS_SERVICE_URL: "http://bots.test/", BOTS_SERVICE_SECRET: secret })!;
  const config = options.config === null ? undefined : { ...(options.config ?? defaults), fetchImpl };
  const app = express();
  app.use(express.json());
  app.use(createCsrfMiddleware());
  app.use("/api/bots/main/courier", createBotsCourierRouter({ config, auth: createAuthMiddleware(key), enabled: options.enabled }));
  const server = app.listen(0, "127.0.0.1");
  const listening = Promise.withResolvers<void>();
  server.once("listening", listening.resolve);
  await listening.promise;
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing loopback address");
  const base = `http://127.0.0.1:${address.port}/api/bots/main/courier`;
  const headersFor = async (address = allowed) => ({ "content-type": "application/json", "X-Requested-With": "XMLHttpRequest", authorization: `Bearer ${(await issueSessionToken(address, key)).token}` });
  const close = () => {
    const closed = Promise.withResolvers<void>();
    server.close(() => closed.resolve());
    return closed.promise;
  };
  return { base, calls, headersFor, close };
}

describe("Courier owner routes", () => {
  it("hides every route when disabled, unconfigured or outside the account allowlist", async () => {
    for (const mode of ["disabled", "unconfigured", "unallowlisted"] as const) {
      const run = await setup(() => { throw new Error("must not call service"); }, { enabled: mode !== "disabled", ...(mode === "unconfigured" ? { config: null } : {}) });
      try {
        const headers = await run.headersFor(mode === "unallowlisted" ? other : allowed);
        for (const [method, path] of [["GET", "/identity"], ["GET", "/grant"], ["PUT", "/grant"], ["DELETE", "/grant"]]) {
          const response = await fetch(`${run.base}${path}`, { method, headers, ...(method === "PUT" ? { body: JSON.stringify({ raw: {}, expiresAt }) } : {}) });
          expect(response.status).toBe(404);
        }
        expect(run.calls).toHaveLength(0);
      } finally { await run.close(); }
    }
  });

  it("defaults dark for a missing, false or non-true environment flag", async () => {
    const previous = process.env.BOTS_COURIER_ENABLED;
    try {
      for (const value of [undefined, "false", "off"]) {
        if (value === undefined) delete process.env.BOTS_COURIER_ENABLED;
        else process.env.BOTS_COURIER_ENABLED = value;
        const run = await setup(() => { throw new Error("must not call service"); }, {});
        try {
          expect((await fetch(`${run.base}/identity`, { headers: await run.headersFor() })).status).toBe(404);
          expect(run.calls).toHaveLength(0);
        } finally { await run.close(); }
      }
    } finally {
      if (previous === undefined) delete process.env.BOTS_COURIER_ENABLED;
      else process.env.BOTS_COURIER_ENABLED = previous;
    }
  });

  it("requires a real authenticated owner session", async () => {
    const run = await setup(() => Response.json({ did: "did:key:public" }));
    try {
      expect((await fetch(`${run.base}/identity`)).status).toBe(401);
      expect((await fetch(`${run.base}/identity`, { headers: { authorization: "Bearer invalid" } })).status).toBe(401);
      expect(run.calls).toHaveLength(0);
    } finally { await run.close(); }
  });

  it("signs every call for the session owner and exposes only public identity and expiry metadata", async () => {
    const raw = { signed: "test-grant" };
    const run = await setup((method, path) => {
      if (path.endsWith("/identity")) return Response.json({
        did: "did:key:public", publicJwk: { ...publicJwk, d: "private-material" }, signer: "private-material", owner: other,
        request: { ...grantRequest, permissions: grantRequest.permissions.map(permission => ({ ...permission, secret: "private-material" })), secret: "private-material" },
      });
      if (method === "DELETE") return new Response(null, { status: 204 });
      return Response.json({ expiresAt, raw, signer: "private-material" });
    });
    try {
      const headers = { ...await run.headersFor(), "x-tinycloud-owner": `did:pkh:eip155:1:${other}` };
      const identity = await fetch(`${run.base}/identity?owner=${other}`, { headers });
      expect(identity.status).toBe(200);
      expect(await identity.json()).toEqual({ did: "did:key:public", publicJwk, request: grantRequest });
      const grant = await fetch(`${run.base}/grant`, { headers });
      expect(grant.status).toBe(200);
      expect(await grant.json()).toEqual({ expiresAt });
      const put = await fetch(`${run.base}/grant`, { method: "PUT", headers, body: JSON.stringify({ raw, expiresAt, owner: other, ownerDid: `did:pkh:eip155:1:${other}` }) });
      expect(put.status).toBe(200);
      expect(await put.json()).toEqual({ expiresAt });
      const remove = await fetch(`${run.base}/grant`, { method: "DELETE", headers });
      expect(remove.status).toBe(204);
      expect(await remove.text()).toBe("");
      expect(run.calls.map(call => call.owner)).toEqual([owner, owner, owner, owner]);
      expect(run.calls.map(({ method, path }) => [method, path])).toEqual([
        ["GET", "/v1/bots/main/courier/identity"], ["GET", "/v1/bots/main/courier/grant"],
        ["PUT", "/v1/bots/main/courier/grant"], ["DELETE", "/v1/bots/main/courier/grant"],
      ]);
      expect(run.calls[2]!.body).toEqual({ raw, expiresAt });
    } finally { await run.close(); }
  });

  it("returns null expiry when the service has no grant", async () => {
    const run = await setup(() => Response.json({ expiresAt: null, raw: "not-public" }));
    try {
      const response = await fetch(`${run.base}/grant`, { headers: await run.headersFor() });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ expiresAt: null });
    } finally { await run.close(); }
  });

  it("rejects malformed grant wrappers before forwarding", async () => {
    const run = await setup(() => { throw new Error("must not call service"); });
    try {
      for (const body of [null, [], {}, { raw: {} }, { raw: {}, expiresAt: "later" }, { raw: {}, expiresAt: -1 }]) {
        expect((await fetch(`${run.base}/grant`, { method: "PUT", headers: await run.headersFor(), body: JSON.stringify(body) })).status).toBe(400);
      }
      expect(run.calls).toHaveLength(0);
    } finally { await run.close(); }
  });

  it("sanitizes upstream failures and malformed success payloads", async () => {
    for (const upstream of [
      () => { throw new Error("private connection details"); },
      () => new Response("private upstream failure", { status: 500 }),
      () => Response.json({ signer: "private-material" }),
    ] as Upstream[]) {
      const run = await setup(upstream);
      try {
        const response = await fetch(`${run.base}/identity`, { headers: await run.headersFor() });
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ error: "courier_unavailable" });
      } finally { await run.close(); }
    }
  });

  it("does not expose grant verification error details", async () => {
    const run = await setup(() => new Response("private signed grant details", { status: 400 }));
    try {
      const response = await fetch(`${run.base}/grant`, { method: "PUT", headers: await run.headersFor(), body: JSON.stringify({ raw: {}, expiresAt }) });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_grant" });
    } finally { await run.close(); }
  });
});
