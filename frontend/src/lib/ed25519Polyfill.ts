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

/** True only when the engine says the algorithm itself does not exist; any other failure is thrown. */
async function nativeEd25519Unsupported(subtle: SubtleCrypto): Promise<boolean> {
  try {
    await subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
    return false;
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotSupportedError") return true;
    throw error;
  }
}

function dataError(message: string): DOMException {
  return new DOMException(message, "DataError");
}

/** The JWK checks WebCrypto makes when importing an Ed25519 private key to sign, in the spec's order. */
function importEd25519Seed(jwk: JsonWebKey, extractable: boolean, usages: readonly string[]): Uint8Array {
  if (usages.length === 0 || usages.some((usage) => usage !== "sign")) {
    throw new DOMException("An Ed25519 private key can only have the sign usage", "SyntaxError");
  }
  if (jwk.kty !== "OKP") throw dataError("The JWK kty must be OKP");
  if (jwk.crv !== "Ed25519") throw dataError("The JWK crv must be Ed25519");
  if (jwk.use !== undefined && jwk.use !== "sig") throw dataError("The JWK use must be sig");
  if (jwk.key_ops !== undefined) {
    if (!Array.isArray(jwk.key_ops) || new Set(jwk.key_ops).size !== jwk.key_ops.length) throw dataError("The JWK key_ops is invalid");
    if (!usages.every((usage) => jwk.key_ops!.includes(usage))) throw dataError("The JWK key_ops does not allow signing");
  }
  if (jwk.ext === false && extractable) throw dataError("The JWK is not extractable");
  if (jwk.alg !== undefined && jwk.alg !== "Ed25519" && jwk.alg !== "EdDSA") throw dataError("The JWK alg must be Ed25519 or EdDSA");
  if (typeof jwk.x !== "string") throw dataError("The JWK has no public key");
  if (extractable) throw new DOMException("Extractable Ed25519 keys are not supported in this WebView", "NotSupportedError");
  let seed: Uint8Array;
  try {
    seed = decodeBase64Url(jwk.d!);
  } catch {
    throw dataError("The JWK private key is not base64url");
  }
  if (seed.length !== 32) throw dataError("The Ed25519 private key must be 32 bytes");
  return seed;
}

function replace(subtle: SubtleCrypto, name: "importKey" | "sign", value: unknown): void {
  Object.defineProperty(subtle, name, { value, configurable: true, writable: true });
}

export async function installEd25519Polyfill(
  subtle: SubtleCrypto | null = globalThis.crypto?.subtle ?? null,
): Promise<Ed25519Support> {
  if (!subtle) return "no-subtle";
  if (!await nativeEd25519Unsupported(subtle)) return "native";

  const importKey = subtle.importKey.bind(subtle) as (...args: unknown[]) => Promise<CryptoKey>;
  const sign = subtle.sign.bind(subtle) as (...args: unknown[]) => Promise<ArrayBuffer>;

  replace(subtle, "importKey", async (format: string, keyData: JsonWebKey, algorithm: unknown, extractable: boolean, usages: string[]) => {
    const privateJwk = format === "jwk" && isEd25519(algorithm) && typeof keyData?.d === "string";
    if (!privateJwk) return importKey(format, keyData, algorithm, extractable, usages);
    const seed = importEd25519Seed(keyData, extractable, usages);
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
