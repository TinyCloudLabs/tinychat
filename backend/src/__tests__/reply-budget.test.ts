import { describe, expect, test } from "bun:test";
import { createReplyBudget } from "../billing/reply-budget.js";
import type { ModelRates } from "../billing/credits.js";

const rates: ModelRates = { creditsPerKInput: 100, creditsPerKOutput: 1000, fallback: false };

describe("ReplyBudget output cap", () => {
  test("derives the output-token cap from the allowance left after the prompt's upper-bound cost", () => {
    const budget = createReplyBudget(500, rates);
    const small = budget.maxTokensFor(300);
    const large = budget.maxTokensFor(3000);
    // 1 credit buys one output token at 1000 credits per 1K; the prompt is never free.
    expect(small).toBeLessThan(500);
    expect(small).toBeGreaterThan(400);
    expect(large).toBeLessThan(small);
    expect(Number.isInteger(small)).toBe(true);
  });

  test("spend observed in earlier calls shrinks the next cap by exactly its cost", () => {
    const budget = createReplyBudget(500, rates);
    const before = budget.maxTokensFor(300);
    // 100 prompt tokens at 100/K + 50 completion tokens at 1000/K = 10 + 50 credits.
    budget.observe({ promptTokens: 100, completionTokens: 50 });
    expect(budget.spentCredits()).toBe(60);
    expect(budget.maxTokensFor(300)).toBe(before - 60);
  });

  test("usage is cumulative for the reply: a later report replaces, not adds to, the earlier one", () => {
    const budget = createReplyBudget(500, rates);
    budget.observe({ promptTokens: 100, completionTokens: 50 });
    budget.observe({ promptTokens: 200, completionTokens: 80 });
    expect(budget.spentCredits()).toBe(100);
  });

  test("an unaffordable call is refused instead of sent with a nonpositive cap", () => {
    const budget = createReplyBudget(500, rates);
    expect(budget.limitFor(300)).not.toBeNull();
    budget.observe({ promptTokens: 0, completionTokens: 495 });
    // Five credits left, but the prompt alone costs more than that.
    expect(budget.limitFor(300)).toBeNull();
    expect(budget.maxTokensFor(300)).toBeLessThanOrEqual(0);
  });

  test("a prompt costing more than the whole allowance is unaffordable before any spend", () => {
    const budget = createReplyBudget(5, { ...rates, creditsPerKInput: 1000 });
    expect(budget.limitFor(30_000)).toBeNull();
  });

  test("exhausted once observed spend reaches the allowance", () => {
    const budget = createReplyBudget(500, rates);
    expect(budget.exhausted()).toBe(false);
    budget.observe({ promptTokens: 0, completionTokens: 499 });
    expect(budget.exhausted()).toBe(false);
    budget.observe({ promptTokens: 0, completionTokens: 500 });
    expect(budget.exhausted()).toBe(true);
  });

  test("the budget cap never raises an existing, tighter output cap", () => {
    const budget = createReplyBudget(5000, rates);
    expect(budget.limitFor(300, 1024)).toEqual({ maxTokens: 1024, capped: false });
  });

  test("a budget cap below the existing cap wins and is flagged so a length stop means the limit", () => {
    const budget = createReplyBudget(600, rates);
    const limit = budget.limitFor(300, 1024);
    expect(limit?.capped).toBe(true);
    expect(limit?.maxTokens).toBeLessThan(600);
  });

  test("a call with no existing cap gets the budget cap and is flagged", () => {
    const limit = createReplyBudget(600, rates).limitFor(300);
    expect(limit?.capped).toBe(true);
    expect(limit?.maxTokens).toBeGreaterThan(0);
  });

  test("a model with no output price needs no output cap", () => {
    const budget = createReplyBudget(500, { ...rates, creditsPerKOutput: 0 });
    expect(budget.limitFor(300, 1024)).toEqual({ maxTokens: 1024, capped: false });
    expect(budget.limitFor(300)).toEqual({ maxTokens: undefined, capped: false });
  });
});
