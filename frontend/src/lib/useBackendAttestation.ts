import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionStore } from "@tinyboilerplate/client";

import {
  fetchBackendSelfAttestation,
  fetchServerInfoDid,
  type BackendAttestationClientResult,
  type BackendSelfAttestation,
} from "@/lib/backendAttestation";
import {
  verifyBackendAttestation,
  type BackendVerdict,
  type VerifyDeps,
} from "@/lib/backendAttestation/verify";

/**
 * Backend (server-side) attestation hook — see docs/backend-attestation-verify-plan.md (R3).
 *
 * Mirrors `useModelVerification` EXACTLY in shape: it fetches the backend's
 * self-attestation via the existing client, then runs the browser-side 3-leg
 * verify() over an `available` result, caching ONLY a positive ("attested")
 * verdict in a MODULE-LEVEL Map so re-opening the panel is instant. Negative
 * verdicts (unattested / unavailable / error / unauthenticated) are transient
 * (a fresh nonce, a network blip, an expired session), so they are never cached
 * and a re-render or `reverify()` re-probes. `reverify()` bumps the generation
 * and refetches with a fresh nonce → re-proves backend liveness.
 *
 * Honesty / safety rules (from the plan):
 *  - `"attested"` means ALL THREE legs passed (quote validity, identity binding,
 *    compose integrity). Any null/thrown sub-check ⇒ NOT attested — never a
 *    false-positive.
 *  - A thrown fetch/verify degrades to `"error"`, never a raw throw to the caller.
 *  - RACE-SAFETY: a superseded probe (a slow original that resolves AFTER a
 *    `reverify()` started a newer one) is discarded instead of overwriting the
 *    fresh verdict, both in the module cache (generation guard) and in render
 *    (the effect's `stale` flag).
 */
export type BackendAttestationStatus =
  | "idle"
  | "verifying"
  | "attested"
  | "unattested"
  | "unavailable"
  | "unauthenticated"
  | "error";

export interface BackendAttestation {
  status: BackendAttestationStatus;
  verdict: BackendVerdict | null;
  attestation: BackendSelfAttestation | null;
  message: string | null;
  verifiedAt: number | null;
  reverify: () => void;
}

export interface UseBackendAttestationInput {
  backendUrl: string;
  sessionStore: SessionStore;
  /**
   * Optional override for the DID served by /api/server-info. Normally left
   * undefined: the hook fetches it independently from the backend's public
   * /api/server-info endpoint so the binding leg can cross-check the attested
   * signing key against the DID the backend advertises (NOT the caller's own
   * session DID). Tests inject it directly. When neither an override nor the
   * fetch yields a DID, the sub-check is fail-honest (it cannot pass).
   */
  serverInfoDid?: string;
  /** Injectable vendored verifiers (stubbed in tests to avoid the network). */
  deps?: Partial<VerifyDeps>;
}

/** A resolved verdict, cached per backend url at module scope. */
interface CachedAttestation {
  status: Extract<
    BackendAttestationStatus,
    "attested" | "unattested" | "unavailable" | "unauthenticated" | "error"
  >;
  verdict: BackendVerdict | null;
  attestation: BackendSelfAttestation | null;
  message: string | null;
  verifiedAt: number | null;
}

/** A `reverify()` token: the targeted backend key + a monotonically-bumped counter. */
interface ForceToken {
  key: string;
  n: number;
}

/** Module-level cache (survives unmount / panel re-open) keyed by backend url. */
const cache = new Map<string, CachedAttestation>();
/** In-flight runs keyed by backend url, so concurrent callers share one probe. */
const inflight = new Map<string, Promise<CachedAttestation>>();
/**
 * Per-backend run generation. Bumped for every fresh `runVerification` launch so
 * a superseded probe (a slow original that resolves AFTER a `reverify()` started
 * a newer one) is silently discarded instead of overwriting the fresh verdict in
 * the module-level cache.
 */
const generation = new Map<string, number>();

/**
 * Only POSITIVE ("attested") verdicts may persist in the session cache. Negative
 * verdicts (unattested / unavailable / error / unauthenticated) are transient and
 * must re-probe on the next render/reverify instead of sticking forever.
 */
function shouldCacheVerdict(status: CachedAttestation["status"]): boolean {
  return status === "attested";
}

/**
 * Synchronous, non-hook read of the module-level cache for callers OUTSIDE the
 * hook's render path (the per-message badge's relay leg). Mirrors
 * `getCachedModelVerification`: returns the attested relay address ONLY from a
 * cached verdict whose status is `"attested"`, else `null`.
 *
 * The attested address is the secp256k1 key the backend quote binds (the same
 * key it signs relay frames with). Anything other than a cached `"attested"`
 * verdict — no cache, an unattested/error/unavailable verdict (never cached
 * anyway), or a missing attestation payload — fails the relay leg CLOSED by
 * returning null (hard constraint 2: fail-honest, never false-green). With a
 * `backendUrl` it reads that key; without one it returns the first attested
 * entry (there is a single relay backend per session).
 */
export function getCachedBackendAttestation(backendUrl?: string): string | null {
  const entries = backendUrl
    ? (() => {
        const hit = cache.get(backendUrl);
        return hit ? [hit] : [];
      })()
    : [...cache.values()];
  for (const entry of entries) {
    if (entry.status === "attested" && entry.attestation) {
      return entry.attestation.identity.address;
    }
  }
  return null;
}

/**
 * Decide whether the effect should force a fresh probe (skip the cache). True
 * only when a `reverify()` token targets THIS backend AND that exact token (key +
 * counter) has not already been consumed by a prior probe — so a single
 * reverify() forces exactly one fresh probe.
 */
