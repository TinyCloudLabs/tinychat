// The focused recorder (plan §2.9): a left-aligned status block (status, the
// timer, a meta line), where the audio goes as the centrepiece, and the tape
// trace above a full-width Stop bar. When the note lands, the centre becomes
// the receipt. Minimising (the chevron, Escape, the scrim, Back) never stops
// the recording; the island takes over.
//
// RecorderSheetView is a pure function of the recorder's value; RecorderSheet
// puts it in a full-height bottom sheet on a phone and a 560px dialog on wider
// screens.
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { AlertCircleIcon, CheckIcon, ChevronDownIcon, Loader2Icon, MicIcon, MicOffIcon, SquareIcon } from "lucide-react";

import { BottomSheet } from "@/components/ui/bottom-sheet";
import { Button } from "@/components/ui/button";
import { useSizeClass } from "@/lib/sizeClass";
import { cn } from "@/lib/utils";
import { LevelTrace } from "./LevelTrace";
import { useRecorder, type RecorderValue } from "./RecorderProvider";
import { micWarning, micWarningSentence, recorderMetaText, recorderStatusText, ISLAND_KEPT } from "./recorderCopy";
import { RecorderTimer, useElapsed } from "./RecorderTimer";
import { voiceNoteRoute } from "./RouteLine";
import { SavedReceipt } from "./SavedReceipt";
import { TranscriptionRouteControl } from "./TranscriptionRouteControl";

/** Private cloud will transcribe the note just saved (it is on, and the note is short enough). */
export function transcribesSaved(value: Pick<RecorderValue, "transcription" | "lastSaved">): boolean {
  const { transcription, lastSaved } = value;
  return (
    transcription?.availability === "available" &&
    transcription.consented &&
    lastSaved !== null &&
    lastSaved.durationMs <= transcription.maxSeconds * 1000
  );
}

function StatusLine(props: { recorder: RecorderValue }) {
  const { phase, mic, savePercent, outcome } = props.recorder;
  const live = phase === "recording";
  const warning = live && micWarning(mic) !== null;
  let icon;
  let text: string;
  if (outcome === "saved" && phase === "idle") {
    icon = <CheckIcon className="size-4 text-primary" aria-hidden="true" />;
    text = "Saved";
  } else if (outcome === "failed" && phase === "idle") {
    icon = <AlertCircleIcon className="size-4 text-warning" aria-hidden="true" />;
    text = ISLAND_KEPT;
  } else {
    text = recorderStatusText(phase, mic, savePercent);
    if (live && warning) icon = <MicOffIcon className="size-4 text-warning" aria-hidden="true" />;
    else if (live) icon = <span className="size-2.5 rounded-full bg-live motion-safe:animate-live-pulse" aria-hidden="true" />;
    else if (phase === "idle") icon = <MicIcon className="size-4 text-muted-foreground" aria-hidden="true" />;
    else icon = <Loader2Icon className="size-4 animate-spin text-muted-foreground" aria-hidden="true" />;
  }
  return (
    <p
      role="status"
      data-testid="voice-note-status"
      data-mic-state={live ? mic.state : "idle"}
      data-mic-reason={live ? mic.reason ?? "" : ""}
      className={cn("flex min-h-6 items-center gap-2 text-callout font-semibold", warning ? "text-warning" : "text-foreground")}
    >
      <span className="flex size-4 items-center justify-center">{icon}</span>
      <span className="tnum">{text}</span>
    </p>
  );
}

export interface RecorderSheetViewProps {
  recorder: RecorderValue;
  /** Opens the saved note; without it the receipt offers Done only. */
  onOpenNote?: (id: string) => void;
  /** Start the route control on its one-time question (the harness). */
  consentAsking?: boolean;
}

