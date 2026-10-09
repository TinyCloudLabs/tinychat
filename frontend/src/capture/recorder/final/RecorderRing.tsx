import { useEffect, useMemo } from "react";
import { HaloRing, LevelSourceAdapter, QUIET, type HaloSource } from "./halo";
import { RingGlyph } from "./softIcons";
import type { RecorderView } from "./recorderView";

// The one place that talks to HaloRing's data API. React never renders per
// frame: the source's fields read the adapter when the renderer asks.
function liveSource(adapter: LevelSourceAdapter): HaloSource {
  let at = -1;
  let current: HaloSource = QUIET;
  const read = (): HaloSource => {
    const now = performance.now();
    if (now - at >= 8) {
      current = adapter.sample(now);
      at = now;
    }
    return current;
  };
  return {
    get level() { return read().level; },
    get act() { return read().act; },
    get low() { return read().low; },
    get mid() { return read().mid; },
    get high() { return read().high; },
    get centroid() { return read().centroid; },
    get spec() { return read().spec; },
    get wave() { return read().wave; },
  };
}

export interface RecorderRingProps {
  ring: RecorderView["ring"];
  flat: boolean;
  theme: "night" | "day";
  subscribeLevel: (listener: (level: number) => void) => () => void;
  /** The ring is the pause/resume button: its label and press handler. */
  action: { label: string; onPress: () => void; disabled: boolean } | null;
  glyph: "pause" | "play" | null;
}

const SIZE = 172;

export function RecorderRing({ ring, flat, theme, subscribeLevel, action, glyph }: RecorderRingProps) {
  const adapter = useMemo(() => new LevelSourceAdapter(), []);
  const source = useMemo(() => liveSource(adapter), [adapter]);
  useEffect(() => subscribeLevel((level) => void adapter.update(level)), [adapter, subscribeLevel]);
  const live = ring === "live";
  const body = (
    <>
      <HaloRing
        size={SIZE}
        ticks={44}
        theme={theme}
        paused={ring === "paused"}
        still={ring === "still" || ring === "still-resumable" || ring === "idle"}
        source={live && !flat ? source : QUIET}
      />
      {glyph && <RingGlyph kind={glyph} />}
    </>
  );
  if (!action) {
    return (
      <div className="pr-ring" data-ring={ring}>
        {body}
      </div>
    );
  }
  return (
    <button type="button" className="pr-ring" data-ring={ring} aria-label={action.label} disabled={action.disabled} onClick={action.onPress}>
      {body}
    </button>
  );
}
