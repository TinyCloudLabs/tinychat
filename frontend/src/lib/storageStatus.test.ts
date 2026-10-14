import { afterEach, describe, expect, test } from "bun:test";
import {
  isFreeStoragePlan,
  isStorageFullError,
  reportStoragePlanTier,
  STORAGE_FULL_DETAIL,
  STORAGE_FULL_RECORDING_LINE,
  STORAGE_FULL_SAVE_MESSAGE,
  STORAGE_TOO_LARGE_SAVE_MESSAGE,
  storageSaveMessage,
  subscribeStoragePlan,
} from "./storageStatus";

afterEach(() => reportStoragePlanTier(null));

const STORAGE_COPY = [
  STORAGE_FULL_SAVE_MESSAGE,
  STORAGE_TOO_LARGE_SAVE_MESSAGE,
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

describe("storage-full error variants", () => {
  test.each<[string, unknown]>([
    ["object with a code", { code: "STORAGE_QUOTA_EXCEEDED", message: "full" }],
    ["object whose cause carries the code", { message: "write failed", cause: { code: "STORAGE_QUOTA_EXCEEDED" } }],
    ["string", "STORAGE_QUOTA_EXCEEDED: full"],
    ["message-only error with the code", new Error("STORAGE_QUOTA_EXCEEDED: full")],
    ["message-only error with the phrase", new Error("storage quota exceeded")],
    ["wrapped error", new Error("save failed", { cause: new Error("STORAGE_QUOTA_EXCEEDED") })],
  ])("%s is storage full and normalizes to the approved full copy", (_label, error) => {
    expect(isStorageFullError(error)).toBe(true);
    expect(storageSaveMessage(error)).toBe(STORAGE_FULL_SAVE_MESSAGE);
  });

  test.each<[string, unknown]>([
    ["limit-reached code", { code: "STORAGE_LIMIT_REACHED" }],
    ["wrapped too-large message", new Error("save failed", { cause: new Error("write exceeds remaining storage") })],
  ])("%s normalizes to the approved too-large copy", (_label, error) => {
    expect(isStorageFullError(error)).toBe(true);
    expect(storageSaveMessage(error)).toBe(STORAGE_TOO_LARGE_SAVE_MESSAGE);
  });

  test("unrelated failures are not storage full and get no storage copy", () => {
    const error = new Error("Load failed");
    expect(isStorageFullError(error)).toBe(false);
    expect(storageSaveMessage(error)).toBeNull();
    expect(storageSaveMessage({ code: "NETWORK_ERROR" })).toBeNull();
  });
});
