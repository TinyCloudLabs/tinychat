import { useCallback, useEffect, useRef, useState } from "react";

import { verifyModel, type VerifyModelResult } from "@/lib/vendor/redpill-verifier";
import { isTeeCapableModel } from "@/lib/completionStore";
import {
  isForcedProbe,
  shouldCacheVerdict,
  type ModelVerificationStatus,
} from "@/lib/modelVerificationState";

export {
  isForcedProbe,
  isRetryableStatus,
  shouldCacheVerdict,
} from "@/lib/modelVerificationState";
export type { ModelVerificationStatus } from "@/lib/modelVerificationState";

/**
 * Model-level (pre-send) attestation hook — see docs/general-verification-plan.md.
 *
 * Runs `verifyModel({ model })` ONCE per model id (no completion, no signature),
 * caching the verdict in a MODULE-LEVEL Map so re-selecting an already-verified
 * model is instant. Auto-runs for the passed model; `reverify()` forces a fresh
 * call (and a fresh enclave nonce → re-proves liveness).
 *
 * Honesty / safety rules from the plan:
 *  - `"verified"` means ENCLAVE-attested, gated on `mr.onchain?.verified ||
 *    mr.light?.tdx?.verified` — never response-bound (there is no reply yet).
 *  - `"unverifiable"` is returned WITHOUT a network call for non-TEE models
 *    (`!isTeeCapableModel`).
 *  - A thrown `verifyModel` degrades to `"error"`, never a raw throw to the
 *    caller — verification is non-blocking and must never gate the composer.
 *  - RACE-SAFETY: rapid model switches must not show a stale verdict. Each run
 *    captures the model it was launched for and ignores its own result if the
 *    active model changed before it resolved.
 */
export interface ModelVerification {
  status: ModelVerificationStatus;
  mr: VerifyModelResult | null;
  verifiedAt: number | null;
  reverify: () => void;
}

/** A resolved verdict, cached per model id at module scope. */
interface CachedVerification {
  status: Extract<
    ModelVerificationStatus,
    "verified" | "unverifiable" | "unverified" | "error"
  >;
  mr: VerifyModelResult | null;
  verifiedAt: number | null;
}

/** Module-level cache (survives unmount / model switching) keyed by model id. */
const cache = new Map<string, CachedVerification>();
/** In-flight runs keyed by model id, so concurrent callers share one probe. */
const inflight = new Map<string, Promise<CachedVerification>>();
/**
 * Per-model run generation. Bumped for every fresh `runVerification` launch so a
 * superseded probe (e.g. a slow original that resolves AFTER a `reverify()` has
 * started a newer one) is silently discarded instead of overwriting the fresh
 * verdict in the module-level cache.
 */
const generation = new Map<string, number>();

/** True when the enclave attestation legs prove a genuine TEE (never signature). */
function isEnclaveVerified(mr: VerifyModelResult): boolean {
  return Boolean(mr.onchain?.verified || mr.light?.tdx?.verified);
}

/**
 * Synchronous read of the module-level cache for callers OUTSIDE the hook's
 * render path (e.g. the per-message badge). Returns the cached `mr` only when a
 * fresh, enclave-`"verified"` verdict exists for `model` — so the badge can
 * reuse it and skip re-running `verifyModel` (design point 5 in the plan).
 * Returns `null` on miss, on a non-verified verdict, or when `mr` is absent.
 */
export function getCachedModelVerification(
  model: string,
): VerifyModelResult | null {
  const hit = cache.get(model);
  return hit?.status === "verified" && hit.mr ? hit.mr : null;
}

/**
 * Resolve the verdict for a model, deduplicating concurrent calls by model id.
 * Never rejects — a thrown `verifyModel` resolves to an `"error"` verdict.
 */
