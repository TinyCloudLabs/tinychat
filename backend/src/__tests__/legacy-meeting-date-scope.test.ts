import { expect, test } from "bun:test";
import { resolveLegacyMeetingDateScope } from "../transcripts/legacy-meeting-date-scope.js";

const context = { localDate: "2026-09-13", timeZone: "Europe/Lisbon" };

test("the current last-week request uses the preceding Monday through Sunday", () => {
  expect(resolveLegacyMeetingDateScope("Summarize my meetings with Hunter last week.", context))
    .toEqual({ from: "2026-08-31", to: "2026-09-06", timeZone: "Europe/Lisbon" });
});

test.each([
  ["2026-09-14", "Europe/Lisbon", "2026-09-07", "2026-09-13"],
  ["2026-01-01", "Europe/Lisbon", "2025-12-22", "2025-12-28"],
  ["2026-01-05", "Europe/Lisbon", "2025-12-29", "2026-01-04"],
  ["2026-03-30", "Europe/Lisbon", "2026-03-23", "2026-03-29"],
  ["2026-10-26", "Europe/Lisbon", "2026-10-19", "2026-10-25"],
])("uses the supplied calendar on %s in %s", (localDate, timeZone, from, to) => {
  expect(resolveLegacyMeetingDateScope("Summarize my meetings last week.", { localDate, timeZone }))
    .toEqual({ from, to, timeZone });
});

test.each([
  "Summarize my meetings last week.",
  "Please recap the meetings from last week.",
  "Summarise our meetings with Hunter last week",
  "Summarize last week's meetings with Hunter.",
  "Recap last week’s meetings.",
  "summarize the last week meetings with Hunter",
  "Summarize my meetings last week with Hunter",
  "Summarize my meetings with Hunter and Dana last week.",
  "Summarize my meetings with O'Connor last week.",
])("accepts a simple complete summary request: %s", question => {
  expect(resolveLegacyMeetingDateScope(question, context))
    .toEqual({ from: "2026-08-31", to: "2026-09-06", timeZone: "Europe/Lisbon" });
});

test.each([
  "Summarize my meetings with Hunter from September 4 through September 10, 2026.",
  "Summarize my meetings from 2026-09-04 to 2026-09-10, last week.",
  "Summarize my meetings from September 4–10 last week.",
  "Summarize my meetings with Hunter September fourth last week.",
  "Summarize my meetings with Hunter since Monday last week.",
  "Summarize my meetings with Hunter last week and this week.",
  "Summarize my meetings with Hunter last week, through Tuesday.",
  "Summarize my meetings with Hunter last week and recap today.",
  "Summarize my meetings with Hunter about last week.",
  "Summarize my meetings about the phrase last week.",
  'Summarize my meetings titled "Last Week".',
  'Summarize my meetings with "Hunter" last week.',
  'Summarize my meetings "last week".',
  "Summarize my meetings 'last week'.",
  'Explain "Summarize my meetings with Hunter last week."',
  "\u0060Summarize my meetings with Hunter last week.\u0060",
  "Summarize what Hunter said last week in that meeting.",
  "Summarize the second meeting from last week.",
  "Summarize that meeting from last week.",
  "Summarize it from last week.",
  "Summarize my meetings with him last week.",
  "Summarize the meetings with Hunter excluding Dana last week.",
  "Summarize my meetings with Hunter last week with Dana.",
  "Summarize my meetings with Hunter last week. Then summarize this week.",
  "Find mentions of last week in my meetings.",
  "What happened in my meetings last week?",
  "Summarize my meetings.",
])("leaves explicit, ambiguous, quoted and unsupported wording unchanged: %s", question => {
  expect(resolveLegacyMeetingDateScope(question, context)).toBeUndefined();
});

test.each([
  undefined,
  { localDate: "2026-02-30", timeZone: "Europe/Lisbon" },
  { localDate: "not-a-date", timeZone: "Europe/Lisbon" },
  { localDate: "2026-09-14", timeZone: "Not/AZone" },
])("does not infer dates without valid trusted calendar context: %j", calendar => {
  expect(resolveLegacyMeetingDateScope("Summarize my meetings with Hunter last week.", calendar))
    .toBeUndefined();
});

test.each([
  "Summarize my meetings with Hunter not from last week.",
  "Summarize my meetings with Hunter not last week.",
  "Summarize my meetings with Hunter outside last week.",
  "Summarize my meetings with Hunter never last week.",
  "Summarize my meetings with Hunter without Dana last week.",
  "Summarize my meetings with Hunter only if Dana last week.",
  "Summarize my meetings with Hunter or Dana last week.",
])("does not override negated or conditional date scope: %s", question => {
  expect(resolveLegacyMeetingDateScope(question, context)).toBeUndefined();
});
