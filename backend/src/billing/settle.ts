// ── Reply settlement ──────────────────────────────────────────────────────────
// The one place a reply's usage becomes a charge (agent chat, Eliza tasks and
// /api/chat all settle here, once per reply). Rules:
//   - The user is never charged above the allowance they had when the reply
//     started, nor above what was left of that window when it settles. The
//     excess is platform cost; the raw figure is only logged.
//   - A failed reply that delivered no output is free.
//   - The charge goes to the window the reply STARTED in, even if it settles
//     after the window rolled over.
// Settlement is synchronous: reading what is left and writing the charge never
// interleave with another reply's settlement. The counter, the allowance and
// this clamp assume ONE backend instance (docs/credits.md).

import { creditsFor, FALLBACK_MODEL_RATES, type ModelRates } from "./credits.js";
import type { LedgerFlusher } from "./ledger-flusher.js";
import type { BudgetWindow, TierConfig } from "./tiers.js";
import { getUsage, isWindowSuperseded, recordUsage, windowStartFor } from "./usage.js";

export type ReplyOutcome = "success" | "limit_stop" | "failed" | "timed_out" | "cancelled";

export interface SettleReplyInput {
  address: string;
  tier: TierConfig;
  anchor: number | null;
  /** Epoch ms when the reply was admitted; selects the window that is charged. */
  startedAt: number;
  /** Credits the account had left in that window at admission. */
  allowance: number;
  model: string;
  usage: { promptTokens: number; completionTokens: number };
  /** Null prices the usage at the conservative fallback rates. */
  rates: ModelRates | null;
  outcome: ReplyOutcome;
  /** True once answer content (not an error notice) reached the user. */
  deliveredOutput: boolean;
  /** Becomes the ledger record id, so a replayed enqueue is a no-op. */
  executionId: string;
  flusher?: Pick<LedgerFlusher, "enqueue">;
}

export interface SettledReply {
  charged: number;
  /** What the observed usage would cost unclamped; platform cost beyond `charged`. */
  rawCredits: number;
  /** The window actually charged, for wording the limit ("today's" vs "this week's"). */
  windowKind: BudgetWindow;
  windowStart: number;
}

/** Never throws: the reply's bytes are already on the wire. */
export function settleReply(input: SettleReplyInput): SettledReply {
  const { address, tier, anchor, startedAt, usage } = input;
  const rawCredits = creditsFor(input.rates ?? FALLBACK_MODEL_RATES, usage.promptTokens, usage.completionTokens);
  const windowStart = windowStartFor(tier, anchor, startedAt);
  const superseded = isWindowSuperseded(address, tier, anchor, startedAt);
  let charged = 0;
  if (!(input.outcome === "failed" && !input.deliveredOutput) && rawCredits > 0) {
    // A superseded record no longer says what the start window used, so only the allowance bounds the charge.
    const windowUsage = getUsage(address, tier, anchor, startedAt);
    const left = superseded ? Number.POSITIVE_INFINITY : Math.max(0, windowUsage.limit - windowUsage.used);
    charged = Math.max(0, Math.min(rawCredits, input.allowance, left));
  }
  if (charged > 0) {
    // Failures are logged without error text, which can carry keys or account data; these fields are what a later reconciliation needs.
    const reconcile = { executionId: input.executionId, account: address, model: input.model, charged, rawCredits, windowKind: tier.budgetWindow, windowStart };
    if (!superseded) {
      try { recordUsage(address, tier, charged, anchor, startedAt); }
      catch { console.error("[billing] local usage recording failed", reconcile); }
    }
    if (input.flusher) {
      try {
        input.flusher.enqueue({
          record_id: input.executionId, account: address, model: input.model, credits: charged,
          window_start: windowStart, window_kind: tier.budgetWindow === "week" ? "anchored_week" : "utc_day",
          prompt_tokens: usage.promptTokens, completion_tokens: usage.completionTokens,
          occurred_at: Date.now(), signed_token_count: null,
        });
      } catch { console.error("[billing] ledger enqueue failed", reconcile); }
    }
  }
  console.info("[billing] reply settled", {
    executionId: input.executionId, outcome: input.outcome, deliveredOutput: input.deliveredOutput,
    allowance: input.allowance, rawCredits, charged, windowKind: tier.budgetWindow, windowStart, windowSuperseded: superseded,
  });
  return { charged, rawCredits, windowKind: tier.budgetWindow, windowStart };
}
