import { describe, expect, test } from "bun:test";

import { dayGroupLabel, detailWhen, formatClockDuration, formatSpokenDuration, groupByDay, rowWhen, timeOfDay } from "./formatters";

const NOW = new Date(2026, 9, 6, 9, 41);
const at = (day: number, hour = 14, year = 2026, month = 9) => new Date(year, month, day, hour, 0).toISOString();

describe("formatters", () => {
  test("durations as tabular clock times", () => {
    expect(formatClockDuration(42)).toBe("0:42");
    expect(formatClockDuration(31 * 60 + 20)).toBe("31:20");
    expect(formatClockDuration(3725)).toBe("1:02:05");
    expect(formatClockDuration(-3)).toBe("0:00");
  });

  test("durations in words for the detail", () => {
    expect(formatSpokenDuration(20)).toBe("under a minute");
    expect(formatSpokenDuration(31 * 60)).toBe("31 min");
    expect(formatSpokenDuration(62 * 60)).toBe("1 h 2 min");
    expect(formatSpokenDuration(120 * 60)).toBe("2 h");
  });

  test("day groups: Today, Yesterday, then the date (with the year only when it differs)", () => {
    expect(dayGroupLabel(at(6, 8), NOW)).toBe("Today");
    expect(dayGroupLabel(at(5, 23), NOW)).toBe("Yesterday");
    expect(dayGroupLabel(at(3), NOW)).toBe(new Date(at(3)).toLocaleDateString(undefined, { month: "short", day: "numeric" }));
    expect(dayGroupLabel(at(30, 14, 2025, 11), NOW)).toContain("2025");
    expect(dayGroupLabel(null, NOW)).toBe("No date");
    expect(dayGroupLabel("not a date", NOW)).toBe("No date");
  });

  test("a row's when: the time inside a group, the day and time outside one", () => {
    const iso = at(6, 8);
    expect(rowWhen(iso, NOW, true)).toBe(timeOfDay(new Date(iso)));
    expect(rowWhen(iso, NOW, false)).toBe(`Today ${timeOfDay(new Date(iso))}`);
    expect(rowWhen(at(5), NOW, false)).toStartWith("Yesterday ");
    expect(rowWhen(null, NOW, false)).toBeNull();
    expect(detailWhen(at(5))).toContain("2026");
  });

  test("groupByDay keeps the order and puts consecutive days together", () => {
    const items = [{ startedAt: at(6, 9) }, { startedAt: at(6, 8) }, { startedAt: at(5) }, { startedAt: null }];
    expect(groupByDay(items, NOW).map((g) => [g.label, g.items.length])).toEqual([
      ["Today", 2],
      ["Yesterday", 1],
      ["No date", 1],
    ]);
  });
});
