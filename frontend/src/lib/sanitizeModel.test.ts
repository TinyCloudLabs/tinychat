import { describe, expect, test } from "bun:test";
import { DEFAULT_CHAT_MODEL, OFFERED_CHAT_MODELS } from "@tinyboilerplate/core";
import { healPersistedModel, sanitizeModel } from "./sanitizeModel";

describe("static offered-model sanitization", () => {
  test("accepts the three remaining exact ids before and after pricing loads", () => {
    const pricingIds = new Set(["pricing/does-not-control-eligibility"]);
    expect(OFFERED_CHAT_MODELS).toHaveLength(3);
    for (const { id } of OFFERED_CHAT_MODELS) {
      expect(sanitizeModel(id, new Set())).toBe(id);
      expect(sanitizeModel(id, pricingIds)).toBe(id);
    }
  });

  test("corrects empty, missing, retired and removed ids to Kimi K3", () => {
    for (const saved of [
      null, undefined, "", "deepseek/deepseek-v4-flash", "phala/gpt-oss-120b",
      "deepseek/deepseek-v4-flash-0731", "qwen/qwen3.6-27b", "google/gemma-4-31b-it",
    ]) {
      expect(sanitizeModel(saved, new Set())).toBe("moonshotai/kimi-k3");
      if (saved) {
        expect(healPersistedModel(saved)).toEqual({ model: "moonshotai/kimi-k3", healed: true });
      }
    }
  });

  test("reports a correction only when a nonempty saved id changed", () => {
    expect(healPersistedModel("deepseek/deepseek-v4-flash")).toEqual({
      model: DEFAULT_CHAT_MODEL,
      healed: true,
    });
    expect(healPersistedModel(DEFAULT_CHAT_MODEL)).toEqual({
      model: DEFAULT_CHAT_MODEL,
      healed: false,
    });
  });
});