function runVerification(model: string): Promise<CachedVerification> {
  const existing = inflight.get(model);
  if (existing) return existing;

  // Claim a generation for this launch; only the latest may commit its result.
  const gen = (generation.get(model) ?? 0) + 1;
  generation.set(model, gen);

  const run = (async (): Promise<CachedVerification> => {
    try {
      const mr = await verifyModel({ model });
      return {
        // "verified" = enclave-attested. A returned-but-unattested result is
        // "unverified" (distinct from a thrown call's "error"); both render the
        // same grey pill but the split keeps the two failure modes legible.
        status: isEnclaveVerified(mr) ? "verified" : "unverified",
        mr,
        verifiedAt: timestamp(),
      };
    } catch {
      return { status: "error", mr: null, verifiedAt: timestamp() };
    }
  })();

  const tracked = run.then((result) => {
    // Drop the result if a newer run for this model has since started — its
    // verdict, not ours, owns the cache.
    if (generation.get(model) === gen) {
      // ST6 — only POSITIVE (enclave-"verified") verdicts are cached for the
      // session. Negative verdicts (error/unverified) are transient (a network
      // blip, a provider hiccup), so they must NOT stick: leave the cache empty
      // so a re-select or reverify() re-probes instead of serving the stale
      // negative forever.
      if (shouldCacheVerdict(result.status)) {
        cache.set(model, result);
      } else {
        cache.delete(model);
      }
      inflight.delete(model);
    }
    return result;
  });
  inflight.set(model, tracked);
  return tracked;
}

/** A best-effort display timestamp; not used in any cache-correctness logic. */
function timestamp(): number {
  return new Date().getTime();
}

export function useModelVerification(model: string): ModelVerification {
  const cached = cache.get(model);
  const [status, setStatus] = useState<ModelVerificationStatus>(
    cached?.status ?? "idle",
  );
  const [mr, setMr] = useState<VerifyModelResult | null>(cached?.mr ?? null);
  const [verifiedAt, setVerifiedAt] = useState<number | null>(
    cached?.verifiedAt ?? null,
  );
  // Set to a model id (+ counter) when a fresh probe is requested for THAT
  // model. Tying the force to a specific model means a later model switch
  // still hits the cache — only the re-verified model bypasses it.
  const [force, setForce] = useState<{ model: string; n: number } | null>(null);
  // ST10 — records the force token (model + counter) already consumed by a
  // probe. Once a reverify()'s token has fired its single fresh probe, a later
  // A→B→A switch back to the forced model must NOT re-probe; only a NEW
  // reverify() (which bumps the counter) re-arms a forced probe. A ref so
  // consuming the token never re-triggers this effect.
  const consumedForce = useRef<{ model: string; n: number } | null>(null);

  useEffect(() => {
    // Race-safety: this run is owned by `model`; if the active model changes
    // before it resolves, `stale` is set and we drop the out-of-order result.
    let stale = false;

    // Non-TEE models can never be attested — surface honestly, with NO probe.
    if (!isTeeCapableModel(model)) {
      setStatus("unverifiable");
      setMr(null);
      setVerifiedAt(null);
      return;
    }

    const forced = isForcedProbe(force, consumedForce.current, model);
    if (forced) {
      // A forced re-verify must skip the cache and probe afresh. Consume the
      // token so switching away and back doesn't re-trigger another probe.
      cache.delete(model);
      inflight.delete(model);
      consumedForce.current = { model: force!.model, n: force!.n };
    } else {
      const hit = cache.get(model);
      if (hit) {
        setStatus(hit.status);
        setMr(hit.mr);
        setVerifiedAt(hit.verifiedAt);
        return;
      }
    }

    setStatus("verifying");
    runVerification(model).then((result) => {
      if (stale) return;
      setStatus(result.status);
      setMr(result.mr);
      setVerifiedAt(result.verifiedAt);
    });

    return () => {
      stale = true;
    };
  }, [model, force]);

  const reverify = useCallback(() => {
    setForce((prev) => ({ model, n: (prev?.n ?? 0) + 1 }));
  }, [model]);

  return { status, mr, verifiedAt, reverify };
}
