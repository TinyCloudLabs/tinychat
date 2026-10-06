// The VOICE NOTES card on Capture, shown only inside the Exo
// mobile app (the native plugin is the capture engine). Record on the device,
// save to the user's TinyCloud space, play back from the space, and (when
// private cloud transcription is available to this build and account)
// transcribe each note into its transcript, which Library and meeting chat read.
//
// `VoiceNotesView` is the whole rendered surface and a pure function of its
// props; `VoiceNotesSection` owns the plugin, its OS mic-state events, the
// storage calls and the transcription queue.
//
// A recording is capped (VOICE_NOTE_MAX_DURATION_MS, 60 minutes) by the native
// recorder itself; when it stops there, its "autoStopped" event is saved exactly
// like a Stop, and the card says it stopped at the limit.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type FC, type ReactNode } from "react";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { FileTextIcon, Loader2Icon, MicIcon, PlayIcon, RefreshCwIcon, SquareIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { SectionCard } from "@/components/ui/section-card";
import {
  VoiceNotes,
  nativeVoiceNotesAvailable,
  voiceNoteMaxDurationMs,
  VOICE_NOTE_MAX_DURATION_MS,
  type MicState,
  type MicStateReason,
  type VoiceNoteAutoStopEvent,
  type VoiceNoteRecording,
} from "@/lib/voiceNotes/nativeVoiceNotes";
import { errorCode, messageOf, saveRecording, savePendingRecordings } from "@/lib/voiceNotes/recorderSaves";
import { listVoiceNotes, loadVoiceNoteAudioBlob, type VoiceNoteListItem } from "@/lib/voiceNotes/voiceNoteStore";
import { transcriptionStatusText, voiceNoteTranscriberFor } from "@/lib/voiceNotes/voiceNoteTranscription";
import { formatDuration, limitNoticeText, micStatusText } from "@/capture/recorder/recorderCopy";
import type { RecorderPhase } from "@/capture/recorder/recorderReducer";
import {
  HIDDEN_SNAPSHOT,
  noSubscription,
  transcriptionProps,
  type VoiceNoteTranscriptionProps,
} from "@/capture/recorder/transcriptionProps";
import { PrivateCloudDisclosure } from "./PrivateCloudDisclosure";

// Moved in TC-761 (PR4); re-exported for the card's callers until the card is split.
export { formatDuration, formatLimit, limitNoticeText, micStatusText } from "@/capture/recorder/recorderCopy";
export type { RecorderPhase } from "@/capture/recorder/recorderReducer";
export { transcriptionProps, type VoiceNoteTranscriptionProps } from "@/capture/recorder/transcriptionProps";
export { savePendingRecordings, type PendingRun } from "@/lib/voiceNotes/recorderSaves";

export interface VoiceNotesViewProps {
  phase: RecorderPhase;
  mic: { state: MicState; reason: MicStateReason };
  elapsedMs: number;
  level: number;
  error: string | null;
  notes: VoiceNoteListItem[];
  notesStatus: "loading" | "ready" | "error";
  /** `src` is an object URL once the audio is loaded; `percent` how much of it has been read. */
  playing: { sourceId: string; src: string | null; percent?: number | null } | null;
  /** The current recording's length limit (shown as it gets close). */
  maxDurationMs?: number;
  /** Set when the recorder stopped itself at the limit, e.g. "Stopped at the 60-minute limit." */
  limitNotice?: string | null;
  /** How much of the note being saved is stored (a 60-minute note is about 30 parts). */
  savePercent?: number | null;
  /** Recordings still only on this phone (a save failed or was interrupted). */
  pendingCount: number;
  retrying: boolean;
  onRecord: () => void;
  onStop: () => void;
  onPlay: (sourceId: string) => void;
  onRetry: () => void;
  /** Absent outside a build that can transcribe; nothing about transcription is shown then. */
  transcription?: VoiceNoteTranscriptionProps;
}

