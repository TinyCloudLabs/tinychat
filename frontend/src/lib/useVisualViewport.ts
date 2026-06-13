import { useEffect } from "react";

// Keep the app shell sized to the *visible* viewport so a bottom-anchored
// composer is never hidden behind the on-screen keyboard.
//
// iOS Safari (and some Android browsers) do NOT shrink the layout viewport —
// nor the `dvh` unit — when the soft keyboard opens; the keyboard is painted as
// an overlay on top of the visual viewport. A composer sized to `100dvh` then
// sits *below* the fold, behind the keyboard. The visualViewport API is the only
// cross-browser signal for the actually-visible region, so we mirror its height
// into a CSS variable and let the shell consume it (falling back to `100dvh`
// when the API is absent, e.g. older browsers or SSR).
export function useVisualViewportFit(): void {
  useEffect(() => {
    if (typeof window === "undefined") return;
    const vv = window.visualViewport;
    const root = document.documentElement;
    if (!vv) return; // No API → the CSS `100dvh` fallback stays in effect.

    let frame = 0;
    const apply = () => {
      frame = 0;
      root.style.setProperty("--tc-app-height", `${Math.round(vv.height)}px`);
    };
    // visualViewport fires resize/scroll in bursts (one per keyboard-animation
    // frame); coalesce to a single rAF write to avoid layout thrash.
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(apply);
    };

    apply();
    vv.addEventListener("resize", schedule);
    vv.addEventListener("scroll", schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      vv.removeEventListener("resize", schedule);
      vv.removeEventListener("scroll", schedule);
      root.style.removeProperty("--tc-app-height");
    };
  }, []);
}
