import { describe, expect, test } from "bun:test";
import { nextSilencedSince } from "./useSilencedSince";

describe("nextSilencedSince", () => {
  test("starts at the first silent observation", () => {
    expect(nextSilencedSince(null, true, 1000)).toBe(1000);
  });
  test("keeps the start while silence lasts", () => {
    expect(nextSilencedSince(1000, true, 9000)).toBe(1000);
  });
  test("resets when sound returns", () => {
    expect(nextSilencedSince(1000, false, 9000)).toBeNull();
    expect(nextSilencedSince(null, true, 12000)).toBe(12000);
  });
});