const VoiceNoteTranscriptionDisclosure: FC<{ maxSeconds: number }> = ({ maxSeconds }) => (
  <PrivateCloudDisclosure
    intro={
      <>
        Transcribe your voice notes so they show up as text in Library and in chat. After a note is saved, its
        audio (notes up to {Math.round(maxSeconds / 60)} minutes) is converted on this phone and uploaded over an
        encrypted connection to <strong>TinyCloud Private Transcription</strong>, a dedicated confidential virtual
        machine on Phala Cloud. It sends short speech segments to <strong>Tinfoil</strong> for speech-to-text.
      </>
    }
    originalStays="The voice note's audio stays in your TinyCloud space; its transcript is saved next to it."
  />
);

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

/** The card-level transcription line: the one-time consent, or how to turn it off / check again. */
function TranscriptionControls({ transcription }: { transcription: VoiceNoteTranscriptionProps | undefined }) {
  if (!transcription) return null;
  if (transcription.availability === "available" && !transcription.consented) {
    return (
      <div className="mt-3 flex flex-col gap-2 rounded-md border border-border px-3 py-2" data-testid="voice-note-transcription-consent">
        <VoiceNoteTranscriptionDisclosure maxSeconds={transcription.maxSeconds} />
        <Button type="button" size="sm" className="w-fit" onClick={transcription.onConsent} data-testid="voice-note-transcription-enable">
          Use private cloud
        </Button>
      </div>
    );
  }
  if (transcription.availability === "available") {
    return (
      <p className="mt-3 text-xs text-muted-foreground" data-testid="voice-note-transcription-on">
        New notes are transcribed in private cloud.{" "}
        <button type="button" className="underline" onClick={transcription.onTurnOff}>
          Turn off
        </button>
      </p>
    );
  }
  // Only someone who chose private cloud hears that it is unreachable; nobody else is offered it.
  if (transcription.availability === "failed" && transcription.consented) {
    return (
      <p className="mt-3 text-xs text-muted-foreground" data-testid="voice-note-transcription-unavailable">
        Private cloud transcription is unavailable right now.{" "}
        <button type="button" className="underline" onClick={transcription.onRecheck}>
          Check again
        </button>
      </p>
    );
  }
  return null;
}

