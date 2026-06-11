import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("app verifier calls disable dstack deep mode", () => {
  test("model-level indicator calls verifyModel with deep: false", () => {
    const src = readFileSync(resolve(import.meta.dir, "useModelVerification.ts"), "utf8");
    expect(src).toContain("verifyModel({ model, deep: false })");
  });

  test("per-message badge calls verifyModel with deep: false on cache miss", () => {
    const src = readFileSync(resolve(import.meta.dir, "../chat/ModelVerificationBadge.tsx"), "utf8");
    expect(src).toContain("verifyModel({ model, deep: false })");
  });
});
