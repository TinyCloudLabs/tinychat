// ── Usage tracking ────────────────────────────────────────────────────────────
// In-memory credit accounting keyed by user address.
//
// In-memory credit counter. When the ledger is configured, the counter is seeded
// from the ledger on first touch (ledger-rehydrate.ts); the chat gate and
// GET /api/billing/status read the ledger's committed credits when it is
// authoritative and this counter otherwise. The durable follow-up is Stripe
// Billing Meters — see docs/stripe-setup.md.
//
// Windows: free tier = UTC day; paid tiers = rolling 7-day anchored to the
// subscription's billing-cycle anchor, which lives in Stripe.

import { creditBudgetFor, type BudgetWindow, type TierConfig } from "./tiers.js";

interface UsageRecord {
  /** Epoch ms marking the start of the current window. */
  periodStart: number;
  /**
   * Window kind ("day" | "week" | "month") this record belongs to. Issue #31:
   * a paid anchored-week and a free UTC-day can resolve to the SAME periodStart
   * integer at a midnight anchor on the first day of the week. Keying the slot
   * on periodStart alone then reads old paid usage against the new free limit
   * (a silent 402). Pairing periodStart with the window kind makes the two
   * windows distinct, so a tier transition always rolls the record over.
   */
  windowKind: BudgetWindow;
  creditsUsed: number;
}

export interface UsageSnapshot {
  used: number;
  limit: number;
  /** ISO timestamp when the current window resets. */
  resetsAt: string;
}

const usageByAddress = new Map<string, UsageRecord>();
// The record a rollover replaced. Replies admitted before a boundary can still settle after it; this lets them be
// charged against (and clamped by) the window they started in. Only one window back is kept.
const previousByAddress = new Map<string, UsageRecord>();

// ── Window boundaries (UTC) ───────────────────────────────────────────────────

