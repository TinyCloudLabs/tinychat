import { describe, expect, test } from "bun:test";

import { STORAGE_FULL_TRANSCRIPT_LINE } from "../storageStatus";
import { LOCAL_COPY, PRIVATE_COPY } from "./notePipelineCopy";

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

describe("held transcript copy", () => {
  test("names the device holding the transcript and uses the transcript main line", () => {
    expect(LOCAL_COPY.transcriptStorageFull("mac")).toContain("this Mac");
    expect(LOCAL_COPY.transcriptStorageFull("iphone")).toContain("this iPhone");
    expect(LOCAL_COPY.transcriptStorageFull("browser")).toContain("this browser");
    for (const device of ["mac", "iphone", "browser"] as const) {
      expect(LOCAL_COPY.transcriptStorageFull(device)).toContain(STORAGE_FULL_TRANSCRIPT_LINE);
    }
  });
});
