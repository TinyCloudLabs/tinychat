import type { BillingConfig } from "./billingApi";

/** What the client knows about the signed-in account's plan and credit window. */
export interface CreditLimitContext {
  /** Display name of the plan, or null when the billing data has not loaded. */
  tierName: string | null;
  /** ISO time the credit window resets, from the billing status, or null. */
  resetsAt: string | null;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAY_MS = 86_400_000;

function utcDayStart(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

/**
 * A short UTC time such as "tomorrow at 00:00 UTC" or "Tuesday at 14:05 UTC".
 * Returns null when the time is missing, unparseable or already past, so a
 * stale billing status never produces a wrong date.
 */
export function formatResetTime(resetsAt: string | null | undefined, now: number): string | null {
  if (!resetsAt) return null;
  const at = Date.parse(resetsAt);
  if (!Number.isFinite(at) || at <= now) return null;
  const date = new Date(at);
  const clock = `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")} UTC`;
  const days = Math.round((utcDayStart(at) - utcDayStart(now)) / DAY_MS);
  if (days === 0) return `today at ${clock}`;
  if (days === 1) return `tomorrow at ${clock}`;
  const weekday = WEEKDAYS[date.getUTCDay()];
  return days >= 7 ? `next ${weekday} at ${clock}` : `${weekday} at ${clock}`;
}

/**
 * The text for a message that got no reply because the account is out of
 * credits. It does not say whether anything was charged: a turn that stopped
 * after a tool round is charged for the usage it observed.
 */
export function outOfCreditsMessage(context: CreditLimitContext, now: number): string {
  const plan = context.tierName ? `the ${context.tierName} plan` : "your plan";
  const base = `You're out of credits on ${plan}, so this message got no reply.`;
  const when = formatResetTime(context.resetsAt, now);
  return when ? `${base} Credits reset ${when}.` : base;
}

/**
 * True when a higher tier exists, judged by credit allowance in the public
 * billing config. The free plan always has an upgrade. An unknown tier or a
 * missing config counts as upgradable, so the pricing dialog is only withheld
 * when a paid top tier is positively known.
 */
export function hasUpgradeTier(config: BillingConfig | null, tierId: string): boolean {
  if (tierId === "free" || !config) return true;
  const current = config.tiers.find((tier) => tier.id === tierId);
  if (!current) return true;
  return config.tiers.some((tier) => tier.creditBudget > current.creditBudget);
}
