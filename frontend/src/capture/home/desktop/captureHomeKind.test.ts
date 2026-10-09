import { describe, expect, test } from "bun:test";

import type { SizeClass } from "@/lib/sizeClass";
import type { NavKind } from "@/shell/navItems";
import {
  captureHomeKind,
  desktopHomeCapabilities,
  layoutForNav,
} from "./captureHomeKind";

const NAVS: NavKind[] = ["tabbar", "rail", "sidebar"];
const SIZES: SizeClass[] = ["compact", "medium", "expanded"];

describe("which home Capture draws", () => {
  test("flag off: today's home, whatever the shell or size", () => {
    for (const nav of NAVS)
      for (const size of SIZES)
        for (const available of [true, false])
          expect(captureHomeKind({ flag: false, available, nav, size })).toBe("classic");
  });

  test("flag on: the phone keeps the Soft home, with or without a recorder", () => {
    for (const available of [true, false])
      expect(captureHomeKind({ flag: true, available, nav: "tabbar", size: "compact" })).toBe("phone");
  });

  test("flag on: a rail or sidebar at medium width and up, with a recorder, gets the desktop home", () => {
    for (const nav of ["rail", "sidebar"] as const)
      for (const size of ["medium", "expanded"] as const)
        expect(captureHomeKind({ flag: true, available: true, nav, size })).toBe("desktop");
  });

  test("flag on: no recorder, or a short rail/sidebar or tablet tab bar, leaves today's home", () => {
    for (const nav of ["rail", "sidebar"] as const)
      for (const size of ["medium", "expanded"] as const)
        expect(captureHomeKind({ flag: true, available: false, nav, size })).toBe("classic");
    expect(captureHomeKind({ flag: true, available: true, nav: "rail", size: "compact" })).toBe("classic");
    expect(captureHomeKind({ flag: true, available: true, nav: "tabbar", size: "medium" })).toBe("classic");
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
