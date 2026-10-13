import { describe, expect, test } from "bun:test";
import { markKeyboardOpened, trackModality } from "./inputModality";

describe("trackModality", () => {
  test("starts as pointer, follows the last key or pointer press, and stops on dispose", () => {
    const target = new EventTarget();
    const tracker = trackModality(target);
    expect(tracker.current()).toBe("pointer");
    target.dispatchEvent(new Event("keydown"));
    expect(tracker.current()).toBe("keyboard");
    target.dispatchEvent(new Event("pointerdown"));
    expect(tracker.current()).toBe("pointer");
    target.dispatchEvent(new Event("keydown"));
    tracker.dispose();
    target.dispatchEvent(new Event("pointerdown"));
    expect(tracker.current()).toBe("keyboard");
  });
});

describe("markKeyboardOpened", () => {
  const element = () => {
    const attributes = new Set<string>();
    return {
      attributes,
      setAttribute: (name: string) => void attributes.add(name),
    };
  };

  test("a dialog opened from the keyboard shows its focus ring at once", () => {
    const el = element();
    markKeyboardOpened(el, "keyboard");
    expect([...el.attributes]).toEqual(["data-kbd"]);
  });

  test("a dialog opened by pointer does not", () => {
    const el = element();
    markKeyboardOpened(el, "pointer");
    expect(el.attributes.size).toBe(0);
  });
});
