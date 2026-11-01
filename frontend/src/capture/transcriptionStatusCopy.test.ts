import { describe, expect, test } from "bun:test";
import type { ActivityJob } from "./activity/activitySelector";
import { secondsLeft, transcriptionStatus } from "./transcriptionStatusCopy";

const job = (patch: Partial<ActivityJob>): ActivityJob => ({ kind: "transcribe", state: "running", label: "Transcribe", destination: "this Mac", detail: "Transcribing on this Mac · 40%", ...patch });

describe("transcriptionStatus", () => {
  test("a running local job reports minutes done of the total, without repeating the percentage in the sentence", () => {
    const status = transcriptionStatus(job({ progress: 0.4 }), 56 * 60);
    expect(status.sentence).toBe("Transcribing on this Mac");
    expect(status.amount).toBe("22 of 56 min");
    expect(status.progress).toBe(0.4);
  });

  test("a job without a known length or a transcribing phase reports a percentage", () => {
    expect(transcriptionStatus(job({ progress: 0.4 }), null).amount).toBe("40%");
    expect(transcriptionStatus(job({ detail: "Sending to Private transcription · 40%", progress: 0.4 }), 3600).amount).toBe("40%");
  });

  test("a failed job offers its own action, or Try again for a retry-only job", () => {
    const run = () => {};
    expect(transcriptionStatus(job({ state: "needs-attention", detail: "Couldn’t transcribe on this Mac.", action: { label: "Transcribe now", run } }), 60).action?.label).toBe("Transcribe now");
    expect(transcriptionStatus(job({ state: "needs-attention", retry: run }), 60).action?.label).toBe("Try again");
    expect(transcriptionStatus(job({ state: "running" }), 60).action).toBeNull();
  });

  test("a waiting job has no progress amount", () => {
    expect(transcriptionStatus(job({ state: "waiting", detail: "Waiting to transcribe", progress: 0 }), 600).amount).toBeNull();
  });
});

describe("secondsLeft", () => {
  test("extends the rate measured between the first and latest samples", () => {
    expect(secondsLeft({ at: 0, progress: 0.1 }, { at: 60_000, progress: 0.3 })).toBe(210);
  });
  test("is unknown until the rate is measurable", () => {
    expect(secondsLeft({ at: 0, progress: 0.1 }, { at: 5_000, progress: 0.3 })).toBeNull();
    expect(secondsLeft({ at: 0, progress: 0.1 }, { at: 60_000, progress: 0.105 })).toBeNull();
  });
});
