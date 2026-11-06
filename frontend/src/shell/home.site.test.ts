import { describe, expect, test } from "bun:test";
import { navItems } from "./navItems";
import { homeDestination, homePath } from "./routes";

describe("navigation on the Home site", () => {
  test("leads with Home (the feed), then Chat and Apps; Recording and Connectors stay on tinycloud.chat", () => {
    const items = navItems(0, true);
    expect(items.map((item) => [item.id, item.label])).toEqual([
      ["feed", "Home"],
      ["chat", "Chat"],
      ["apps", "Apps"],
    ]);
    expect(items[0]!.href).toBe("/chat/feed");
  });

  test("keeps the existing order and the Feed label elsewhere", () => {
    expect(navItems(0, false).map((item) => item.label)).toEqual(["Recording", "Chat", "Apps", "Feed", "Connectors"]);
  });

  test("keeps the Connectors badge on the other builds", () => {
    expect(navItems(3, false).find((item) => item.id === "connectors")!.badge).toBe(3);
  });
});

describe("where the web opens", () => {
  test("the Home site opens on the feed; other web builds on Chat", () => {
    expect(homeDestination("web", true)).toBe("feed");
    expect(homePath("web", true)).toBe("/chat/feed");
    expect(homeDestination("web", false)).toBe("chat");
    expect(homePath("web", false)).toBe("/chat");
  });

  test("the phone app and the desktop app ignore the Home site", () => {
    expect(homeDestination("ios", true)).toBe("capture");
    expect(homeDestination("android", true)).toBe("capture");
    expect(homeDestination("tauri", true)).toBe("chat");
  });
});
