// ── Per-reply credit budget ───────────────────────────────────────────────────
// One reply can make several provider calls (interpretation, rounds, synthesis,
// repair). The budget is the credits the account still had when the reply
// started (the allowance). Before each call it turns what is left into a
// provider `max_tokens`, so a reply stops at the limit instead of overshooting
// it. Observed usage is cumulative for the reply; settlement (settle.ts) is the
// authority for what is actually charged.

import { creditsFor, type ModelRates } from "./credits.js";

/**
 * Prompt tokens are priced from request JSON length before a call, when the
 * provider has not counted them yet. 3 chars/token overestimates English and
 * JSON (about 4) and stays below one token per char for scripts that tokenize
 * worse, so the output cap errs towards stopping early rather than late.
 */
const PROMPT_CHARS_PER_TOKEN = 3;

export interface ReplyUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface CallLimit {
  /** `max_tokens` to send; undefined when neither the budget nor the caller caps output. */
  maxTokens: number | undefined;
  /** True when the budget (not the caller's own cap) is the binding limit, so `finish_reason: "length"` means the limit was hit. */
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
  /** Output tokens the next call may use; zero or negative when it is unaffordable. Infinity when output is free. */
  maxTokensFor(promptChars: number): number;
  /** The limit for the next provider call, or null when it is unaffordable and must not be made. */
  limitFor(promptChars: number, existingMaxTokens?: number): CallLimit | null;
}

export function createReplyBudget(allowance: number, rates: ModelRates): ReplyBudget {
  let observed: ReplyUsage = { promptTokens: 0, completionTokens: 0 };
  const spentCredits = () => creditsFor(rates, observed.promptTokens, observed.completionTokens);
  const maxTokensFor = (promptChars: number) => {
    const promptCredits = (Math.ceil(promptChars / PROMPT_CHARS_PER_TOKEN) * rates.creditsPerKInput) / 1000;
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
    limitFor: (promptChars, existingMaxTokens) => {
      const cap = maxTokensFor(promptChars);
      if (cap < 1) return null;
      if (cap === Number.POSITIVE_INFINITY || (existingMaxTokens !== undefined && existingMaxTokens < cap)) return { maxTokens: existingMaxTokens, capped: false };
      return { maxTokens: cap, capped: true };
    },
  };
}
