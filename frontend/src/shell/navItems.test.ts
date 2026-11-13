import { describe, expect, test } from "bun:test";
import { navItems } from "./navItems";
import { HOME_DESTINATION, HOME_PATH } from "./routes";

describe("navigation", () => {
  test("leads with Home (the feed), then Chat, Apps, Recording, Connectors", () => {
    const items = navItems(0);
    expect(items.map((item) => [item.id, item.label])).toEqual([
      ["feed", "One Feed"],
      ["chat", "Chat"],
      ["apps", "Apps"],
      ["capture", "Recording"],
      ["connectors", "Connectors"],
    ]);
    expect(items[0]!.href).toBe("/chat/feed");
  });

  test("keeps the Connectors badge", () => {
    expect(navItems(3).find((item) => item.id === "connectors")!.badge).toBe(3);
  });
});

describe("where Home opens", () => {
  test("every build and platform is at home on the feed", () => {
    expect(HOME_DESTINATION).toBe("feed");
    expect(HOME_PATH).toBe("/chat/feed");
  });
});
