import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { CatalogModel } from "../billing/catalog.js";
import {
  PEG_USD,
  _resetCreditsWarnings,
  creditsFor,
  estimateCredits,
  multiplierFor,
  niceCeil,
  ratesForModel,
} from "../billing/credits.js";

beforeEach(() => {
  _resetCreditsWarnings();
});

afterEach(() => {
  _resetCreditsWarnings();
});

describe("PEG_USD", () => {
  test("internal constant is 1e-4 (never serialized)", () => {
    expect(PEG_USD).toBe(1e-4);
  });
});

describe("niceCeil ladder snapping (spec §2.2)", () => {
  test("exact ladder values stay put", () => {
    // Sample several rungs spanning multiple decades.
    expect(niceCeil(0.5)).toBe(0.5);
    expect(niceCeil(1)).toBe(1);
    expect(niceCeil(1.5)).toBe(1.5);
    expect(niceCeil(2)).toBe(2);
    expect(niceCeil(2.5)).toBe(2.5);
    expect(niceCeil(3)).toBe(3);
    expect(niceCeil(4)).toBe(4);
    expect(niceCeil(5)).toBe(5);
    expect(niceCeil(6)).toBe(6);
    expect(niceCeil(8)).toBe(8);
    expect(niceCeil(10)).toBe(10);
    expect(niceCeil(20)).toBe(20);
    expect(niceCeil(150)).toBe(150);
    expect(niceCeil(800)).toBe(800);
    expect(niceCeil(1000)).toBe(1000);
  });

  test("between-ladder values snap UP to the next rung", () => {
    expect(niceCeil(0.45)).toBe(0.5);
    expect(niceCeil(1.1)).toBe(1.5);
    expect(niceCeil(2.6)).toBe(3);
    expect(niceCeil(7)).toBe(8);
    expect(niceCeil(9)).toBe(10);
    expect(niceCeil(11)).toBe(15);
    expect(niceCeil(21)).toBe(25);
    expect(niceCeil(750)).toBe(800); // the opus output example
    expect(niceCeil(801)).toBe(1000);
  });

  test("decade boundaries land on the higher decade's first rung", () => {
    // Just above a power of ten pushes into the next decade.
    expect(niceCeil(10.01)).toBe(15);
    expect(niceCeil(100.01)).toBe(150);
  });

  test("extends geometrically downward", () => {
    // The pattern continues below 1: 0.04, 0.05, 0.06, 0.08, 0.1, ...
    expect(niceCeil(0.05)).toBe(0.05);
    expect(niceCeil(0.04)).toBe(0.04);
    expect(niceCeil(0.045)).toBeCloseTo(0.05, 10);
  });

  test("extends geometrically upward", () => {
    expect(niceCeil(1500)).toBe(1500);
    expect(niceCeil(1600)).toBe(2000);
    expect(niceCeil(9000)).toBe(10000);
  });

  test("non-positive / non-finite inputs return 0", () => {
    expect(niceCeil(0)).toBe(0);
    expect(niceCeil(-1)).toBe(0);
    expect(niceCeil(Number.NaN)).toBe(0);
    expect(niceCeil(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("ratesForModel known fixtures (spec §2.2 table)", () => {
  test("openai/gpt-5-nano → 0.5 / 4", () => {
    const m: CatalogModel = {
      id: "openai/gpt-5-nano",
      pricing: { prompt: 0.00000005, completion: 0.0000004 },
    };
    expect(ratesForModel(m)).toEqual({
      creditsPerKInput: 0.5,
      creditsPerKOutput: 4,
      fallback: false,
    });
  });

  test("openai/gpt-5-mini → 2.5 / 20", () => {
    const m: CatalogModel = {
      id: "openai/gpt-5-mini",
      pricing: { prompt: 0.00000025, completion: 0.000002 },
    };
    expect(ratesForModel(m)).toEqual({
      creditsPerKInput: 2.5,
      creditsPerKOutput: 20,
      fallback: false,
    });
  });

  test("anthropic/claude-opus-4.1 → 150 / 800 (750 snaps up)", () => {
    const m: CatalogModel = {
      id: "anthropic/claude-opus-4.1",
      pricing: { prompt: 0.000015, completion: 0.000075 },
    };
    expect(ratesForModel(m)).toEqual({
      creditsPerKInput: 150,
      creditsPerKOutput: 800,
      fallback: false,
    });
  });
});

describe("ratesForModel fallback path (spec §2.5)", () => {
  test("missing pricing → 200/1000 + fallback flag + one console.warn per id", () => {
    const warn = mock(() => {});
    const original = console.warn;
    console.warn = warn as unknown as typeof console.warn;
    try {
      const m: CatalogModel = { id: "weird/unpriced", pricing: null };
      const a = ratesForModel(m);
      const b = ratesForModel(m);
      const c = ratesForModel(m);
      expect(a).toEqual({ creditsPerKInput: 200, creditsPerKOutput: 1000, fallback: true });
      expect(b).toEqual(a);
      expect(c).toEqual(a);
      expect(warn).toHaveBeenCalledTimes(1); // only the first call warns
    } finally {
      console.warn = original;
    }
  });

  test("different unpriced ids each warn exactly once", () => {
    const warn = mock(() => {});
    const original = console.warn;
    console.warn = warn as unknown as typeof console.warn;
    try {
      ratesForModel({ id: "alpha/unpriced", pricing: null });
      ratesForModel({ id: "beta/unpriced", pricing: null });
      ratesForModel({ id: "alpha/unpriced", pricing: null });
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      console.warn = original;
    }
  });
});

describe("creditsFor (spec §2.3)", () => {
  const miniRates = { creditsPerKInput: 2.5, creditsPerKOutput: 20, fallback: false };

  test("rounds UP via ceil", () => {
    // 100/1000 * 2.5 + 50/1000 * 20 = 0.25 + 1.0 = 1.25 → ceil = 2
    expect(creditsFor(miniRates, 100, 50)).toBe(2);
  });

  test("matches the opus fixture from §2.3", () => {
    const opus = { creditsPerKInput: 150, creditsPerKOutput: 800, fallback: false };
    // 1000 in + 500 out = 150 + 400 = 550
    expect(creditsFor(opus, 1000, 500)).toBe(550);
  });

  test("minimum 1 credit when any tokens were consumed", () => {
    // 1 prompt token on mini: 1/1000 * 2.5 = 0.0025 → ceil = 1
    expect(creditsFor(miniRates, 1, 0)).toBe(1);
    expect(creditsFor(miniRates, 0, 1)).toBe(1);
  });

  test("zero tokens on both sides → 0 credits (no usage = no charge)", () => {
    expect(creditsFor(miniRates, 0, 0)).toBe(0);
  });

  test("negative inputs are clamped to zero", () => {
    expect(creditsFor(miniRates, -10, -10)).toBe(0);
  });
});

describe("multiplierFor (spec §2.4)", () => {
  const baseline = { creditsPerKInput: 2.5, creditsPerKOutput: 20, fallback: false };

  test("baseline maps to 1×", () => {
    expect(multiplierFor(baseline, baseline)).toBe(1);
  });

  test("opus-class (800/20 = 40) snaps UP to 50×", () => {
    const opus = { creditsPerKInput: 150, creditsPerKOutput: 800, fallback: false };
    expect(multiplierFor(opus, baseline)).toBe(50);
  });

  test("intermediate ratios snap to the next badge", () => {
    expect(multiplierFor({ ...baseline, creditsPerKOutput: 30 }, baseline)).toBe(2); // 1.5 → 2
    expect(multiplierFor({ ...baseline, creditsPerKOutput: 60 }, baseline)).toBe(5); // 3 → 5
    expect(multiplierFor({ ...baseline, creditsPerKOutput: 200 }, baseline)).toBe(10);
    expect(multiplierFor({ ...baseline, creditsPerKOutput: 400 }, baseline)).toBe(25);
    expect(multiplierFor({ ...baseline, creditsPerKOutput: 1000 }, baseline)).toBe(50);
  });

  test("exact-rung ratios stay put", () => {
    expect(multiplierFor({ ...baseline, creditsPerKOutput: 40 }, baseline)).toBe(2);
    expect(multiplierFor({ ...baseline, creditsPerKOutput: 100 }, baseline)).toBe(5);
    expect(multiplierFor({ ...baseline, creditsPerKOutput: 500 }, baseline)).toBe(25);
  });

  test("ratios above 100× cap at 100", () => {
    expect(multiplierFor({ ...baseline, creditsPerKOutput: 5000 }, baseline)).toBe(100);
  });

  test("fallback-rated model pins to the top rung (spec §2.5: multiplier = 100)", () => {
    // 200/1000 vs 2.5/20 → ratio 50 by formula, but the fallback override
    // forces the conservative 100× badge.
    const fallback = { creditsPerKInput: 200, creditsPerKOutput: 1000, fallback: true };
    expect(multiplierFor(fallback, baseline)).toBe(100);
  });
});

describe("estimateCredits (chars/4 fallback)", () => {
  const miniRates = { creditsPerKInput: 2.5, creditsPerKOutput: 20, fallback: false };

  test("prices both sides through creditsFor", () => {
    // 4 chars prompt → 1 token; 8 chars completion → 2 tokens
    // 1/1000 * 2.5 + 2/1000 * 20 = 0.0025 + 0.04 = 0.0425 → ceil = 1 (min 1)
    expect(estimateCredits(miniRates, [{ content: "abcd" }], "abcdefgh")).toBe(1);
  });

  test("ignores non-string message content", () => {
    expect(estimateCredits(miniRates, [{ content: 42 as unknown as string }], "")).toBe(0);
  });

  test("larger payload scales through the formula", () => {
    // 4000 prompt chars → 1000 tokens; 4000 completion chars → 1000 tokens
    // 1000/1000 * 2.5 + 1000/1000 * 20 = 2.5 + 20 = 22.5 → ceil = 23
    const prompt = "a".repeat(4000);
    const completion = "b".repeat(4000);
    expect(estimateCredits(miniRates, [{ content: prompt }], completion)).toBe(23);
  });

  test("sums string content across multiple messages", () => {
    // total prompt: 8000 chars → 2000 tokens; completion: 0
    // 2000/1000 * 2.5 = 5
    const four_k = "a".repeat(4000);
    expect(estimateCredits(miniRates, [{ content: four_k }, { content: four_k }], "")).toBe(5);
  });
});
