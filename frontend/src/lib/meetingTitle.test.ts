import { describe, expect, test } from "bun:test";
import { autoMeetingTitle } from "./meetingTitle";

const OCT_9 = new Date(2026, 9, 9, 10, 30).getTime();

describe("autoMeetingTitle", () => {
  test("joins date, model label and real participant names", () => {
    expect(autoMeetingTitle({ startedAt: OCT_9, modelLabel: "AssemblyAI Universal-2", participantNames: ["Alice Chen", "Bob"] }))
      .toBe("Oct 9 · AssemblyAI Universal-2 · Alice Chen, Bob");
  });

  test("omits the names part when there are no participants", () => {
    expect(autoMeetingTitle({ startedAt: OCT_9, modelLabel: "AssemblyAI Universal-2", participantNames: [] }))
      .toBe("Oct 9 · AssemblyAI Universal-2");
  });

  test("omits the model part when there is no model label", () => {
    expect(autoMeetingTitle({ startedAt: OCT_9, modelLabel: null, participantNames: ["Alice Chen"] }))
      .toBe("Oct 9 · Alice Chen");
  });

  test("is just the date when there is neither a model nor names", () => {
    expect(autoMeetingTitle({ startedAt: OCT_9, modelLabel: null, participantNames: undefined })).toBe("Oct 9");
  });

  test("uses English month abbreviations and local day numbers", () => {
    expect(autoMeetingTitle({ startedAt: new Date(2026, 11, 31, 23).getTime(), modelLabel: null, participantNames: [] }))
      .toBe("Dec 31");
  });

  test("returns null without a usable start date so the caller keeps its title", () => {
    expect(autoMeetingTitle({ startedAt: undefined, modelLabel: "AssemblyAI Universal-2", participantNames: ["Alice"] })).toBeNull();
    expect(autoMeetingTitle({ startedAt: "not a date", modelLabel: null, participantNames: [] })).toBeNull();
  });

  test("accepts an ISO start date string from the stored row", () => {
    const iso = new Date(2026, 0, 5, 9).toISOString();
    expect(autoMeetingTitle({ startedAt: iso, modelLabel: null, participantNames: [] })).toBe("Jan 5");
  });

  test("drops generic speaker labels and blanks", () => {
    expect(autoMeetingTitle({
      startedAt: OCT_9, modelLabel: null,
      participantNames: ["Me", "Them", "Speaker 2", "speaker 1", "Unknown", "   ", "Carol"],
    })).toBe("Oct 9 · Carol");
  });

  test("dedupes names case-insensitively, keeping the first spelling", () => {
    expect(autoMeetingTitle({ startedAt: OCT_9, modelLabel: null, participantNames: ["Alice", "alice ", "ALICE", "Bob"] }))
      .toBe("Oct 9 · Alice, Bob");
  });

  test("shows at most three names and counts the rest", () => {
    expect(autoMeetingTitle({ startedAt: OCT_9, modelLabel: null, participantNames: ["A", "B", "C", "D", "E"] }))
      .toBe("Oct 9 · A, B, C +2");
  });

  test("truncates a long single name with an ellipsis", () => {
    expect(autoMeetingTitle({ startedAt: OCT_9, modelLabel: null, participantNames: ["x".repeat(80)] }))
      .toBe(`Oct 9 · ${"x".repeat(39)}…`);
  });

  test("caps the whole title at 120 characters", () => {
    const title = autoMeetingTitle({ startedAt: OCT_9, modelLabel: "M".repeat(100), participantNames: ["N".repeat(40)] });
    expect(title).not.toBeNull();
    expect(title!.length).toBe(120);
    expect(title!.endsWith("…")).toBe(true);
    expect(title!.startsWith("Oct 9 · MMM")).toBe(true);
  });

  test("strips control characters and newlines from names", () => {
    expect(autoMeetingTitle({ startedAt: OCT_9, modelLabel: null, participantNames: ["Ali\nce\u0007"] }))
      .toBe("Oct 9 · Ali ce");
  });

  test("ignores non-string entries and non-array participant values", () => {
    expect(autoMeetingTitle({ startedAt: OCT_9, modelLabel: null, participantNames: [42, null, { name: "x" }, "Dana"] }))
      .toBe("Oct 9 · Dana");
    expect(autoMeetingTitle({ startedAt: OCT_9, modelLabel: null, participantNames: "Alice" })).toBe("Oct 9");
  });

  test("ignores a non-string model label", () => {
    expect(autoMeetingTitle({ startedAt: OCT_9, modelLabel: 42, participantNames: [] })).toBe("Oct 9");
  });
});
