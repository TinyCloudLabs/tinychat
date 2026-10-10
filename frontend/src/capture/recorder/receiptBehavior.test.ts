import { describe, expect, test } from "bun:test";

import { initialRecorderState, recorderReducer } from "./recorderReducer";
import { shouldScheduleReceiptDismissal } from "./receiptBehavior";

describe("automatic-stop receipt timing", () => {
  test("keeps an auto-stop receipt open while the moment field is focused, then allows dismissal after blur", () => {
    let state = recorderReducer(initialRecorderState, { type: "START_REQUESTED" });
    state = recorderReducer(state, {
      type: "STARTED", id: "recording-1", startedAt: 1, elapsedAt: 1, maxDurationMs: 100,
    });
    state = recorderReducer(state, {
      type: "AUTO_STOPPED", id: "recording-1", notice: "Stopped at the limit.", captured: true, at: 101,
    });
    state = recorderReducer(state, { type: "LOCAL_COMMITTED", id: "recording-1", durationMs: 100, at: 102 });

    expect(state.outcome).toBe("local");
    expect(state.limitNotice).toBe("Stopped at the limit.");
    expect(shouldScheduleReceiptDismissal(state, true)).toBe(false);
    expect(shouldScheduleReceiptDismissal(state, false)).toBe(true);
    expect(shouldScheduleReceiptDismissal({ limitNotice: null }, true)).toBe(true);
  });
});
