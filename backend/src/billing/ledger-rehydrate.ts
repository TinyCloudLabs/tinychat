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

    let committed: number | null = null;
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
        committed = body.committed_credits ?? null;
      } else {
        throw new Error(`HTTP ${res.status}`);
      }
    } catch (err) {
      console.warn("[ledger-rehydrate] failed to rehydrate", address, ":", err);
      this.unrehydratedServes++;
      if (this.unrehydratedServes > K) {
        return true; // degrade to at-limit
      }
      return false; // bounded forgiveness: serve normally
    }

    // Mark as done — even if committed is null/0 so we don't retry every request.
    this.rehydratedKeys.add(key);

    if (committed !== null && committed > 0) {
      const local = getUsage(address, tier, anchor, now).used;
      const delta = Math.max(0, Math.floor(committed) - local);
      if (delta > 0) {
        recordUsage(address, tier, delta, anchor, now);
      }
    }

    return false;
  }

  /** For tests: current count of failed first-touch serves. */
  get unrehydratedServesCount(): number {
    return this.unrehydratedServes;
  }
}