/** Start of the UTC day containing `now` (epoch ms). */
export function startOfUtcDay(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Start of the next UTC day after `now` (epoch ms). */
export function startOfNextUtcDay(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Start (epoch ms) of the anchored 7-day window containing `now`. Pure
 * arithmetic on epoch ms — no calendar fields — so DST and timezone shifts
 * never bend the boundary. For a future anchor (now < anchor) Math.floor of
 * a negative ratio still yields a boundary ≤ now and a reset > now.
 */
export function startOfAnchoredWeek(anchor: number, now: number): number {
  return anchor + Math.floor((now - anchor) / WEEK_MS) * WEEK_MS;
}

/** Start of the next anchored 7-day window after `now` (epoch ms). */
export function startOfNextAnchoredWeek(anchor: number, now: number): number {
  return startOfAnchoredWeek(anchor, now) + WEEK_MS;
}

function windowStart(window: BudgetWindow, anchor: number | null, now: number): number {
  if (window === "week") return startOfAnchoredWeek(anchor ?? now, now);
  return startOfUtcDay(now);
}

function windowReset(window: BudgetWindow, anchor: number | null, now: number): number {
  if (window === "week") return startOfNextAnchoredWeek(anchor ?? now, now);
  return startOfNextUtcDay(now);
}

// ── Missing-anchor diagnostic (one-shot per process) ─────────────────────────
// A paid tier should always reach usage fns with a Stripe-derived anchor; null
// indicates a routing bug upstream. We treat anchor=now (window starts now —
// never wrongly locks the user out) and warn ONCE per process so the bug is
// visible without spamming logs on every request.

let missingAnchorWarned = false;

function warnMissingAnchor(): void {
  if (missingAnchorWarned) return;
  missingAnchorWarned = true;
  console.warn(
    "[billing] paid tier resolved without a billing anchor; defaulting window to now",
  );
}

function preflightAnchor(tier: TierConfig, anchor: number | null): void {
  if (tier.budgetWindow === "week" && anchor === null) warnMissingAnchor();
}

// ── Accounting ────────────────────────────────────────────────────────────────

/**
 * Read the current usage for an address within the tier's window, rolling the
 * record over to a fresh window when the previous one has elapsed.
 */
export function getUsage(
  address: string,
  tier: TierConfig,
  anchor: number | null = null,
  now: number = Date.now(),
): UsageSnapshot {
  preflightAnchor(tier, anchor);
  const used = currentCredits(address, tier.budgetWindow, anchor, now);
  return {
    used,
    limit: creditBudgetFor(tier.id),
    resetsAt: new Date(windowReset(tier.budgetWindow, anchor, now)).toISOString(),
  };
}

/** True when the address has already met or exceeded the tier budget. */
export function isOverBudget(
  address: string,
  tier: TierConfig,
  anchor: number | null = null,
  now: number = Date.now(),
): boolean {
  preflightAnchor(tier, anchor);
  return currentCredits(address, tier.budgetWindow, anchor, now) >= creditBudgetFor(tier.id);
}

/** Add credits to the address's current window. */
export function recordUsage(
  address: string,
  tier: TierConfig,
  credits: number,
  anchor: number | null = null,
  now: number = Date.now(),
): void {
  if (credits <= 0) return;
  preflightAnchor(tier, anchor);
  const start = windowStart(tier.budgetWindow, anchor, now);
  const record = usageByAddress.get(address);
  if (!record || record.periodStart !== start || record.windowKind !== tier.budgetWindow) {
    if (record) previousByAddress.set(address, record);
    usageByAddress.set(address, { periodStart: start, windowKind: tier.budgetWindow, creditsUsed: credits });
    return;
  }
  record.creditsUsed += credits;
}

/** Start (epoch ms) of the tier's window containing `at`. */
export function windowStartFor(tier: TierConfig, anchor: number | null, at: number): number {
  preflightAnchor(tier, anchor);
  return windowStart(tier.budgetWindow, anchor, at);
}

type WindowRecord = UsageRecord | "empty" | "gap" | "lost";

/**
 * Which record describes the tier's window containing `at`: the current one,
 * the one a rollover replaced, or else
 *   "empty" - nothing recorded and the current record is not newer (a write replaces it, moving it aside),
 *   "gap"   - the current record is newer and nothing newer than `at` sits in the previous slot, so that window used nothing,
 *   "lost"  - the previous slot holds a window at or after `at` that is not its own: it rolled twice.
 */
function recordFor(address: string, tier: TierConfig, anchor: number | null, at: number): WindowRecord {
  const start = windowStartFor(tier, anchor, at);
  const kind = tier.budgetWindow;
  const current = usageByAddress.get(address);
  if (current && current.periodStart === start && current.windowKind === kind) return current;
  const previous = previousByAddress.get(address);
  if (previous && previous.periodStart === start && previous.windowKind === kind) return previous;
  if (!current || current.periodStart <= start) return "empty";
  return !previous || previous.periodStart < start ? "gap" : "lost";
}

/** Credits used in the window containing `at`, or null when no record describes it any more. */
export function usedInWindow(address: string, tier: TierConfig, anchor: number | null, at: number): number | null {
  const record = recordFor(address, tier, anchor, at);
  return record === "lost" ? null : typeof record === "string" ? 0 : record.creditsUsed;
}

/** Add credits to the window containing `at`; a window no record describes any more is left alone. Never overwrites another window's record. */
export function recordUsageInWindow(address: string, tier: TierConfig, credits: number, anchor: number | null, at: number): void {
  if (credits <= 0) return;
  const record = recordFor(address, tier, anchor, at);
  if (record === "lost") return;
  if (record === "empty") recordUsage(address, tier, credits, anchor, at);
  else if (record === "gap") previousByAddress.set(address, { periodStart: windowStartFor(tier, anchor, at), windowKind: tier.budgetWindow, creditsUsed: credits });
  else record.creditsUsed += credits;
}

function currentCredits(
  address: string,
  window: BudgetWindow,
  anchor: number | null,
  now: number,
): number {
  const start = windowStart(window, anchor, now);
  const record = usageByAddress.get(address);
  if (!record || record.periodStart !== start || record.windowKind !== window) return 0;
  return record.creditsUsed;
}

// ── Test/util helpers ─────────────────────────────────────────────────────────

/** Clear all tracked usage. Exposed for tests. */
export function _resetUsage(): void {
  usageByAddress.clear();
  previousByAddress.clear();
}

/** Reset the one-shot missing-anchor warning. Exposed for tests. */
export function _resetMissingAnchorWarning(): void {
  missingAnchorWarned = false;
}
