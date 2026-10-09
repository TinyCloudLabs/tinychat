import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { SignJWT, decodeJwt } from "jose";
import { issueSessionToken, verifySessionToken } from "../auth.js";

const NOW = Date.parse("2026-10-08T12:00:00.000Z");
const SECOND = 1_000;
const DAY = 24 * 60 * 60;
const THIRTY_DAYS = 30 * DAY;
const ADDRESS = "0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD";
const KEY = "isolated-session-token-signing-key";

afterEach(() => setSystemTime());

describe("session JWT lifetime", () => {
  test("an uncapped token lasts 30 days with matching response and JWT claims", async () => {
    setSystemTime(NOW);
    const { token, expiresIn } = await issueSessionToken(ADDRESS, KEY);
    const claims = decodeJwt(token);
    expect(expiresIn).toBe(THIRTY_DAYS);
    expect(claims).toMatchObject({
      sub: ADDRESS.toLowerCase(),
      address: ADDRESS.toLowerCase(),
      iat: NOW / SECOND,
      exp: NOW / SECOND + THIRTY_DAYS,
    });
    setSystemTime(NOW + 25 * DAY * SECOND);
    expect(await verifySessionToken(token, KEY)).toEqual({ address: ADDRESS.toLowerCase() });
    setSystemTime(NOW + THIRTY_DAYS * SECOND);
    await expect(verifySessionToken(token, KEY)).rejects.toThrow();
  });

  test("a shorter signed deadline limits both expiresIn and exp", async () => {
    setSystemTime(NOW);
    const { token, expiresIn } = await issueSessionToken(ADDRESS, KEY, {
      notAfter: new Date(NOW + 2 * 60 * 60 * SECOND),
    });
    expect(expiresIn).toBe(2 * 60 * 60);
    expect(decodeJwt(token).exp).toBe(NOW / SECOND + expiresIn);
  });

  test("a signed 60-day deadline cannot lengthen the fresh token", async () => {
    setSystemTime(NOW);
    const { token, expiresIn } = await issueSessionToken(ADDRESS, KEY, {
      notAfter: new Date(NOW + 60 * DAY * SECOND),
    });
    expect(expiresIn).toBe(THIRTY_DAYS);
    expect(decodeJwt(token).exp).toBe(NOW / SECOND + THIRTY_DAYS);
  });

  test("invalid and non-future whole-second deadlines cannot issue a token", async () => {
    setSystemTime(NOW);
    for (const notAfter of [new Date(NaN), new Date(NOW - SECOND), new Date(NOW), new Date(NOW + 999)]) {
      await expect(issueSessionToken(ADDRESS, KEY, { notAfter })).rejects.toThrow();
    }
  });

  test("a previously issued 24-hour JWT retains its embedded expiration", async () => {
    setSystemTime(NOW);
    const token = await new SignJWT({ address: ADDRESS.toLowerCase() })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(ADDRESS.toLowerCase())
      .setIssuedAt(NOW / SECOND)
      .setExpirationTime(NOW / SECOND + DAY)
      .sign(new TextEncoder().encode(KEY));
    expect(decodeJwt(token).exp).toBe(NOW / SECOND + DAY);
    setSystemTime(NOW + 23 * 60 * 60 * SECOND);
    expect(await verifySessionToken(token, KEY)).toEqual({ address: ADDRESS.toLowerCase() });
    setSystemTime(NOW + 25 * 60 * 60 * SECOND);
    await expect(verifySessionToken(token, KEY)).rejects.toThrow();
  });
});
