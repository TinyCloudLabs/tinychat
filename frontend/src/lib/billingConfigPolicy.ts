import type { BillingConfig, TierId } from "@/lib/billingApi";

/**
 * A1 — billing-config fetch resilience.
 *
 * `App.tsx` used to fetch `/api/billing/config` exactly once on mount and, on
 * ANY failure, silently treat the paywall as off — hiding every monetization
 * surface for the whole SPA session (no retry, no refetch, ever). A single 429,
 * a load during a backend restart, or any network blip therefore darkened the
 * upgrade path for good.
 *
 * This module is the pure, DOM-free policy for closing that mode (extraction
 * idiom mirrors `paywall.ts`): a bounded, backed-off retry for the INITIAL
 * fetch, plus a `shouldRefetch` predicate that re-requests the config at a few
 * trigger points — but ONLY while it is still null. A held (successfully
 * fetched) config is NEVER re-requested: no polling, no focus storms. When
 * every attempt still fails, the caller keeps the current "treat as off"
 * behavior; the fix removes the "one transient failure = whole session dark"
 * mode without adding any nagging.
 */

/**
 * Backoff (ms) applied before the 2nd and 3rd initial-fetch attempts (~1s, then
 * ~4s). A third, larger step (~10s) is listed for when the schedule is extended;
 * the default policy caps at {@link MAX_INITIAL_ATTEMPTS} attempts, so only the
 * first two entries are consumed by default. All of it is injectable so unit
 * tests never actually sleep.
 */
export const DEFAULT_RETRY_BACKOFF_MS: readonly number[] = [1000, 4000, 10000];

/** Bounded attempt count for the initial fetch — the retry can never storm. */
export const MAX_INITIAL_ATTEMPTS = 3;

export interface FetchRetryOptions {
  /** Delay before each retry (index 0 = before attempt 2, etc.). */
  backoffMs?: readonly number[];
  /** Max total attempts (default {@link MAX_INITIAL_ATTEMPTS}). Bounds the loop. */
  maxAttempts?: number;
  /** Injectable sleep so tests don't wait real time. */
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `fetchConfig` with a bounded, backed-off retry. Resolves with the first
 * successful result and STOPS immediately (no further attempts), or `null` once
 * every attempt has failed — it never throws and never loops unbounded. There
 * are no lingering timers: the only waits are the awaited `sleep` calls between
 * attempts.
 */
export async function fetchConfigWithRetry<T>(
  fetchConfig: () => Promise<T>,
  opts: FetchRetryOptions = {},
): Promise<T | null> {
  const backoffMs = opts.backoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
  const sleep = opts.sleep ?? realSleep;
  const attempts = Math.max(1, opts.maxAttempts ?? MAX_INITIAL_ATTEMPTS);

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) {
      const delay = backoffMs[attempt - 1] ?? backoffMs[backoffMs.length - 1] ?? 0;
      await sleep(delay);
    }
    try {
      return await fetchConfig();
    } catch {
      // Swallow and retry — after the last attempt we fall through to `null`.
    }
  }
  return null;
}

/** The trigger points at which config may be re-requested while still null. */
export type RefetchTrigger = "settings-entry" | "paywall-402" | "window-focus";

export interface BillingConfigState {
  /** The cached config, or null if it has never been fetched successfully. */
  config: BillingConfig | null;
  /** Did the initial bounded-retry fetch run to exhaustion and fail? */
  initialFetchFailed: boolean;
}

/**
 * Should the config be re-requested for this trigger?
 *
 * The overriding rule: a config we already hold is NEVER re-requested — that's
 * what keeps this free of polling and focus-driven fetch storms. While the
 * config is still null:
 *  - `settings-entry` and `paywall-402` always refetch (the user just reached a
 *    surface that needs the config, so recover it now).
 *  - `window-focus` refetches ONLY after the initial fetch has actually failed,
 *    so a focus event mid-initial-fetch doesn't pile on a duplicate request.
 */
export function shouldRefetch(
  state: BillingConfigState,
  trigger: RefetchTrigger,
): boolean {
  // Never re-fetch a held config — no polling, no focus storms.
  if (state.config !== null) return false;

  switch (trigger) {
    case "settings-entry":
    case "paywall-402":
      return true;
    case "window-focus":
      return state.initialFetchFailed;
  }
}

/**
 * The affordance the header usage chip presents for a given tier.
 *
 * By design this is a plain usage meter for EVERY tier — the resilience work
 * (A1) and the mobile-surfacing work (A2) add no tier-conditional upgrade nag.
 * Encoded as a pure function so the "paid users see no new CTA" invariant is
 * unit-asserted (the chip must not branch on tier), not just eyeballed.
 */
export type ChipAffordance = "usage-meter";

export function usageChipAffordance(_tier: TierId | null): ChipAffordance {
  return "usage-meter";
}
