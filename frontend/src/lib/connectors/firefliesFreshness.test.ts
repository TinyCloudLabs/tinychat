import { describe, expect, test } from "bun:test";

import { FIREFLIES_STALE_AFTER_MS, isFirefliesStale } from "./firefliesFreshness";

describe("isFirefliesStale", () => {
  const now = Date.parse("2026-10-13T12:00:00.000Z");

  test("treats absent or invalid success time as stale", () => {
    expect(isFirefliesStale(null, now)).toBe(true);
    expect(isFirefliesStale("not-a-date", now)).toBe(true);
  });

  test("uses a strict 24-hour cutoff", () => {
    expect(FIREFLIES_STALE_AFTER_MS).toBe(24 * 60 * 60 * 1000);
    expect(isFirefliesStale(new Date(now - FIREFLIES_STALE_AFTER_MS).toISOString(), now)).toBe(false);
    expect(isFirefliesStale(new Date(now - FIREFLIES_STALE_AFTER_MS - 1).toISOString(), now)).toBe(true);
  });
});
