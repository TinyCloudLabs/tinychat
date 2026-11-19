import { encodeBase64Url, signCompactUcanAuthorization } from "@tinycloud/sdk-core";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
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

// ── Lease-Renewed Session ───────────────────────────────────────────

/** The proofs `/api/auth/verify-renewal` checks, from the lease-restored TinyCloud session. */
export interface RenewalVerifyProof {
  /** The owner's SIWE grant the lease renews, and its CID. */
  delegation: { message: string; signature: string; delegationCid: string };
  /** Session-key signature over `tinychat-renewal-verify|<backend origin>|<address>|<delegationCid>|<nonce>`, base64url. */
  holderProof: string;
  /** Session-signed 60-second status invocation for `delegationCid`, carrying `nonce`; the backend relays it to the node. */
  statusInvocation: string;
}

export interface VerifyRenewedSessionBody extends RenewalVerifyProof {
  address: string;
  nonce: string;
  /** The owner-signed renewal lease the session was restored with. */
  leaseAuthorization: string;
}

export interface VerifyRenewedSessionResponse extends VerifyResponse {
  /** The node-verified renewed end of the TinyCloud session, in Unix seconds. */
  renewal: { effectiveEnd: number };
}

/**
 * Build the verify-renewal proofs from a TinyCloudWeb restored with its renewal lease. Uses only the
 * session's public signing surface: the session key signs both proofs and never leaves the SDK.
 */
export async function renewalVerifyProof(input: {
  tcw: Pick<TinyCloudWeb, "session" | "accountAuthorizationCid" | "sessionDid" | "signSessionBytes" | "activeNodeIdentity">;
  backendOrigin: string;
  address: string;
  nonce: string;
}): Promise<RenewalVerifyProof> {
  const { tcw, backendOrigin, address, nonce } = input;
  const session = tcw.session();
  if (!session) throw new Error("Not signed in");
  const delegationCid = tcw.accountAuthorizationCid();
  const proofMessage = `tinychat-renewal-verify|${backendOrigin}|${address.toLowerCase()}|${delegationCid}|${nonce}`;
  const holderProof = encodeBase64Url(await tcw.signSessionBytes(new TextEncoder().encode(proofMessage)));
  const { nodeDid } = await tcw.activeNodeIdentity();
  const now = Math.floor(Date.now() / 1000);
  const invocation = await signCompactUcanAuthorization({
    issuerDid: tcw.sessionDid,
    audienceDid: nodeDid,
    attenuation: { [`urn:cid:${delegationCid}`]: { "tinycloud.delegation/status": [{}] } },
    facts: [{}],
    proofs: [],
    notBefore: now,
    expiresAt: now + 60,
    nonce,
    sign: (bytes) => tcw.signSessionBytes(bytes),
  });
  return {
    delegation: { message: session.siwe, signature: session.signature, delegationCid },
    holderProof,
    statusInvocation: invocation.authorization,
  };
}

/**
 * Exchange a lease-renewed TinyCloud session for a backend session token. A refusal throws with the
 * HTTP `status` (401 means the renewal is no longer valid); a network failure throws as `fetch` does.
 */
export async function verifyRenewedSession(
  backendUrl: string,
  body: VerifyRenewedSessionBody,
  options?: { signal?: AbortSignal },
): Promise<VerifyRenewedSessionResponse> {
  const res = await fetch(`${backendUrl}/api/auth/verify-renewal`, {
    method: "POST",
    ...(options?.signal ? { signal: options.signal } : {}),
    headers: {
      "Content-Type": "application/json",
      [DEFAULT_REQUEST_HEADER_NAME]: DEFAULT_REQUEST_HEADER_VALUE,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "unknown", message: res.statusText }));
    throw Object.assign(new Error(`Renewed session verification failed: ${err.message ?? err.error}`), { status: res.status });
  }

  return res.json() as Promise<VerifyRenewedSessionResponse>;
}
