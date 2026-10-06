// The Voice notes list on Capture (TC-761, PR4), in the Exo mobile app only:
// the notes in the user's space, played back from it, and each one's
// transcript, progress or Transcribe (when private cloud transcription is
// available to this build and account). Recording is the recorder's (Record
// bar, sheet, island); this card is the old Voice notes card's list half.
//
// It reads through the per-space queue and re-lists when something lands
// (captureEvents) and when a transcript is saved. Notes still only on this
// phone are In progress rows (capture/InProgressRows), not here.
import { useCallback, useEffect, useMemo, useRef, useState, type FC } from "react";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { FileTextIcon, Loader2Icon, MicIcon, PlayIcon, RefreshCwIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { SectionCard } from "@/components/ui/section-card";
import { captureEvents } from "@/capture/captureEvents";
import { formatDuration } from "@/capture/recorder/recorderCopy";
import { useRecorder } from "@/capture/recorder/RecorderProvider";
import { TranscriptionRouteControl } from "@/capture/recorder/TranscriptionRouteControl";
import type { VoiceNoteTranscriptionProps } from "@/capture/recorder/transcriptionProps";
import { scheduledSpace } from "@/lib/spaceQueue";
import { listVoiceNotes, loadVoiceNoteAudioBlob, type VoiceNoteListItem } from "@/lib/voiceNotes/voiceNoteStore";
import { transcriptionStatusText, voiceNoteTranscriberFor } from "@/lib/voiceNotes/voiceNoteTranscription";

export interface VoiceNotesListViewProps {
  notes: VoiceNoteListItem[];
  notesStatus: "loading" | "ready" | "error";
  /** `src` is an object URL once the audio is loaded; `percent` how much of it has been read. */
  playing: { sourceId: string; src: string | null; percent?: number | null } | null;
  error?: string | null;
  onPlay: (sourceId: string) => void;
  /** Absent outside a build that can transcribe; nothing about transcription is shown then. */
  transcription?: VoiceNoteTranscriptionProps;
}

/** One note's transcript, progress or failure; null when there is nothing to show or offer. */
function NoteTranscription({
  note,
  transcription,
}: {
  note: VoiceNoteListItem;
  transcription: VoiceNoteTranscriptionProps | undefined;
}) {
  if (note.transcript.status === "transcribed") {
    return (
      <p data-testid="voice-note-transcript" className="mt-1 line-clamp-3 whitespace-pre-wrap text-xs text-foreground/80">
        {note.transcript.preview}
      </p>
    );
  }
  if (note.transcript.status === "no_speech") {
    return (
      <p data-testid="voice-note-no-speech" className="mt-1 text-xs text-muted-foreground">
        No speech was found in this note.
      </p>
    );
  }
  if (!transcription) return null;
  const job = transcription.jobs.get(note.sourceId);
  // Saved just now; the list has not caught up yet. Never offer Transcribe again meanwhile.
  if (job?.kind === "done") {
    return (
      <p data-testid="voice-note-transcription-done" className="mt-1 text-xs text-muted-foreground">
        {job.outcome === "no_speech" ? "No speech was found in this note." : "Transcript saved."}
      </p>
    );
  }
  if (job?.kind === "active") {
    return (
      <p role="status" data-testid="voice-note-transcription-status" className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2Icon className="size-3 animate-spin" aria-hidden /> {transcriptionStatusText(job.status)}
      </p>
    );
  }
  const offered = transcription.availability === "available" && transcription.consented;
  if (job?.kind === "failed") {
    return (
      <div className="mt-1 flex items-start gap-2" data-testid="voice-note-transcription-failed">
        <p role="alert" className="min-w-0 flex-1 text-xs text-destructive">
          {job.message}
          {job.reference && <span className="text-muted-foreground"> Reference: {job.reference}</span>}
        </p>
        {offered && job.retryable && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => transcription.onTranscribe(note.sourceId)}
            data-testid="voice-note-transcribe-retry"
          >
            <RefreshCwIcon className="size-4" /> Retry
          </Button>
        )}
      </div>
    );
  }
  if (!offered) return null;
  if (note.durationSecs !== null && note.durationSecs > transcription.maxSeconds) {
    return (
      <p data-testid="voice-note-too-long" className="mt-1 text-xs text-muted-foreground">
        Notes up to {Math.round(transcription.maxSeconds / 60)} minutes can be transcribed from the phone.
      </p>
    );
  }
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      className="mt-1"
      onClick={() => transcription.onTranscribe(note.sourceId)}
      data-testid="voice-note-transcribe"
    >
      <FileTextIcon className="size-4" /> Transcribe
    </Button>
  );
}

/**
 * Where new notes' audio goes, offered only when there is a choice to make or
 * news about it: private cloud is available to this build and account, or the
 * user chose it and it is unreachable. The recorder's route control: the
 * heading, Off · Private cloud, one short line, the one-time question when
 * Private cloud is chosen, and How it works for the rest.
 */
function CardTranscription({ transcription }: { transcription: VoiceNoteTranscriptionProps | undefined }) {
  if (!transcription) return null;
  const offered = transcription.availability === "available" || (transcription.availability === "failed" && transcription.consented);
  if (!offered) return null;
  return <TranscriptionRouteControl transcription={transcription} className="mt-3 rounded-md border border-border px-3 py-3" />;
}

