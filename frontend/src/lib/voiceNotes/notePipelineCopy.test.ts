import { describe, expect, test } from "bun:test";

import { PRIVATE_COPY } from "./notePipelineCopy";

describe("private transcription part progress copy", () => {
  test("unknown or zero totals stay indeterminate", () => {
    expect(PRIVATE_COPY.transcribing(null, null)).toBe("Transcribing…");
    expect(PRIVATE_COPY.transcribing(null, 5)).toBe("Transcribing…");
    expect(PRIVATE_COPY.transcribing(2, null)).toBe("Transcribing…");
    expect(PRIVATE_COPY.transcribing(0, 0)).toBe("Transcribing…");
  });

  test("labels zero and completed parts without claiming the whole transcript is done", () => {
    expect(PRIVATE_COPY.transcribing(0, 9)).toBe("Transcribing · 0 of 9 parts done");
    expect(PRIVATE_COPY.transcribing(9, 9)).toBe("Transcribing · 9 of 9 parts done");
  });

  test("completed part count stays monotonic when total grows", () => {
    const copy = [PRIVATE_COPY.transcribing(2, 5), PRIVATE_COPY.transcribing(4, 9)];
    const completed = copy.map((text) => Number(text.match(/Transcribing · (\d+) of/)?.[1]));
    expect(completed).toEqual([2, 4]);
    expect(completed[1]).toBeGreaterThanOrEqual(completed[0]!);
  });
});
