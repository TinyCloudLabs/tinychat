import { describe, expect, it } from "bun:test";
import { OFFERED_CHAT_MODELS } from "@tinyboilerplate/core";
import { pickExtractionModel } from "./extractionModel";

describe("pickExtractionModel", () => {
  it("preserves every offered turn model exactly", () => {
    for (const { id } of OFFERED_CHAT_MODELS) expect(pickExtractionModel(id)).toBe(id);
  });

  it("rejects an unoffered model instead of falling back", () => {
    expect(() => pickExtractionModel("z-ai/glm-5.2-retired")).toThrow("not offered");
  });
});
