/**
 * Session minting is bounded whatever bearer the caller holds (Astra on #380): with per-session
 * keying, a signed-in caller signing in a DIFFERENT wallet was charged to its own session bucket,
 * so it could mint sessions for new addresses without spending any shared capacity. `/api/auth`
 * now has one bucket that never looks at the bearer. Real auth router, real SIWE signatures.
 */
import { describe, expect, test } from "bun:test";
import express from "express";
import { SiweMessage } from "@tinycloud/sdk-core";
import { createNonceStore, issueSessionToken } from "@tinyboilerplate/server";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createApiBodyParser } from "../body-parsing.js";
import { applyRateLimiters, AUTH_LIMIT, AUTH_PATHS, bucketFor, SESSION_LIMITS } from "../rate-limits.js";
import { createAuthRouter } from "../routes/auth.js";

const SESSION_KEY = "synthetic-session-signing-key";
const realFetch = globalThis.fetch;

function rateLimitHeader(r: Response): { limit: number; remaining: number } | null {
  const header = r.headers.get("ratelimit");
  if (!header) return null;
  return { limit: Number(/limit=(\d+)/.exec(header)![1]), remaining: Number(/remaining=(\d+)/.exec(header)![1]) };
}

/** index.ts's shape: parser → limiters → `app.use("/api/auth", router)`. */
function productionApp() {
  const app = express();
  app.use(createApiBodyParser());
  applyRateLimiters(app, { sessionKey: SESSION_KEY });
  app.use("/api/auth", createAuthRouter({ nonceStore: createNonceStore(), privateKey: SESSION_KEY }));
  app.get("/api/manifest", (_req, res) => res.json({ ok: true }));
  return app;
}

async function withServer<T>(app: express.Express, fn: (base: string) => Promise<T>): Promise<T> {
  const server = await new Promise<import("http").Server>((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });
  const { port } = server.address() as { port: number };
  try {
    return await fn(`http://localhost:${port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** One full sign-in of a brand-new wallet (nonce + verify), sent with `bearer`. */
async function signInNewWallet(base: string, bearer: string) {
  const account = privateKeyToAccount(generatePrivateKey());
  const headers = { authorization: bearer, "content-type": "application/json", "x-requested-with": "XMLHttpRequest" };
  const nonceResponse = await realFetch(`${base}/api/auth/nonce?address=${account.address}`, { headers });
  const nonceStatus = nonceResponse.status;
  const nonceHeader = rateLimitHeader(nonceResponse);
  if (nonceStatus !== 200) return { account, nonceStatus, nonceHeader, verifyStatus: null, verifyHeader: null, token: null };
  const { nonce } = (await nonceResponse.json()) as { nonce: string };
  const message = new SiweMessage({
    domain: "localhost",
    address: account.address,
    statement: "Sign in to TinyChat",
    uri: "https://localhost/",
    version: "1",
    chainId: 1,
    nonce,
    issuedAt: new Date().toISOString(),
  }).prepareMessage();
  const signature = await account.signMessage({ message });
  const verify = await realFetch(`${base}/api/auth/verify`, { method: "POST", headers, body: JSON.stringify({ message, signature }) });
  const body = (await verify.json().catch(() => ({}))) as { token?: string };
  return { account, nonceStatus, nonceHeader, verifyStatus: verify.status, verifyHeader: rateLimitHeader(verify), token: body.token ?? null };
}

describe("session minting bucket", () => {
  test("/api/auth is its own bucket, in every spelling", () => {
    expect(AUTH_PATHS).toEqual(["/api/auth"]);
    for (const path of ["/api/auth/nonce", "/API/AUTH//verify", "/api/auth/verify/"]) {
      expect([path, bucketFor("POST", path)]).toEqual([path, "auth"]);
    }
    expect(bucketFor("GET", "/api/authx")).toBe("global");
  });

  test("a valid bearer for A signing in new wallets is charged to the mint bucket, not A's session", async () => {
    const alice = `Bearer ${(await issueSessionToken("0x00000000000000000000000000000000000a11ce", SESSION_KEY)).token}`;
    await withServer(productionApp(), async (base) => {
      let charged = 0;
      for (let i = 0; i < 3; i++) {
        const r = await signInNewWallet(base, alice);
        expect(r.verifyStatus).toBe(200);
        expect(r.token).toBeString();
        charged += 2;
        expect(r.nonceHeader).toEqual({ limit: AUTH_LIMIT, remaining: AUTH_LIMIT - charged + 1 });
        expect(r.verifyHeader).toEqual({ limit: AUTH_LIMIT, remaining: AUTH_LIMIT - charged });
      }
      // A's own session buckets never paid for the mints.
      const manifest = await realFetch(`${base}/api/manifest`, { headers: { authorization: alice } });
      expect(rateLimitHeader(manifest)).toEqual({ limit: SESSION_LIMITS.global, remaining: SESSION_LIMITS.global - 1 });
    });
  });

  test("the mint ceiling holds across rotated wallets and rotated bearers", async () => {
    await withServer(productionApp(), async (base) => {
      // Each sign-in carries the session minted by the previous one: the recursive mint chain.
      let bearer = "";
      let minted = 0;
      for (let i = 0; i < 4; i++) {
        const r = await signInNewWallet(base, bearer);
        expect(r.verifyStatus).toBe(200);
        bearer = `Bearer ${r.token}`;
        minted++;
      }
      // Spend the rest of the window with fresh bearers for fresh addresses.
      for (let i = 2 * minted; i < AUTH_LIMIT; i++) {
        const fresh = (await issueSessionToken(privateKeyToAccount(generatePrivateKey()).address, SESSION_KEY)).token;
        const r = await realFetch(`${base}/api/auth/nonce`, { headers: { authorization: `Bearer ${fresh}` } });
        expect(r.status).toBe(200);
      }
      // Ceiling reached: no bearer, a chained bearer or a fresh one mints anything more.
      const chained = await signInNewWallet(base, bearer);
      expect(chained.nonceStatus).toBe(429);
      expect(chained.token).toBeNull();
      const anonymous = await realFetch(`${base}/api/auth/nonce`);
      expect(anonymous.status).toBe(429);
    });
  });
});
