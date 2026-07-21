// §E.7 — LedgerRehydrator: lazy-on-first-touch rehydration of the in-memory credit
// counter from the durable ledger. Seeds the counter before the budget gate so a
// cold start / redeploy no longer forgives a full window of consumption (R5/R6).
//
// R6 bounded forgiveness: if the sidecar read fails, serve (never block) and track
// unrehydratedServes. Once it exceeds K = 200 per process, degrade first-touch
// requests to at-limit (402) until the store is reachable again.

import type { TierConfig } from "./tiers.js";
import {
  getUsage,
  recordUsage,
  startOfAnchoredWeek,
  startOfUtcDay,
} from "./usage.js";

const K = 200;

interface CreditEntitlementResponse {
  account: string;
  credit_limit: number;
  period_anchor: string;
  window_start: number | null;
  committed_credits: number | null;
}

export class LedgerRehydrator {
  private readonly serviceUrl: string;
  private readonly serviceSecret: string;
  private readonly rehydratedKeys = new Set<string>();
  private unrehydratedServes = 0;

  constructor(serviceUrl: string, serviceSecret: string) {
    this.serviceUrl = serviceUrl.replace(/\/$/, "");
    this.serviceSecret = serviceSecret;
  }

  /**
   * Ensure the in-memory counter for (address, current window) is seeded from
   * the durable ledger. Returns true when the caller should treat the request as
   * at-limit (degraded 402 due to K-cap exceeded with store still unreachable).
   * Never throws — on any error the request is served (never blocked).
   */
  async rehydrateIfNeeded(
    address: string,
    tier: TierConfig,
    anchor: number | null,
    now: number = Date.now(),
  ): Promise<boolean> {
    const ws =
      tier.budgetWindow === "week"
        ? startOfAnchoredWeek(anchor ?? now, now)
        : startOfUtcDay(now);
    const key = `${address}:${ws}`;

    if (this.rehydratedKeys.has(key)) return false;

    let committed: number;
    try {
      const url =
        `${this.serviceUrl}/api/credit-entitlement/${encodeURIComponent(address)}` +
        `?window_start=${ws}`;
      const res = await fetch(url, {
        signal: AbortSignal.timeout(2000),
        headers: { Authorization: `Bearer ${this.serviceSecret}` },
      });
      if (res.ok) {
        const body = (await res.json()) as CreditEntitlementResponse;
        // A null 200 is the DO's soft-fail shape, not a zero-credit read. It
        // must take the same K-degrade path as a failed fetch and must never
        // mark this (account, window) as rehydrated.
        if (typeof body.committed_credits !== "number" || !Number.isFinite(body.committed_credits)) {
          throw new Error("invalid committed_credits response");
        }
        committed = body.committed_credits;
      } else {
        throw new Error(`HTTP ${res.status}`);
      }
    } catch (err) {
      console.warn("[ledger-rehydrate] failed to rehydrate", address, ":", err);
      this.unrehydratedServes++;
      console.warn(
        `[ledger-rehydrate] source=k_degrade address=${address} ` +
          `unrehydrated_serves=${this.unrehydratedServes} k=${K}`,
      );
      if (this.unrehydratedServes === K / 2 || this.unrehydratedServes === K) {
        console.warn(
          `[ledger-rehydrate] source=k_degrade threshold=${this.unrehydratedServes} k=${K}`,
        );
      }
      if (this.unrehydratedServes > K) {
        return true; // degrade to at-limit
      }
      return false; // bounded forgiveness: serve normally
    }

    // Only a finite committed count successfully rehydrates this key.
    this.rehydratedKeys.add(key);

    if (committed > 0) {
      const local = getUsage(address, tier, anchor, now).used;
      const delta = Math.max(0, Math.floor(committed) - local);
      if (delta > 0) {
        recordUsage(address, tier, delta, anchor, now);
      }
    }

    return false;
  }

  /**
   * Fetch the entitlement for (address, tier) from the sidecar, returning a
   * null-aware outage signal alongside credit_limit and committed_credits.
   * Never throws. isOutage=true when the fetch fails OR when committed_credits
   * is null despite a window being requested (DO soft-fail — must not be read
   * as zero).
   */
  async getEntitlement(
    address: string,
    tier: TierConfig,
    anchor: number | null,
    now: number = Date.now(),
  ): Promise<{
    credit_limit: number | null;
    committed_credits: number | null;
    period_anchor: string | null;
    isOutage: boolean;
  }> {
    const ws =
      tier.budgetWindow === "week"
        ? startOfAnchoredWeek(anchor ?? now, now)
        : startOfUtcDay(now);

    try {
      const url =
        `${this.serviceUrl}/api/credit-entitlement/${encodeURIComponent(address)}` +
        `?window_start=${ws}`;
      const res = await fetch(url, {
        signal: AbortSignal.timeout(2000),
        headers: { Authorization: `Bearer ${this.serviceSecret}` },
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const body = (await res.json()) as CreditEntitlementResponse;
      // committed_credits===null while we asked for a window → DO soft-fail → outage
      if (body.committed_credits === null) {
        console.warn(
          `[ledger-rehydrate] source=outage_policy null_committed_credits address=${address} ` +
            `window_start=${ws}`,
        );
        return {
          credit_limit: body.credit_limit ?? null,
          committed_credits: null,
          period_anchor: body.period_anchor ?? null,
          isOutage: true,
        };
      }
      return {
        credit_limit: body.credit_limit ?? null,
        committed_credits: body.committed_credits,
        period_anchor: body.period_anchor ?? null,
        isOutage: false,
      };
    } catch (err) {
      console.warn("[ledger-rehydrate] getEntitlement failed", address, ":", err);
      return {
        credit_limit: null,
        committed_credits: null,
        period_anchor: null,
        isOutage: true,
      };
    }
  }

  /** For tests: current count of failed first-touch serves. */
  get unrehydratedServesCount(): number {
    return this.unrehydratedServes;
  }
}
