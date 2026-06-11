/**
 * Pure, DOM-free verification-state decisions for the model-level attestation
 * hook (`useModelVerification`). Extracted here — with NO React and NO transitive
 * DOM/SDK imports — so the cache/force/retry rules are covered by a deterministic
 * unit test (see modelVerificationState.test.ts) instead of browser-checked.
 */

export type ModelVerificationStatus =
  | "idle"
  | "verifying"
  | "verified"
  | "unverifiable"
  | "unverified"
  | "error";

/** A `reverify()` token: the targeted model id + a monotonically-bumped counter. */
export interface ForceToken {
  model: string;
  n: number;
}

/**
 * ST6 — only POSITIVE (enclave-"verified") verdicts may persist in the session
 * cache. Negative verdicts (error/unverified) are transient (a network blip, a
 * provider hiccup) and must re-probe on the next select/reverify instead of
 * sticking forever, so they are never cached.
 */
export function shouldCacheVerdict(status: ModelVerificationStatus): boolean {
  return status === "verified";
}

/**
 * ST6 — a negative verdict (error/unverified) is transient, so its header pill
 * must be clickable to RETRY exactly when it failed. (A "verified" pill expands;
 * idle/verifying/unverifiable are not retry-actionable.)
 */
export function isRetryableStatus(status: ModelVerificationStatus): boolean {
  return status === "error" || status === "unverified";
}

/**
 * ST10 — decide whether the effect should force a fresh probe (skip the cache).
 * True only when a `reverify()` token targets THIS model AND that exact token
 * (model + counter) has not already been consumed by a prior probe — so a single
 * reverify() forces exactly one fresh probe, and a later A→B→A switch back to the
 * forced model hits the cache again rather than re-probing.
 */
export function isForcedProbe(
  force: ForceToken | null,
  consumed: ForceToken | null,
  model: string,
): boolean {
  return (
    force?.model === model &&
    !(consumed?.model === force.model && consumed.n === force.n)
  );
}
