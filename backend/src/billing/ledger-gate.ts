// ── Authoritative ledger gate ─────────────────────────────────────────────────
//
// The ledger owns the credit limit and committed count, while TinyChat still
// derives the producer window from its local tier. Until those tier sources are
// unified, a healthy comparison is valid only when their window authorities
// agree. Keep this decision shared by both chat routes so they cannot drift.

import type { TierConfig } from "./tiers.js";

export interface LedgerEntitlement {
  credit_limit: number | null;
  committed_credits: number | null;
  period_anchor: string | null;
  isOutage: boolean;
}

export interface LedgerGateDecision {
  deny: boolean;
  /** A missing weekly anchor has no safe local window from which to build usage. */
  includeUsage: boolean;
  reason: "allow" | "ledger_limit" | "outage";
  source: CreditGateSource;
}

export type CreditGateSource =
  | "ledger"
  | "local"
  | "k_degrade"
  | "outage_policy"
  | "config_outage"
  | "authority_mismatch";

/**
 * The 402 `source` tag is operational diagnostics — it can reveal degraded or
 * misconfigured billing state (k_degrade, config_outage, authority_mismatch)
 * to any client. It is always logged server-side via logCreditGateDeny; it
 * reaches the client-facing body only when LEDGER_EXPOSE_SOURCE=true (set by
 * the e2e rig, never in prod). Operator ruling R3, 2026-07-20.
 */
export function exposeGateSource(source: CreditGateSource): { source?: CreditGateSource } {
  return process.env.LEDGER_EXPOSE_SOURCE === "true" ? { source } : {};
}

export function logCreditGateDeny(args: {
  source: CreditGateSource;
  address: string;
  committed: number | null;
  limit: number | null;
  windowKind: TierConfig["budgetWindow"];
}): void {
  const { source, address, committed, limit, windowKind } = args;
  console.warn(
    `[credit-gate] source=${source} address=${address} committed=${committed ?? "null"} ` +
      `limit=${limit ?? "null"} window_kind=${windowKind}`,
  );
}

/**
 * The rehydration K cap is itself an outage response. Decide its disposition
 * from the selected policy before either route emits a K-derived 402.
 */
export function evaluateKDegradePolicy(outagePolicy: string): {
  deny: boolean;
  source: Extract<CreditGateSource, "k_degrade" | "outage_policy">;
} {
  if (outagePolicy === "fail_open") {
    console.warn("[ledger-gate] source=outage_policy policy=fail_open: bypassing K-degrade denial");
    return { deny: false, source: "outage_policy" };
  }
  return {
    deny: true,
    source: outagePolicy === "fail_closed" ? "outage_policy" : "k_degrade",
  };
}

// `month` is not a current TinyChat BudgetWindow, but it is part of the ledger
// vocabulary and belongs in this authority contract rather than in a future
// route-specific special case.
const PERIOD_ANCHOR_BY_WINDOW = {
  day: "utc_day",
  week: "anchored_week",
  month: "calendar_month",
} as const;

type LedgerWindowKind = keyof typeof PERIOD_ANCHOR_BY_WINDOW;

export function hasMissingWeeklyLedgerAnchor(tier: TierConfig, anchor: number | null): boolean {
  return tier.budgetWindow === "week" && anchor === null;
}

function expectedPeriodAnchor(tier: TierConfig): (typeof PERIOD_ANCHOR_BY_WINDOW)[LedgerWindowKind] {
  return PERIOD_ANCHOR_BY_WINDOW[tier.budgetWindow];
}

function applyOutagePolicy(
  outagePolicy: string,
  isLocalOverBudget: () => boolean,
  source: Extract<CreditGateSource, "outage_policy" | "config_outage" | "authority_mismatch">,
): LedgerGateDecision {
  if (outagePolicy === "fail_closed") {
    return { deny: true, includeUsage: true, reason: "outage", source };
  }
  if (outagePolicy === "fail_open") {
    console.warn("[ledger-gate] source=outage_policy policy=fail_open: serving without ledger enforcement");
    return { deny: false, includeUsage: true, reason: "outage", source };
  }
  console.warn("[ledger-gate] source=outage_policy policy=bounded_k: falling through to local enforcement");
  return {
    deny: isLocalOverBudget(),
    includeUsage: true,
    reason: "outage",
    source,
  };
}

/**
 * Decide the flag-on credit gate without ever comparing values from mismatched
 * windows. `isLocalOverBudget` is deliberately lazy: configuration failures
 * that lack a safe local window must never reach usage.ts's `anchor ?? now`.
 */
export function evaluateLedgerGate(args: {
  tier: TierConfig;
  anchor: number | null;
  entitlement?: LedgerEntitlement;
  outagePolicy: string;
  isLocalOverBudget: () => boolean;
}): LedgerGateDecision {
  const { tier, anchor, entitlement, outagePolicy, isLocalOverBudget } = args;

  if (hasMissingWeeklyLedgerAnchor(tier, anchor)) {
    console.error(
      `[ledger-gate] source=local configuration_outage=missing_week_anchor ` +
        `local_window=${tier.budgetWindow} outage_policy=${outagePolicy}; denying because no safe window exists`,
    );
    // A policy fallback would itself scatter a new `anchor ?? now` window. This
    // is a hard configuration error, so it cannot safely fail open or fall back.
    return { deny: true, includeUsage: false, reason: "outage", source: "config_outage" };
  }

  // Keep this explicit guard even though getEntitlement marks it as an outage:
  // a 200/null response is a DO outage, never a zero-credit healthy read.
  if (
    entitlement === undefined ||
    entitlement.isOutage ||
    entitlement.committed_credits === null ||
    entitlement.credit_limit === null
  ) {
    return applyOutagePolicy(outagePolicy, isLocalOverBudget, "outage_policy");
  }

  const expectedAnchor = expectedPeriodAnchor(tier);
  if (entitlement.period_anchor !== expectedAnchor) {
    console.error(
      `[ledger-gate] source=ledger configuration_outage=window_authority_mismatch ` +
        `local_window=${tier.budgetWindow} local_period_anchor=${expectedAnchor} ` +
        `sidecar_period_anchor=${entitlement.period_anchor ?? "null"}`,
    );
    return applyOutagePolicy(outagePolicy, isLocalOverBudget, "authority_mismatch");
  }

  if (!Number.isFinite(entitlement.credit_limit) || entitlement.credit_limit <= 0) {
    console.error(
      `[ledger-gate] source=ledger configuration_outage=non_positive_credit_limit ` +
        `credit_limit=${entitlement.credit_limit} sidecar_period_anchor=${entitlement.period_anchor}`,
    );
    return applyOutagePolicy(outagePolicy, isLocalOverBudget, "config_outage");
  }

  return {
    deny: entitlement.committed_credits >= entitlement.credit_limit,
    includeUsage: true,
    reason: entitlement.committed_credits >= entitlement.credit_limit ? "ledger_limit" : "allow",
    source: "ledger",
  };
}
