import { describe, expect, it } from "bun:test";
import { formatShareExpiry, unexpiredShares } from "./shareExpiry";

// Local-time dates in July: no DST change within 24 h of them, so day arithmetic is unambiguous in any zone.
const NOW = new Date(2026, 6, 14, 10, 0, 0).getTime();
const iso = (date: Date) => date.toISOString();

describe("formatShareExpiry", () => {
  it("says 'today at' for a link that expires later the same day", () => {
    expect(formatShareExpiry(iso(new Date(2026, 6, 14, 15, 30)), NOW, "en-US")).toMatch(/^Expires today at 3:30\s?PM$/);
  });

  it("says 'tomorrow at' for a link under 24 h away that expires on the next calendar day", () => {
    expect(formatShareExpiry(iso(new Date(2026, 6, 15, 9, 30)), NOW, "en-US")).toMatch(/^Expires tomorrow at 9:30\s?AM$/);
  });

  it("switches to the medium date at exactly 24 h", () => {
    const atBoundary = new Date(NOW + 24 * 60 * 60 * 1000);
    const justUnder = new Date(NOW + 24 * 60 * 60 * 1000 - 60_000);

    expect(formatShareExpiry(iso(justUnder), NOW, "en-US")).toMatch(/^Expires tomorrow at 9:59\s?AM$/);
    expect(formatShareExpiry(iso(atBoundary), NOW, "en-US")).toMatch(/^Expires Jul 15, 2026, 10:00\s?AM$/);
  });

  it("uses the medium date plus short time for a link further away", () => {
    expect(formatShareExpiry(iso(new Date(2026, 6, 30, 15, 0)), NOW, "en-US")).toMatch(/^Expires Jul 30, 2026, 3:00\s?PM$/);
  });

  it("follows the viewer's locale for the date and the time", () => {
    expect(formatShareExpiry(iso(new Date(2026, 6, 30, 15, 0)), NOW, "de-DE")).toBe("Expires 30.07.2026, 15:00");
    expect(formatShareExpiry(iso(new Date(2026, 6, 14, 15, 0)), NOW, "de-DE")).toBe("Expires today at 15:00");
  });

  it("falls back to the raw value when the expiry is unreadable", () => {
    expect(formatShareExpiry("not-a-date", NOW, "en-US")).toBe("Expires not-a-date");
  });
});

describe("unexpiredShares", () => {
  it("drops links that expire at or before now and keeps the rest in order", () => {
    const shares = [
      { id: "past", expiresAt: iso(new Date(NOW - 1)) },
      { id: "exactly-now", expiresAt: iso(new Date(NOW)) },
      { id: "later", expiresAt: iso(new Date(NOW + 1)) },
      { id: "much-later", expiresAt: iso(new Date(NOW + 86_400_000)) },
    ];

    expect(unexpiredShares(shares, NOW).map((share) => share.id)).toEqual(["later", "much-later"]);
  });

  it("returns nothing when every link has expired", () => {
    expect(unexpiredShares([{ expiresAt: iso(new Date(NOW - 1000)) }], NOW)).toEqual([]);
  });
});
