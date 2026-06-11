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

import type { GpuResult, VerifyModelResult } from "@/lib/vendor/redpill-verifier";

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
  // Only the documented shapes carry a response hash: `reqHash:respHash` (2) and
  // `model:reqHash:respHash` (3). Any other colon-part count is unexpected — fail
  // SAFE by returning undefined (→ replyBound=false, never green) instead of a
  // model-name/hash fragment masquerading as the response hash (ST12c).
  if (parts.length === 2) return parts[1];
  if (parts.length === 3) return parts[2];
  return undefined;
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

/** Signature-leg sub-state for `AttestationDetails`; `null` ⇒ omit the leg. */
export interface SignatureLegState {
  valid: boolean;
  signer: string | null;
  /** Set when the signature is self-consistent + reply-bound but only freshness
   *  failed — labeled "Signature valid — nonce not fresh", NOT "invalid" (ST8). */
  reason?: "nonce_not_fresh";
}

/**
 * ST8 — assemble the signature leg state the badge hands to `AttestationDetails`.
 * Pure so the three honest outcomes are unit-tested rather than browser-checked:
 *  - no signature fetched → `null` (the leg is omitted entirely, never rendered
 *    as "Signature invalid — signer: null");
 *  - the full green tier → `{ valid: true }`;
 *  - a cryptographically valid, reply-bound signature that ONLY fails freshness →
 *    `{ valid: false, reason: "nonce_not_fresh" }` (honest "valid — nonce not
 *    fresh", not "invalid");
 *  - anything else (incl. a malformed/throwing signature, ST7) → `{ valid: false }`.
 * The tier is computed elsewhere from `mr`; this only labels the signature leg and
 * NEVER changes which tier renders (ST-constraint 2).
 */
export function assembleSignatureState(opts: {
  hasSignature: boolean;
  signer: string | null;
  tier: Tier;
  signatureMalformed: boolean;
  enclaveBound: boolean;
  replyBound: boolean;
  fresh: boolean;
}): SignatureLegState | null {
  if (!opts.hasSignature) return null;
  if (opts.tier === "response-verified") return { valid: true, signer: opts.signer };
  if (!opts.signatureMalformed && opts.enclaveBound && opts.replyBound && !opts.fresh) {
    return { valid: false, signer: opts.signer, reason: "nonce_not_fresh" };
  }
  return { valid: false, signer: opts.signer };
}

/** ST8 — the honest signature-leg label, distinguishing a stale-but-valid
 *  signature ("valid — nonce not fresh") from a genuinely invalid one. */
export function signatureLegLabel(sig: {
  valid: boolean;
  reason?: "nonce_not_fresh";
}): string {
  if (sig.valid) return "Signature valid";
  if (sig.reason === "nonce_not_fresh") return "Signature valid — nonce not fresh";
  return "Signature invalid";
}

/**
 * ST9 — a GPU leg renders green ONLY when the NRAS verdict passes AND the nonce
 * is fresh (not replayed evidence), mirroring the TDX leg's freshness gate. A
 * PASS with `nonceMatches=false` is replayed and must render non-green.
 */
export function isGpuLegFresh(gpu: GpuResult | null | undefined): boolean {
  const verdictPass = gpu?.verdict === "true" || gpu?.verdict === "PASS";
  return verdictPass && gpu?.nonceMatches === true;
}
