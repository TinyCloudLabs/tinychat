import { expect, test } from "bun:test";
import { validateMeetingPlan } from "../transcripts/meeting-turn.js";

const context = { localDate: "2026-09-09", timeZone: "Europe/Lisbon" };
test("last week resolves Monday to Sunday from the supplied local calendar", () => {
  const result = validateMeetingPlan({ kind: "meeting_content", scope: "range", purpose: "summary", evidenceRequirement: "overview", relativeDate: "last_week" }, context);
  expect(result.ok).toBe(true);
  if (result.ok && result.plan.kind === "meeting_content") {
    expect(result.plan.filters).toMatchObject({ from: "2026-08-31", to: "2026-09-06" });
    expect(result.plan.timeZone).toBe("Europe/Lisbon");
  }
});
test("invalid calendar dates, zones and conflicting scopes never widen discovery", () => {
  for (const extra of [{ from: "2026-02-30" }, { from: "2026-10-01", to: "2026-09-01" }, { timeZone: "Not/AZone" }, { meetingRef: "[M1]" }, { scope: "selected", title: "Design" }, { scope: "exact", meetingRef: "abc", from: "2026-09-01" }]) {
    expect(validateMeetingPlan({ kind: "meeting_metadata", scope: "range", ...extra }, context).ok).toBe(false);
  }
});
test("relative dates require valid local context and explicit dates take precedence", () => {
  expect(validateMeetingPlan({ kind: "meeting_metadata", scope: "range", relativeDate: "last_week" }).ok).toBe(false);
  const result = validateMeetingPlan({ kind: "meeting_metadata", scope: "range", relativeDate: "last_week", from: "2026-01-01", to: "2026-01-03" }, context);
  expect(result.ok && result.plan.kind === "meeting_metadata" && result.plan.filters).toMatchObject({ from: "2026-01-01", to: "2026-01-03" });
});
test("purpose constraints and typed inline booleans are validated", () => {
  expect(validateMeetingPlan({ kind: "meeting_content", scope: "selected", purpose: "speaker", evidenceRequirement: "body" }, context).ok).toBe(false);
  expect(validateMeetingPlan({ kind: "meeting_content", scope: "selected", purpose: "topic", evidenceRequirement: "body" }, context).ok).toBe(false);
  expect(validateMeetingPlan({ kind: "meeting_metadata", scope: "single", selectFirst: "false" }, context, true).ok).toBe(true);
  expect(validateMeetingPlan({ kind: "meeting_metadata", scope: "single", selectFirst: "yes" }, context, true).ok).toBe(false);
  expect(validateMeetingPlan({ kind: "general", purpose: "summary" }, context).ok).toBe(false);
});