export const VoiceNotesListView: FC<VoiceNotesListViewProps> = (props) => {
  const { notes, notesStatus, playing, transcription, error } = props;
  return (
    <SectionCard icon={MicIcon} title="Voice notes">
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}

      <CardTranscription transcription={transcription} />

      <div className="mt-4">
        {notesStatus === "loading" && <p className="text-xs text-muted-foreground">Loading your voice notes…</p>}
        {notesStatus === "error" && <p className="text-xs text-muted-foreground">Could not load your voice notes.</p>}
        {notesStatus === "ready" && notes.length === 0 && (
          <p className="text-xs text-muted-foreground">No voice notes yet.</p>
        )}
        {notes.length > 0 && (
          <ul className="flex flex-col divide-y divide-border">
            {notes.map((note) => (
              <li key={note.id} data-testid="voice-note-item" data-source-id={note.sourceId} className="py-2">
                <div className="flex items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">{note.title ?? "Voice note"}</p>
                    {note.durationSecs !== null && (
                      <p className="text-xs text-muted-foreground">{formatDuration(note.durationSecs * 1000)}</p>
                    )}
                  </div>
                  <Button type="button" size="sm" variant="ghost" onClick={() => props.onPlay(note.sourceId)} aria-label="Play voice note">
                    <PlayIcon className="size-4" />
                  </Button>
                </div>
                <NoteTranscription note={note} transcription={transcription} />
                {playing?.sourceId === note.sourceId && (
                  playing.src ? (
                    <audio className="mt-2 w-full" controls autoPlay src={playing.src} data-testid="voice-note-player" />
                  ) : (
                    <p className="mt-1 text-xs text-muted-foreground" data-testid="voice-note-player-loading">
                      Loading audio…{typeof playing.percent === "number" ? ` ${playing.percent}%` : ""}
                    </p>
                  )
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </SectionCard>
  );
};

/** The list, read from the user's space; renders nothing outside the Exo mobile app. */
export function VoiceNotesListCard(props: { tcw: TinyCloudWeb; backendUrl: string; sessionStore: SessionStore }) {
  const recorder = useRecorder();
  if (!recorder.available) return null;
  return <VoiceNotesList {...props} />;
}

function VoiceNotesList({ tcw, backendUrl, sessionStore }: { tcw: TinyCloudWeb; backendUrl: string; sessionStore: SessionStore }) {
  const recorder = useRecorder();
  const space = useMemo(() => scheduledSpace(tcw), [tcw]);
  const [notes, setNotes] = useState<VoiceNoteListItem[]>([]);
  const [notesStatus, setNotesStatus] = useState<"loading" | "ready" | "error">("loading");
  const [playing, setPlaying] = useState<{ sourceId: string; src: string | null; percent: number | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  /** The object URL being played; revoked when replaced or on unmount. */
  const playingUrl = useRef<string | null>(null);
  const playRequest = useRef(0);

  const refresh = useCallback(async () => {
    const res = await listVoiceNotes(space);
    if (!mounted.current) return;
    if (res.ok) {
      setNotes(res.data);
      setNotesStatus("ready");
    } else {
      setNotesStatus("error");
    }
  }, [space]);

  // Listed on mount, again when something lands, and when a transcript is saved.
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const offLanded = captureEvents.on("library-changed", () => void refresh());
    // Null in a build without private cloud transcription.
    const offSaved = voiceNoteTranscriberFor(tcw, backendUrl, sessionStore)?.subscribe((event) => {
      if (event.kind === "saved") void refresh();
    });
    return () => {
      mounted.current = false;
      offLanded();
      offSaved?.();
    };
  }, [backendUrl, refresh, sessionStore, tcw]);

  useEffect(
    () => () => {
      if (playingUrl.current) URL.revokeObjectURL(playingUrl.current);
      playingUrl.current = null;
    },
    [],
  );

  const onPlay = useCallback(
    async (sourceId: string) => {
      playRequest.current++;
      if (playingUrl.current) URL.revokeObjectURL(playingUrl.current);
      playingUrl.current = null;
      const request = playRequest.current;
      setError(null);
      setPlaying({ sourceId, src: null, percent: null });
      const res = await loadVoiceNoteAudioBlob(space, sourceId, {
        onProgress: (loaded, total) => {
          if (!mounted.current || playRequest.current !== request || total <= 0) return;
          setPlaying({ sourceId, src: null, percent: Math.floor((loaded / total) * 100) });
        },
      });
      if (!mounted.current || playRequest.current !== request) return;
      if (!res.ok) {
        setPlaying(null);
        setError(`Could not load that voice note: ${res.error.message}`);
        return;
      }
      const url = URL.createObjectURL(res.data);
      playingUrl.current = url;
      setPlaying({ sourceId, src: url, percent: null });
    },
    [space],
  );

  return (
    <VoiceNotesListView
      notes={notes}
      notesStatus={notesStatus}
      playing={playing}
      error={error}
      onPlay={(id) => void onPlay(id)}
      transcription={recorder.transcription}
    />
  );
}
