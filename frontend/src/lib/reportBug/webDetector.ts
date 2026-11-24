// Browsers have no screenshot event. These are the signs a page can see (TC-3716, best effort):
// - Print Screen (Windows, Linux): the page gets its keyup, often not its keydown.
// - Cmd+Shift+3/4/5 (macOS): delivered only when the OS lets the browser see it.
// - Win+Shift+S or Cmd+Shift+5: the OS takes the final key, but the page sees Meta and Shift go down and then
//   loses focus (or goes hidden) as the snipping overlay opens.
// A chord with any other key in it, or a focus loss later than chordToBlurMs, is not counted.
export const WEB_DETECT = {
  chordToBlurMs: 1_000,
  /** Signs closer together than this are one screenshot (keydown + keyup, blur + hidden). */
  coalesceMs: 1_500,
} as const;

const SCREENSHOT_DIGITS: Record<string, true> = { Digit3: true, Digit4: true, Digit5: true };

export interface WebDetectorOptions {
  target: Pick<Window, "addEventListener" | "removeEventListener">;
  document: Pick<Document, "addEventListener" | "removeEventListener" | "visibilityState">;
  now: () => number;
  onScreenshot: (id: string) => void;
}

export function createWebScreenshotDetector({ target, document, now, onScreenshot }: WebDetectorOptions): () => void {
  let chordAt = -Infinity;
  let lastSignal = -Infinity;
  let count = 0;
  const signal = () => {
    const at = now();
    chordAt = -Infinity;
    if (at - lastSignal < WEB_DETECT.coalesceMs) return;
    lastSignal = at;
    onScreenshot(`web-${at}-${++count}`);
  };
  const onKey = (event: Event) => {
    const key = event as KeyboardEvent;
    if (key.key === "PrintScreen") return signal();
    if (key.type !== "keydown") return;
    if (key.metaKey && key.shiftKey && SCREENSHOT_DIGITS[key.code]) return signal();
    const modifierOnly = key.key === "Meta" || key.key === "Shift";
    if (modifierOnly && key.metaKey && key.shiftKey && !key.ctrlKey && !key.altKey) chordAt = now();
    else if (!modifierOnly) chordAt = -Infinity;
  };
  const onFocusLoss = () => {
    if (now() - chordAt <= WEB_DETECT.chordToBlurMs) signal();
  };
  const onVisibility = () => {
    if (document.visibilityState === "hidden") onFocusLoss();
  };
  target.addEventListener("keydown", onKey);
  target.addEventListener("keyup", onKey);
  target.addEventListener("blur", onFocusLoss);
  document.addEventListener("visibilitychange", onVisibility);
  return () => {
    target.removeEventListener("keydown", onKey);
    target.removeEventListener("keyup", onKey);
    target.removeEventListener("blur", onFocusLoss);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}
