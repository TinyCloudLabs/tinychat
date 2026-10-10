import { expect, spyOn, test } from "bun:test";
import { installEd25519Polyfill } from "./ed25519Polyfill";

function notSupported(): Promise<never> {
  return Promise.reject(new DOMException("Unrecognized name.", "NotSupportedError"));
}

// A SubtleCrypto of a WebView before 137: everything but Ed25519 reaches the real one.
function oldWebViewSubtle(calls: string[]): SubtleCrypto {
  const real = crypto.subtle;
  return {
    generateKey: notSupported,
    importKey: (format: string, keyData: unknown, algorithm: { name: string } | string, ...rest: unknown[]) => {
      calls.push(`importKey:${typeof algorithm === "string" ? algorithm : algorithm.name}`);
      if (typeof algorithm !== "string" && algorithm.name === "Ed25519") return notSupported();
      return (real.importKey as (...args: unknown[]) => Promise<CryptoKey>)(format, keyData, algorithm, ...rest);
    },
    sign: (algorithm: { name: string } | string, key: CryptoKey, data: BufferSource) => {
      calls.push("sign");
      return real.sign(algorithm as Algorithm, key, data);
    },
  } as unknown as SubtleCrypto;
}

async function nativeKeyPair() {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const { d: _d, key_ops: _ops, ...publicJwk } = jwk;
  const publicKey = await crypto.subtle.importKey("jwk", publicJwk, { name: "Ed25519" }, true, ["verify"]);
  return { jwk, publicKey };
}

test("a WebView without Ed25519 signs what the real WebCrypto verifies", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => undefined);
  const subtle = oldWebViewSubtle([]);
  expect(await installEd25519Polyfill(subtle)).toBe("polyfill");
  expect(warn).toHaveBeenCalledTimes(1);
  warn.mockRestore();

  const { jwk, publicKey } = await nativeKeyPair();
  const key = await subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["sign"]);
  const message = new TextEncoder().encode("header.payload");
  const signature = await subtle.sign({ name: "Ed25519" }, key, message);

  expect(signature.byteLength).toBe(64);
  expect(await crypto.subtle.verify({ name: "Ed25519" }, publicKey, signature, message)).toBe(true);
  const tampered = new TextEncoder().encode("header.payload!");
  expect(await crypto.subtle.verify({ name: "Ed25519" }, publicKey, signature, tampered)).toBe(false);
});

test("a view of a larger buffer signs only its own bytes", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => undefined);
  const subtle = oldWebViewSubtle([]);
  await installEd25519Polyfill(subtle);
  warn.mockRestore();
  const { jwk, publicKey } = await nativeKeyPair();
  const key = await subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["sign"]);
  const padded = new TextEncoder().encode("xxhello world");
  const signature = await subtle.sign("Ed25519", key, padded.subarray(2));
  expect(await crypto.subtle.verify({ name: "Ed25519" }, publicKey, signature, new TextEncoder().encode("hello world"))).toBe(true);
});

test("other algorithms and keys still reach the real SubtleCrypto", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => undefined);
  const calls: string[] = [];
  const subtle = oldWebViewSubtle(calls);
  await installEd25519Polyfill(subtle);
  warn.mockRestore();
  const hmac = await subtle.importKey("raw", new Uint8Array(32), { name: "HMAC", hash: "SHA-256" } as HmacImportParams, false, ["sign"]);
  const mac = await subtle.sign("HMAC", hmac, new Uint8Array([1, 2, 3]));
  expect(mac.byteLength).toBe(32);
  expect(calls).toEqual(["importKey:HMAC", "sign"]);
});

test("a private key that is not a 32-byte Ed25519 JWK is refused, not signed with", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => undefined);
  const subtle = oldWebViewSubtle([]);
  await installEd25519Polyfill(subtle);
  warn.mockRestore();
  const { jwk } = await nativeKeyPair();
  await expect(subtle.importKey("jwk", { ...jwk, d: "AAAA" }, { name: "Ed25519" }, false, ["sign"])).rejects.toThrow(/32 bytes/);
  await expect(subtle.importKey("jwk", { ...jwk, crv: "X25519" }, { name: "Ed25519" }, false, ["sign"])).rejects.toThrow(/crv must be Ed25519/);
  await expect(subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["sign", "verify"])).rejects.toThrow(/can only have the sign usage/);
});

