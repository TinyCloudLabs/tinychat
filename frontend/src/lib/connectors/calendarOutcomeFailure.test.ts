import { describe, expect, test } from "bun:test";
import { calendarOutcomeLabel, type CalendarFailureCode } from "./calendarAutojoinApi";

describe("TC-4461 failed calendar recording words", () => {
  const generic = "The notetaker could not complete this recording.";

  test("a failed outcome without a code keeps the general line", () => {
    expect(calendarOutcomeLabel("failed")).toBe(generic);
    expect(calendarOutcomeLabel("failed", "other")).toBe(generic);
    expect(calendarOutcomeLabel("failed", "not_a_code_this_app_knows")).toBe(generic);
  });

  test("each listed code reads as plain words with no code text", () => {
    const codes: CalendarFailureCode[] = ["invalid_meeting_url", "unsupported_platform", "meeting_not_found", "meeting_join_failed",
      "waiting_room_timeout", "bot_removed", "meeting_ended", "capture_failed", "transcription_failed", "provider_timeout",
      "provider_unavailable", "capacity_exhausted", "internal_error", "other"];
    for (const code of codes) {
      const label = calendarOutcomeLabel("failed", code);
      expect(label).not.toMatch(/_/);
      expect(label.endsWith(".")).toBe(true);
    }
    expect(new Set(["meeting_join_failed", "waiting_room_timeout", "bot_removed", "meeting_ended", "capture_failed", "transcription_failed"]
      .map(code => calendarOutcomeLabel("failed", code))).size).toBe(6);
  });

  test("a code never changes the line of another reason", () => {
    expect(calendarOutcomeLabel("missed", "bot_removed")).toBe(calendarOutcomeLabel("missed"));
    expect(calendarOutcomeLabel("capacity_exhausted", "bot_removed")).toBe(calendarOutcomeLabel("capacity_exhausted"));
  });
});
