import { expect, test } from "bun:test";

import { initialRecorderState, recorderReducer } from "./recorderReducer";
import { permissionDeniedAnnouncement, RECEIPT_ACTION_MS, RECEIPT_MAX_MS, RECEIPT_MS, receiptWindowMs } from "./RecorderProvider";

test("microphone denial announces once when permission changes to denied", () => {
  const denied = recorderReducer(initialRecorderState, { type: "PERMISSION_DENIED" });
  expect(permissionDeniedAnnouncement(initialRecorderState.permissionDenied, denied.permissionDenied))
    .toBe("Microphone access is off");
  expect(permissionDeniedAnnouncement(denied.permissionDenied, denied.permissionDenied)).toBeNull();
  const granted = recorderReducer(denied, { type: "PERMISSION_GRANTED" });
  expect(permissionDeniedAnnouncement(denied.permissionDenied, granted.permissionDenied)).toBeNull();
});

test("a receipt with something to press stays open at least 7 s, and never past the ceiling", () => {
  expect(receiptWindowMs(false)).toBe(RECEIPT_MS);
  expect(receiptWindowMs(true)).toBe(RECEIPT_ACTION_MS);
  expect(RECEIPT_ACTION_MS).toBeGreaterThanOrEqual(7_000);
  expect(RECEIPT_ACTION_MS).toBeLessThan(RECEIPT_MAX_MS);
});
