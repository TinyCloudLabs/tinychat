import { describe, expect, test } from "bun:test";
import type { BackgroundUsage, ModelRates } from "./billingApi";

// billingApi transitively imports @tinyboilerplate/client, which evaluates the
// TinyCloud web-sdk at module load — and that references DOM globals. The pure
// credit math under test needs none of it, so stub the referenced globals
// BEFORE the (dynamic, so it runs after these assignments) import, letting this
// colocated test load standalone as well as inside the full `bun test` run.
const g = globalThis as unknown as Record<string, unknown>;
if (typeof g.HTMLElement === "undefined") g.HTMLElement = class {};
if (typeof g.customElements === "undefined") {
  g.customElements = { define() {}, get() {} };
}
if (typeof g.window === "undefined") g.window = g;

const { aggregateTurnCredits, creditsFor, splitCredits } = await import(
  "./billingApi"
);

// A representative rates row. Only creditsPerKInput/Output feed the math; the
// id/multiplier ride along to match the on-the-wire ModelRates shape.
function rates(over: Partial<ModelRates> = {}): ModelRates {
  return {
    id: "phala/model",
    creditsPerKInput: 3,
    creditsPerKOutput: 9,
    multiplier: 1,
    ...over,
  };
}

describe("splitCredits — the two footers always sum to the charged total", () => {
  // Rounding shapes chosen so the input share rounds up, down, and lands on a
  // boundary — the split must never leak a credit in any of them.
  const shapes: Array<{ name: string; prompt: number; completion: number; r: ModelRates }> = [
    { name: "even split", prompt: 1000, completion: 1000, r: rates() },
    { name: "input rounds up", prompt: 1500, completion: 200, r: rates() },
    { name: "input rounds down", prompt: 1100, completion: 900, r: rates() },
    { name: "tiny usage clamps to min-1", prompt: 5, completion: 5, r: rates() },
    { name: "output-heavy", prompt: 100, completion: 9000, r: rates() },
    { name: "input-heavy", prompt: 9000, completion: 100, r: rates() },
    { name: "fractional rates", prompt: 733, completion: 1287, r: rates({ creditsPerKInput: 1.7, creditsPerKOutput: 4.3 }) },
    { name: "zero output", prompt: 2000, completion: 0, r: rates() },
    { name: "zero input", prompt: 0, completion: 2000, r: rates() },
  ];

  for (const s of shapes) {
    test(`${s.name}: input + output === total`, () => {
      const { total, inputCredits, outputCredits } = splitCredits(s.r, s.prompt, s.completion);
      expect(inputCredits + outputCredits).toBe(total);
      // Both shares are non-negative and never exceed the total.
      expect(inputCredits).toBeGreaterThanOrEqual(0);
      expect(outputCredits).toBeGreaterThanOrEqual(0);
      expect(inputCredits).toBeLessThanOrEqual(total);
      // total is exactly the ledger's charge for that single call.
      expect(total).toBe(creditsFor(s.r, s.prompt, s.completion));
    });
  }
});

describe("aggregateTurnCredits — visible reply + background billed calls", () => {
  const r = rates(); // 3 in / 9 out per 1k tokens

  test("visible receipt + N background usages: total == sum of components == meter bump", () => {
    const visible = splitCredits(r, 1000, 1000).total; // 3 + 9 = 12
    const background: BackgroundUsage[] = [
      { rates: r, promptTokens: 2000, completionTokens: 500 }, // 6 + 4.5 → ceil 11
      { rates: rates({ creditsPerKInput: 1, creditsPerKOutput: 2 }), promptTokens: 1000, completionTokens: 1000 }, // 1 + 2 = 3
    ];
    const agg = aggregateTurnCredits(visible, background);

    // Components are each call's independent creditsFor.
    expect(agg.backgroundComponents).toEqual([
      creditsFor(background[0].rates, 2000, 500),
      creditsFor(background[1].rates, 1000, 1000),
    ]);
    // The invariant the badge + meter both rely on.
    const componentSum = agg.backgroundComponents.reduce((a, b) => a + b, 0);
    expect(agg.backgroundCredits).toBe(componentSum);
    expect(agg.total).toBe(agg.visibleCredits + agg.backgroundCredits);
    expect(agg.total).toBe(visible + componentSum);
    // The meter bump (what App.tsx adds to usage.used) is exactly the background sum.
    expect(agg.backgroundCredits).toBe(agg.total - visible);
  });

  test("zero-background turn: total == the visible badge, nothing extra bumped", () => {
    const visible = splitCredits(r, 1200, 800).total;
    const agg = aggregateTurnCredits(visible, []);
    expect(agg.total).toBe(visible);
    expect(agg.visibleCredits).toBe(visible);
    expect(agg.backgroundCredits).toBe(0);
    expect(agg.backgroundComponents).toEqual([]);
  });

  test("background usage with NO pending visible reply (compaction on load): total == background only", () => {
    const background: BackgroundUsage[] = [{ rates: r, promptTokens: 3000, completionTokens: 1000 }];
    const agg = aggregateTurnCredits(0, background);
    expect(agg.visibleCredits).toBe(0);
    expect(agg.total).toBe(agg.backgroundCredits);
    expect(agg.total).toBe(creditsFor(r, 3000, 1000));
  });

  test("0-token background usage is ignored (contributes 0, never a phantom min-1)", () => {
    const visible = 12;
    const background: BackgroundUsage[] = [
      { rates: r, promptTokens: 0, completionTokens: 0 }, // no tokens billed → 0
      { rates: r, promptTokens: 1000, completionTokens: 0 }, // 3
    ];
    const agg = aggregateTurnCredits(visible, background);
    expect(agg.backgroundComponents[0]).toBe(0);
    expect(agg.backgroundComponents[1]).toBe(creditsFor(r, 1000, 0));
    expect(agg.backgroundCredits).toBe(agg.backgroundComponents[1]);
    expect(agg.total).toBe(visible + agg.backgroundComponents[1]);
  });

  test("components always sum to the returned total (fuzzed shapes)", () => {
    const cases: Array<[number, BackgroundUsage[]]> = [
      [0, []],
      [1, [{ rates: r, promptTokens: 10, completionTokens: 10 }]],
      [50, [
        { rates: r, promptTokens: 4321, completionTokens: 987 },
        { rates: rates({ creditsPerKInput: 0.5, creditsPerKOutput: 7 }), promptTokens: 2222, completionTokens: 3333 },
        { rates: r, promptTokens: 0, completionTokens: 0 },
      ]],
    ];
    for (const [visible, bg] of cases) {
      const agg = aggregateTurnCredits(visible, bg);
      const sum = agg.visibleCredits + agg.backgroundComponents.reduce((a, b) => a + b, 0);
      expect(agg.total).toBe(sum);
    }
  });
});
