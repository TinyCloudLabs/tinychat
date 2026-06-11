/**
 * Pure, dependency-free verification of NVIDIA NRAS attestation tokens.
 *
 * Factored out of the vendored `verifiers/cloud-api.ts` (which carries Vite/
 * client imports) so the ES384-signature check is covered by a deterministic
 * unit test (see nrasJwt.test.ts). The GPU verdict the badge trusts must be
 * forge-proof: NVIDIA signs the NRAS token, and the browser verifies that
 * signature against NVIDIA's public JWKS itself (relayed through our backend) —
 * an unverifiable signature must degrade the verdict, never silently pass.
 */

/** A single key from NVIDIA's JWKS (EC P-384; carries x/y or an x5c chain). */
export interface NrasJwk {
  kid?: string
  kty?: string
  crv?: string
  x?: string
  y?: string
  alg?: string
  x5c?: string[]
}

/** Decode a binary string into an ArrayBuffer-backed byte array. */
function binToBytes(bin: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(bin.length))
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

/** base64url → bytes (JWT segments + the raw r||s signature). */
export function base64UrlToBytes(b64url: string): Uint8Array<ArrayBuffer> {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/")
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4)
  return binToBytes(atob(padded))
}

/** standard base64 → bytes (x5c cert DER). */
function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  return binToBytes(atob(b64))
}

/** Import an NRAS JWK as an ECDSA P-384 verify key (x/y first, else x5c leaf). */
async function importNrasKey(jwk: NrasJwk): Promise<CryptoKey | null> {
  const algo = { name: "ECDSA", namedCurve: "P-384" } as const
  if (jwk.x && jwk.y) {
    return crypto.subtle.importKey(
      "jwk",
      { kty: "EC", crv: "P-384", x: jwk.x, y: jwk.y },
      algo,
      false,
      ["verify"],
    )
  }
  if (jwk.x5c?.[0]) {
    const { X509Certificate } = await import("@peculiar/x509")
    const cert = new X509Certificate(base64ToBytes(jwk.x5c[0]))
    return crypto.subtle.importKey("spki", cert.publicKey.rawData, algo, false, ["verify"])
  }
  return null
}

/**
 * Verify an NRAS JWT's ES384 signature against NVIDIA's JWKS. Returns false on
 * ANY failure (network, missing/unsupported key, malformed token, bad
 * signature) — an unverifiable signature must degrade the GPU verdict, never
 * silently pass.
 */
export async function verifyNrasJwt(jwt: string, keys: NrasJwk[]): Promise<boolean> {
  try {
    const [headerB64, payloadB64, sigB64] = jwt.split(".")
    if (!headerB64 || !payloadB64 || !sigB64) return false
    const header = JSON.parse(
      new TextDecoder().decode(base64UrlToBytes(headerB64)),
    ) as { alg?: string; kid?: string }
    if (header.alg !== "ES384") return false
    // Match on kid when the token carries one; otherwise fall back to the first
    // EC P-384 key in the set.
    const jwk =
      keys.find((k) => header.kid != null && k.kid === header.kid) ??
      keys.find((k) => k.kty === "EC" && (k.crv === "P-384" || k.crv == null))
    if (!jwk) return false
    const key = await importNrasKey(jwk)
    if (!key) return false
    const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`)
    const signature = base64UrlToBytes(sigB64)
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-384" },
      key,
      signature,
      signingInput,
    )
  } catch {
    return false
  }
}
