// Back, scroll and navigation memory with Feed and Apps in the model (TC-2040).
import { beforeEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

import { decideBack } from "./backDecision";
import { navItems } from "./navItems";
import { noteLocation, resetNavigationMemory, tabTarget } from "./navigation";
import { HOME_DESTINATION, HOME_PATH, PATHS, screenFor } from "./routes";
import { TabBar } from "./TabBar";

const back = (path: string) => decideBack({ overlay: false, screen: screenFor(path), size: "compact", historyIdx: 0, homeDestination: HOME_DESTINATION, homePath: HOME_PATH });

describe("navigation model", () => {
  test("Home (the feed), Chat, Apps, Recording, then Connectors, each to its own root", () => {
    expect(navItems(0).map((item) => [item.label, item.href])).toEqual([
      ["Home", PATHS.feed],
      ["Chat", PATHS.chat],
      ["Apps", PATHS.apps],
      ["Recording", PATHS.capture],
      ["Connectors", PATHS.connectors],
    ]);
  });

  test("Back from Apps or Chat returns to the home destination (Feed); Feed minimises, never exits", () => {
    expect(back(PATHS.apps)).toEqual({ kind: "navigate", to: "/chat/feed", replace: true });
    expect(back(PATHS.chat)).toEqual({ kind: "navigate", to: "/chat/feed", replace: true });
    expect(back(PATHS.feed)).toEqual({ kind: "minimize" });
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

describe("tab bar labels", () => {
  test("every label carries the 11 px cap, which keeps five tabs inside 320 px at 200% text", () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter initialEntries={[PATHS.chat]}>
        <TabBar items={navItems(0)} current="chat" replace={false} onReselect={() => {}} />
      </MemoryRouter>,
    );
    const labels = [...markup.matchAll(/<span class="([^"]*text-label[^"]*)"/g)].map((m) => m[1]!);
    expect(labels).toHaveLength(5);
    for (const classes of labels) expect(classes.split(" ")).toContain("!text-[11px]");
  });
});
