// ── Per-reply credit budget ───────────────────────────────────────────────────
// One reply can make several provider calls (interpretation, rounds, synthesis,
// repair). The budget is the credits the account still had when the reply
// started (the allowance). Before each call it turns what is left into a
// provider `max_tokens`, so a reply stops at the limit instead of overshooting
// it. Observed usage is cumulative for the reply; settlement (settle.ts) is the
// authority for what is actually charged.

import { creditsFor, type ModelRates } from "./credits.js";

export interface ReplyUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface CallLimit {
  /** `max_tokens` to send; undefined when neither the budget nor the caller caps output. */
  maxTokens: number | undefined;
  /** True when the budget's cap is below every other bound (the caller's cap and the room the context leaves), so it is what a `length` finish would have hit. */
  capped: boolean;
}

export interface ReplyBudget {
  readonly allowance: number;
  readonly rates: ModelRates;
  /** Credits for the usage observed so far in this reply. */
  spentCredits(): number;
  /** Record the reply's cumulative usage across all provider calls so far. */
  observe(usage: ReplyUsage): void;
  /** True once observed spend has used the whole allowance. */
  exhausted(): boolean;
  /**
   * Output tokens the next call may use; zero or negative when it is unaffordable. Infinity when output is free.
   * `promptTokens` is the caller's estimate of the call's prompt before the provider counts it (agent chat:
   * `estimateTextTokens` of the request JSON).
   */
  maxTokensFor(promptTokens: number): number;
  /** The limit for the next provider call, or null when it is unaffordable and must not be made. */
  limitFor(promptTokens: number, existingMaxTokens?: number): CallLimit | null;
}

/** A `length` finish is the budget's stop only when its cap bound the call and the reply reached it or used up the allowance; a model stopping at its own limit with credits left is a normal end. */
export function lengthStoppedByBudget(limit: CallLimit, completionTokens: number, budget: ReplyBudget): boolean {
  return limit.capped && (completionTokens >= (limit.maxTokens ?? Number.POSITIVE_INFINITY) || budget.exhausted());
}

/** The most one provider call can cost: its prompt, estimated as the caller passes it to `limitFor`, plus `maxTokens` of output. */
export function callCostBound(rates: ModelRates, promptTokens: number, maxTokens: number): number {
  return creditsFor(rates, promptTokens, maxTokens);
}

/** `contextTokens` is the model's context window: a budget cap that does not fit the room it leaves is not a cap. A non-finite value means the size is unknown. */
export function createReplyBudget(allowance: number, rates: ModelRates, contextTokens?: number): ReplyBudget {
  let observed: ReplyUsage = { promptTokens: 0, completionTokens: 0 };
  const spentCredits = () => creditsFor(rates, observed.promptTokens, observed.completionTokens);
  const maxTokensFor = (promptTokens: number) => {
    const promptCredits = (promptTokens * rates.creditsPerKInput) / 1000;
    const remaining = allowance - spentCredits() - promptCredits;
    if (remaining <= 0) return 0;
    return rates.creditsPerKOutput > 0 ? Math.floor((remaining * 1000) / rates.creditsPerKOutput) : Number.POSITIVE_INFINITY;
  };
  return {
    allowance,
    rates,
    spentCredits,
    observe: usage => { observed = usage; },
    exhausted: () => spentCredits() >= allowance,
    maxTokensFor,
    limitFor: (promptTokens, existingMaxTokens) => {
      const cap = maxTokensFor(promptTokens);
      if (cap < 1) return null;
      const roomInContext = contextTokens === undefined ? Number.POSITIVE_INFINITY : contextTokens - promptTokens;
      if (cap >= roomInContext || (existingMaxTokens !== undefined && existingMaxTokens < cap)) return { maxTokens: existingMaxTokens, capped: false };
      return { maxTokens: cap, capped: true };
    },
  };
}
