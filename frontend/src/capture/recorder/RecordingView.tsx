import { useEffect, useState } from "react";
import { CheckIcon, ChevronDownIcon, MicOffIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { VoiceNotes, type NoteSttState, type TranscriberId } from "@/lib/voiceNotes/nativeVoiceNotes";
import { LevelTrace } from "./LevelTrace";
import { MicrophoneAccessOff } from "./MicrophoneAccessOff";
import { micWarning, micWarningSentence, recorderMetaText, recorderStatusText } from "./recorderCopy";
import { RecorderControls } from "./RecorderControls";
import { honestRecorderError } from "./final/honestRecorderError";
import type { RecorderValue } from "./RecorderProvider";
import { RecorderTimer, useAudioElapsed } from "./RecorderTimer";
import { voiceNoteRoute } from "./RouteLine";
import { SavedReceipt } from "./SavedReceipt";
import { TranscriptionRouteControl } from "./TranscriptionRouteControl";

/**
 * `lastSaved` (recorderReducer.ts) carries only id/durationMs/at, so the receipt looks the note's
 * own transcriber and durable on-device STT state up directly, in one native `listPending()` read
 * shared with SavedReceipt's on-device receipt (`sttHint`) — not a second one. Android's
 * `listPending()` runs a full recovery scan over every note on the phone before it answers; two of
 * them firing on every Stop (one here, one inside SavedReceipt) serialize behind that scan's lock,
 * and on a phone with many notes that reliably outran the saved receipt's fixed display window,
 * closing it before anything useful rendered (TC-781, "Stop loses the local playback receipt").
 */
function useSavedNote(id: string | undefined): { transcriber: TranscriberId | null; stt: NoteSttState | null } {
  const [note, setNote] = useState<{ transcriber: TranscriberId | null; stt: NoteSttState | null }>({ transcriber: null, stt: null });
  useEffect(() => {
    setNote({ transcriber: null, stt: null });
    if (!id) return;
    let active = true;
    VoiceNotes.listPending()
      .then(({ recordings }) => {
        if (!active) return;
        const found = recordings.find((recording) => recording.id === id);
        setNote({ transcriber: (found?.options?.transcriber as TranscriberId | undefined) ?? null, stt: found?.stt ?? null });
      })
      .catch(() => {
        // Best-effort: the receipt falls back to the private-cloud/off line below.
      });
    return () => {
      active = false;
    };
  }, [id]);
  return note;
}

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
  const audioElapsed = useAudioElapsed(recorder.audioMs, active && (mic.state === "recording" || mic.state === "silenced"));
  const transcribing = outcome === "saved" && recorder.transcription?.availability === "available" &&
    recorder.transcription.consented && !!lastSaved && lastSaved.durationMs <= recorder.transcription.maxSeconds * 1000;
  // Looked up for every outcome with a note (not just "saved"): a signed-out or offline on-device
  // recording lands as "local" and must still show its real route and transcript.
  const savedNote = useSavedNote(lastSaved?.id);
  const savedTranscriber = savedNote.transcriber;
  const savedRoute = savedTranscriber === "on-device" ? "on-device" : transcribing ? "private-cloud" : "off";
  const paused = mic.state === "paused" || mic.state === "interrupted" || mic.state === "needs_user";

  if (recorder.permissionDenied) return <MicrophoneAccessOff onMinimise={recorder.minimiseSheet} onOpenSettings={recorder.openSettings} />;

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
          <RecorderTimer audioMs={recorder.audioMs} running={active && (mic.state === "recording" || mic.state === "silenced")} fixedMs={receipt ? lastSaved?.durationMs ?? 0 : undefined} className="font-display text-[4.25rem] leading-tight tracking-[-0.025em] sm:text-[5rem]" />
          {!receipt && <p className="tnum text-meta text-muted-foreground" data-testid="recorder-meta">{recorderMetaText(recorder.startedAt, audioElapsed, recorder.maxDurationMs)}</p>}
          {active && mic.input && <p className="mt-2 text-meta text-muted-foreground" data-testid="recorder-active-input">Using {mic.input.name}</p>}
          {!receipt && <LevelTrace subscribe={recorder.subscribeLevel} variant="waveform" tone={paused ? "muted" : warning ? "warning" : "live"} paused={!active || paused} className="mt-10 h-32 max-w-[36rem] land:mt-6" />}
          {warning && <p className="mt-5 flex items-start gap-2 text-callout text-warning"><MicOffIcon className="mt-0.5 size-4 shrink-0" aria-hidden />{warning}</p>}
          {paused && <p className="mt-5 text-callout text-warning">{mic.state === "paused" ? "Paused · microphone off" : mic.state === "interrupted" ? "Recording interrupted · trying to resume" : "Recording needs you · tap Resume to continue"}</p>}
          {mic.state === "needs_user" && <Button type="button" size="lg" onClick={recorder.resume} disabled={recorder.controlPending !== null} className="mt-5 min-h-12 min-w-36" data-testid="voice-note-resume-main">Resume</Button>}
          {recorder.limitNotice && !active && <p data-testid="voice-note-limit" className="mt-4 text-callout text-warning">{recorder.limitNotice}</p>}
          {recorder.error && !receipt && <p role="alert" className="mt-4 text-callout text-destructive">{honestRecorderError(recorder)}</p>}
        </div>

        <div className="flex min-h-0 flex-col justify-end land:col-start-2 land:row-start-1">
          {receipt ? (
            <SavedReceipt outcome={outcome} localUpload={recorder.localUpload} saved={lastSaved} route={voiceNoteRoute(savedRoute)} transcriber={savedTranscriber} sttHint={savedNote.stt} transcribing={transcribing} error={honestRecorderError(recorder)} retrying={recorder.pending.running}
              onOpen={onOpenNote && lastSaved ? () => { recorder.dismissOutcome(); onOpenNote(lastSaved.id); } : undefined}
              onDone={recorder.dismissOutcome} onSaveNow={recorder.retryPending} onPlayingChange={recorder.setReceiptPlaying} onReady={recorder.setReceiptReady} />
          ) : (
            <TranscriptionRouteControl transcription={recorder.transcription} signedIn={recorder.signedIn}
              recorder={recorder} defaultAsking={consentAsking} />
          )}
        </div>
        {!receipt && <div className="land:col-start-2 land:row-start-2"><RecorderControls recorder={recorder} discardAsking={discardAsking} /></div>}
      </main>
    </div>
  );
}
