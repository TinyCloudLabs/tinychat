// ── Completion-id store (session-scoped, per assistant message) ──────
//
// Maps an assistant message id → the RedPill completion `id` (+ the model that
// produced the turn) needed to verify it. Mirrors the receipt store in
// billingApi: populated live as a stream completes (runtime.tsx), read by the
// verification badge (ModelVerificationBadge). NOT persisted — historical
// messages from before a reload carry no entry, so the badge simply doesn't
// appear for them. Capturing the id is strictly non-blocking; it never gates
// the reply.

/** The id + model needed to call verify() for one assistant turn. */
export interface CompletionRef {
  /** The streamed completion `id` (the RedPill chat-completion id). */
  completionId: string;
  /** Model id used for the turn — handed to verify() for provider detection. */
  model: string;
}

const completionMap = new Map<string, CompletionRef>();
type CompletionListener = (messageId: string, ref: CompletionRef) => void;
const completionListeners = new Set<CompletionListener>();

/** Get the completion ref for an assistant message id, if known this session. */
export function getCompletion(messageId: string): CompletionRef | undefined {
  return completionMap.get(messageId);
}

/** Record a completion ref for a message id and notify subscribers. */
export function setCompletion(messageId: string, ref: CompletionRef): void {
  completionMap.set(messageId, ref);
  for (const listener of completionListeners) {
    try {
      listener(messageId, ref);
    } catch {
      // a listener throwing must not break the capture path
    }
  }
}

/** Subscribe to completion-ref updates. Returns an unsubscribe fn. */
export function onCompletion(listener: CompletionListener): () => void {
  completionListeners.add(listener);
  return () => {
    completionListeners.delete(listener);
  };
}

/**
 * The TIER-1 ("Response verified", green) allowlist: models whose responses
 * verify trustlessly AND carry a per-message signature in-browser.
 *
 * This is an explicit ALLOWLIST because only these models publish the FLAT
 * attestation shape (an `intel_quote` + a per-message `signing_address`) so
 * BOTH tier-1 legs can run: the Intel TDX quote checked on-chain (Automata
 * DCAP) and the per-message ECDSA signature that binds *this exact reply* to
 * the enclave. Every other `phala/*` model is Chutes/Tinfoil-format (e.g.
 * glm-5, glm-5.1, kimi-k2.6, qwen3-vl-30b, qwen3.6-27b) — it has no flat
 * signature path, so it can reach at most tier 2 ("Enclave attested": on-chain
 * quote valid, but no response signature).
 *
 * TO EXTEND: confirm the model verifies GREEN in a REAL browser first (on-chain
 * DCAP + signature both pass), then add its exact id here. Never guess.
 */
// The confirmed tier-1 (GREEN, "Response verified") set — the curated picker's
// green tier. Each publishes the FLAT attestation shape so the per-message
// signature can ECDSA-recover to its attested signing_address in-browser. These
// three are exactly the GREEN tier of the picker allowlist (backend
// PICKER_MODELS); the other three offered models (qwen3-vl-30b-a3b-instruct,
// gemma-3-27b-it, kimi-k2.6) are TEAL ("Enclave attested") — TEE-attestable but
// not flat-signed, so they reach tier 2 via isTeeCapableModel below.
//
// NOTE: the green flat-attestation shape was confirmed at the attestation-report
// level only; each green badge (especially glm-5.2) still needs one live
// in-browser verify before merge.
export const VERIFIABLE_MODELS = [
  "phala/qwen-2.5-7b-instruct",
  "phala/gpt-oss-20b",
  "phala/glm-5.2",
] as const;

const VERIFIABLE_MODEL_SET: ReadonlySet<string> = new Set(VERIFIABLE_MODELS);
const MISLABELED_BLOCKLIST: ReadonlySet<string> = new Set([
  "phala/deepseek-chat-v3.1",
  "phala/qwen3-30b-a3b-instruct-2507",
  "phala/qwen2.5-vl-72b-instruct",
  "phala/glm-4.7",
]);

/** True iff `model` is an exact member of the tier-1 (green) allowlist. */
export function isVerifiableModel(model: string): boolean {
  return VERIFIABLE_MODEL_SET.has(model);
}

export function isBlocklistedModel(model: string): boolean {
  return MISLABELED_BLOCKLIST.has(model);
}

/**
 * Tier-1 check ("Response verified", green): exact membership of
 * VERIFIABLE_MODELS — the only models with a per-message response signature.
 * Drives the default model and the green picker shield.
 */
export function isResponseVerifiableModel(model: string): boolean {
  return isVerifiableModel(model);
}

/**
 * True when `model` is a confidential (TEE) model worth ATTEMPTING verification
 * on — i.e. any `phala/*` model. The badge orchestrates the result into a tier:
 * flat models reach tier 1 ("Response verified"), non-flat phala models reach
 * tier 2 ("Enclave attested"), and anything that errors falls back to tier 0
 * ("Not verifiable"). Broadening this past the tier-1 allowlist is safe because
 * the badge tiers + graceful fallback mean no crash — non-`phala/` models still
 * short-circuit to tier 0 and never attempt verification.
 */
export function isTeeCapableModel(model: string): boolean {
  return model.startsWith("phala/") && !isBlocklistedModel(model);
}
