// The chat screen's one-tap voice note (TC-522), inside the Exo mobile app only.
//
// The chat header's voice note button opens this bar under the header: it
// starts recording at once and shows the live state, the OS mic-state copy and
// Stop without leaving the chat. It is the Voice notes card's own controller
// (`VoiceNotesSection`) with a compact view, so recording, saving, the pending
// retry and the transcription hand-off are the card's, and a saved note shows
// up in Capture and its Library exactly as one recorded there.
//
// The bar is never mounted next to the card: it lives on Chat only, and the
// card on Capture picks a running recording up instead.

import { useCallback, useState, type FC } from "react";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { CheckCircle2Icon, Loader2Icon, MicIcon, SquareIcon, XIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { captureEvents } from "@/capture/captureEvents";
import type { MicState, MicStateReason } from "@/lib/voiceNotes/nativeVoiceNotes";
import { VoiceNotesSection, micStatusText, type RecorderPhase } from "./VoiceNotesSection";

export interface QuickVoiceNoteViewProps {
  phase: RecorderPhase;
  mic: { state: MicState; reason: MicStateReason };
  elapsedMs: number;
  level: number;
  error: string | null;
  /** Recordings still only on this phone (a save failed or was interrupted). */
  pendingCount: number;
  /** The last recording made here is in the user's space. */
  saved: boolean;
  onStop: () => void;
  onRecord: () => void;
  onClose: () => void;
  onOpenLibrary: () => void;
}

export const QuickVoiceNoteView: FC<QuickVoiceNoteViewProps> = (props) => {
  const { phase, mic, elapsedMs, level, error, pendingCount, saved } = props;
  const live = phase === "recording";
  const idle = phase === "idle";
  const warn = live && (mic.state === "silenced" || mic.reason === "no_signal");

  return (
    <section
      aria-label="Voice note"
      data-testid="quick-voice-note"
      className="border-b border-border bg-muted/40 px-3 py-2 sm:px-4"
    >
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p
            role="status"
            data-testid="quick-voice-note-status"
            data-mic-state={live ? mic.state : "idle"}
            data-mic-reason={live ? mic.reason ?? "" : ""}
            className={`flex items-center gap-2 text-sm ${warn ? "text-amber-600 dark:text-amber-400" : live || saved ? "text-foreground" : "text-muted-foreground"}`}
          >
            {live ? (
              <span className={`inline-block size-2 shrink-0 rounded-full ${warn ? "bg-amber-500" : "bg-red-500"}`} aria-hidden />
            ) : idle && saved ? (
              <CheckCircle2Icon className="size-4 shrink-0 text-primary" aria-hidden />
            ) : idle ? (
              <MicIcon className="size-4 shrink-0" aria-hidden />
            ) : (
              <Loader2Icon className="size-4 shrink-0 animate-spin" aria-hidden />
            )}
            <span className="min-w-0">
              {idle && saved ? "Saved to your TinyCloud space." : micStatusText(phase, mic, elapsedMs)}
            </span>
          </p>
          {live && (
            <div className="mt-1 h-1 w-full overflow-hidden rounded bg-muted" aria-hidden>
              <div className="h-full bg-foreground/60 transition-[width] duration-150" style={{ width: `${Math.round(level * 100)}%` }} />
            </div>
          )}
          {idle && saved && (
            <button
              type="button"
              onClick={props.onOpenLibrary}
              className="ml-6 py-1 text-xs font-medium underline underline-offset-2"
              data-testid="quick-voice-note-library"
            >
              Open Library
            </button>
          )}
        </div>
        {(live || phase === "starting") && (
          <Button
            type="button"
            variant="destructive"
            onClick={props.onStop}
            disabled={!live}
            className="h-11 shrink-0 md:h-9"
            data-testid="quick-voice-note-stop"
          >
            <SquareIcon className="size-4" /> Stop
          </Button>
        )}
        {idle && (
          <>
            <Button
              type="button"
              variant="outline"
              onClick={props.onRecord}
              className="h-11 shrink-0 md:h-9"
              data-testid="quick-voice-note-record"
            >
              <MicIcon className="size-4" /> Record
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={props.onClose}
              aria-label="Close voice note"
              className="h-11 w-11 shrink-0 p-0 md:h-9 md:w-9"
              data-testid="quick-voice-note-close"
            >
              <XIcon className="size-4" />
            </Button>
          </>
        )}
      </div>

      {error && (
        <p role="alert" className="mt-1 text-xs text-destructive">
          {error}
        </p>
      )}

      {idle && pendingCount > 0 && (
        <p className="mt-1 text-xs text-muted-foreground" data-testid="quick-voice-note-pending">
          {pendingCount === 1 ? "1 note is" : `${pendingCount} notes are`} on this phone but not yet in your TinyCloud
          space. Exo saves them the next time it opens, or from Voice notes in Capture.
        </p>
      )}
    </section>
  );
};

export interface QuickVoiceNoteProps {
  /**
   * Record as soon as it opens (the header button). False only shows a recording that is
   * already running (one started on the offline screen, TC-515): never a new one.
   */
  autoStart?: boolean;
  tcw: TinyCloudWeb;
  backendUrl: string;
  sessionStore: SessionStore;
  onClose: () => void;
  onOpenLibrary: () => void;
}

/** Renders nothing outside the Exo mobile app (VoiceNotesSection's gate). */
export function QuickVoiceNote({ autoStart = true, tcw, backendUrl, sessionStore, onClose, onOpenLibrary }: QuickVoiceNoteProps) {
  const [saved, setSaved] = useState(false);
  const onSaved = useCallback(() => {
    setSaved(true);
    // The Library re-lists if it is open (Capture keeps it mounted).
    captureEvents.emit("library-changed");
  }, []);
  return (
    <VoiceNotesSection
      tcw={tcw}
      backendUrl={backendUrl}
      sessionStore={sessionStore}
      autoStart={autoStart}
      onSaved={onSaved}
      render={(view) => (
        <QuickVoiceNoteView
          phase={view.phase}
          mic={view.mic}
          elapsedMs={view.elapsedMs}
          level={view.level}
          error={view.error}
          pendingCount={view.pendingCount}
          saved={saved}
          onStop={view.onStop}
          onRecord={() => {
            setSaved(false);
            view.onRecord();
          }}
          onClose={onClose}
          onOpenLibrary={onOpenLibrary}
        />
      )}
    />
  );
}
