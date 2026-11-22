import { describe, expect, test } from "bun:test";
import type { ModelRates } from "../billing/credits.js";
import { minTurnCredits } from "../billing/turn-budget.js";

const rates = (creditsPerKInput: number, creditsPerKOutput: number): ModelRates => ({ creditsPerKInput, creditsPerKOutput, fallback: false });

describe("per-turn minimum (TC-3734)", () => {
  test("is one short turn (8k in, 1k out) at the turn's own model rates", () => {
    // Production rates on 2026-11-22 (/api/billing/rates).
    expect(minTurnCredits(rates(15, 30))).toBe(150); // z-ai/glm-5.2, the baseline
    expect(minTurnCredits(rates(2, 15))).toBe(31); // qwen/qwen3.6-35b-a3b
    expect(minTurnCredits(rates(30, 150))).toBe(390); // moonshotai/kimi-k3
  });

  test("a model without pricing uses the fallback rates (200/1000), so its minimum is the highest", () => {
    expect(minTurnCredits({ creditsPerKInput: 200, creditsPerKOutput: 1000, fallback: true })).toBe(2600);
  });

  test("rounds a fractional cost up, like the charge", () => {
    expect(minTurnCredits(rates(1.5, 5))).toBe(17);
  });
});
