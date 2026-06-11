import { describe, expect, test } from "bun:test";

import { verifyNrasJwt, type NrasJwk } from "./nrasJwt";

function bytesToB64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function strToB64Url(s: string): string {
  return bytesToB64Url(new TextEncoder().encode(s));
}

/** Mint a real ES384-signed NRAS-style token + its matching JWKS. */
async function makeToken() {
  const kp = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-384" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwkPub = await crypto.subtle.exportKey("jwk", kp.publicKey);
  const header = { alg: "ES384", kid: "nv-test-key" };
  const payload = { "x-nvidia-overall-att-result": true, nonce: "abc123" };
  const signingInput = `${strToB64Url(JSON.stringify(header))}.${strToB64Url(JSON.stringify(payload))}`;
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-384" },
    kp.privateKey,
    new TextEncoder().encode(signingInput),
  );
  const jwt = `${signingInput}.${bytesToB64Url(new Uint8Array(sig))}`;
  const jwks: NrasJwk[] = [
    { kid: "nv-test-key", kty: "EC", crv: "P-384", x: jwkPub.x, y: jwkPub.y },
  ];
  return { jwt, jwks };
}

describe("ST5 — NRAS GPU JWT signature verification", () => {
  test("a genuinely signed token verifies against its JWKS", async () => {
    const { jwt, jwks } = await makeToken();
    expect(await verifyNrasJwt(jwt, jwks)).toBe(true);
  });

  test("a tampered payload (forged claim) fails verification", async () => {
    const { jwt, jwks } = await makeToken();
    const [h, , s] = jwt.split(".");
    const forgedPayload = strToB64Url(
      JSON.stringify({ "x-nvidia-overall-att-result": true, nonce: "evil" }),
    );
    const forged = `${h}.${forgedPayload}.${s}`;
    expect(await verifyNrasJwt(forged, jwks)).toBe(false);
  });

  test("a token verified against an unrelated key set fails", async () => {
    const { jwt } = await makeToken();
    const { jwks: otherJwks } = await makeToken(); // same kid, different key
    expect(await verifyNrasJwt(jwt, otherJwks)).toBe(false);
  });

  test("empty JWKS and a malformed token both fail (honest degradation)", async () => {
    const { jwt } = await makeToken();
    expect(await verifyNrasJwt(jwt, [])).toBe(false);
    expect(await verifyNrasJwt("not-a-jwt", [])).toBe(false);
  });
});
