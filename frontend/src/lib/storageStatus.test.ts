import { afterEach, describe, expect, test } from "bun:test";
import {
  isFreeStoragePlan,
  reportStoragePlanTier,
  STORAGE_FULL_DETAIL,
  STORAGE_FULL_RECORDING_LINE,
  STORAGE_FULL_SAVE_MESSAGE,
  STORAGE_READ_ONLY_NOTICE,
  STORAGE_TOO_LARGE_SAVE_MESSAGE,
  subscribeStoragePlan,
} from "./storageStatus";

afterEach(() => reportStoragePlanTier(null));

const STORAGE_COPY = [
  STORAGE_FULL_SAVE_MESSAGE,
  STORAGE_TOO_LARGE_SAVE_MESSAGE,
  STORAGE_READ_ONLY_NOTICE,
  STORAGE_FULL_RECORDING_LINE,
  STORAGE_FULL_DETAIL.free,
  STORAGE_FULL_DETAIL.paid,
];

describe("storage-full copy", () => {
  test("never tells a user to free up space or make room, never says deleting does or does not lower usage", () => {
    const banned = [
      /free up/i,
      /make room/i,
      /upgrade your plan/i,
      /delet\w* (doesn't|does not|won't|will not|can't|cannot|never) (lower|reduce|free)/i,
      /delet\w* (always|will) (lower|reduce|free)/i,
    ];
    for (const copy of STORAGE_COPY) {
      for (const pattern of banned) expect(copy).not.toMatch(pattern);
    }
  });

  test("paid detail ends with the no-larger-plan line; free detail is the first sentence only", () => {
    expect(STORAGE_FULL_DETAIL.paid).toMatch(/There's no larger plan to buy\.$/);
    expect(STORAGE_FULL_DETAIL.free).toMatch(/TinyCloud\.$/);
    expect(STORAGE_FULL_DETAIL.free).not.toMatch(/larger plan/);
    expect(STORAGE_FULL_DETAIL.paid.startsWith(STORAGE_FULL_DETAIL.free)).toBe(true);
  });

  test("a plan not confirmed as Free gets the paid detail", () => {
    reportStoragePlanTier(null);
    expect(STORAGE_FULL_DETAIL[isFreeStoragePlan() ? "free" : "paid"]).toBe(STORAGE_FULL_DETAIL.paid);
    reportStoragePlanTier("free");
    expect(STORAGE_FULL_DETAIL[isFreeStoragePlan() ? "free" : "paid"]).toBe(STORAGE_FULL_DETAIL.free);
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
