/**
 * Badge-callable, graceful signature fetch.
 *
 * This is the non-throwing equivalent of the vendored fork's `fetchSignature`
 * (frontend/src/lib/vendor/redpill-verifier/verify.ts): it hits the SAME
 * forge-proof backend passthrough (`GET /api/signature/:id?model=...`, which
 * injects REDPILL_API_KEY server-side) using the SAME backend origin, session
 * bearer, and `X-Requested-With` CSRF header that `frontend/src/lib/chatApi.ts`
 * uses — but it NEVER throws on a missing field.
 *
 * Only flat/NearAI models (gpt-oss-120b, deepseek-v4-flash) return a real
 * per-message signature `{ text, signature, signing_address }`. Tinfoil/Chutes
 * models (e.g. phala/glm-5.1) return `{ attestation_type, intel_quote,
 * all_attestations }` with no `.text` — for those this returns `null` instead
 * of crashing (the vendored `fetchSignature` → `sig.text.split` is what threw).
 * The badge uses the parsed payload for tier 1 and treats `null` as "no
 * per-response signature" (tier 2 falls back to enclave attestation only).
 *
 * The vendored package is intentionally left untouched (still byte-identical
 * except its two URL forks); this is the badge-layer copy of that mechanism.
 */

import {
  SessionStore,
  DEFAULT_REQUEST_HEADER_NAME,
  DEFAULT_REQUEST_HEADER_VALUE,
} from "@tinyboilerplate/client";

/** Parsed per-message signature payload (tier-1 only). */
export interface SignatureProxyResult {
  text: string;
  signature: string;
  signing_address: string;
}

// Same backend origin + session-store key that chatApi.ts (via App.tsx) and the
// vendored fork resolve — read from the env var, not hardcoded.
const BACKEND_ORIGIN =
  import.meta.env.VITE_BACKEND_URL ||
  `${globalThis.location?.protocol ?? "http:"}//localhost:3014`;

const SESSION_STORE_KEY = "xyz.tinycloud.tinychat:session";

function backendHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    [DEFAULT_REQUEST_HEADER_NAME]: DEFAULT_REQUEST_HEADER_VALUE,
  };
  const token = new SessionStore(SESSION_STORE_KEY).getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/**
 * Fetch the per-message signature for a completion through the backend proxy.
 *
 * Returns `{ text, signature, signing_address }` ONLY when all three are
 * present strings; returns `null` otherwise (missing fields, non-JSON body,
 * network error, or a non-signing model). Never throws.
 */
export async function fetchSignatureProxy(
  completionId: string,
  model: string,
): Promise<SignatureProxyResult | null> {
  try {
    const url =
      `${BACKEND_ORIGIN}/api/signature/${encodeURIComponent(completionId)}` +
      `?model=${encodeURIComponent(model)}`;
    const res = await fetch(url, {
      headers: backendHeaders(),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;

    const payload: unknown = await res.json();
    if (!payload || typeof payload !== "object") return null;

    const { text, signature, signing_address } = payload as Record<string, unknown>;
    if (
      typeof text === "string" &&
      typeof signature === "string" &&
      typeof signing_address === "string"
    ) {
      return { text, signature, signing_address };
    }
    return null;
  } catch {
    // Missing field, non-JSON, timeout, or network error — graceful null.
    return null;
  }
}