function isForcedProbe(
  force: ForceToken | null,
  consumed: ForceToken | null,
  key: string,
): boolean {
  return (
    force?.key === key &&
    !(consumed?.key === force.key && consumed.n === force.n)
  );
}

/** A best-effort display timestamp; not used in any cache-correctness logic. */
function timestamp(): number {
  return new Date().getTime();
}

/**
 * Map a client fetch result to a cached verdict, running the 3-leg verify() over
 * an `available` attestation. Exported (DOM-free) so the mapping is unit-tested
 * without a React render harness.
 */
export async function resolveBackendVerdict(
  result: BackendAttestationClientResult,
  input: UseBackendAttestationInput,
): Promise<CachedAttestation> {
  if (result.status !== "available") {
    return {
      status: result.status,
      verdict: null,
      attestation: null,
      message: result.message,
      verifiedAt: timestamp(),
    };
  }

  const verdict = await verifyBackendAttestation({
    attestation: result.attestation,
    serverInfoDid: input.serverInfoDid,
    deps: input.deps,
  });
  return {
    status: verdict.attested ? "attested" : "unattested",
    verdict,
    attestation: result.attestation,
    message: null,
    verifiedAt: timestamp(),
  };
}

/**
 * Resolve the verdict for a backend, deduplicating concurrent calls by url.
 * Never rejects — a thrown fetch/verify resolves to an `"error"` verdict.
 */
function runVerification(
  key: string,
  input: UseBackendAttestationInput,
): Promise<CachedAttestation> {
  const existing = inflight.get(key);
  if (existing) return existing;

  // Claim a generation for this launch; only the latest may commit its result.
  const gen = (generation.get(key) ?? 0) + 1;
  generation.set(key, gen);

  const run = (async (): Promise<CachedAttestation> => {
    try {
      const result = await fetchBackendSelfAttestation({
        backendUrl: input.backendUrl,
        sessionStore: input.sessionStore,
      });
      // Only when the attestation is available AND no DID was injected do we
      // independently fetch the backend's published DID to cross-check against.
      if (result.status === "available" && input.serverInfoDid === undefined) {
        const serverInfoDid =
          (await fetchServerInfoDid(input.backendUrl)) ?? undefined;
        return await resolveBackendVerdict(result, { ...input, serverInfoDid });
      }
      return await resolveBackendVerdict(result, input);
    } catch (error) {
      return {
        status: "error",
        verdict: null,
        attestation: null,
        message:
          error instanceof Error ? error.message : "Backend attestation failed.",
        verifiedAt: timestamp(),
      };
    }
  })();

  const tracked = run.then((result) => {
    // Drop the result if a newer run for this backend has since started — its
    // verdict, not ours, owns the cache.
    if (generation.get(key) === gen) {
      // Only POSITIVE ("attested") verdicts are cached for the session; negative
      // verdicts are transient, so leave the cache empty to re-probe next time.
      if (shouldCacheVerdict(result.status)) {
        cache.set(key, result);
      } else {
        cache.delete(key);
      }
      inflight.delete(key);
    }
    return result;
  });
  inflight.set(key, tracked);
  return tracked;
}

export function useBackendAttestation(
  input: UseBackendAttestationInput,
): BackendAttestation {
  const { backendUrl, sessionStore, serverInfoDid } = input;
  const key = backendUrl;
  const cached = cache.get(key);
  const [status, setStatus] = useState<BackendAttestationStatus>(
    cached?.status ?? "idle",
  );
  const [verdict, setVerdict] = useState<BackendVerdict | null>(
    cached?.verdict ?? null,
  );
  const [attestation, setAttestation] = useState<BackendSelfAttestation | null>(
    cached?.attestation ?? null,
  );
  const [message, setMessage] = useState<string | null>(cached?.message ?? null);
  const [verifiedAt, setVerifiedAt] = useState<number | null>(
    cached?.verifiedAt ?? null,
  );
  // Set to a backend key (+ counter) when a fresh probe is requested.
  const [force, setForce] = useState<ForceToken | null>(null);
  // Records the force token already consumed by a probe, so a re-render does not
  // re-fire it; only a NEW reverify() (which bumps the counter) re-arms a probe.
  // A ref so consuming the token never re-triggers this effect.
  const consumedForce = useRef<ForceToken | null>(null);

  useEffect(() => {
    // Race-safety: this run is owned by `key`; if the active backend changes
    // before it resolves, `stale` is set and we drop the out-of-order result.
    let stale = false;

    const forced = isForcedProbe(force, consumedForce.current, key);
    if (forced) {
      // A forced re-verify must skip the cache and probe afresh. Consume the
      // token so a later re-render doesn't re-trigger another probe.
      cache.delete(key);
      inflight.delete(key);
      consumedForce.current = { key: force!.key, n: force!.n };
    } else {
      const hit = cache.get(key);
      if (hit) {
        setStatus(hit.status);
        setVerdict(hit.verdict);
        setAttestation(hit.attestation);
        setMessage(hit.message);
        setVerifiedAt(hit.verifiedAt);
        return;
      }
    }

    setStatus("verifying");
    runVerification(key, input).then((result) => {
      if (stale) return;
      setStatus(result.status);
      setVerdict(result.verdict);
      setAttestation(result.attestation);
      setMessage(result.message);
      setVerifiedAt(result.verifiedAt);
    });

    return () => {
      stale = true;
    };
  }, [backendUrl, sessionStore, serverInfoDid, force]);

  const reverify = useCallback(() => {
    setForce((prev) => ({ key, n: (prev?.n ?? 0) + 1 }));
  }, [key]);

  return { status, verdict, attestation, message, verifiedAt, reverify };
}
