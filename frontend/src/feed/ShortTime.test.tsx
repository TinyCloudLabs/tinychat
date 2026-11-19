import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ShortTime, shortTime } from "./ShortTime";

// Local noon, so the same day in every time zone the tests run in.
const now = new Date(2026, 10, 12, 12, 0).getTime();
const at = (year: number, month: number, day: number, hour: number, minute: number) => new Date(year, month, day, hour, minute).toISOString();

test("today shows the time alone; another day adds the day; another year adds the year", () => {
  const today = shortTime(at(2026, 10, 12, 9, 2), now);
  expect(today).toBe(new Date(at(2026, 10, 12, 9, 2)).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }));
  expect(today).not.toMatch(/2026|Nov|11\//);
  const yesterday = shortTime(at(2026, 10, 11, 9, 2), now);
  expect(yesterday).toContain(today);
  expect(yesterday).toMatch(/11/);
  expect(yesterday).not.toContain("2026");
  expect(shortTime(at(2025, 10, 11, 9, 2), now)).toContain("2025");
  expect(shortTime("not a time", now)).toBe("not a time");
});

test("a short time keeps the exact moment for machines and the full date on hover", () => {
  const value = at(2026, 10, 11, 9, 2);
  const html = renderToStaticMarkup(<ShortTime at={value} />);
  expect(html).toContain(`dateTime="${value}"`);
  expect(html).toContain(`title="${new Date(value).toLocaleString()}"`);
  expect(html).toContain(`>${shortTime(value)}</time>`);
});
