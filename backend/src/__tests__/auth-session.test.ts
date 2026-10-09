import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import type { Server } from "node:http";
import express from "express";
import { createSiweMessage } from "viem/siwe";
import { privateKeyToAccount } from "viem/accounts";
import { createCsrfMiddleware, createNonceStore } from "@tinyboilerplate/server";
import { requestNonce, verifySession } from "../../../packages/client/src/auth.js";
import { SessionStore } from "../../../packages/client/src/tokens.js";
import { createAuthMiddleware } from "../middleware/auth.js";
import { createAuthRouter } from "../routes/auth.js";

const NOW = Date.parse("2026-10-08T12:00:00.000Z");
const SECOND = 1_000;
const HOUR = 60 * 60 * SECOND;
const DAY = 24 * HOUR;
const SESSION_SECONDS = 30 * DAY / SECOND;
const KEY = "isolated-http-auth-session-signing-key";
const account = privateKeyToAccount(`0x${"01".repeat(32)}`);
const otherAccount = privateKeyToAccount(`0x${"02".repeat(32)}`);
const csrfHeader = { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" };

function decodeJwt(token: string) {
  const payload: unknown = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
  if (!payload || typeof payload !== "object" ||
    !("exp" in payload) || typeof payload.exp !== "number" ||
    !("iat" in payload) || typeof payload.iat !== "number") {
    throw new Error("Expected JWT with numeric exp and iat");
  }
  return payload;
}

const servers: Server[] = [];
afterEach(async () => {
  setSystemTime();
  while (servers.length) {
    const server = servers.pop()!;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function startAuthServer() {
  const app = express();
  app.use(express.json());
  app.use(createCsrfMiddleware());
  app.use("/api/auth", createAuthRouter({ nonceStore: createNonceStore(), privateKey: KEY }));
  app.get("/whoami", createAuthMiddleware(KEY), (req, res) => res.json(req.user));
  const server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address");
  return `http://127.0.0.1:${address.port}`;
}

async function signMessage(
  nonce: string,
  options: {
    signer?: typeof account;
    address?: typeof account.address;
    expirationTime?: Date;
    notBefore?: Date;
  } = {},
) {
  const signer = options.signer ?? account;
  const message = createSiweMessage({
    domain: "localhost",
    address: options.address ?? signer.address,
    statement: "Sign in",
    uri: "http://localhost",
    version: "1",
    chainId: 1,
    nonce,
    issuedAt: new Date(),
    ...(options.expirationTime ? { expirationTime: options.expirationTime } : {}),
    ...(options.notBefore ? { notBefore: options.notBefore } : {}),
  });
  return { message, signature: await signer.signMessage({ message }) };
}

async function signIn(base: string, options: { expirationTime?: Date } = {}) {
  const nonce = await requestNonce(base, account.address);
  const { message, signature } = await signMessage(nonce, options);
  const session = await verifySession(base, message, signature);
  return { ...session, message, signature, claims: decodeJwt(session.token) };
}

async function postVerify(base: string, payload: unknown, bearer?: string) {
  const response = await fetch(`${base}/api/auth/verify`, {
    method: "POST",
    headers: { ...csrfHeader, ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify(payload),
  });
  const body: unknown = await response.json();
  return { status: response.status, body };
}

async function whoami(base: string, bearer: string) {
  const response = await fetch(`${base}/whoami`, { headers: { Authorization: `Bearer ${bearer}` } });
  const body: unknown = await response.json();
  return { status: response.status, body };
}

describe("HTTP SIWE sessions", () => {
  test("an uncapped sign-in remains usable at +25h; presenting its bearer cannot renew it", async () => {
    setSystemTime(NOW);
    const base = await startAuthServer();
    const session = await signIn(base);
    expect(session.address).toBe(account.address.toLowerCase());
    expect(session.expiresIn).toBe(SESSION_SECONDS);
    expect(session.claims).toMatchObject({
      sub: account.address.toLowerCase(),
      address: account.address.toLowerCase(),
      iat: NOW / SECOND,
      exp: NOW / SECOND + SESSION_SECONDS,
    });
    const store = new SessionStore("tc842-uncapped-session");
    store.setSession(session.token, session.expiresIn, session.address);
    expect(await whoami(base, store.getToken()!)).toEqual({
      status: 200, body: { address: account.address.toLowerCase() },
    });

    setSystemTime(NOW + 25 * HOUR);
    expect(store.isExpired()).toBe(false);
    expect(await whoami(base, store.getToken()!)).toEqual({
      status: 200, body: { address: account.address.toLowerCase() },
    });
    expect(await postVerify(base, {}, store.getToken()!)).toEqual({
      status: 400,
      body: { error: "invalid_request", message: "Message and signature are required" },
    });
    expect(decodeJwt(store.getToken()!).exp).toBe(NOW / SECOND + SESSION_SECONDS);
    expect(store.getToken()).toBe(session.token);
  });

  test("a signed two-hour cap sets JWT and response lifetime and separates client buffer from server expiration", async () => {
    setSystemTime(NOW);
    const base = await startAuthServer();
    const session = await signIn(base, { expirationTime: new Date(NOW + 2 * HOUR) });
    expect(session.expiresIn).toBe(2 * HOUR / SECOND);
    expect(session.claims.iat).toBe(NOW / SECOND);
    expect(session.claims.exp).toBe(NOW / SECOND + session.expiresIn);
    const store = new SessionStore("tc842-short-session");
    store.setSession(session.token, session.expiresIn, session.address);

    for (const [remaining, clientExpired] of [[31, false], [29, true], [1, true]] as const) {
      setSystemTime(NOW + 2 * HOUR - remaining * SECOND);
      expect(store.isExpired()).toBe(clientExpired);
      expect(await whoami(base, session.token)).toEqual({
        status: 200, body: { address: account.address.toLowerCase() },
      });
    }
    setSystemTime(NOW + 2 * HOUR);
    expect(store.isExpired()).toBe(true);
    expect(await whoami(base, session.token)).toEqual({
      status: 401, body: { error: "invalid_token", message: "Token verification failed" },
    });
  });

  test("a signed 60-day cap still produces a 30-day bearer", async () => {
    setSystemTime(NOW);
    const base = await startAuthServer();
    const session = await signIn(base, { expirationTime: new Date(NOW + 60 * DAY) });
    expect(session.expiresIn).toBe(SESSION_SECONDS);
    expect(session.claims.exp).toBe(session.claims.iat! + SESSION_SECONDS);
    setSystemTime(NOW + 30 * DAY);
    expect(await whoami(base, session.token)).toEqual({
      status: 401, body: { error: "invalid_token", message: "Token verification failed" },
    });
  });

  test("expired, future not-before, and subsecond-only signed windows cannot issue a bearer", async () => {
    setSystemTime(NOW);
    const base = await startAuthServer();
    for (const options of [
      { expirationTime: new Date(NOW - SECOND) },
      { notBefore: new Date(NOW + HOUR) },
      { expirationTime: new Date(NOW + 999) },
    ]) {
      const nonce = await requestNonce(base, account.address);
      const { message, signature } = await signMessage(nonce, options);
      expect(await postVerify(base, { message, signature })).toEqual({
        status: 401,
        body: { error: "verification_failed", message: "SIWE signature verification failed" },
      });
    }
  });

  test("nonce is single-use, address-bound, and valid through exactly five minutes", async () => {
    setSystemTime(NOW);
    const base = await startAuthServer();
    const firstNonce = await requestNonce(base, account.address);
    const lateNonce = await requestNonce(base, account.address);
    const first = await signMessage(firstNonce);
    const late = await signMessage(lateNonce);
    setSystemTime(NOW + 5 * 60 * SECOND);
    const accepted = await postVerify(base, first);
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({
      address: account.address.toLowerCase(),
      expiresIn: SESSION_SECONDS,
    });
    if (!accepted.body || typeof accepted.body !== "object" || !("token" in accepted.body) || typeof accepted.body.token !== "string") {
      throw new Error("Expected a token in the successful verify response");
    }
    expect(decodeJwt(accepted.body.token).exp).toBe(NOW / SECOND + 5 * 60 + SESSION_SECONDS);
    expect(await postVerify(base, first)).toEqual({
      status: 401,
      body: { error: "invalid_nonce", message: "Nonce is invalid, expired, or already used" },
    });
    setSystemTime(NOW + 5 * 60 * SECOND + 1);
    expect(await postVerify(base, late)).toEqual({
      status: 401,
      body: { error: "invalid_nonce", message: "Nonce is invalid, expired, or already used" },
    });

    const wrongAddressNonce = await requestNonce(base, account.address);
    const wrongAddress = await signMessage(wrongAddressNonce, { signer: otherAccount });
    expect(await postVerify(base, wrongAddress)).toEqual({
      status: 401,
      body: { error: "invalid_nonce", message: "Nonce is invalid, expired, or already used" },
    });
    const wrongSignerNonce = await requestNonce(base, account.address);
    const wrongSigner = await signMessage(wrongSignerNonce, {
      signer: otherAccount, address: account.address,
    });
    expect(await postVerify(base, wrongSigner)).toEqual({
      status: 401,
      body: { error: "verification_failed", message: "SIWE signature verification failed" },
    });
  });

  test("signing in again at +10 days issues a new token without extending the old one", async () => {
    setSystemTime(NOW);
    const base = await startAuthServer();
    const oldSession = await signIn(base);
    const store = new SessionStore("tc842-resign-session");
    store.setSession(oldSession.token, oldSession.expiresIn, oldSession.address);
    setSystemTime(NOW + 10 * DAY);
    const newSession = await signIn(base);
    store.setSession(newSession.token, newSession.expiresIn, newSession.address);
    expect(store.getToken()).toBe(newSession.token);
    expect(newSession.token).not.toBe(oldSession.token);
    expect(newSession.claims.iat).toBe(NOW / SECOND + 10 * DAY / SECOND);
    expect(newSession.claims.exp).toBe(NOW / SECOND + 40 * DAY / SECOND);
    expect(decodeJwt(oldSession.token).exp).toBe(NOW / SECOND + SESSION_SECONDS);
    expect((await whoami(base, oldSession.token)).status).toBe(200);
    expect((await whoami(base, newSession.token)).status).toBe(200);
    setSystemTime(NOW + 30 * DAY);
    expect((await whoami(base, oldSession.token)).status).toBe(401);
    expect((await whoami(base, newSession.token)).status).toBe(200);
    expect(store.isExpired()).toBe(false);
  });
});
