import { useEffect, useRef } from "react";
import type { RecorderPhase } from "../../recorderReducer";
import type { RecorderLayout } from "../shellCapabilities";

export const KEEP_TAB_OPEN = "Keep this tab open while you record";
export const KEEP_PAGE_OPEN = "Keep this page open while you record";

export const keepOpenMessage = (layout: RecorderLayout): string => (layout === "phone" ? KEEP_PAGE_OPEN : KEEP_TAB_OPEN);

/** Once per recording, when it starts. A recording picked up on mount (a reload) is not a start. */
export function useKeepOpenToast(
  enabled: boolean,
  phase: RecorderPhase,
  layout: RecorderLayout,
  show: (message: string) => void,
): void {
  const previous = useRef(phase);
  useEffect(() => {
    const before = previous.current;
    previous.current = phase;
    if (enabled && phase === "recording" && before !== "recording") show(keepOpenMessage(layout));
    // Only a change of phase is a start; the layout and `show` are read as they are then.
  }, [phase]);
}
