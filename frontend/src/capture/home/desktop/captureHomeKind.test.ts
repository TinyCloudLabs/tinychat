import { describe, expect, test } from "bun:test";

import {
  captureHomeKind,
  desktopHomeCapabilities,
  layoutForNav,
} from "./captureHomeKind";

describe("which home Capture draws", () => {
  test("a compact width gets the phone's Soft home, a phone on its side included", () => {
    expect(captureHomeKind("compact")).toBe("phone");
  });

  test("medium and expanded widths get the desktop home", () => {
    for (const size of ["medium", "expanded"] as const)
      expect(captureHomeKind(size)).toBe("desktop");
  });

  test("the layout follows the navigation", () => {
    expect(layoutForNav("tabbar")).toBe("phone");
    expect(layoutForNav("rail")).toBe("rail");
    expect(layoutForNav("sidebar")).toBe("desktop");
  });
});

describe("what the desktop home offers per shell", () => {
  test("the desktop app: full settings, meeting sources, the on-this-Mac card", () => {
    for (const layout of ["rail", "desktop"] as const)
      expect(desktopHomeCapabilities("tauri", layout)).toEqual({
        settings: "app",
        connectMeetings: true,
        onThisMac: true,
      });
  });

  test("the web at a desktop layout: microphone-only settings, meeting sources, no card", () => {
    for (const layout of ["rail", "desktop"] as const)
      expect(desktopHomeCapabilities("web", layout)).toEqual({
        settings: "microphone-only",
        connectMeetings: true,
        onThisMac: false,
      });
  });

  test("the web at the phone layout: no settings, no meeting sources", () => {
    expect(desktopHomeCapabilities("web", "phone")).toEqual({
      settings: null,
      connectMeetings: false,
      onThisMac: false,
    });
  });
});
