import { useEffect, useState } from "react";

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

// TODO(TC-878): on the native shell, read the keyboard height from `@capacitor/keyboard` (lazily imported, behind
// `Capacitor.isNativePlatform()`) once that plugin is added. Until then the visual viewport is the only source.
/** The keyboard's height from the visual viewport; 0 where there is none (older web views, the harness). */
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
