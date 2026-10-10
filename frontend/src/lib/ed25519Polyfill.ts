// WebCrypto Ed25519 for Android System WebView older than 137. The TinyCloud
// SDK signs session bytes with `crypto.subtle` Ed25519 and, when that throws,
// falls back to Node's `createPrivateKey` — which does not exist in a browser
// bundle, so sign-in died with "createPrivateKey is not a function". On a
// WebView without Ed25519 this installs a signing-only stand-in backed by
// @noble/curves; everything else still reaches the real SubtleCrypto.

import { ed25519 } from "@noble/curves/ed25519";

export type Ed25519Support = "native" | "polyfill" | "no-subtle";

const seeds = new WeakMap<object, Uint8Array>();

function decodeBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

function isEd25519(algorithm: unknown): boolean {
  const name = typeof algorithm === "string" ? algorithm : (algorithm as { name?: unknown } | null)?.name;
  return typeof name === "string" && name.toLowerCase() === "ed25519";
}

function asBytes(data: BufferSource): Uint8Array {
  return ArrayBuffer.isView(data)
    ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    : new Uint8Array(data);
}

async function nativeEd25519Works(subtle: SubtleCrypto): Promise<boolean> {
  try {
    await subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
    return true;
  } catch {
    return false;
  }
}

function replace(subtle: SubtleCrypto, name: "importKey" | "sign", value: unknown): void {
  Object.defineProperty(subtle, name, { value, configurable: true, writable: true });
}

export async function installEd25519Polyfill(
  subtle: SubtleCrypto | null = globalThis.crypto?.subtle ?? null,
): Promise<Ed25519Support> {
  if (!subtle) return "no-subtle";
  if (await nativeEd25519Works(subtle)) return "native";

  const importKey = subtle.importKey.bind(subtle) as (...args: unknown[]) => Promise<CryptoKey>;
  const sign = subtle.sign.bind(subtle) as (...args: unknown[]) => Promise<ArrayBuffer>;

  replace(subtle, "importKey", async (format: string, keyData: JsonWebKey, algorithm: unknown, extractable: boolean, usages: string[]) => {
    const privateJwk = format === "jwk" && isEd25519(algorithm) && typeof keyData?.d === "string";
    if (!privateJwk) return importKey(format, keyData, algorithm, extractable, usages);
    if (keyData.kty !== "OKP" || keyData.crv !== "Ed25519") throw new DOMException("Not an Ed25519 JWK", "DataError");
    if (usages.length !== 1 || usages[0] !== "sign") throw new DOMException("Ed25519 keys here can only sign", "SyntaxError");
    const seed = decodeBase64Url(keyData.d!);
    if (seed.length !== 32) throw new DOMException("Ed25519 private key must be 32 bytes", "DataError");
    const key = { type: "private", extractable: false, algorithm: { name: "Ed25519" }, usages: ["sign"] } as CryptoKey;
    seeds.set(key, seed);
    return key;
  });

  replace(subtle, "sign", async (algorithm: unknown, key: CryptoKey, data: BufferSource) => {
    const seed = seeds.get(key);
    if (!seed) return sign(algorithm, key, data);
    if (!isEd25519(algorithm)) throw new DOMException("This key signs Ed25519 only", "InvalidAccessError");
    const signature = ed25519.sign(asBytes(data), seed);
    return signature.buffer.slice(signature.byteOffset, signature.byteOffset + signature.byteLength);
  });

  console.warn("[webcrypto] This WebView has no Ed25519; using the @noble/curves signing stand-in.");
  return "polyfill";
}
