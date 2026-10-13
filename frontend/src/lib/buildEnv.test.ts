// TC-840 review: an exported-but-empty commit variable must not shadow the
// fallbacks — `VITE_EXO_BUILD_COMMIT=""` with a real GITHUB_SHA or git
// checkout behind it should still land the sha on the build line.
import { describe, expect, test } from "bun:test";

import { firstNonEmpty } from "./buildEnv";

describe("firstNonEmpty", () => {
  test("an empty higher-priority value does not block the fallback", () => {
    expect(firstNonEmpty("", "abc1234")).toBe("abc1234");
    expect(firstNonEmpty("   ", "abc1234")).toBe("abc1234");
    expect(firstNonEmpty(undefined, "", "abc1234", "ignored")).toBe("abc1234");
  });

  test("the first real value wins, and is trimmed", () => {
    expect(firstNonEmpty("  sha-one  ", "sha-two")).toBe("sha-one");
    expect(firstNonEmpty("a", "b", "c")).toBe("a");
  });

  test("nothing to say: undefined, not an empty string", () => {
    expect(firstNonEmpty()).toBeUndefined();
    expect(firstNonEmpty(undefined, "", "   ")).toBeUndefined();
  });
});
