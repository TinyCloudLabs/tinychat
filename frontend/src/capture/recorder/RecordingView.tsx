import { CheckIcon, ChevronDownIcon, MicOffIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { LevelTrace } from "./LevelTrace";
import { micWarning, micWarningSentence, recorderMetaText, recorderStatusText } from "./recorderCopy";
import { RecorderControls } from "./RecorderControls";
import type { RecorderValue } from "./RecorderProvider";
import { RecorderTimer, useAudioElapsed } from "./RecorderTimer";
import { voiceNoteRoute } from "./RouteLine";
import { SavedReceipt } from "./SavedReceipt";
import { TranscriptionRouteControl } from "./TranscriptionRouteControl";

export interface RecordingViewProps {
  recorder: RecorderValue;
  onOpenNote?: (id: string) => void;
  consentAsking?: boolean;
  discardAsking?: boolean;
}

export function RecordingView({ recorder, onOpenNote, consentAsking, discardAsking }: RecordingViewProps) {
  const { phase, mic, outcome, lastSaved } = recorder;
  const active = phase === "recording";
  const warning = active && micWarning(mic) ? micWarningSentence(mic) : null;
  const receipt = phase === "idle" && outcome !== null;
  const audioElapsed = useAudioElapsed(recorder.audioMs ?? 0, active && (mic.state === "recording" || mic.state === "silenced"));
  const transcribing = outcome === "saved" && recorder.transcription?.availability === "available" &&
    recorder.transcription.consented && !!lastSaved && lastSaved.durationMs <= recorder.transcription.maxSeconds * 1000;
  const paused = mic.state === "paused" || mic.state === "interrupted" || mic.state === "needs_user";

  return (
    <div data-testid="voice-note-recorder" data-phase={phase} className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <header className="flex min-h-14 shrink-0 items-center justify-between gap-3 px-4 pt-[env(safe-area-inset-top)] land:px-[max(1.25rem,env(safe-area-inset-left))]">
        <Button type="button" variant="ghost" size="icon" className="size-11 shrink-0" aria-label="Minimise recorder" onClick={recorder.minimiseSheet} data-testid="recorder-minimise"><ChevronDownIcon className="!size-5" /></Button>
        <p role="status" data-testid="voice-note-status" data-mic-state={active ? mic.state : "idle"} data-mic-reason={active ? mic.reason ?? "" : ""} className={cn("flex items-center gap-2 rounded-full bg-surface-2 px-3 py-1.5 text-callout font-semibold", paused || warning ? "text-warning" : "text-foreground")}>
          {receipt ? <CheckIcon className="size-4 text-primary" aria-hidden /> : <span className={cn("size-2.5 rounded-full", paused ? "bg-muted-foreground" : warning ? "bg-warning" : "bg-live motion-safe:animate-live-pulse")} aria-hidden />}
          {receipt ? "Saved on this phone" : recorderStatusText(phase, mic, recorder.savePercent)}
        </p>
        <span className="size-11 shrink-0" aria-hidden />
      </header>

      <main className="mx-auto grid min-h-0 w-full max-w-xl flex-1 grid-cols-1 grid-rows-[auto_minmax(0,1fr)_auto] gap-4 overflow-y-auto px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-4 land:max-w-[72rem] land:grid-cols-2 land:grid-rows-[minmax(0,1fr)_auto] land:gap-x-10 land:px-[max(1.5rem,env(safe-area-inset-left))]">
        <div className="flex min-w-0 flex-col items-center justify-center text-center land:col-start-1 land:row-start-1">
          <RecorderTimer startedAt={recorder.startedAt} audioMs={recorder.audioMs} running={active && (mic.state === "recording" || mic.state === "silenced")} fixedMs={receipt ? lastSaved?.durationMs ?? 0 : undefined} className="font-display text-[4.25rem] leading-tight tracking-[-0.025em] sm:text-[5rem]" />
          {!receipt && <p className="tnum text-meta text-muted-foreground" data-testid="recorder-meta">{recorderMetaText(recorder.startedAt, audioElapsed, recorder.maxDurationMs)}</p>}
          {!receipt && <LevelTrace subscribe={recorder.subscribeLevel} variant="waveform" tone={warning ? "warning" : "live"} paused={!active || paused} className="mt-10 h-32 max-w-[36rem] land:mt-6" />}
          {warning && <p className="mt-5 flex items-start gap-2 text-callout text-warning"><MicOffIcon className="mt-0.5 size-4 shrink-0" aria-hidden />{warning}</p>}
          {paused && <p className="mt-5 text-callout text-warning">{mic.state === "paused" ? "Paused · microphone off" : "Recording interrupted · tap Resume to continue"}</p>}
          {(mic.state === "interrupted" || mic.state === "needs_user") && <Button type="button" size="lg" onClick={recorder.resume} className="mt-5 min-h-12 min-w-36" data-testid="voice-note-resume-main">Resume</Button>}
          {recorder.limitNotice && !active && <p data-testid="voice-note-limit" className="mt-4 text-callout text-warning">{recorder.limitNotice}</p>}
          {recorder.error && !receipt && <p role="alert" className="mt-4 text-callout text-destructive">{recorder.error}</p>}
        </div>

        <div className="flex min-h-0 flex-col justify-end land:col-start-2 land:row-start-1">
          {receipt ? (
            <SavedReceipt outcome={outcome} saved={lastSaved} route={voiceNoteRoute(outcome === "saved" && transcribing)} transcribing={transcribing} error={recorder.error} retrying={recorder.pending.running}
              onOpen={outcome === "saved" && onOpenNote && lastSaved ? () => { recorder.dismissOutcome(); onOpenNote(lastSaved.id); } : undefined}
              onDone={recorder.dismissOutcome} onSaveNow={recorder.retryPending} onPlayingChange={recorder.setReceiptPlaying} />
          ) : (
            <TranscriptionRouteControl transcription={recorder.transcription} defaultAsking={consentAsking} />
          )}
        </div>
        {!receipt && <div className="land:col-start-2 land:row-start-2"><RecorderControls recorder={recorder} discardAsking={discardAsking} /></div>}
      </main>
    </div>
  );
}
