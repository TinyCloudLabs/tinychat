import { describe, expect, test } from "bun:test";

import { compute, initSizeClass, isTextEntry } from "./sizeClass";

describe("compute", () => {
  test("width decides compact, medium and expanded", () => {
    expect(compute(390, 844)).toEqual({ size: "compact", land: false });
    expect(compute(767, 1024)).toEqual({ size: "compact", land: false });
    expect(compute(768, 1024)).toEqual({ size: "medium", land: false });
    expect(compute(820, 1180)).toEqual({ size: "medium", land: false });
    expect(compute(900, 600)).toEqual({ size: "medium", land: false });
    expect(compute(1023, 768)).toEqual({ size: "medium", land: false });
    expect(compute(1024, 768)).toEqual({ size: "expanded", land: false });
    expect(compute(1280, 800)).toEqual({ size: "expanded", land: false });
  });

  test("a short landscape window is compact and `land`, however wide", () => {
    expect(compute(844, 390)).toEqual({ size: "compact", land: true });
    expect(compute(1280, 420)).toEqual({ size: "compact", land: true });
    expect(compute(640, 400)).toEqual({ size: "compact", land: true });
    expect(compute(1024, 500)).toEqual({ size: "compact", land: true });
    expect(compute(1024, 501)).toEqual({ size: "expanded", land: false });
    // Square is not landscape.
    expect(compute(480, 480)).toEqual({ size: "compact", land: false });
  });
});

describe("isTextEntry", () => {
  test("text fields bring up the keyboard; toggles, buttons and files do not", () => {
    expect(isTextEntry({ tagName: "TEXTAREA" } as unknown as Element)).toBe(true);
    expect(isTextEntry({ tagName: "INPUT", type: "text" } as unknown as Element)).toBe(true);
    expect(isTextEntry({ tagName: "INPUT", type: "search" } as unknown as Element)).toBe(true);
    expect(isTextEntry({ tagName: "INPUT", type: "url" } as unknown as Element)).toBe(true);
    expect(isTextEntry({ tagName: "DIV", isContentEditable: true } as unknown as Element)).toBe(true);
    for (const type of ["checkbox", "radio", "file", "button", "submit", "range"]) {
      expect(isTextEntry({ tagName: "INPUT", type } as unknown as Element)).toBe(false);
    }
    expect(isTextEntry({ tagName: "BUTTON" } as unknown as Element)).toBe(false);
    expect(isTextEntry({ tagName: "DIV", isContentEditable: false } as unknown as Element)).toBe(false);
    expect(isTextEntry(null)).toBe(false);
  });
});

/** A window whose size and focus a test drives. */
function fakeWindow(width: number, height: number, options: { coarse: boolean }) {
  const attributes = new Map<string, string>();
  const document = Object.assign(new EventTarget(), {
    activeElement: null as unknown,
    documentElement: {
      setAttribute: (name: string, value: string) => void attributes.set(name, value),
      removeAttribute: (name: string) => void attributes.delete(name),
    },
  });
  const window = Object.assign(new EventTarget(), {
    document,
    innerWidth: width,
    innerHeight: height,
    matchMedia: (query: string) => ({ matches: query === "(pointer: coarse)" && options.coarse }),
  });
  const field = { tagName: "INPUT", type: "text" };
  return {
    window: window as unknown as Window,
    published: () => ({ size: attributes.get("data-size"), land: attributes.has("data-land") }),
    resize(w: number, h: number) {
      window.innerWidth = w;
      window.innerHeight = h;
      window.dispatchEvent(new Event("resize"));
    },
    focusField() {
      document.activeElement = field;
    },
    blur(relatedTarget: unknown = null) {
      const from = document.activeElement;
      document.activeElement = null;
      const event = new Event("focusout");
      Object.defineProperty(event, "target", { value: from });
      Object.defineProperty(event, "relatedTarget", { value: relatedTarget });
      document.dispatchEvent(event);
      document.activeElement = relatedTarget;
    },
  };
}

describe("the keyboard latch", () => {
  test("on touch, typing keeps the class while the keyboard shrinks the window", () => {
    const tablet = fakeWindow(1280, 800, { coarse: true });
    const stop = initSizeClass(tablet.window);
    expect(tablet.published()).toEqual({ size: "expanded", land: false });
    tablet.focusField();
    tablet.resize(1280, 420); // the keyboard
    expect(tablet.published()).toEqual({ size: "expanded", land: false });
    stop();
  });

  test("with a mouse there is no latch", () => {
    const desktop = fakeWindow(1280, 800, { coarse: false });
    const stop = initSizeClass(desktop.window);
    desktop.focusField();
    desktop.resize(1280, 420);
    expect(desktop.published()).toEqual({ size: "compact", land: true });
    stop();
  });

  test("a toggle or a button with focus does not latch", () => {
    const tablet = fakeWindow(1280, 800, { coarse: true });
    const stop = initSizeClass(tablet.window);
    tablet.blur({ tagName: "INPUT", type: "checkbox" });
    tablet.resize(1280, 420);
    expect(tablet.published()).toEqual({ size: "compact", land: true });
    stop();
  });

  test("rotation changes the width, so it re-evaluates even while typing", () => {
    const tablet = fakeWindow(1180, 820, { coarse: true });
    const stop = initSizeClass(tablet.window);
    expect(tablet.published()).toEqual({ size: "expanded", land: false });
    tablet.focusField();
    tablet.resize(820, 1180);
    expect(tablet.published()).toEqual({ size: "medium", land: false });
    stop();
  });

  test("leaving the field re-evaluates once the keyboard has gone, without a flip on the way", () => {
    const tablet = fakeWindow(1280, 800, { coarse: true });
    const stop = initSizeClass(tablet.window);
    tablet.focusField();
    tablet.resize(1280, 420);
    tablet.blur();
    // The keyboard is still going down: no compact flash.
    expect(tablet.published()).toEqual({ size: "expanded", land: false });
    tablet.resize(1280, 800);
    expect(tablet.published()).toEqual({ size: "expanded", land: false });
    stop();
  });

  test("leaving the field applies a change that happened while typing", () => {
    // A short window that grew while a field had focus (a split-screen resize).
    const phone = fakeWindow(900, 450, { coarse: true });
    const stop = initSizeClass(phone.window);
    expect(phone.published()).toEqual({ size: "compact", land: true });
    phone.focusField();
    phone.resize(900, 700);
    expect(phone.published()).toEqual({ size: "compact", land: true });
    phone.blur();
    expect(phone.published()).toEqual({ size: "medium", land: false });
    stop();
  });

  test("moving focus to another field keeps the latch", () => {
    const tablet = fakeWindow(1280, 800, { coarse: true });
    const stop = initSizeClass(tablet.window);
    tablet.focusField();
    tablet.resize(1280, 420);
    tablet.blur({ tagName: "TEXTAREA" });
    tablet.resize(1280, 400);
    expect(tablet.published()).toEqual({ size: "expanded", land: false });
    stop();
  });
});
