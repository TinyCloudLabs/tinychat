import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createWebScreenshotDetector, WEB_DETECT } from "./webDetector";

let dispose: (() => void) | null = null;
afterEach(() => { dispose?.(); dispose = null; });

function setup() {
  const win = new Window();
  let now = 10_000;
  const signals: string[] = [];
  dispose = createWebScreenshotDetector({
    target: win as unknown as Window & typeof globalThis,
    document: win.document as unknown as Document,
    now: () => now,
    onScreenshot: (id) => signals.push(id),
  });
  const key = (type: "keydown" | "keyup", init: { key: string; code?: string; metaKey?: boolean; shiftKey?: boolean; ctrlKey?: boolean }) =>
    win.dispatchEvent(new win.KeyboardEvent(type, init));
  const blur = () => win.dispatchEvent(new win.Event("blur"));
  const hide = () => {
    Object.defineProperty(win.document, "visibilityState", { configurable: true, get: () => "hidden" });
    win.document.dispatchEvent(new win.Event("visibilitychange"));
  };
  return { signals, key, blur, hide, advance: (ms: number) => { now += ms; } };
}

test("Print Screen is a screenshot (Windows and Linux deliver its keyup)", () => {
  const { signals, key } = setup();
  key("keyup", { key: "PrintScreen", code: "PrintScreen" });
  expect(signals).toHaveLength(1);
});

test("Cmd+Shift+3/4/5 is a screenshot when the browser sees it (macOS)", () => {
  const { signals, key } = setup();
  key("keydown", { key: "#", code: "Digit3", metaKey: true, shiftKey: true });
  expect(signals).toHaveLength(1);
});

test("Win/Cmd+Shift then the window loses focus at once is a snip (Win+Shift+S, Cmd+Shift+5)", () => {
  const { signals, key, blur } = setup();
  key("keydown", { key: "Meta", code: "MetaLeft", metaKey: true });
  key("keydown", { key: "Shift", code: "ShiftLeft", metaKey: true, shiftKey: true });
  blur();
  expect(signals).toHaveLength(1);
});

test("the same chord followed by the page going hidden also counts", () => {
  const { signals, key, hide } = setup();
  key("keydown", { key: "Shift", code: "ShiftLeft", shiftKey: true });
  key("keydown", { key: "Meta", code: "MetaLeft", metaKey: true, shiftKey: true });
  hide();
  expect(signals).toHaveLength(1);
});

test("not a screenshot: a blur long after the chord, a chord with another key in it, a blur with no chord, Ctrl+Shift", () => {
  const { signals, key, blur, advance } = setup();
  key("keydown", { key: "Meta", metaKey: true });
  key("keydown", { key: "Shift", metaKey: true, shiftKey: true });
  advance(WEB_DETECT.chordToBlurMs + 1);
  blur();
  key("keydown", { key: "Meta", metaKey: true });
  key("keydown", { key: "Shift", metaKey: true, shiftKey: true });
  key("keydown", { key: "ArrowLeft", code: "ArrowLeft", metaKey: true, shiftKey: true });
  blur();
  blur();
  key("keydown", { key: "Control", ctrlKey: true });
  key("keydown", { key: "Shift", ctrlKey: true, shiftKey: true });
  blur();
  key("keydown", { key: "#", code: "Digit3", shiftKey: true });
  expect(signals).toHaveLength(0);
});

test("one gesture gives one signal: PrintScreen's keydown and keyup together, or chord then blur then hidden", () => {
  const { signals, key, blur, hide } = setup();
  key("keydown", { key: "PrintScreen", code: "PrintScreen" });
  key("keyup", { key: "PrintScreen", code: "PrintScreen" });
  expect(signals).toHaveLength(1);
  key("keydown", { key: "Meta", metaKey: true });
  key("keydown", { key: "Shift", metaKey: true, shiftKey: true });
  blur();
  hide();
  expect(signals).toHaveLength(1);
});
