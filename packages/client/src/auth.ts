import { DEFAULT_REQUEST_HEADER_NAME, DEFAULT_REQUEST_HEADER_VALUE } from "./request-headers.js";

// ── Types ────────────────────────────────────────────────────────────

export interface VerifyResponse {
  token: string;
  expiresIn: number;
  address: string;
}

// ── Nonce Request ───────────────────────────────────────────────────

/**
 * Request a nonce from the backend for SIWE authentication.
 * Omit `address` for an unbound nonce (native OpenKey sign-in binds it to the
 * recovered signer at /verify). Bound and unbound nonces are both single-use.
 */
export async function requestNonce(backendUrl: string, address?: string, options?: { signal?: AbortSignal }): Promise<string> {
  const query = address !== undefined ? `?address=${encodeURIComponent(address)}` : "";
  const res = await fetch(`${backendUrl}/api/auth/nonce${query}`, options?.signal ? { signal: options.signal } : undefined);

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "unknown", message: res.statusText }));
    throw new Error(`Failed to request nonce: ${err.message ?? err.error}`);
  }

  const data = await res.json();
  return data.nonce;
}

// ── Backend Verification ────────────────────────────────────────────

/**
 * Send the SDK-produced SIWE message and signature to the backend for verification.
 * Returns a session token on success.
 */
export async function verifySession(
  backendUrl: string,
  siwe: string,
  signature: string,
  options?: { signal?: AbortSignal },
): Promise<VerifyResponse> {
  const res = await fetch(`${backendUrl}/api/auth/verify`, {
    method: "POST",
    ...(options?.signal ? { signal: options.signal } : {}),
    headers: {
      "Content-Type": "application/json",
      [DEFAULT_REQUEST_HEADER_NAME]: DEFAULT_REQUEST_HEADER_VALUE,
    },
    body: JSON.stringify({ message: siwe, signature }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "unknown", message: res.statusText }));
    throw new Error(`SIWE verification failed: ${err.message ?? err.error}`);
  }

  return res.json() as Promise<VerifyResponse>;
}
