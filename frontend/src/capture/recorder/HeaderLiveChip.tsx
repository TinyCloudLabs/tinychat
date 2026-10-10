// With the keyboard up, the tab bar and the island hide; this chip in the
// page or chat header keeps the recording in sight ("● 12:48"). It shows only
// while a recording is live and html[data-keyboard=open], and opens the recorder.
import { cn } from "@/lib/utils";
import { useMinimizedElapsed } from "./final/MinimizedProvider";
import { minimizedView } from "./final/minimizedView";
import { useRecorder, type RecorderValue } from "./RecorderProvider";

/** The Ribbon's clock and the view-model's dot: grey when paused, hollow when interrupted, red only while capturing. */
export function HeaderLiveChipView(props: { recorder: RecorderValue; className?: string }) {
  const { recorder } = props;
  const view = minimizedView(recorder, useMinimizedElapsed());
  return (
    <button
      type="button"
      onClick={recorder.openSheet}
      aria-label={`${view.status}. Open recorder`}
      data-testid="header-live-chip"
      className={cn(
        "tap-transparent hidden h-11 shrink-0 items-center px-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [html[data-keyboard=open]_&]:inline-flex",
        props.className,
      )}
    >
      <span className="flex h-8 items-center gap-1.5 rounded-full bg-surface-2 px-3 text-meta font-semibold">
        <span
          className={cn("size-2 rounded-full", view.pill.dot === "red" ? "bg-live" : view.pill.dot === "filled-grey" ? "bg-muted-foreground" : "border-[1.5px] border-muted-foreground")}
          aria-hidden="true"
        />
        <span className="tnum">{view.timer.text}</span>
      </span>
    </button>
  );
}

export function HeaderLiveChip(props: { className?: string }) {
  const recorder = useRecorder();
  if (recorder.phase !== "starting" && recorder.phase !== "recording") return null;
  return <HeaderLiveChipView recorder={recorder} className={props.className} />;
}
