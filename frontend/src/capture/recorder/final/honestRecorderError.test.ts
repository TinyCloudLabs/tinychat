import { describe, expect, test } from "bun:test";

import { HOME_COPY } from "../../home/homeCopy";
import { FINALIZATION_PENDING } from "../recorderCopy";
import {
  initialRecorderState,
  recorderReducer,
  type RecorderCaptureIssue,
  type RecorderState,
} from "../recorderReducer";
import { honestRecorderError } from "./honestRecorderError";

const failed: RecorderCaptureIssue = {
  kind: "recoveryFailed",
  detail: "ENOSPC /var/mobile/secret.m4a",
};
const writeFailed: RecorderCaptureIssue = { kind: "write_failed", detail: "EIO" };
const timedOut: RecorderCaptureIssue = { kind: "finalization_timed_out" };

const line = (state: Partial<RecorderState>) =>
  honestRecorderError({ error: null, captureIssues: {}, finalizationPendingId: null, ...state });

describe("honestRecorderError", () => {
  test("no error stays none", () => {
    expect(line({ captureIssues: { a: failed }, finalizationPendingId: "a" })).toBeNull();
  });

  test("pending with no issue stays the finishing promise", () => {
    expect(line({ error: FINALIZATION_PENDING, finalizationPendingId: "a" })).toBe(FINALIZATION_PENDING);
  });

  test("pending with a timed-out issue keeps the promise", () => {
    expect(line({ error: FINALIZATION_PENDING, finalizationPendingId: "a", captureIssues: { a: timedOut } })).toBe(FINALIZATION_PENDING);
  });

  test("recoveryFailed on the pending recording", () => {
    expect(line({ error: FINALIZATION_PENDING, finalizationPendingId: "a", captureIssues: { a: failed } }))
      .toBe("Couldn't recover this recording. Exo will try again when it next opens.");
  });

  test("write_failed on the pending recording", () => {
    expect(line({ error: FINALIZATION_PENDING, finalizationPendingId: "a", captureIssues: { a: writeFailed } }))
      .toBe(HOME_COPY.writeFailedError);
  });

  test("another recording's failure does not change this one's line", () => {
    expect(line({ error: FINALIZATION_PENDING, finalizationPendingId: "a", captureIssues: { z: failed } })).toBe(FINALIZATION_PENDING);
  });

  test("a pending line with no pending id is never rewritten", () => {
    expect(line({ error: FINALIZATION_PENDING, captureIssues: { a: failed } })).toBe(FINALIZATION_PENDING);
  });

  test("a different error is left alone, whatever the issues", () => {
    expect(line({ error: "Could not stop: boom", finalizationPendingId: "a", captureIssues: { a: failed } })).toBe("Could not stop: boom");
  });

  test("a last-saved recording's failure does not rewrite another recording's pending line", () => {
    expect(line({
      error: FINALIZATION_PENDING,
      finalizationPendingId: "a",
      lastSaved: { id: "c", durationMs: 1, at: 0 },
      captureIssues: { c: failed },
    })).toBe(FINALIZATION_PENDING);
  });

  test("never renders an issue's detail", () => {
    const text = line({ error: FINALIZATION_PENDING, finalizationPendingId: "a", captureIssues: { a: failed } });
    expect(text).not.toContain("ENOSPC");
    expect(text).not.toContain("secret");
  });

  test("a failed recording never reads 'will finish it automatically'", () => {
    for (const issue of [failed, writeFailed]) {
      expect(line({ error: FINALIZATION_PENDING, finalizationPendingId: "a", captureIssues: { a: issue } })).not.toContain("automatically");
    }
  });
});

describe("through the reducer", () => {
  const live = (): RecorderState => recorderReducer(
    recorderReducer(initialRecorderState, { type: "START_REQUESTED" }),
    { type: "STARTED", id: "rec-1", startedAt: 1, maxDurationMs: 3_600_000, elapsedAt: 0 },
  );

  for (const [issue, expected] of [
    [failed, HOME_COPY.recoveryFailedError],
    [writeFailed, HOME_COPY.writeFailedError],
  ] as const) {
    test(`stop timeout, then the recorder goes idle, then ${issue.kind}: the line is honest`, () => {
      const stopping = recorderReducer(live(), { type: "STOP_REQUESTED", at: 0 });
      const idle = recorderReducer(stopping, { type: "STOP_FAILED", status: "idle", error: FINALIZATION_PENDING, id: "rec-1" });
      expect(idle.recordingId).toBeNull();
      expect(honestRecorderError(idle)).toBe(FINALIZATION_PENDING);
      expect(honestRecorderError(recorderReducer(idle, { type: "CAPTURE_ISSUE", id: "rec-1", issue }))).toBe(expected);
    });
  }
});
