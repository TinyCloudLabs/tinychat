// ── Relay-signature frame (frontend mirror of the backend format) ────
//
// The attested relay backend emits ONE in-band SSE frame after a clean stream,
// binding the bytes it forwarded to the secp256k1 key its attestation already
// proves (backend/src/routes/chat.ts `buildRelaySignatureFrame`). This module is
// the FRONTEND mirror: it recognizes that frame and rebuilds the exact message
// the backend signed so the badge (Phase 3) can recover the signer.
//
// NORMATIVE message format (plan precedence rule 3 — the backend is the source
// of truth; this side must match it byte-for-byte, never invent a variant):
//
//   preimage = concatenation of every rendered `choices[0].delta.content` string
//   hash     = sha256(preimage), lowercase hex            → frame.content_sha256
//   message  = `tinychat-relay-sign-v1:${completion_id}:${model}:${content_sha256}`
//   signature = viem signMessage(message)  // EIP-191
//
// The frame carries NO `choices`/`usage`, so a parser that only reads
// `choices[0].delta.content` skips it for free (hard constraint 7). chatApi
// recognizes it explicitly only to surface it off the rendered-text path.

const RELAY_SIGN_PREFIX = "tinychat-relay-sign-v1";

/** The relay-signature frame, exactly as it rides in
 *  `data: {"tinychat_relay_signature": …}`. Field names match the wire shape. */
export interface RelaySignatureFrame {
  v: number;
  completion_id: string;
  model: string;
  /** sha256(preimage), lowercase hex — preimage = concatenated rendered content. */
  content_sha256: string;
  signature: `0x${string}`;
  address: string;
}

/**
 * Pure, NEVER-throwing recognizer for the relay-signature frame.
 *
 * Given an already-parsed SSE `data:` JSON value, returns the validated frame
 * when it is a `tinychat_relay_signature` envelope, else null. A normal
 * completion chunk (choices/usage), a malformed envelope, or any non-object all
 * return null — so the caller leaves text rendering untouched (hard constraint
 * 7). It never throws: every branch is a type guard, not an assertion.
 */
export function parseRelayFrame(jsonPayload: unknown): RelaySignatureFrame | null {
  if (!jsonPayload || typeof jsonPayload !== "object") return null;
  const envelope = (jsonPayload as { tinychat_relay_signature?: unknown }).tinychat_relay_signature;
  if (!envelope || typeof envelope !== "object") return null;
  const f = envelope as Record<string, unknown>;
  if (
    typeof f.v !== "number" ||
    typeof f.completion_id !== "string" ||
    typeof f.model !== "string" ||
    typeof f.content_sha256 !== "string" ||
    typeof f.signature !== "string" ||
    typeof f.address !== "string"
  ) {
    return null;
  }
  return {
    v: f.v,
    completion_id: f.completion_id,
    model: f.model,
    content_sha256: f.content_sha256,
    signature: f.signature as `0x${string}`,
    address: f.address,
  };
}

/**
 * Rebuild the exact EIP-191 message the relay signed. MUST mirror the backend
 * `relaySignMessage` byte-for-byte (precedence rule 3): the badge recovers the
 * signer from this string and checks it equals the attested relay address. Any
 * deviation here silently breaks every signature check — fix THIS side to match
 * the backend, never the reverse.
 */
export function relaySignMessage(
  frame: Pick<RelaySignatureFrame, "completion_id" | "model" | "content_sha256">,
): string {
  return `${RELAY_SIGN_PREFIX}:${frame.completion_id}:${frame.model}:${frame.content_sha256}`;
}
