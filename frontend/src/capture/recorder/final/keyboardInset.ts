import { useEffect, useState } from "react";
import { nativeKeyboard, type NativeKeyboard } from "@/lib/nativeKeyboard";

/** How much of the bottom of the layout viewport the on-screen keyboard covers, in px. */
export function keyboardInset(
  viewport: Pick<VisualViewport, "height" | "offsetTop">,
  layoutHeight: number,
): number {
  return Math.max(
    0,
    Math.round(layoutHeight - viewport.height - viewport.offsetTop),
  );
}

/**
 * The keyboard's height from the visual viewport; 0 where there is none (older web views, the harness) and in the iOS
 * app, where `@capacitor/keyboard` resizes the web view itself (`resize: "native"`), so the layout already ends above
 * the keyboard.
 */
export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = () => setInset(keyboardInset(viewport, window.innerHeight));
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
    };
  }, []);
  return inset;
}

/** Hides the keyboard's accessory bar (iOS) while the calling component is mounted: the notes sheet, the moment field. */
export function useAccessoryBarHidden(
  keyboard: NativeKeyboard = nativeKeyboard,
): void {
  useEffect(() => keyboard.holdAccessoryBarHidden(), [keyboard]);
}

/** How long a press keeps the bar hidden when nothing opens: long enough for the tap's click to open the field. */
export const PRIME_HOLD_MS = 1500;

/**
 * iOS drops the accessory bar only for a focus that comes after the plugin call, and the moment field (and the notes
 * sheet, when it opens in Write) focuses inside the tap that opens it (the keyboard needs that gesture). So the bar is
 * hidden when an opener is pressed, ahead of its click; the field or sheet then holds it from its own mount, and this
 * hold lapses on a timer.
 */
export function usePrimeAccessoryBarOnPress(
  openerSelector: string,
  keyboard: NativeKeyboard = nativeKeyboard,
): void {
  useEffect(() => {
    let release: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const lapse = () => {
      clearTimeout(timer);
      release?.();
      release = null;
    };
    const onPress = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest(openerSelector)) return;
      lapse();
      release = keyboard.holdAccessoryBarHidden();
      timer = setTimeout(lapse, PRIME_HOLD_MS);
    };
    document.addEventListener("pointerdown", onPress, true);
    return () => {
      document.removeEventListener("pointerdown", onPress, true);
      lapse();
    };
  }, [openerSelector, keyboard]);
}
