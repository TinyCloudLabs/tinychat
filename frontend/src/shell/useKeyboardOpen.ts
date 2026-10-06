// The on-screen keyboard (TC-761). While it is up on a compact screen,
// `html[data-keyboard="open"]` hides the tab bar (and, from PR4, the recording
// island), drops the composer's bottom padding to 8 px and lets
// `--tc-bottom-chrome` fall back to the safe area (index.css).
//
// "Up" means a text field has focus on a touch screen and the visible viewport
// is clearly shorter than the window was without it: iOS shrinks the visual
// viewport, Android (interactive-widget=resizes-content) the whole window. A
// field focused with no keyboard (an autofocus on load) leaves the bar alone.
import { useEffect } from "react";

import { isTextEntry, type SizeClass } from "../lib/sizeClass";

/** Less than this is a resize, not a keyboard. */
const KEYBOARD_MIN_PX = 120;

/**
 * The keyboard is up: a field has focus on a touch screen, and the visible
 * height is more than a resize's worth below the height without a keyboard.
 */
export function keyboardIsUp(input: { typing: boolean; fullHeight: number; visibleHeight: number }): boolean {
  return input.typing && input.fullHeight - input.visibleHeight > KEYBOARD_MIN_PX;
}

export function useKeyboardOpen(size: SizeClass): void {
  useEffect(() => {
    const root = document.documentElement;
    if (size !== "compact") {
      delete root.dataset.keyboard;
      return;
    }
    const coarse = window.matchMedia("(pointer: coarse)");
    const visible = () => window.visualViewport?.height ?? window.innerHeight;
    // The window's height with no keyboard, at the current width.
    let full = { width: window.innerWidth, height: Math.max(window.innerHeight, visible()) };
    let frame = 0;

    const update = () => {
      frame = 0;
      const typing = coarse.matches && isTextEntry(document.activeElement);
      if (!typing || window.innerWidth !== full.width) {
        full = { width: window.innerWidth, height: Math.max(window.innerHeight, visible()) };
      }
      if (keyboardIsUp({ typing, fullHeight: full.height, visibleHeight: visible() })) root.dataset.keyboard = "open";
      else delete root.dataset.keyboard;
    };
    // Focus moves settle before the next frame (activeElement is the body mid-move).
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };

    update();
    document.addEventListener("focusin", schedule);
    document.addEventListener("focusout", schedule);
    window.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("resize", schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      document.removeEventListener("focusin", schedule);
      document.removeEventListener("focusout", schedule);
      window.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("resize", schedule);
      delete root.dataset.keyboard;
    };
  }, [size]);
}
