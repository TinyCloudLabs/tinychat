import { describe, expect, test } from "bun:test";

import { HOME_COPY } from "../../home/homeCopy";
import { FINALIZATION_PENDING } from "../recorderCopy";
import type {
  RecorderCaptureIssue,
  RecorderState,
} from "../recorderReducer";
import { honestRecorderError } from "./honestRecorderError";

const failed: RecorderCaptureIssue = {
  kind: "recoveryFailed",
  detail: "ENOSPC /var/mobile/secret.m4a",
};
const writeFailed: RecorderCaptureIssue = { kind: "write_failed", detail: "EIO" };
const timedOut: RecorderCaptureIssue = { kind: "finalization_timed_out" };

type Case = {
  name: string;
  state: Partial<RecorderState>;
  expected: string | null;
};

const cases: Case[] = [
  {
    name: "no error stays none",
    state: { error: null, captureIssues: { a: failed }, recordingId: "a" },
    expected: null,
  },
  {
    name: "pending with no issue stays the finishing promise",
    state: { error: FINALIZATION_PENDING, recordingId: "a" },
    expected: FINALIZATION_PENDING,
  },
  {
    name: "pending with a timed-out issue keeps the promise",
    state: {
      error: FINALIZATION_PENDING,
      recordingId: "a",
      captureIssues: { a: timedOut },
    },
    expected: FINALIZATION_PENDING,
  },
  {
    name: "recoveryFailed on the live recording",
    state: {
      error: FINALIZATION_PENDING,
      recordingId: "a",
      captureIssues: { a: failed },
    },
    expected: "Couldn't recover this recording. Exo will try again when it next opens.",
  },
  {
    name: "stop timeout: only recordingId names the recording (no lastSaved, no failedRecording)",
    state: {
      error: FINALIZATION_PENDING,
      recordingId: "a",
      lastSaved: null,
      failedRecording: null,
      captureIssues: { a: writeFailed },
    },
    expected: HOME_COPY.writeFailedError,
  },
  {
    name: "recoveryFailed on the failed recording",
    state: {
      error: FINALIZATION_PENDING,
      failedRecording: { id: "b", durationMs: 1 },
      captureIssues: { b: failed },
    },
    expected: HOME_COPY.recoveryFailedError,
  },
  {
    name: "recoveryFailed on the last saved recording",
    state: {
      error: FINALIZATION_PENDING,
      lastSaved: { id: "c", durationMs: 1, at: 0 },
      captureIssues: { c: failed },
    },
    expected: HOME_COPY.recoveryFailedError,
  },
  {
    name: "write_failed",
    state: {
      error: FINALIZATION_PENDING,
      recordingId: "a",
      captureIssues: { a: writeFailed },
    },
    expected: "Couldn't save all of this recording.",
  },
  {
    name: "another recording's failure does not change this one's line",
    state: {
      error: FINALIZATION_PENDING,
      recordingId: "a",
      captureIssues: { z: failed },
    },
    expected: FINALIZATION_PENDING,
  },
  {
    name: "a different error is left alone, whatever the issues",
    state: {
      error: "Could not stop: boom",
      recordingId: "a",
      captureIssues: { a: failed },
    },
    expected: "Could not stop: boom",
  },
];

describe("honestRecorderError", () => {
  for (const { name, state, expected } of cases) {
    test(name, () => {
      expect(
        honestRecorderError({
          error: null,
          lastSaved: null,
          captureIssues: {},
          ...state,
        }),
      ).toBe(expected);
    });
  }

  test("never renders an issue's detail", () => {
    const line = honestRecorderError({
      error: FINALIZATION_PENDING,
      lastSaved: null,
      recordingId: "a",
      captureIssues: { a: failed },
    });
    expect(line).not.toContain("ENOSPC");
    expect(line).not.toContain("secret");
  });

  test("a failed recording never reads 'will finish it automatically'", () => {
    for (const issue of [failed, writeFailed]) {
      expect(
        honestRecorderError({
          error: FINALIZATION_PENDING,
          lastSaved: null,
          recordingId: "a",
          captureIssues: { a: issue },
        }),
      ).not.toContain("automatically");
    }
  });
});
