import { describe, expect, test } from "bun:test";

import { decideBack, type BackInput } from "./backDecision";
import { HOME_DESTINATION, HOME_PATH, notePath, PATHS, screenFor } from "./routes";

const home = { homeDestination: HOME_DESTINATION, homePath: HOME_PATH };

function back(path: string, rest: Partial<BackInput> = {}) {
  return decideBack({ overlay: false, screen: screenFor(path), size: "compact", historyIdx: 0, ...home, ...rest });
}

describe("Back with home on Feed (every platform)", () => {
  test("Feed's root minimises, never exits", () => {
    expect(back(PATHS.feed)).toEqual({ kind: "minimize" });
    expect(back(PATHS.feed, { historyIdx: 3 })).toEqual({ kind: "minimize" });
  });

  test("Capture's, Chat's, Apps' and Connectors' roots go home to Feed", () => {
    for (const path of [PATHS.capture, PATHS.chat, PATHS.apps, PATHS.connectors]) {
      expect(back(path)).toEqual({ kind: "navigate", to: "/chat/feed", replace: true });
    }
  });
});

describe("pushed screens", () => {
  test("with history, Back steps back through it", () => {
    expect(back(PATHS.library, { historyIdx: 2 })).toEqual({ kind: "history-back" });
    expect(back(PATHS.settings, { historyIdx: 1 })).toEqual({ kind: "history-back" });
    expect(back(notePath("n1"), { historyIdx: 1 })).toEqual({ kind: "history-back" });
  });

  test("without history, Back goes up to the parent", () => {
    expect(back(PATHS.library)).toEqual({ kind: "navigate", to: PATHS.capture, replace: true });
    expect(back(notePath("n1"))).toEqual({ kind: "navigate", to: PATHS.library, replace: true });
    // Settings belongs to no destination: up is home.
    expect(back(PATHS.settings)).toEqual({ kind: "navigate", to: PATHS.feed, replace: true });
  });

  test("the Library is pushed at every size class for now", () => {
    for (const size of ["compact", "medium", "expanded"] as const) {
      expect(back(PATHS.library, { size })).toEqual({ kind: "navigate", to: PATHS.capture, replace: true });
    }
  });
});

describe("an open overlay", () => {
  test("closes first, on every screen and with any history", () => {
    for (const path of [PATHS.capture, PATHS.chat, PATHS.connectors, PATHS.library, PATHS.settings]) {
      expect(back(path, { overlay: true })).toEqual({ kind: "dismiss-overlay" });
      expect(back(path, { overlay: true, historyIdx: 4 })).toEqual({ kind: "dismiss-overlay" });
    }
  });
});
