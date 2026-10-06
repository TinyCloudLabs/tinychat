// With the keyboard up, the tab bar and the island hide; this chip in the
// page or chat header keeps the recording in sight ("● 12:48"). It shows only
// while a recording is live and html[data-keyboard=open], and opens the recorder.
import { cn } from "@/lib/utils";
import { useRecorder, type RecorderValue } from "./RecorderProvider";
import { micWarning } from "./recorderCopy";
import { RecorderTimer } from "./RecorderTimer";

export function HeaderLiveChipView(props: { recorder: RecorderValue; className?: string }) {
  const { recorder } = props;
  const warning = recorder.phase === "recording" && micWarning(recorder.mic) !== null;
  return (
    <button
      type="button"
      onClick={recorder.openSheet}
      aria-label="Recording. Open recorder"
      data-testid="header-live-chip"
      className={cn(
        "tap-transparent hidden h-11 shrink-0 items-center px-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [html[data-keyboard=open]_&]:inline-flex",
        props.className,
      )}
    >
      <span className="flex h-8 items-center gap-1.5 rounded-full bg-surface-2 px-3 text-meta font-semibold">
        <span className={cn("size-2 rounded-full", warning ? "bg-warning" : "bg-live")} aria-hidden="true" />
        <RecorderTimer startedAt={recorder.startedAt} />
      </span>
    </button>
  );
}

export function HeaderLiveChip(props: { className?: string }) {
  const recorder = useRecorder();
  if (recorder.phase !== "starting" && recorder.phase !== "recording") return null;
  return <HeaderLiveChipView recorder={recorder} className={props.className} />;
}
