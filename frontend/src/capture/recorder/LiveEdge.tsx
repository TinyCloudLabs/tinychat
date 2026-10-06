// The Live Edge (plan §2.8): a faint rim around the screen while a microphone
// is capturing in Exo, brightening with the input level. Amber and still when
// the mic is silenced or hears nothing; still for the desktop app's recorder
// (it reports no level) and with reduced motion; hidden in forced colours.
// Never the only signal: the status, the timer and the island say the same.
// Mounted once at the app root; it never takes a pointer event.
import { useEffect, useRef } from "react";

import { edgeLevel, liveCapture, useLiveCapture } from "./liveCapture";

export function LiveEdge() {
  const capture = useLiveCapture();
  const ref = useRef<HTMLDivElement>(null);
  const moving = capture !== null && !capture.warning && capture.source !== "desktop-local";

  useEffect(() => {
    const element = ref.current;
    if (!element || !moving) return;
    let level = 0;
    const unsubscribe = liveCapture.subscribeLevel((sample) => {
      level = edgeLevel(sample, level);
      element.style.setProperty("--live-level", level.toFixed(3));
    });
    return () => {
      unsubscribe();
      element.style.removeProperty("--live-level");
    };
  }, [moving]);

  if (capture === null) return null;
  return (
    <div
      ref={ref}
      aria-hidden="true"
      className="live-edge"
      data-source={capture.source}
      data-tone={capture.warning ? "warning" : "live"}
      data-static={moving ? undefined : ""}
    />
  );
}
