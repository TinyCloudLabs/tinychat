// The minimised recorder (plan §2.9): a pill with the status, the time, a
// short level trace and Stop. It morphs into the receipt when the note lands
// ("Saved to your space", for 3 s) or into "Kept on this phone" with Save now
// when the save failed. Tapping it opens the recorder again.
import { AlertCircleIcon, CheckIcon, Loader2Icon, SquareIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { LevelTrace } from "./LevelTrace";
import { islandShown, useRecorder, type RecorderValue } from "./RecorderProvider";
import { ISLAND_KEPT, ISLAND_SAVED, micWarning } from "./recorderCopy";
import { RecorderTimer } from "./RecorderTimer";

export type IslandState = "live" | "saving" | "landed" | "failed";

export function islandState(value: Pick<RecorderValue, "phase" | "outcome">): IslandState {
  if (value.phase === "starting" || value.phase === "recording") return "live";
  if (value.phase === "stopping" || value.phase === "saving") return "saving";
  return value.outcome === "failed" ? "failed" : "landed";
}

export function IslandView(props: { recorder: RecorderValue; onOpenNote?: (id: string) => void; className?: string }) {
  const { recorder } = props;
  const state = islandState(recorder);
  const warning = recorder.phase === "recording" && micWarning(recorder.mic) !== null;
  const lastSaved = recorder.lastSaved;

  let summary;
  if (state === "live") {
    summary = (
      <>
        <span
          className={cn("size-2.5 shrink-0 rounded-full", warning ? "bg-warning" : "bg-live motion-safe:animate-live-pulse")}
          aria-hidden="true"
        />
        <RecorderTimer startedAt={recorder.startedAt} className="text-callout font-semibold" />
        <LevelTrace subscribe={recorder.subscribeLevel} tone={warning ? "warning" : "live"} bars={12} className="h-6 w-14 shrink-0" />
        <span className={cn("min-w-0 text-callout [overflow-wrap:anywhere]", warning ? "text-warning" : "text-muted-foreground")}>
          {recorder.phase === "starting" ? "Starting…" : warning ? "Mic problem" : "Recording"}
        </span>
      </>
    );
  } else if (state === "saving") {
    summary = (
      <>
        <Loader2Icon className="size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" />
        <span className="tnum min-w-0 text-callout [overflow-wrap:anywhere]">
          Saving{typeof recorder.savePercent === "number" ? ` · ${recorder.savePercent}%` : "…"}
        </span>
      </>
    );
  } else if (state === "landed") {
    summary = (
      <>
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground motion-safe:animate-in motion-safe:zoom-in-50 motion-safe:duration-500">
          <CheckIcon className="size-3" strokeWidth={3} aria-hidden="true" />
        </span>
        <span className="min-w-0 text-callout font-semibold [overflow-wrap:anywhere]">{ISLAND_SAVED}</span>
      </>
    );
  } else {
    summary = (
      <>
        <AlertCircleIcon className="size-4 shrink-0 text-warning" aria-hidden="true" />
        <span className="min-w-0 text-callout font-semibold [overflow-wrap:anywhere]">{ISLAND_KEPT}</span>
      </>
    );
  }

  return (
    <div
      data-testid="recorder-island"
      data-state={state}
      className={cn("flex min-h-14 w-full min-w-0 items-center gap-1 rounded-[1.75rem] bg-surface-2 p-1.5 shadow-float", props.className)}
    >
      <button
        type="button"
        onClick={recorder.openSheet}
        aria-label="Open recorder"
        className="tap-transparent flex min-h-11 min-w-0 flex-1 items-center gap-2.5 rounded-full pl-3 pr-2 text-left transition-opacity active:opacity-70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        {summary}
      </button>
      {state === "live" && (
        <Button
          type="button"
          variant="live"
          size="icon"
          className="size-11 shrink-0 rounded-full"
          onClick={recorder.stop}
          disabled={recorder.phase !== "recording"}
          aria-label="Stop and save"
          data-testid="island-stop"
        >
          <SquareIcon className="fill-current" aria-hidden="true" />
        </Button>
      )}
      {state === "landed" && props.onOpenNote && lastSaved && (
        <Button
          type="button"
          variant="ghost"
          className="h-11 shrink-0 rounded-full px-4"
          onClick={() => {
            recorder.dismissOutcome();
            props.onOpenNote?.(lastSaved.id);
          }}
          data-testid="island-open"
        >
          Open
        </Button>
      )}
      {state === "failed" && (
        <Button
          type="button"
          variant="ghost"
          className="h-11 shrink-0 rounded-full px-4"
          onClick={recorder.retryPending}
          disabled={recorder.pending.running}
          data-testid="island-save-now"
        >
          Save now
        </Button>
      )}
    </div>
  );
}

/** The island, while the recorder is minimised and a recording is under way or just ended. */
export function Island(props: { onOpenNote?: (id: string) => void; className?: string }) {
  const recorder = useRecorder();
  if (!islandShown(recorder)) return null;
  return <IslandView recorder={recorder} onOpenNote={props.onOpenNote} className={props.className} />;
}
