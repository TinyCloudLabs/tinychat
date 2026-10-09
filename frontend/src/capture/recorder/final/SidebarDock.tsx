import { useResolvedTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import type { RecorderValue } from "../RecorderProvider";
import { MinimizedBars } from "./MinimizedBars";
import { ExpandGlyph, PauseGlyph, PlayGlyph } from "./minimizedIcons";
import {
  useEntrance,
  useMinimizedAnnouncement,
  useMinimizedElapsed,
  useMinimizedRecorder,
  useMinimizedSilencedSince,
} from "./MinimizedProvider";
import { minimizedView } from "./minimizedView";
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
  const view = minimizedView(recorder, elapsedMs, silencedSinceMs);
  const live = view.ring === "live";
  const canToggle = view.controls.resume || view.controls.pause;
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
          data-testid="dock-open"
        />
        <div className="dock-row">
          <span className="soft-timer dock-timer" data-testid="dock-timer">
            {view.timer.text}
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
        <div className="dock-bars">
          <MinimizedBars
            recorder={recorder}
            view={view}
            bars={22}
            theme={theme}
          />
        </div>
        <div className="dock-foot" aria-hidden="true">
          <span className="dock-status" data-testid="dock-status">
            {view.statusLine ?? view.pill.label}
          </span>
          <span className="dock-foot-gap" />
          <ExpandGlyph size={14} />
        </div>
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
