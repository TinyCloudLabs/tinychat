import { useEffect, useMemo } from "react";
import { HaloRing, LevelSourceAdapter, QUIET } from "../halo";
import type { RecorderView } from "../recorderView";
import { RingGlyph } from "../softIcons";

export interface DesktopRingProps {
  ring: RecorderView["ring"];
  flat: boolean;
  theme: "night" | "day";
  size: 214 | 172;
  subscribeLevel: (listener: (level: number) => void) => () => void;
  /** The ring is the pause/resume button: its label and press handler. */
  action: { label: string; onPress: () => void; disabled: boolean } | null;
  glyph: "pause" | "play" | null;
}

/** RecorderRing at the desktop sizes; the phone's is fixed at 172. */
export function DesktopRing({
  ring,
  flat,
  theme,
  size,
  subscribeLevel,
  action,
  glyph,
}: DesktopRingProps) {
  const adapter = useMemo(() => new LevelSourceAdapter(), []);
  const subscribe = useMemo(() => adapter.subscribe.bind(adapter), [adapter]);
  useEffect(
    () => subscribeLevel((level) => void adapter.update(level)),
    [adapter, subscribeLevel],
  );
  const body = (
    <>
      <HaloRing
        size={size}
        ticks={44}
        theme={theme}
        paused={ring === "paused"}
        still={
          ring === "still" || ring === "still-resumable" || ring === "idle"
        }
        source={QUIET}
        subscribe={ring === "live" && !flat ? subscribe : undefined}
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
