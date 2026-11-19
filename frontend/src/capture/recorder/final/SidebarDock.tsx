import { useContext, useId } from "react";
import { PlatformContext } from "@/lib/platform";
import { useResolvedTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import type { RecorderValue } from "../RecorderProvider";
import { PauseGlyph, PlayGlyph } from "./minimizedIcons";
import {
  useEntrance,
  useMinimizedAnnouncement,
  useMinimizedElapsed,
  useMinimizedRecorder,
  useMinimizedSilencedSince,
} from "./MinimizedProvider";
import { minimizedLimit, minimizedView } from "./minimizedView";
import "./soft.css";
import "./ribbon.css";

export interface SidebarDockViewProps {
  recorder: RecorderValue;
  elapsedMs: number;
  /** When the mic went silent, for the no-sound line. */
  silencedSinceMs?: number | null;
  theme: "night" | "day";
  entering?: boolean;
  /** The polite live region's text. */
  announcement?: string;
}

/** The minimised recorder at the sidebar's foot: pressing anywhere on the card but Pause and Stop reopens it. */
export function SidebarDockView({
  recorder,
  elapsedMs,
  silencedSinceMs = null,
  theme,
  entering = false,
  announcement = "",
}: SidebarDockViewProps) {
  const device = useContext(PlatformContext) === "tauri" ? "mac" : "phone";
  const view = minimizedView(recorder, elapsedMs, silencedSinceMs, device);
  const live = view.ring === "live";
  const limit = minimizedLimit(view, recorder.maxDurationMs);
  const canToggle = view.controls.resume || view.controls.pause;
  const stopsId = useId();
  return (
    <div
      data-testid="sidebar-dock"
      data-state={view.ring}
      data-live={live}
      data-layout="desktop"
      className={cn(
        "mini-skin soft-skin dock-skin",
        theme === "night" ? "soft-night" : "soft-day",
        entering && "is-entering",
      )}
    >
      <div className="dock">
        <button
          type="button"
          className="dock-open"
          onClick={recorder.openSheet}
          aria-label={`${view.status}. Open recorder`}
          aria-describedby={limit ? stopsId : undefined}
          data-testid="dock-open"
        />
        <div className="dock-row">
          <span className="dock-clock">
            <span className="soft-timer dock-timer" data-testid="dock-timer">
              {view.timer.text}
            </span>
            {limit && (
              <span className="dock-remaining" data-testid="dock-remaining">
                {limit.stopsIn}
              </span>
            )}
          </span>
          <button
            type="button"
            className="mini-btn"
            onClick={view.controls.resume ? recorder.resume : recorder.pause}
            disabled={!canToggle}
            aria-label={
              view.controls.resume ? "Resume recording" : "Pause recording"
            }
            data-testid="dock-pause"
          >
            <span className="mini-disc">
              {view.controls.resume ? (
                <PlayGlyph size={13} />
              ) : (
                <PauseGlyph size={13} />
              )}
            </span>
          </button>
          <button
            type="button"
            className="mini-btn mini-btn--stop"
            onClick={recorder.stop}
            disabled={!view.controls.stop}
            aria-label="Stop and save"
            data-testid="dock-stop"
          >
            <span className="mini-disc">
              <i className="mini-stop-glyph" aria-hidden="true" />
            </span>
          </button>
        </div>
        {limit && (
          <>
            <span id={stopsId} className="mini-tip" role="tooltip" data-testid="dock-stops">
              {limit.stopsAt}
            </span>
            <span className="mini-limit" aria-hidden="true" data-testid="dock-limit">
              <span
                className="mini-limit-fill"
                style={{ width: `${(limit.fraction * 100).toFixed(1)}%` }}
              />
            </span>
          </>
        )}
      </div>
      <span
        role="status"
        className="sr-only"
        data-testid="minimized-announcement"
      >
        {announcement}
      </span>
    </div>
  );
}

export function SidebarDock() {
  const recorder = useMinimizedRecorder();
  const elapsedMs = useMinimizedElapsed();
  const silencedSinceMs = useMinimizedSilencedSince();
  const entering = useEntrance();
  const announcement = useMinimizedAnnouncement(entering);
  const theme = useResolvedTheme() === "dark" ? "night" : "day";
  return (
    <SidebarDockView
      recorder={recorder}
      elapsedMs={elapsedMs}
      silencedSinceMs={silencedSinceMs}
      theme={theme}
      entering={entering}
      announcement={announcement}
    />
  );
}
