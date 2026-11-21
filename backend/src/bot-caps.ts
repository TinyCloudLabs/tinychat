// TC-3325: how many bots an account may have. Checked when a bot is created and nowhere else: an account that
// already has more keeps every bot, and every one keeps working.

import type { TierId } from "./billing/tiers.js";
import type { BotEnvironment, OwnerBots } from "./bots-registry.js";

export type CapMode = "flat3" | "table";
/** A row of the per-plan table, lowest first. */
export type PlanName = "tier1" | "tier2" | "tier3" | "tier4";

/**
 * Which rule applies.
 * - "flat3": every account may have 3 bots, Main included, whatever its plan. No plan is read.
 * - "table": the limits per plan below.
 * The default is "flat3" for as long as only private bots can be created. Setting BOTS_CAP_MODE=table switches to the
 * table without a code change.
 */
export const CAP_MODE: CapMode = "flat3";
export const FLAT_LIMIT = 3;

/**
 * Limits per plan. NOT ENFORCED while the mode is "flat3": nothing reads this table then.
 * Main counts as a private bot. So under "table", while only private bots can be created, a tier1 or tier2 account
 * cannot create a bot at all: Main already fills its private limit.
 */
export const BOT_LIMITS_BY_PLAN: Record<PlanName, Record<BotEnvironment, number>> = {
  tier1: { private: 0, regular: 1 },
  tier2: { private: 1, regular: 3 },
  tier3: { private: 3, regular: 5 },
  tier4: { private: 10, regular: 10 },
};

export interface BotCount { max: number; used: number }
export interface BotCaps {
  capMode: CapMode;
  /** Null when the account's plan cannot be read: no numbers are shown and nothing can be created. */
  limits: Record<BotEnvironment, BotCount> | null;
  canCreate: Record<BotEnvironment, boolean>;
}

/** The rule in force: BOTS_CAP_MODE when it is exactly "table" or "flat3", otherwise the default. */
export function capModeFromEnv(env: Record<string, string | undefined>): CapMode {
  const value = env.BOTS_CAP_MODE;
  return value === "table" || value === "flat3" ? value : CAP_MODE;
}

/** The table row a backend tier gets. The two lists do not match one for one; how they correspond is recorded in TC-3325. */
export function planFor(tier: TierId): PlanName {
  return tier === "free" ? "tier1" : tier === "plus" ? "tier2" : "tier3";
}

/** What the owner is told about limits, from the rule in force, the account's plan if it could be read, and its record. */
export function botCaps(capMode: CapMode, plan: PlanName | undefined, row: OwnerBots): BotCaps {
  const max = capMode === "flat3" ? { private: FLAT_LIMIT, regular: 0 } : plan === undefined ? undefined : BOT_LIMITS_BY_PLAN[plan];
  if (max === undefined) return { capMode, limits: null, canCreate: { private: false, regular: false } };
  const used = (environment: BotEnvironment) => row.bots.filter(bot => bot.environment === environment && bot.state !== "deleting").length;
  const limits = { private: { max: max.private, used: used("private") }, regular: { max: max.regular, used: used("regular") } };
  // A regular bot cannot be created whatever its limit says: nothing runs one.
  return { capMode, limits, canCreate: { private: limits.private.used < limits.private.max, regular: false } };
}