test("only an unsupported-algorithm answer installs the stand-in; any other probe failure throws and changes nothing", async () => {
  for (const [message, name] of [["op failed", "OperationError"], ["policy", "SecurityError"], ["bad", "DataError"], ["quota", "QuotaExceededError"]]) {
    const calls: string[] = [];
    const subtle = oldWebViewSubtle(calls);
    const importKey = subtle.importKey;
    const sign = subtle.sign;
    (subtle as unknown as { generateKey: () => Promise<never> }).generateKey = () => Promise.reject(new DOMException(message, name));
    await expect(installEd25519Polyfill(subtle)).rejects.toMatchObject({ name });
    expect(subtle.importKey).toBe(importKey);
    expect(subtle.sign).toBe(sign);
  }
  const plain = oldWebViewSubtle([]);
  (plain as unknown as { generateKey: () => Promise<never> }).generateKey = () => Promise.reject(new TypeError("boom"));
  await expect(installEd25519Polyfill(plain)).rejects.toThrow("boom");
});

test("JWK restrictions are honoured exactly as native WebCrypto honours them", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => undefined);
  const subtle = oldWebViewSubtle([]);
  await installEd25519Polyfill(subtle);
  warn.mockRestore();
  const { jwk } = await nativeKeyPair();
  const { key_ops: _ops, ext: _ext, ...base } = jwk;
  const cases: Array<[string, JsonWebKey, boolean, KeyUsage[], string]> = [
    ["key_ops without sign", { ...base, key_ops: ["verify"] }, false, ["sign"], "DataError"],
    ["key_ops duplicated", { ...base, key_ops: ["sign", "sign"] }, false, ["sign"], "DataError"],
    ["use enc", { ...base, use: "enc" }, false, ["sign"], "DataError"],
    ["ext false but extractable requested", { ...base, ext: false }, true, ["sign"], "DataError"],
    ["alg RS256", { ...base, alg: "RS256" }, false, ["sign"], "DataError"],
    ["crv X25519", { ...base, crv: "X25519" }, false, ["sign"], "DataError"],
    ["kty EC", { ...base, kty: "EC" }, false, ["sign"], "DataError"],
    ["no public x", { ...base, x: undefined }, false, ["sign"], "DataError"],
    ["not base64url", { ...base, d: "***" }, false, ["sign"], "DataError"],
    ["verify usage on a private key", base, false, ["sign", "verify"], "SyntaxError"],
    ["no usages", base, false, [], "SyntaxError"],
    ["extractable import is refused, not mislabelled", base, true, ["sign"], "NotSupportedError"],
  ];
  for (const [label, key, extractable, usages, name] of cases) {
    await expect(subtle.importKey("jwk", key, { name: "Ed25519" }, extractable, usages)).rejects.toMatchObject({ name });
    // Bun's WebCrypto is laxer than the spec for a duplicated key_ops and a foreign alg (Chromium rejects both); the rest it rejects too.
    if (name === "DataError" && !["no public x", "not base64url", "key_ops duplicated", "alg RS256"].includes(label)) {
      await expect(crypto.subtle.importKey("jwk", key, { name: "Ed25519" }, extractable, usages)).rejects.toMatchObject({ name });
    }
  }
  for (const accepted of [{ ...base, key_ops: ["sign"] }, { ...base, key_ops: ["sign", "verify"], use: "sig", ext: true, alg: "EdDSA" }, { ...base, alg: "Ed25519" }]) {
    const key = await subtle.importKey("jwk", accepted, { name: "Ed25519" }, false, ["sign"]);
    expect(key.extractable).toBe(false);
  }
});

test("a WebView that has Ed25519 is left untouched", async () => {
  const before = crypto.subtle.importKey;
  expect(await installEd25519Polyfill(crypto.subtle)).toBe("native");
  expect(crypto.subtle.importKey).toBe(before);
});

test("no SubtleCrypto at all is reported, not patched", async () => {
  expect(await installEd25519Polyfill(null)).toBe("no-subtle");
});
