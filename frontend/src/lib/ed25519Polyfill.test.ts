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
  await expect(subtle.importKey("jwk", { ...jwk, crv: "X25519" }, { name: "Ed25519" }, false, ["sign"])).rejects.toThrow(/Ed25519 JWK/);
  await expect(subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["sign", "verify"])).rejects.toThrow(/only sign/);
});

test("a WebView that has Ed25519 is left untouched", async () => {
  const before = crypto.subtle.importKey;
  expect(await installEd25519Polyfill(crypto.subtle)).toBe("native");
  expect(crypto.subtle.importKey).toBe(before);
});

test("no SubtleCrypto at all is reported, not patched", async () => {
  expect(await installEd25519Polyfill(null)).toBe("no-subtle");
});