export const VoiceNotesView: FC<VoiceNotesViewProps> = (props) => {
  const { phase, mic, elapsedMs, level, error, notes, notesStatus, playing, pendingCount, retrying, transcription, maxDurationMs, limitNotice, savePercent } = props;
  const live = phase === "recording";
  const busy = phase === "starting" || phase === "stopping" || phase === "saving";
  const warn = live && (mic.state === "silenced" || mic.reason === "no_signal");

  return (
    <SectionCard icon={MicIcon} title="Voice notes">
      <p className="text-xs text-muted-foreground">
        Record a note on this phone (up to {Math.round(VOICE_NOTE_MAX_DURATION_MS / 60_000)} minutes). It is saved to
        your TinyCloud space and shows up in Library. While Exo records, your phone shows its microphone indicator
        and a notification.
      </p>

      <div className="mt-3 flex items-center gap-3">
        {live ? (
          <Button type="button" variant="destructive" onClick={props.onStop} data-testid="voice-note-stop">
            <SquareIcon className="size-4" /> Stop
          </Button>
        ) : (
          <Button type="button" onClick={props.onRecord} disabled={busy} data-testid="voice-note-record">
            {busy ? <Loader2Icon className="size-4 animate-spin" /> : <MicIcon className="size-4" />} Record
          </Button>
        )}
        <div className="min-w-0 flex-1">
          <p
            role="status"
            data-testid="voice-note-status"
            data-mic-state={live ? mic.state : "idle"}
            data-mic-reason={live ? mic.reason ?? "" : ""}
            className={`text-sm ${warn ? "text-amber-600 dark:text-amber-400" : live ? "text-foreground" : "text-muted-foreground"}`}
          >
            {live && <span className={`mr-2 inline-block size-2 rounded-full ${warn ? "bg-amber-500" : "bg-red-500"}`} aria-hidden />}
            {micStatusText(phase, mic, elapsedMs, maxDurationMs)}
            {phase === "saving" && typeof savePercent === "number" ? ` ${savePercent}%` : ""}
          </p>
          {limitNotice && !live && (
            <p data-testid="voice-note-limit" className="mt-1 text-xs text-amber-600 dark:text-amber-400">
              {limitNotice}
            </p>
          )}
          {live && (
            <div className="mt-1 h-1 w-full overflow-hidden rounded bg-muted" aria-hidden>
              <div className="h-full bg-foreground/60 transition-[width] duration-150" style={{ width: `${Math.round(level * 100)}%` }} />
            </div>
          )}
        </div>
      </div>

      {error && (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      )}

      {pendingCount > 0 && (
        <div className="mt-3 flex items-center gap-2 rounded-md border border-border px-3 py-2" data-testid="voice-note-pending">
          <p className="min-w-0 flex-1 text-xs text-muted-foreground">
            {pendingCount === 1 ? "1 note is" : `${pendingCount} notes are`} on this phone but not yet in your
            TinyCloud space.
          </p>
          <Button type="button" size="sm" variant="outline" onClick={props.onRetry} disabled={retrying || busy} data-testid="voice-note-retry">
            {retrying ? <Loader2Icon className="size-4 animate-spin" /> : <RefreshCwIcon className="size-4" />} Save now
          </Button>
        </div>
      )}

      <TranscriptionControls transcription={transcription} />

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

/** The chat screen's one-tap voice note (QuickVoiceNote.tsx) is this same controller with a compact view. */
interface ControllerProps {
  tcw: TinyCloudWeb;
  backendUrl?: string;
  sessionStore?: SessionStore;
  /**
   * The chat screen's one-tap voice note (TC-522): start recording as soon as this mounts,
   * unless a recording is already running (that one is picked up, as after a reload).
   */
  autoStart?: boolean;
  /** A stopped recording was saved to the space. */
  onSaved?: (recording: VoiceNoteRecording) => void;
  /** Another view of the same recorder (the chat screen's bar); the card by default. */
  render?: (view: VoiceNotesViewProps) => ReactNode;
}

function VoiceNotesController({ tcw, backendUrl, sessionStore, autoStart, onSaved, render }: ControllerProps) {
  const [phase, setPhase] = useState<RecorderPhase>(autoStart ? "starting" : "idle");
  const [mic, setMic] = useState<{ state: MicState; reason: MicStateReason }>({ state: "idle", reason: null });
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<VoiceNoteListItem[]>([]);
  const [notesStatus, setNotesStatus] = useState<"loading" | "ready" | "error">("loading");
  const [playing, setPlaying] = useState<{ sourceId: string; src: string | null; percent: number | null } | null>(null);
  const [pending, setPending] = useState<VoiceNoteRecording[]>([]);
  const [retrying, setRetrying] = useState(false);
  const [maxDurationMs, setMaxDurationMs] = useState(VOICE_NOTE_MAX_DURATION_MS);
  const [limitNotice, setLimitNotice] = useState<string | null>(null);
  const [savePercent, setSavePercent] = useState<number | null>(null);
  const mounted = useRef(true);
  /** The object URL being played; revoked when replaced or on unmount. */
  const playingUrl = useRef<string | null>(null);
  const playRequest = useRef(0);
  /** An auto-stopped recording is being saved (a Stop that lost the race must not reset the card). */
  const autoSaving = useRef(false);
  const onAutoStoppedRef = useRef<(event: VoiceNoteAutoStopEvent) => void>(() => {});

  // Private cloud transcription for this account (null without one), shared across mounts.
  const transcriber = useMemo(
    () => (backendUrl !== undefined && sessionStore !== undefined ? voiceNoteTranscriberFor(tcw, backendUrl, sessionStore) : null),
    [backendUrl, sessionStore, tcw],
  );
  const snapshot = useSyncExternalStore(
    transcriber ? transcriber.subscribe : noSubscription,
    () => transcriber?.snapshot() ?? HIDDEN_SNAPSHOT,
  );

  const refresh = useCallback(async () => {
    const res = await listVoiceNotes(tcw);
    if (!mounted.current) return;
    if (res.ok) {
      setNotes(res.data);
      setNotesStatus("ready");
    } else {
      setNotesStatus("error");
    }
  }, [tcw]);

  const retryPending = useCallback(async () => {
    setRetrying(true);
    setError(null);
    try {
      const run = await savePendingRecordings(tcw);
      if (!mounted.current) return;
      setPending(run.left);
      if (run.lastError) setError(`Some notes could not be saved yet: ${run.lastError}`);
      if (run.left.length < run.total) await refresh();
      for (const recording of run.saved) transcriber?.noteSaved(recording);
    } catch (caught) {
      if (mounted.current) setError(messageOf(caught));
    } finally {
      if (mounted.current) setRetrying(false);
    }
  }, [refresh, tcw, transcriber]);

  useEffect(() => {
    mounted.current = true;
    const handles = [
      VoiceNotes.addListener("micState", (event) => setMic({ state: event.state, reason: event.reason })),
      VoiceNotes.addListener("level", (event) => setLevel(event.level)),
      // Retained by the shell until heard, so a reload mid-recording still saves the note.
      VoiceNotes.addListener("autoStopped", (event) => onAutoStoppedRef.current(event)),
    ];
    // A WebView reload mid-recording leaves the native recorder running; pick it back up.
    void VoiceNotes.status().then((status) => {
      if (!mounted.current || status.state === "idle") return;
      setMic({ state: status.state, reason: status.reason });
      setStartedAt(Date.now() - status.elapsedMs);
      if (typeof status.maxDurationMs === "number") setMaxDurationMs(status.maxDurationMs);
      setPhase("recording");
    });
    void refresh();
    // Anything left from an earlier failed save or an app restart gets another try.
    void VoiceNotes.listPending().then(({ recordings }) => {
      if (!mounted.current || recordings.length === 0) return;
      setPending(recordings);
      void retryPending();
    });
    return () => {
      mounted.current = false;
      for (const handle of handles) void handle.then((h) => h.remove());
    };
  }, [refresh, retryPending]);

  useEffect(
    () => () => {
      if (playingUrl.current) URL.revokeObjectURL(playingUrl.current);
      playingUrl.current = null;
    },
    [],
  );

  // A saved transcript refreshes the list (the transcriber outlives this view); availability is
  // checked on every mount.
  useEffect(() => {
    if (transcriber === null) return;
    const unsubscribe = transcriber.subscribe((event) => {
      if (event.kind === "saved" && mounted.current) void refresh();
    });
    void transcriber.check();
    return unsubscribe;
  }, [refresh, transcriber]);

  useEffect(() => {
    if (phase !== "recording") return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [phase]);

  const stopPlayback = useCallback(() => {
    playRequest.current++;
    if (playingUrl.current) URL.revokeObjectURL(playingUrl.current);
    playingUrl.current = null;
    setPlaying(null);
  }, []);

  const onRecord = useCallback(async () => {
    setError(null);
    setLimitNotice(null);
    stopPlayback();
    setPhase("starting");
    try {
      const requested = voiceNoteMaxDurationMs();
      const started = await VoiceNotes.start({ maxDurationMs: requested });
      setStartedAt(started.startedAt);
      setMaxDurationMs(typeof started.maxDurationMs === "number" ? started.maxDurationMs : requested);
      setNow(Date.now());
      setMic({ state: "recording", reason: null });
      setPhase("recording");
    } catch (caught) {
      setError(messageOf(caught));
      setPhase("idle");
    }
  }, [stopPlayback]);

  const resetRecorder = useCallback(() => {
    if (!mounted.current) return;
    setPhase("idle");
    setMic({ state: "idle", reason: null });
    setStartedAt(null);
    setLevel(0);
  }, []);

  /** Save a stopped recording (by Stop or by the limit); a failure leaves it pending on the phone. */
  const saveStopped = useCallback(async (recording: VoiceNoteRecording) => {
    if (mounted.current) {
      setPhase("saving");
      setSavePercent(null);
    }
    const outcome = await saveRecording(tcw, recording, (stored, total) => {
      if (mounted.current && total > 0) setSavePercent(Math.floor((stored / total) * 100));
    });
    if (mounted.current) setSavePercent(null);
    if (outcome.saved) {
      await refresh();
      transcriber?.noteSaved(recording, outcome.audio ?? undefined);
      onSaved?.(recording);
    } else if (outcome.failure !== null && mounted.current) {
      // The audio stays on the device; nothing is lost if the save failed.
      setPending((current) => [...current.filter((r) => r.id !== recording.id), recording]);
      setError(`Recorded, but saving to your space failed: ${outcome.failure}`);
    }
  }, [onSaved, refresh, tcw, transcriber]);

  const onStop = useCallback(async () => {
    setPhase("stopping");
    try {
      const recording = await VoiceNotes.stop();
      await saveStopped(recording);
    } catch (caught) {
      // "not_recording": the limit stopped it first, and its "autoStopped" event saves it.
      if (errorCode(caught) !== "not_recording") setError(messageOf(caught));
    } finally {
      if (!autoSaving.current) resetRecorder();
    }
  }, [resetRecorder, saveStopped]);

  useEffect(() => {
    onAutoStoppedRef.current = (event) => {
      const notice = limitNoticeText(event.maxDurationMs);
      setLimitNotice(notice);
      if (!event.recording) {
        setError(`${notice} The recording captured no audio.`);
        if (!autoSaving.current) resetRecorder();
        return;
      }
      const recording = event.recording;
      autoSaving.current = true;
      void (async () => {
        try {
          await saveStopped(recording);
        } catch (caught) {
          if (mounted.current) setError(messageOf(caught));
        } finally {
          autoSaving.current = false;
          resetRecorder();
        }
      })();
    };
  }, [resetRecorder, saveStopped]);

  const onPlay = useCallback(async (sourceId: string) => {
    stopPlayback();
    const request = playRequest.current;
    setPlaying({ sourceId, src: null, percent: null });
    const res = await loadVoiceNoteAudioBlob(tcw, sourceId, {
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
  }, [stopPlayback, tcw]);

  // One tap from the chat screen records at once; a recording already running is left to the
  // mount-time pickup. Once per mount (StrictMode's second effect run included).
  const autoStarted = useRef(false);
  useEffect(() => {
    if (!autoStart || autoStarted.current) return;
    autoStarted.current = true;
    void VoiceNotes.status()
      .then((status) => status.state === "idle", () => true)
      .then((idle) => {
        if (idle && mounted.current) void onRecord();
      });
  }, [autoStart, onRecord]);

  const transcription = transcriptionProps(transcriber, snapshot);

  return (
    <VoiceNotesSurface
      render={render}
      phase={phase}
      mic={mic}
      elapsedMs={startedAt === null ? 0 : now - startedAt}
      level={level}
      error={error}
      notes={notes}
      notesStatus={notesStatus}
      playing={playing}
      maxDurationMs={maxDurationMs}
      limitNotice={limitNotice}
      savePercent={savePercent}
      pendingCount={pending.length}
      retrying={retrying}
      onRecord={() => void onRecord()}
      onStop={() => void onStop()}
      onPlay={(id) => void onPlay(id)}
      onRetry={() => void retryPending()}
      transcription={transcription}
    />
  );
}

/** The card, or another view of the same recorder (the chat screen's bar). */
function VoiceNotesSurface({ render, ...view }: VoiceNotesViewProps & Pick<ControllerProps, "render">) {
  return render ? <>{render(view)}</> : <VoiceNotesView {...view} />;
}

/** Renders nothing outside the Exo mobile app. */
export function VoiceNotesSection(props: ControllerProps) {
  if (!nativeVoiceNotesAvailable()) return null;
  return <VoiceNotesController {...props} />;
}
