import { describe, expect, test } from "bun:test";
import { autoMeetingTitle } from "./meetingTitle";

const OCT_9 = new Date(2026, 9, 9, 10, 30).getTime();
const title = (participantNames: unknown, startedAt: unknown = OCT_9) => autoMeetingTitle({ startedAt, participantNames });
const titleAt = (startedAt: unknown) => autoMeetingTitle({ startedAt, participantNames: ["Alice"] });

describe("autoMeetingTitle", () => {
  test("joins the date and real participant names, never a model or provider", () => {
    expect(title(["Alice Chen", "Bob"])).toBe("Oct 9 · Alice Chen, Bob");
  });

  test("returns null without a real name so the caller keeps its title", () => {
    expect(title([])).toBeNull();
    expect(title(undefined)).toBeNull();
    expect(title("Alice")).toBeNull();
    expect(title(["Me", "Them", "Speaker 2", "Speaker A", "Guest", "HOST", "Participant 3", "Unknown speaker", "   "])).toBeNull();
  });

  test("returns null without a usable start date", () => {
    expect(titleAt(undefined)).toBeNull();
    expect(titleAt("not a date")).toBeNull();
  });

  test("uses English month abbreviations and local day numbers, and accepts an ISO string", () => {
    expect(title(["Dana"], new Date(2026, 11, 31, 23).getTime())).toBe("Dec 31 · Dana");
    expect(title(["Dana"], new Date(2026, 0, 5, 9).toISOString())).toBe("Jan 5 · Dana");
  });

  test("drops generic labels, dedupes case-insensitively and keeps the first spelling", () => {
    expect(title(["Me", "Speaker 1", "Alice", "alice ", "ALICE", "Bob"])).toBe("Oct 9 · Alice, Bob");
  });

  test("shows at most three names and counts the rest", () => {
    expect(title(["A", "B", "C", "D", "E"])).toBe("Oct 9 · A, B, C +2");
  });

  test("truncates a long name and caps the whole title at 120 characters", () => {
    expect(title(["x".repeat(80)])).toBe(`Oct 9 · ${"x".repeat(39)}…`);
    const long = title(["a".repeat(40), "b".repeat(40), "c".repeat(40)]);
    expect(long!.length).toBe(120);
    expect(long!.endsWith("…")).toBe(true);
  });

  test("strips control characters and angle brackets, ignores non-string entries", () => {
    expect(title(["Ali\nce\u0007"])).toBe("Oct 9 · Ali ce");
    expect(title(["Dana <CEO>"])).toBe("Oct 9 · Dana CEO");
    expect(title([42, null, { name: "x" }, "Dana"])).toBe("Oct 9 · Dana");
  });

  test("drops email addresses and phone numbers, keeping the other names", () => {
    expect(title(["dana@example.com", "+1 (555) 123-4567", "555-1234", "Carol"])).toBe("Oct 9 · Carol");
  });
});
