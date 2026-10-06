import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { NavigateFunction } from "react-router-dom";

import { goUp, noteLocation, resetNavigationMemory, tabTarget } from "./navigation";
import { PATHS } from "./routes";
import { keyboardIsUp } from "./useKeyboardOpen";

beforeEach(() => resetNavigationMemory());

describe("each tab reopens where it was left", () => {
  test("an unvisited destination opens at its root", () => {
    expect(tabTarget("capture", false)).toBe(PATHS.capture);
    expect(tabTarget("connectors", false)).toBe(PATHS.connectors);
  });

  test("the last address in a destination is remembered, until the tab is tapped again", () => {
    noteLocation(PATHS.capture, 0);
    noteLocation(PATHS.library, 1);
    noteLocation(PATHS.chat, 1);
    expect(tabTarget("capture", false)).toBe(PATHS.library);
    // The current tab tapped again pops to its root.
    expect(tabTarget("capture", true)).toBe(PATHS.capture);
    // Settings belongs to no destination: nothing is remembered for it.
    noteLocation(PATHS.settings, 2);
    expect(tabTarget("chat", false)).toBe(PATHS.chat);
  });
});

describe("a pushed screen's Back goes up", () => {
  const original = globalThis.history;
  let calls: unknown[][];
  const navigate = ((...args: unknown[]) => {
    calls.push(args);
  }) as unknown as NavigateFunction;
  const at = (idx: number) => {
    (globalThis as { history?: unknown }).history = { state: { idx } };
  };

  beforeEach(() => {
    calls = [];
  });
  afterEach(() => {
    (globalThis as { history?: unknown }).history = original;
  });

  test("through history when the entry before is the parent", () => {
    noteLocation(PATHS.capture, 0);
    noteLocation(PATHS.library, 1);
    at(1);
    goUp(navigate, PATHS.capture);
    expect(calls).toEqual([[-1]]);
  });

  test("straight up when the entry before is somewhere else (a tab switch pushed it)", () => {
    noteLocation(PATHS.chat, 0);
    noteLocation(PATHS.library, 1);
    at(1);
    goUp(navigate, PATHS.capture);
    expect(calls).toEqual([[PATHS.capture, { replace: true }]]);
  });

  test("straight up from a deep link with no history", () => {
    noteLocation(PATHS.library, 0);
    at(0);
    goUp(navigate, PATHS.capture);
    expect(calls).toEqual([[PATHS.capture, { replace: true }]]);
  });
});

describe("the keyboard", () => {
  test("is up only while typing with the visible height clearly short of the full height", () => {
    // iOS: the visual viewport shrinks under the keyboard.
    expect(keyboardIsUp({ typing: true, fullHeight: 844, visibleHeight: 508 })).toBe(true);
    // A field focused with no keyboard (an autofocus on load).
    expect(keyboardIsUp({ typing: true, fullHeight: 844, visibleHeight: 844 })).toBe(false);
    // A small resize (a browser bar) is not a keyboard.
    expect(keyboardIsUp({ typing: true, fullHeight: 844, visibleHeight: 760 })).toBe(false);
    // Not typing: never.
    expect(keyboardIsUp({ typing: false, fullHeight: 844, visibleHeight: 400 })).toBe(false);
  });
});

describe("remembered places never cross accounts", () => {
  test("forgetting them sends every tab back to its root", () => {
    noteLocation(PATHS.library, 3);
    resetNavigationMemory();
    expect(tabTarget("capture", false)).toBe(PATHS.capture);
  });

  test("App forgets them at both account boundaries, sign-in and sign-out", async () => {
    const app = await Bun.file(new URL("../App.tsx", import.meta.url)).text();
    const body = (name: string) => app.slice(app.indexOf(`const ${name} = useCallback(`), app.indexOf("}, [", app.indexOf(`const ${name} = useCallback(`)));
    expect(body("signIn")).toContain("resetNavigationMemory();");
    expect(body("signOut")).toContain("resetNavigationMemory();");
  });
});
