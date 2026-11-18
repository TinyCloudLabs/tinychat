import { useEffect, useState } from "react";
import type { RecorderValue } from "../RecorderProvider";
import { LevelSourceAdapter } from "./halo/source";

/** The bars' source: native levels in, a frame-rate spectrum out (the stable `subscribe` the bars take). */
export function useLevelSource(
  recorder: Pick<RecorderValue, "subscribeLevel">,
): LevelSourceAdapter["subscribe"] {
  const [source] = useState(() => {
    const adapter = new LevelSourceAdapter();
    return { adapter, subscribe: adapter.subscribe.bind(adapter) };
  });
  const { subscribeLevel } = recorder;
  useEffect(
    () => subscribeLevel((level) => source.adapter.update(level)),
    [source, subscribeLevel],
  );
  return source.subscribe;
}
