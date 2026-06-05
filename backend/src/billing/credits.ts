// ── Credits math (spec §2, §4.2) ─────────────────────────────────────────────
// Pure functions for the credit-metering paywall. The peg is internal: PEG_USD
// must never leak into API responses, UI strings, or user-facing docs. Public
// rates are denominated in credits only (see docs/credits-spec.md §2.1).

import type { CatalogModel } from "./catalog.js";

/**
 * Internal peg used to convert RedPill USD/token pricing into credits.
 * 1 credit = $0.0001 of upstream cost. NEVER serialize this value or any
 * dollar figure derived from it into a response or UI string.
 */
export const PEG_USD = 1e-4;

/**
 * Per-decade base of the snap ladder. Real ladder values are these scaled by
 * 10^n. Yields the spec §2.2 ladder: 0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10,
 * 15, 20, 25, 30, 40, 50, 60, 80, 100, 150, 200, 250, 300, 400, 500, 600, 800,
 * 1000, ...
 */
const LADDER_BASE = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8] as const;

/** Multiplier-badge ladder for the model picker (spec §2.4). */
const MULTIPLIER_LADDER = [1, 2, 5, 10, 25, 50, 100] as const;

/** Fallback rates when a catalog entry is missing parseable pricing (spec §2.5). */
const FALLBACK_RATES = {
  creditsPerKInput: 200,
  creditsPerKOutput: 1000,
} as const;

/** Relative epsilon for FP-safe ladder comparisons. Tight enough that
 *  meaningful offsets (>~ 1e-10 of the value) cleanly snap UP, loose enough
 *  to absorb double-precision rounding noise from `pricing.* * 1000 / PEG`. */
const EPS = 1e-12;

export interface ModelRates {
  creditsPerKInput: number;
  creditsPerKOutput: number;
  fallback: boolean;
}

/** Clean up FP noise on ladder values (e.g. 1.5 * 0.1 ≠ 0.15 exactly). */
function trimFpNoise(v: number): number {
  return Number(v.toPrecision(12));
}

/**
 * Snap `x` UP to the nearest value on the 1–2–5-style ladder (spec §2.2).
 * Extends geometrically in both directions. Values already on the ladder stay
 * put (within FP tolerance). Returns 0 for non-positive inputs.
 */
export function niceCeil(x: number): number {
  if (!Number.isFinite(x) || x <= 0) return 0;
  // Decade selection: floor(log10(x)) places x in [10^n, 10^(n+1)). Add a tiny
  // epsilon so exact powers of ten land in the higher decade where their
  // ladder entry lives (e.g. 10 → n=1 → ladder values 10..80).
  const n = Math.floor(Math.log10(x) + EPS);
  const scale = Math.pow(10, n);
  for (const b of LADDER_BASE) {
    const v = b * scale;
    if (v + EPS * Math.max(1, v) >= x) return trimFpNoise(v);
  }
  // Top of this decade — overflow into next decade's first rung (10 * scale).
  return trimFpNoise(10 * scale);
}

// Track which catalog ids have already warned this process, so the fallback
// branch emits exactly one console.warn per model id (spec §2.5).
const warnedFallbackIds = new Set<string>();

/** Clear the warn-once set. Exposed for tests. */
export function _resetCreditsWarnings(): void {
  warnedFallbackIds.clear();
}

/**
 * Derive credits-per-1K rates for a catalog model. Snaps both sides UP onto
 * the ladder so the charged rate ≥ upstream cost (margin by construction).
 * Models missing pricing fall back to a conservative 200/1000 with a one-shot
 * console.warn (spec §2.5 — no silent free rides).
 */
export function ratesForModel(m: CatalogModel): ModelRates {
  if (!m.pricing) {
    if (!warnedFallbackIds.has(m.id)) {
      warnedFallbackIds.add(m.id);
      console.warn(
        `[credits] missing pricing for model "${m.id}"; using fallback ${FALLBACK_RATES.creditsPerKInput}/${FALLBACK_RATES.creditsPerKOutput} credits per 1K`,
      );
    }
    return { ...FALLBACK_RATES, fallback: true };
  }
  const rawIn = (m.pricing.prompt * 1000) / PEG_USD;
  const rawOut = (m.pricing.completion * 1000) / PEG_USD;
  return {
    creditsPerKInput: niceCeil(rawIn),
    creditsPerKOutput: niceCeil(rawOut),
    fallback: false,
  };
}

/**
 * Picker-badge multiplier (spec §2.4): ratio of this model's output rate to
 * the baseline model's output rate, snapped UP onto [1,2,5,10,25,50,100].
 * Caps at the top rung when the ratio exceeds 100×.
 */
export function multiplierFor(model: ModelRates, baseline: ModelRates): number {
  // Fallback rates intentionally pin to the top rung (spec §2.5: missing
  // pricing → multiplier = 100). The §2.4 formula on 200/1000 vs 2.5/20 would
  // otherwise yield 50; the override keeps the badge conservative and the
  // spec wording authoritative.
  if (model.fallback) {
    return MULTIPLIER_LADDER[MULTIPLIER_LADDER.length - 1];
  }
  if (!Number.isFinite(baseline.creditsPerKOutput) || baseline.creditsPerKOutput <= 0) {
    return MULTIPLIER_LADDER[MULTIPLIER_LADDER.length - 1];
  }
  const ratio = model.creditsPerKOutput / baseline.creditsPerKOutput;
  for (const m of MULTIPLIER_LADDER) {
    if (m + EPS >= ratio) return m;
  }
  return MULTIPLIER_LADDER[MULTIPLIER_LADDER.length - 1];
}

/**
 * Cost of a single message in credits (spec §2.3). Minimum 1 credit when any
 * tokens were consumed, 0 when neither side recorded tokens.
 */
export function creditsFor(
  rates: ModelRates,
  promptTokens: number,
  completionTokens: number,
): number {
  const prompt = Math.max(0, promptTokens);
  const completion = Math.max(0, completionTokens);
  const credits = Math.ceil(
    (prompt / 1000) * rates.creditsPerKInput +
      (completion / 1000) * rates.creditsPerKOutput,
  );
  if (prompt === 0 && completion === 0) return 0;
  return Math.max(1, credits);
}

/**
 * Chars/4 fallback when the upstream stream omitted the usage chunk. Counts
 * every message's string content as prompt and the streamed text as
 * completion, then prices the result through `creditsFor`. Replaces the
 * earlier flat token estimator (spec §4.4).
 */
export function estimateCredits(
  rates: ModelRates,
  messages: Array<{ content?: unknown }>,
  completionText: string,
): number {
  let promptChars = 0;
  for (const message of messages) {
    if (typeof message.content === "string") promptChars += message.content.length;
  }
  const promptTokens = Math.ceil(promptChars / 4);
  const completionTokens = Math.ceil(completionText.length / 4);
  return creditsFor(rates, promptTokens, completionTokens);
}
