import { describe, expect, it } from "bun:test";
import { OFFERED_CHAT_MODELS } from "@tinyboilerplate/core";
import { pickExtractionModel } from "./extractionModel";

describe("pickExtractionModel", () => {
  it("preserves every offered turn model exactly", () => {
    for (const { id } of OFFERED_CHAT_MODELS) expect(pickExtractionModel(id)).toBe(id);
  });

  it("rejects retired and removed models instead of falling back", () => {
    for (const model of [
      "z-ai/glm-5.2-retired", "deepseek/deepseek-v4-flash-0731",
      "qwen/qwen3.6-27b", "google/gemma-4-31b-it",
    ]) {
      expect(() => pickExtractionModel(model)).toThrow("not offered");
    }
  });
});
