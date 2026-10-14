import { afterEach, describe, expect, test } from "bun:test";
import {
  isFreeStoragePlan,
  reportStoragePlanTier,
  STORAGE_FULL_SAVE_MESSAGE,
  STORAGE_READ_ONLY_NOTICE,
  STORAGE_TOO_LARGE_SAVE_MESSAGE,
  subscribeStoragePlan,
} from "./storageStatus";

afterEach(() => reportStoragePlanTier(null));

describe("storage-full copy", () => {
  test("never tells a user to free up space, delete items, or upgrade their plan", () => {
    const banned = /free up|delete|upgrade your plan/i;
    for (const copy of [STORAGE_FULL_SAVE_MESSAGE, STORAGE_TOO_LARGE_SAVE_MESSAGE, STORAGE_READ_ONLY_NOTICE]) {
      expect(copy).not.toMatch(banned);
    }
  });
});

describe("storage plan tier", () => {
  test("only a positively Free plan reads as Free; pro and unknown do not", () => {
    reportStoragePlanTier("free");
    expect(isFreeStoragePlan()).toBe(true);
    reportStoragePlanTier("pro");
    expect(isFreeStoragePlan()).toBe(false);
    reportStoragePlanTier("free");
    reportStoragePlanTier(null);
    expect(isFreeStoragePlan()).toBe(false);
  });

  test("subscribers hear a change to the Free flag, not repeats of the same value", () => {
    let calls = 0;
    const unsubscribe = subscribeStoragePlan(() => {
      calls += 1;
    });
    reportStoragePlanTier("free");
    reportStoragePlanTier("free");
    reportStoragePlanTier("pro");
    unsubscribe();
    reportStoragePlanTier("free");
    expect(calls).toBe(2);
  });
});
