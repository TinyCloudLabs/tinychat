import { describe, expect, it } from "bun:test";
import { pickExtractionModel } from "./extractionModel";

const PREFERRED = "deepseek/deepseek-v3.2";

describe("pickExtractionModel", () => {
  it("returns the preferred id (best effort) when the catalog has not loaded", () => {
    expect(pickExtractionModel(PREFERRED, undefined, "anything")).toEqual({
      model: PREFERRED,
      source: "catalog-empty",
    });
    expect(pickExtractionModel(PREFERRED, new Set(), "anything")).toEqual({
      model: PREFERRED,
      source: "catalog-empty",
    });
  });

  it("uses the preferred id when it is offered", () => {
    const offered = new Set([PREFERRED, "other/model"]);
    expect(pickExtractionModel(PREFERRED, offered, "other/model")).toEqual({
      model: PREFERRED,
      source: "preferred",
    });
  });

  it("falls back to the current chat model when the preferred id is not offered", () => {
    const offered = new Set(["chat/model", "first/offered"]);
    expect(pickExtractionModel(PREFERRED, offered, "chat/model")).toEqual({
      model: "chat/model",
      source: "chat",
    });
  });

  it("falls back to the first offered id when neither preferred nor chat model is offered", () => {
    const offered = new Set(["first/offered", "second/offered"]);
    expect(pickExtractionModel(PREFERRED, offered, "unoffered/chat")).toEqual({
      model: "first/offered",
      source: "first",
    });
  });

  it("falls back to the first offered id when there is no current chat model", () => {
    const offered = new Set(["first/offered", "second/offered"]);
    expect(pickExtractionModel(PREFERRED, offered, undefined)).toEqual({
      model: "first/offered",
      source: "first",
    });
    expect(pickExtractionModel(PREFERRED, offered, null)).toEqual({
      model: "first/offered",
      source: "first",
    });
  });

  it("INVARIANT: when the catalog is loaded, the chosen model is always offered (no 403)", () => {
    const offered = new Set(["a/model", "b/model", "c/model"]);
    for (const chat of [PREFERRED, "a/model", "unoffered/chat", undefined]) {
      const { model } = pickExtractionModel(PREFERRED, offered, chat);
      expect(offered.has(model)).toBe(true);
    }
  });
});
