import { describe, expect, test } from "bun:test";
import { DEFAULT_CHAT_MODEL, OFFERED_CHAT_MODELS } from "@tinyboilerplate/core";
import { healPersistedModel, sanitizeModel } from "./sanitizeModel";

describe("static offered-model sanitization", () => {
  test("accepts all six exact ids before and after pricing loads", () => {
    const pricingIds = new Set(["pricing/does-not-control-eligibility"]);
    expect(OFFERED_CHAT_MODELS).toHaveLength(6);
    for (const { id } of OFFERED_CHAT_MODELS) {
      expect(sanitizeModel(id, new Set())).toBe(id);
      expect(sanitizeModel(id, pricingIds)).toBe(id);
    }
  });

  test("corrects empty, missing, retired and merely TEE-capable ids to the first ladder id", () => {
    for (const saved of [null, undefined, "", "deepseek/deepseek-v4-flash", "phala/gpt-oss-120b"]) {
      expect(sanitizeModel(saved, new Set())).toBe(DEFAULT_CHAT_MODEL);
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
