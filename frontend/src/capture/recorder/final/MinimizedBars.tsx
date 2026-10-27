import { MirroredSpectrumBars, QUIET } from "./halo";
import type { MinimizedView } from "./minimizedView";
import { useLevelSource } from "./useLevelSource";
import type { RecorderValue } from "../RecorderProvider";

interface MinimizedBarsProps {
  recorder: Pick<RecorderValue, "subscribeLevel">;
  view: Pick<MinimizedView, "ring" | "flat">;
  bars: 30 | 22;
  theme: "night" | "day";
}

/** Live bars follow the level; paused ones hold their shape in grey; a silenced mic is red but flat at rest. */
export function MinimizedBars({
  recorder,
  view,
  bars,
  theme,
}: MinimizedBarsProps) {
  const subscribe = useLevelSource(recorder);
  const live = view.ring === "live";
  return (
    <MirroredSpectrumBars
      subscribe={live && !view.flat ? subscribe : undefined}
      source={live && view.flat ? QUIET : undefined}
      bars={bars}
      paused={!live}
      theme={theme}
    />
  );
}
