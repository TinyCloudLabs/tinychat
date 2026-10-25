// Back, scroll and navigation memory with Feed and Apps in the model (TC-2040).
import { beforeEach, describe, expect, test } from "bun:test";

import { decideBack } from "./backDecision";
import { navItems } from "./navItems";
import { noteLocation, resetNavigationMemory, tabTarget } from "./navigation";
import { homeDestination, homePath, PATHS, screenFor } from "./routes";

const web = { homeDestination: homeDestination("web"), homePath: homePath("web") };
const back = (path: string) => decideBack({ overlay: false, screen: screenFor(path), size: "compact", historyIdx: 0, ...web });

describe("navigation model", () => {
  test("Recording, Chat, Apps, Feed, then Connectors, each to its own root", () => {
    expect(navItems(0).map((item) => [item.label, item.href])).toEqual([
      ["Recording", PATHS.capture],
      ["Chat", PATHS.chat],
      ["Apps", PATHS.apps],
      ["Feed", PATHS.feed],
      ["Connectors", PATHS.connectors],
    ]);
  });

  test("Back from Feed or Apps returns to the home destination (Chat), never exits", () => {
    expect(back(PATHS.feed)).toEqual({ kind: "navigate", to: "/chat", replace: true });
    expect(back(PATHS.apps)).toEqual({ kind: "navigate", to: "/chat", replace: true });
    expect(back(PATHS.chat)).toEqual({ kind: "minimize" });
  });

  test("a tab remembers where it was left; tapping the current tab returns to its root", () => {
    resetNavigationMemory();
    noteLocation("/chat/feed/sub", 1);
    expect(tabTarget("feed", false)).toBe("/chat/feed/sub");
    expect(tabTarget("feed", true)).toBe(PATHS.feed);
    expect(tabTarget("apps", false)).toBe(PATHS.apps);
  });
  beforeEach(() => resetNavigationMemory());
});