export function RecorderSheetView({ recorder, onOpenNote, consentAsking }: RecorderSheetViewProps) {
  const { phase, mic, startedAt, maxDurationMs, outcome, lastSaved, error, limitNotice } = recorder;
  const live = phase === "recording";
  const warning = live ? micWarningSentence(mic) : null;
  const elapsed = useElapsed(startedAt);
  const receipt = phase === "idle" && outcome !== null;
  const saving = phase === "stopping" || phase === "saving";
  const meta = receipt ? null : recorderMetaText(startedAt, elapsed, maxDurationMs);

  return (
    <div data-testid="voice-note-recorder" data-phase={phase} className="flex h-full min-h-0 flex-col">
      <header className="flex h-13 shrink-0 items-center justify-between px-2">
        <Button type="button" variant="ghost" size="icon" className="size-11" aria-label="Minimise recorder" onClick={recorder.minimiseSheet} data-testid="recorder-minimise">
          <ChevronDownIcon className="!size-5" />
        </Button>
        {/* Discard (PR5) sits here, far from Stop. */}
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[auto_minmax(0,1fr)_auto_auto] gap-y-5 px-5 pb-[max(1rem,env(safe-area-inset-bottom))] land:grid-cols-2 land:grid-rows-[minmax(0,1fr)_auto] land:gap-x-8 land:gap-y-3 land:pl-[max(1.25rem,env(safe-area-inset-left))] land:pr-[max(1.25rem,env(safe-area-inset-right))]">
        <div className="flex min-w-0 flex-col land:col-start-1 land:row-start-1">
          <StatusLine recorder={recorder} />
          {!(receipt && outcome === "failed") && (
            <RecorderTimer
              startedAt={startedAt}
              fixedMs={receipt ? lastSaved?.durationMs ?? 0 : undefined}
              className="mt-1 font-display text-timer land:text-[2.5rem] land:leading-[2.5rem]"
            />
          )}
          {meta && <p className="tnum mt-1 text-meta text-muted-foreground" data-testid="recorder-meta">{meta}</p>}
          {warning && <p className="mt-3 text-callout text-warning">{warning}</p>}
          {limitNotice && !live && (
            <p data-testid="voice-note-limit" className="mt-3 text-callout text-warning">
              {limitNotice}
            </p>
          )}
          {error && !receipt && (
            <p role="alert" className="mt-3 text-callout text-destructive">
              {error}
            </p>
          )}
        </div>

        <div className="min-h-0 overflow-y-auto land:col-start-2 land:row-start-1">
          {receipt ? (
            <SavedReceipt
              outcome={outcome}
              saved={lastSaved}
              route={voiceNoteRoute(outcome === "saved" && transcribesSaved(recorder))}
              transcribing={outcome === "saved" && transcribesSaved(recorder)}
              error={error}
              retrying={recorder.pending.running}
              onOpen={onOpenNote && lastSaved ? () => {
                recorder.dismissOutcome();
                onOpenNote(lastSaved.id);
              } : undefined}
              onDone={recorder.dismissOutcome}
              onSaveNow={recorder.retryPending}
            />
          ) : (
            <TranscriptionRouteControl transcription={recorder.transcription} defaultAsking={consentAsking} />
          )}
        </div>

        {!receipt && (
          <LevelTrace
            subscribe={recorder.subscribeLevel}
            tone={warning ? "warning" : "live"}
            className={cn("land:col-start-1 land:row-start-2 land:self-end", !live && "opacity-40")}
          />
        )}
        {!receipt && (
          phase === "idle" ? (
            <Button type="button" onClick={recorder.record} className="h-14 w-full justify-start gap-3 rounded-xl px-5 text-body font-semibold land:col-start-2 land:row-start-2" data-testid="recorder-record-again">
              <MicIcon className="!size-5" aria-hidden="true" /> Record
            </Button>
          ) : (
            <Button
              type="button"
              variant="live"
              onClick={recorder.stop}
              disabled={!live}
              className="h-14 w-full justify-start gap-3 rounded-xl px-5 text-body font-semibold land:col-start-2 land:row-start-2"
              data-testid="voice-note-stop"
            >
              {saving || phase === "starting" ? (
                <Loader2Icon className="!size-5 animate-spin" aria-hidden="true" />
              ) : (
                <SquareIcon className="fill-current" aria-hidden="true" />
              )}
              {saving ? "Saving…" : "Stop and save"}
            </Button>
          )
        )}
      </div>
    </div>
  );
}

/**
 * The recorder in a full-height bottom sheet on a phone (drag down, the scrim,
 * Escape or Android Back minimise it) and a 560px dialog on wider screens,
 * open while `sheetOpen`. Closing it never stops the recording.
 */
export function RecorderSheet(props: { onOpenNote?: (id: string) => void; consentAsking?: boolean }) {
  const recorder = useRecorder();
  const { size } = useSizeClass();
  const onOpenChange = (open: boolean) => {
    if (!open) recorder.minimiseSheet();
  };
  const view = <RecorderSheetView recorder={recorder} onOpenNote={props.onOpenNote} consentAsking={props.consentAsking} />;
  if (size === "compact") {
    return (
      <BottomSheet open={recorder.sheetOpen} onOpenChange={onOpenChange} height="full" title="Voice note recorder" bare contentProps={{ "data-testid": "recorder-sheet" }}>
        <div className="flex min-h-0 flex-1 flex-col">{view}</div>
      </BottomSheet>
    );
  }
  return (
    <DialogPrimitive.Root open={recorder.sheetOpen} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0 data-[state=open]:duration-250 data-[state=closed]:duration-150 motion-reduce:data-[state=open]:duration-150 motion-reduce:data-[state=closed]:duration-150" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          data-testid="recorder-sheet"
          // Focus the recorder itself, not its first control (a ring on Minimise reads as a selection).
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            (event.currentTarget as HTMLElement).focus();
          }}
          className={cn(
            "fixed left-1/2 top-1/2 z-50 flex h-[min(46rem,calc(100dvh-4rem))] w-[min(35rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl bg-card text-card-foreground shadow-float outline-none",
            "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0 data-[state=open]:zoom-in-[0.97] data-[state=closed]:zoom-out-[0.97] data-[state=open]:duration-250 data-[state=open]:ease-smooth data-[state=closed]:duration-150 data-[state=closed]:ease-exit",
            "motion-reduce:data-[state=open]:zoom-in-100 motion-reduce:data-[state=closed]:zoom-out-100 motion-reduce:data-[state=open]:duration-150 motion-reduce:data-[state=closed]:duration-150",
          )}
        >
          <DialogPrimitive.Title className="sr-only">Voice note recorder</DialogPrimitive.Title>
          {view}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
