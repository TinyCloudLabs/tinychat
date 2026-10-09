import { useEffect, useMemo } from "react";
import { HaloRing, LevelSourceAdapter, QUIET } from "./halo";
import { RingGlyph } from "./softIcons";
import type { RecorderView } from "./recorderView";

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

export function RecorderRing({
  ring,
  flat,
  theme,
  subscribeLevel,
  action,
  glyph,
}: RecorderRingProps) {
  const adapter = useMemo(() => new LevelSourceAdapter(), []);
  const subscribe = useMemo(() => adapter.subscribe.bind(adapter), [adapter]);
  useEffect(
    () => subscribeLevel((level) => void adapter.update(level)),
    [adapter, subscribeLevel],
  );
  const live = ring === "live";
  const body = (
    <>
      <HaloRing
        size={SIZE}
        ticks={44}
        theme={theme}
        paused={ring === "paused"}
        still={
          ring === "still" || ring === "still-resumable" || ring === "idle"
        }
        source={QUIET}
        subscribe={live && !flat ? subscribe : undefined}
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
    <button
      type="button"
      className="pr-ring"
      data-ring={ring}
      aria-label={action.label}
      disabled={action.disabled}
      onClick={action.onPress}
    >
      {body}
    </button>
  );
}
