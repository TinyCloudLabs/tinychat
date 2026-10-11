import { useEffect, useState } from "react";
import { CheckIcon, ChevronDownIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { VoiceNotes, type NoteSttState, type TranscriberId } from "@/lib/voiceNotes/nativeVoiceNotes";
import { MicrophoneAccessOff } from "./MicrophoneAccessOff";
import { honestRecorderError, receiptPartialNotice } from "./final/honestRecorderError";
import type { RecorderValue } from "./RecorderProvider";
import { RecorderTimer } from "./RecorderTimer";
import { privateInsteadOffered, switchToPrivate } from "./privateInstead";
import { voiceNoteRoute } from "./RouteLine";
import { SavedReceipt } from "./SavedReceipt";

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

export interface ReceiptViewProps {
  recorder: RecorderValue;
  onOpenNote?: (id: string) => void;
}

/**
 * Where a saved note stands now. A Local note is only in private cloud once the user moved it there
 * ("Use Private instead"); until then private cloud is not transcribing it, whatever is available.
 */
export function receiptRouting(args: {
  outcome: RecorderValue["outcome"];
  lastSaved: RecorderValue["lastSaved"];
  transcription: RecorderValue["transcription"];
  savedTranscriber: TranscriberId | null;
}) {
  const { outcome, lastSaved, transcription, savedTranscriber } = args;
  const privateJob = lastSaved ? transcription?.jobs.get(lastSaved.id) : undefined;
  const movedToPrivate = savedTranscriber === "on-device" && privateJob !== undefined;
  // Only a job that is really running says "Transcribing": availability alone never does, and a
  // note committed to Audio only or to Local (not moved) has no private job to speak of.
  const transcribing = outcome === "saved" && savedTranscriber !== "off" && privateJob?.kind === "active";
  const savedRoute = savedTranscriber === "on-device" && !movedToPrivate ? "on-device"
    : savedTranscriber === "off" ? "off"
    : privateJob !== undefined ? "private-cloud" : "off";
  const privateOutcome = savedTranscriber !== "off" && privateJob?.kind === "done" ? privateJob.outcome : null;
  const canUsePrivate = outcome === "saved" && savedTranscriber === "on-device" && !!lastSaved &&
    privateInsteadOffered(transcription, lastSaved.id, lastSaved.durationMs / 1000);
  return { transcribing, movedToPrivate, savedRoute, privateJob, privateOutcome, canUsePrivate } as const;
}

/** The full-page receipt once a recording has ended: saved, kept on this phone, or failed (Save now). */
export function ReceiptView({ recorder, onOpenNote }: ReceiptViewProps) {
  const { phase, outcome, lastSaved } = recorder;
  // Looked up for every outcome with a note (not just "saved"): a signed-out or offline on-device
  // recording lands as "local" and must still show its real route and transcript.
  const savedNote = useSavedNote(lastSaved?.id);
  const savedTranscriber = savedNote.transcriber;
  const { transcribing, movedToPrivate, savedRoute, privateJob, privateOutcome, canUsePrivate } = receiptRouting({ outcome, lastSaved, transcription: recorder.transcription, savedTranscriber });
  const transcription = recorder.transcription;
  const usePrivate = canUsePrivate && lastSaved && transcription ? () => switchToPrivate(transcription, lastSaved.id) : undefined;

  if (recorder.permissionDenied) return <MicrophoneAccessOff onMinimise={recorder.minimiseSheet} onOpenSettings={recorder.openSettings} onTryAgain={recorder.record} />;
  if (outcome === null) throw new Error("ReceiptView mounted without an outcome");

  return (
    <div data-testid="voice-note-recorder" data-phase={phase} className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <header className="flex min-h-14 shrink-0 items-center justify-between gap-3 px-4 pt-[env(safe-area-inset-top)] land:px-[max(1.25rem,env(safe-area-inset-left))]">
        <Button type="button" variant="ghost" size="icon" className="size-11 shrink-0" aria-label="Minimise recorder" onClick={recorder.minimiseSheet} data-testid="recorder-minimise"><ChevronDownIcon className="!size-5" /></Button>
        <p role="status" data-testid="voice-note-status" data-mic-state="idle" data-mic-reason="" className="flex items-center gap-2 rounded-full bg-surface-2 px-3 py-1.5 text-callout font-semibold text-foreground">
          <CheckIcon className="size-4 text-primary" aria-hidden />
          Saved on this phone
        </p>
        <span className="size-11 shrink-0" aria-hidden />
      </header>

      <main className="mx-auto grid min-h-0 w-full max-w-xl flex-1 grid-cols-1 grid-rows-[auto_auto] content-start gap-4 overflow-y-auto px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-4 land:max-w-[72rem] land:grid-cols-2 land:grid-rows-[minmax(0,1fr)_auto] land:gap-x-10 land:px-[max(1.5rem,env(safe-area-inset-left))]">
        <div className="flex min-w-0 flex-col items-center justify-center text-center land:col-start-1 land:row-start-1">
          <RecorderTimer audioMs={recorder.audioMs} running={false} fixedMs={lastSaved?.durationMs ?? 0} className="font-display text-[4.25rem] leading-tight tracking-[-0.025em] sm:text-[5rem]" />
          {recorder.limitNotice && <p data-testid="voice-note-limit" className="mt-4 text-callout text-warning">{recorder.limitNotice}</p>}
        </div>

        <div className="flex min-h-0 flex-col justify-start land:col-start-2 land:row-start-1 land:justify-end">
          <SavedReceipt outcome={outcome} localUpload={recorder.localUpload} saved={lastSaved} route={voiceNoteRoute(savedRoute)} transcriber={savedTranscriber} sttHint={savedNote.stt} transcribing={transcribing} held={privateJob?.kind === "held" ? privateJob.message : null} movedToPrivate={movedToPrivate} privateFailure={savedTranscriber !== "off" && privateJob?.kind === "failed" ? privateJob.message : null} privateOutcome={privateOutcome} error={honestRecorderError(recorder)} notice={receiptPartialNotice(recorder, lastSaved?.id)} retrying={recorder.pending.running}
            onOpen={onOpenNote && lastSaved ? () => { recorder.dismissOutcome(); onOpenNote(lastSaved.id); } : undefined}
            onDone={recorder.dismissOutcome} onSaveNow={recorder.retryPending} onPlayingChange={recorder.setReceiptPlaying} onReady={recorder.setReceiptReady} onUsePrivate={usePrivate} onActionableChange={recorder.setReceiptActionable} />
        </div>
      </main>
    </div>
  );
}
