import { describe, expect, test } from "bun:test";

import { decideBack, type BackInput } from "./backDecision";
import { homeDestination, homePath, notePath, PATHS, screenFor } from "./routes";

const phoneApp = { homeDestination: homeDestination("android"), homePath: homePath("android") };
const web = { homeDestination: homeDestination("web"), homePath: homePath("web") };

function back(path: string, defaults: typeof phoneApp, rest: Partial<BackInput> = {}) {
  return decideBack({ overlay: false, screen: screenFor(path), size: "compact", historyIdx: 0, ...defaults, ...rest });
}

describe("Android Back on the phone app (home is Capture)", () => {
  test("Capture's root minimises, never exits", () => {
    expect(back(PATHS.capture, phoneApp)).toEqual({ kind: "minimize" });
    expect(back(PATHS.capture, phoneApp, { historyIdx: 3 })).toEqual({ kind: "minimize" });
  });

  test("Chat's and Connectors' roots go home to Capture", () => {
    expect(back(PATHS.chat, phoneApp)).toEqual({ kind: "navigate", to: "/chat/capture", replace: true });
    expect(back(PATHS.connectors, phoneApp)).toEqual({ kind: "navigate", to: "/chat/capture", replace: true });
  });
});

describe("Back with the web defaults (home is Chat)", () => {
  test("Chat's root minimises", () => {
    expect(back(PATHS.chat, web)).toEqual({ kind: "minimize" });
  });

  test("Capture's and Connectors' roots go home to Chat", () => {
    expect(back(PATHS.capture, web)).toEqual({ kind: "navigate", to: "/chat", replace: true });
    expect(back(PATHS.connectors, web)).toEqual({ kind: "navigate", to: "/chat", replace: true });
  });
});

describe("pushed screens", () => {
  for (const [name, defaults] of [["phone app", phoneApp], ["web", web]] as const) {
    test(`${name}: with history, Back steps back through it`, () => {
      expect(back(PATHS.library, defaults, { historyIdx: 2 })).toEqual({ kind: "history-back" });
      expect(back(PATHS.settings, defaults, { historyIdx: 1 })).toEqual({ kind: "history-back" });
      expect(back(notePath("n1"), defaults, { historyIdx: 1 })).toEqual({ kind: "history-back" });
    });

    test(`${name}: without history, Back goes up to the parent`, () => {
      expect(back(PATHS.library, defaults)).toEqual({ kind: "navigate", to: PATHS.capture, replace: true });
      expect(back(notePath("n1"), defaults)).toEqual({ kind: "navigate", to: PATHS.library, replace: true });
      // Settings belongs to no destination: up is home.
      expect(back(PATHS.settings, defaults)).toEqual({ kind: "navigate", to: defaults.homePath, replace: true });
    });
  }

  test("the Library is pushed at every size class for now", () => {
    for (const size of ["compact", "medium", "expanded"] as const) {
      expect(back(PATHS.library, phoneApp, { size })).toEqual({ kind: "navigate", to: PATHS.capture, replace: true });
    }
  });
});

describe("an open overlay", () => {
  test("closes first, on every screen and with any history", () => {
    for (const path of [PATHS.capture, PATHS.chat, PATHS.connectors, PATHS.library, PATHS.settings]) {
      expect(back(path, phoneApp, { overlay: true })).toEqual({ kind: "dismiss-overlay" });
      expect(back(path, web, { overlay: true, historyIdx: 4 })).toEqual({ kind: "dismiss-overlay" });
    }
  });
});
