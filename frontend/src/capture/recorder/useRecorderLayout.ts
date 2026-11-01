import { useEffect, useState } from "react";

import { recorderLayout, type RecorderLayout } from "./final/shellCapabilities";

/** The recorder's layout for the window's width now: phone below 768 px, rail below 1024 px, desktop from there. */
export function useRecorderLayout(): RecorderLayout {
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return recorderLayout(width);
}
