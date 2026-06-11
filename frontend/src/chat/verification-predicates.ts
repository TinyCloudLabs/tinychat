/**
 * Pure, framework-free verification predicates for the per-message badge.
 *
 * These compose the HONEST three-tier verdict over a vendored `verifyModel`
 * result + the per-message signature. They are extracted here (no React, no DOM,
 * no network) so the trust-critical binding/freshness logic is covered by a
 * deterministic unit test (see verification-predicates.test.ts) rather than left
 * to manual browser checking.
 *
 * The green ("response-verified") tier is reachable ONLY when ALL of these hold:
 *  - quoteVerified — a genuine TDX quote was verified (on-chain DCAP / Phala),
 *  - enclaveBound  — the signing key is the enclave-attested key (ST1),
 *  - replyBound    — the signed text hashes to the displayed reply (ST2),
 *  - fresh         — the quote embeds OUR nonce, i.e. not replayed (ST4).
 * A verified quote missing any binding/freshness leg is sky ("enclave-attested");
 * no verified quote is grey ("not-verifiable"). Stricter only — never relaxed.
 */

import type { VerifyModelResult } from "@/lib/vendor/redpill-verifier";

export type Tier = "response-verified" | "enclave-attested" | "not-verifiable";

/**
 * A genuine TDX quote was verified — trustlessly on-chain (Automata DCAP) and/or
 * via Phala's attestation verifier (relayed). Either path proves the enclave.
 */
export function isQuoteVerified(mr: VerifyModelResult): boolean {
  return mr.onchain?.verified === true || mr.light?.tdx?.verified === true;
}

/**
 * ST1 — the per-message signing key is bound to the attested enclave. Requires
 * ALL THREE: (1) the recovered signer matches the claimed signing_address,
 * (2) that claimed address equals the enclave-attested `mr.signingAddress`, and
 * (3) `reportData.bindsAddress === true` (the attested key is inside the quote).
 * Without (2)+(3) a malicious backend could return a self-consistent triple.
 */
export function isEnclaveBound(
  mr: VerifyModelResult,
  signer: string | null,
  signingAddress: string | null,
): boolean {
  return (
    signer != null &&
    signingAddress != null &&
    signer.toLowerCase() === signingAddress.toLowerCase() &&
    mr.signingAddress != null &&
    signingAddress.toLowerCase() === mr.signingAddress.toLowerCase() &&
    mr.light?.reportData?.bindsAddress === true
  );
}

/**
 * ST4 — the attestation embedded the freshly-generated nonce (not a replayed
 * historical quote). Only ever true when `embedsNonce` was actually computed and
 * matched in `checkReportData`.
 */
export function isFresh(mr: VerifyModelResult): boolean {
  return mr.light?.reportData?.embedsNonce === true;
}

/**
 * ST2 — parse the server's response hash out of the signed `sig.text`. The
 * signed message is `[model:]reqHash:respHash`; mirrors verify.ts exactly so the
 * compare uses the same bytes the server signed.
 */
export function parseResponseHash(sigText: string): string | undefined {
  const parts = sigText.split(":");
  const [, respHashServer] =
    parts.length === 3 ? [parts[1], parts[2]] : [parts[0], parts[1]];
  return respHashServer;
}

/**
 * Compose the honest tier from the four sub-conditions. Green requires every
 * leg; a verified quote without full binding/freshness is sky; an unverified
 * quote is grey. (Ambiguity resolves toward FEWER green badges — never more.)
 */
export function computeTier(opts: {
  quoteVerified: boolean;
  enclaveBound: boolean;
  replyBound: boolean;
  fresh: boolean;
}): Tier {
  if (!opts.quoteVerified) return "not-verifiable";
  if (opts.enclaveBound && opts.replyBound && opts.fresh) {
    return "response-verified";
  }
  return "enclave-attested";
}
